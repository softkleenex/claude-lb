"""Request forwarding: pick an account, replay the request upstream, retry on failure."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from claude_lb.core.config import get_settings
from claude_lb.core.pricing import estimate_cost_usd
from claude_lb.db.models import Account, ApiKey, QuotaHistory, RequestLog
from claude_lb.db.session import session_scope
from claude_lb.modules.accounts import credentials
from claude_lb.modules.health import service as health_service
from claude_lb.modules.proxy import load_balancer as lb
from claude_lb.modules.proxy import model_blocks, sticky
from claude_lb.modules.proxy import quota as quota_mod
from claude_lb.modules.proxy.usage_parser import StreamUsageCollector, Usage, parse_json_usage
from claude_lb.modules.settings import service as settings_service
from claude_lb.modules.usage import rollup

logger = logging.getLogger(__name__)

# Hop-by-hop and auth headers we must not blindly relay upstream.
_STRIPPED_REQUEST_HEADERS = frozenset(
    {
        "host",
        "content-length",
        "authorization",
        "x-api-key",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "accept-encoding",
        # The dashboard session cookie rides along on any same-origin request; it is
        # claude-lb's credential and must never reach an upstream.
        "cookie",
        "te",
        "trailer",
    }
)
_STRIPPED_RESPONSE_HEADERS = frozenset(
    {"content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"}
)

RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504, 529})

_BILLING_MARKERS = ("credit balance is too low", "reached your specified api usage limits")


def is_billing_exhausted(body: bytes) -> bool:
    """True when a 400 says the *account* cannot pay, e.g. Console credit ran out."""
    try:
        message = str(json.loads(body).get("error", {}).get("message", "")).lower()
    except (ValueError, AttributeError):
        return False
    return any(marker in message for marker in _BILLING_MARKERS)


def explain_unavailable(accounts: list[Account], model: str | None) -> str | None:
    """Say *why* nothing can take the request, in terms an operator can act on."""
    if not accounts:
        return "no accounts configured — add one with `claude-lb account add`"
    reasons: list[str] = []
    for account in accounts:
        if not account.enabled:
            reasons.append(f"{account.name}: disabled ({account.disabled_reason or 'by operator'})")
        elif lb.spend_cap_reached(account):
            reasons.append(f"{account.name}: spend cap ${account.spend_cap_usd:.2f} reached")
        elif model_blocks.is_blocked(account, model):
            reasons.append(f"{account.name}: subscription does not serve {model}")
        elif not lb.is_available(account):
            reasons.append(f"{account.name}: {account.quota_status or 'cooling down'}")
    if not reasons:
        return None
    return f"no account can serve {model or 'this request'} right now — " + "; ".join(reasons)


class UpstreamExhausted(RuntimeError):
    """Every candidate account failed or none were available."""

    def __init__(self, message: str, *, status_code: int = 503, last_body: bytes | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.last_body = last_body


@dataclass
class ProxyOutcome:
    status_code: int
    headers: dict[str, str]
    account: Account
    attempts: int
    streaming: bool
    body: bytes | None = None
    stream: AsyncIterator[bytes] | None = None
    usage: Usage = field(default_factory=Usage)


class ProxyService:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    # ---- account loading -------------------------------------------------

    async def _load_accounts(self, session: AsyncSession) -> list[Account]:
        result = await session.execute(select(Account).order_by(Account.name))
        return list(result.scalars())

    @staticmethod
    async def _filter_by_model(
        session: AsyncSession, accounts: list[Account], model: str | None, *, keep_id: str | None = None
    ) -> list[Account]:
        """Drop accounts whose org is *known* not to serve `model`.

        Fail-open: an account that has never synced stays in the pool, and if the
        catalog would rule out every account the request is attempted anyway.
        ``keep_id`` (a key's pinned account) is never dropped — a pinned key has no
        other account to go to, so upstream gets to answer rather than the catalog.
        """
        excluded = await health_service.unsupported_accounts(session, model or "")
        excluded |= {a.id for a in accounts if model_blocks.is_blocked(a, model)}
        excluded.discard(keep_id)
        if not excluded:
            return accounts
        filtered = [a for a in accounts if a.id not in excluded]
        # If the catalog rules out everyone, trust the request over the catalog.
        return filtered or accounts

    # ---- request shaping -------------------------------------------------

    @staticmethod
    def _build_upstream_headers(client_headers: dict[str, str]) -> dict[str, str]:
        """Relay the client's headers minus the ones we must not forward.

        Auth is applied afterwards by `ResolvedCredential.apply`, which knows whether
        this account wants `x-api-key` or a bearer token.
        """
        # RFC 9110 7.6.1: headers named in Connection are hop-by-hop too.
        connection_scoped = {
            token.strip().lower()
            for key, value in client_headers.items()
            if key.lower() == "connection"
            for token in value.split(",")
        }
        headers = {
            k: v
            for k, v in client_headers.items()
            if k.lower() not in _STRIPPED_REQUEST_HEADERS and k.lower() not in connection_scoped
        }
        headers.setdefault("anthropic-version", "2023-06-01")
        headers.setdefault("content-type", "application/json")
        return headers

    @staticmethod
    def _filter_response_headers(headers: httpx.Headers) -> dict[str, str]:
        return {k: v for k, v in headers.items() if k.lower() not in _STRIPPED_RESPONSE_HEADERS}

    @staticmethod
    def _peek_request(body: bytes) -> tuple[str | None, bool]:
        """Best-effort read of ``model`` and ``stream`` without failing on odd bodies."""
        try:
            payload = json.loads(body) if body else {}
        except (ValueError, UnicodeDecodeError):
            return None, False
        if not isinstance(payload, dict):
            return None, False
        model = payload.get("model")
        return (model if isinstance(model, str) else None), bool(payload.get("stream"))

    @staticmethod
    def _retry_after(headers: httpx.Headers) -> float | None:
        raw = headers.get("retry-after")
        if raw is None:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    # ---- forwarding ------------------------------------------------------

    async def forward(
        self,
        *,
        method: str,
        path: str,
        query: str,
        headers: dict[str, str],
        body: bytes,
        api_key: ApiKey | None,
        session_key: str | None = None,
    ) -> ProxyOutcome:
        """``session_key`` is the conversation key when the caller already computed it
        (it is logged as well); otherwise it is derived here when sticky routing needs it."""
        env = get_settings()
        async with session_scope() as session:
            runtime = await settings_service.load(session)

        model, wants_stream = self._peek_request(body)
        sticky_key = (
            (session_key or sticky.session_key(body, api_key_id=api_key.id if api_key else None))
            if runtime.sticky_sessions_enabled
            else None
        )
        assigned_ids = api_key.assigned_account_ids if api_key else None
        assigned = set(assigned_ids) if assigned_ids is not None else None
        tried: list[str] = []
        reauthed: dict[str, bool] = {}
        last_error: str = "no upstream attempt was made"
        last_status = 503
        last_body: bytes | None = None

        for attempt in range(1, runtime.max_attempts + 1):
            async with session_scope() as session:
                all_accounts = await self._load_accounts(session)
                if assigned is not None:
                    # A key restricted to some accounts never spills onto the rest.
                    all_accounts = [a for a in all_accounts if a.id in assigned]
                    if not all_accounts:
                        raise UpstreamExhausted(
                            "none of the accounts assigned to this API key exist any more", status_code=503
                        )
                accounts = await self._filter_by_model(
                    session, all_accounts, model, keep_id=api_key.pinned_account_id if api_key else None
                )
                preferred = (
                    sticky.resolve(sticky_key, accounts, ttl_seconds=runtime.sticky_ttl_seconds)
                    # Only honour affinity on the first attempt; after a failure the whole
                    # point is to land somewhere else.
                    if sticky_key and attempt == 1
                    else None
                )
                try:
                    account = lb.select_account(
                        accounts,
                        strategy=runtime.routing_strategy,
                        exclude_ids=tried,
                        pinned_account_id=api_key.pinned_account_id if api_key else None,
                        preferred_account_id=preferred,
                    )
                except lb.NoAccountAvailable as exc:
                    if tried:
                        break
                    raise UpstreamExhausted(
                        explain_unavailable(all_accounts, model) or str(exc), status_code=503
                    ) from exc
                account_id = account.id
                account_name = account.name
                account_snapshot = account
                can_reauth = credentials.can_retry_after_auth_failure(account)
                base_url = (account.base_url or env.upstream_base_url).rstrip("/")
                session.expunge(account)

            tried.append(account_id)
            url = f"{base_url}{path}" + (f"?{query}" if query else "")

            try:
                credential = await credentials.resolve(self._client, account)
            except credentials.CredentialError as exc:
                last_error = str(exc)
                last_status = 502
                await self._record_attempt_failure(account_id, status_code=None, reason=last_error)
                logger.warning("could not resolve credential for account=%s: %s", account_name, exc)
                continue

            upstream_headers = credential.apply(self._build_upstream_headers(headers))

            request = self._client.build_request(method, url, headers=upstream_headers, content=body or None)
            try:
                response = await self._client.send(request, stream=True)
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                last_status = 502
                await self._record_attempt_failure(account_id, status_code=None, reason=last_error)
                logger.warning("upstream transport error on account=%s: %s", account_id, last_error)
                continue

            if model and model_blocks.is_model_refusal(
                account_snapshot, response.status_code, dict(response.headers)
            ):
                # This model is off-limits for this subscription; the account itself is
                # fine for others. Route the model elsewhere instead of cooling down.
                last_body = await response.aread()
                await response.aclose()
                last_status = 429
                last_error = f"upstream refused model {model} for this subscription"
                await self._record_model_block(account_id, model)
                logger.info("account=%s refuses model=%s; routing it elsewhere", account_name, model)
                continue

            if response.status_code in RETRYABLE_STATUS:
                error_body = await response.aread()
                await response.aclose()
                last_status = response.status_code
                last_body = error_body
                last_error = f"upstream returned {response.status_code}"
                await self._record_attempt_failure(
                    account_id,
                    status_code=response.status_code,
                    retry_after_seconds=self._retry_after(response.headers),
                    reason=last_error,
                    rate_limit_headers=dict(response.headers),
                )
                logger.info(
                    "retryable upstream status=%s account=%s attempt=%s",
                    response.status_code,
                    account_id,
                    attempt,
                )
                continue

            if response.status_code == 403:
                # A 403 is usually about *this request* on this org — a model or
                # feature it has no access to — not about the credential. Disabling on
                # it let one client request knock `max_attempts` healthy accounts out
                # of rotation. Try the next account; if every account refuses, the
                # caller gets the 403 verbatim. A credential that is genuinely revoked
                # is caught by the health probe, which asks an account-level question.
                last_body = await response.aread()
                await response.aclose()
                last_status = 403
                last_error = "upstream refused the request (403)"
                logger.info("upstream 403 on account=%s; trying the next account", account_name)
                continue

            if response.status_code == 400 and is_billing_exhausted(error_body := await response.aread()):
                # Out of Console credit (or over the org's spend limit) is an account
                # problem, not a caller problem: take this account out and try the next.
                await response.aclose()
                last_status = 400
                last_body = error_body
                last_error = "upstream account is out of credit"
                await self._record_attempt_failure(account_id, status_code=402, reason=last_error)
                logger.warning("disabling account=%s: %s", account_name, last_error)
                continue

            if response.status_code == 401:
                error_body = await response.aread()
                await response.aclose()
                last_status = response.status_code
                last_body = error_body
                last_error = f"upstream rejected credentials ({response.status_code})"

                # An OAuth access token can be rejected simply because it expired
                # earlier than advertised. Force one refresh and replay before
                # concluding the account is dead.
                if can_reauth and not reauthed.get(account_id):
                    reauthed[account_id] = True
                    tried.remove(account_id)
                    try:
                        await credentials.refresh(
                            self._client, account_id, force=True, stale_token=credential.token
                        )
                        logger.info(
                            "re-authenticated account=%s after %s", account_name, response.status_code
                        )
                        continue
                    except credentials.CredentialError as exc:
                        last_error = f"re-authentication failed: {exc}"
                        tried.append(account_id)

                await self._record_attempt_failure(
                    account_id, status_code=response.status_code, reason=last_error
                )
                logger.warning("disabling account=%s: %s", account_name, last_error)
                continue

            # Success, or a non-retryable client error (4xx) that belongs to the caller.
            account_obj = await self._refresh_account(account_id, dict(response.headers))
            is_stream = wants_stream or "text/event-stream" in response.headers.get("content-type", "")

            if is_stream and response.status_code < 400:
                sticky.remember(sticky_key, account_id, ttl_seconds=runtime.sticky_ttl_seconds)
                return ProxyOutcome(
                    status_code=response.status_code,
                    headers=self._filter_response_headers(response.headers),
                    account=account_obj,
                    attempts=attempt,
                    streaming=True,
                    stream=self._iterate_stream(response),
                )

            payload = await response.aread()
            await response.aclose()
            if response.status_code < 400:
                sticky.remember(sticky_key, account_id, ttl_seconds=runtime.sticky_ttl_seconds)
            usage = parse_json_usage(payload)
            if usage.model is None:
                usage.model = model
            return ProxyOutcome(
                status_code=response.status_code,
                headers=self._filter_response_headers(response.headers),
                account=account_obj,
                attempts=attempt,
                streaming=False,
                body=payload,
                usage=usage,
            )

        raise UpstreamExhausted(last_error, status_code=last_status, last_body=last_body)

    @staticmethod
    async def _iterate_stream(response: httpx.Response) -> AsyncIterator[bytes]:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()

    # ---- persistence -----------------------------------------------------

    async def _refresh_account(self, account_id: str, headers: dict[str, str]) -> Account:
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            if account is None:  # pragma: no cover - deleted mid-flight
                raise UpstreamExhausted("account disappeared mid-request")
            lb.apply_rate_limit_headers(account, headers)
            lb.record_success(account)
            if quota_mod.parse_unified_headers(headers) is not None:
                session.add(
                    QuotaHistory(
                        account_id=account.id,
                        primary_used_percent=account.primary_used_percent,
                        primary_reset_at=account.primary_reset_at,
                        secondary_used_percent=account.secondary_used_percent,
                        secondary_reset_at=account.secondary_reset_at,
                        unified_status=account.unified_status,
                    )
                )
            await session.flush()
            session.expunge(account)
            return account

    async def _record_model_block(self, account_id: str, model: str) -> None:
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            if account is not None:
                model_blocks.add_block(account, model)

    async def _record_attempt_failure(
        self,
        account_id: str,
        *,
        status_code: int | None,
        reason: str,
        retry_after_seconds: float | None = None,
        rate_limit_headers: dict[str, str] | None = None,
    ) -> None:
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            if account is None:  # pragma: no cover
                return
            if rate_limit_headers:
                lb.apply_rate_limit_headers(account, rate_limit_headers)
                if quota_mod.parse_unified_headers(rate_limit_headers) is not None:
                    session.add(
                        QuotaHistory(
                            account_id=account.id,
                            primary_used_percent=account.primary_used_percent,
                            primary_reset_at=account.primary_reset_at,
                            secondary_used_percent=account.secondary_used_percent,
                            secondary_reset_at=account.secondary_reset_at,
                            unified_status=account.unified_status,
                        )
                    )
            lb.record_failure(
                account,
                status_code=status_code,
                retry_after_seconds=retry_after_seconds,
                reason=reason,
            )


async def record_request(
    *,
    account_id: str | None,
    api_key_id: str | None,
    path: str,
    model: str | None,
    status_code: int,
    streaming: bool,
    started_at: float,
    attempts: int,
    usage: Usage,
    error: str | None = None,
    ttft_ms: int | None = None,
    session_key: str | None = None,
    user_agent: str | None = None,
    client_ip: str | None = None,
) -> None:
    """Write the request log and roll the counters onto the account and API key."""
    logged_model = _clip_model(usage.model or model)
    cost = estimate_cost_usd(logged_model, **usage.cost_inputs())
    duration_ms = int((time.perf_counter() - started_at) * 1000)

    async with session_scope() as session:
        session.add(
            RequestLog(
                account_id=account_id,
                api_key_id=api_key_id,
                path=path,
                model=logged_model,
                status_code=status_code,
                streaming=streaming,
                duration_ms=duration_ms,
                attempts=attempts,
                cost_usd=cost,
                error=error[:512] if error else None,
                ttft_ms=ttft_ms,
                session_key=session_key,
                user_agent=user_agent[:255] if user_agent else None,
                client_ip=client_ip[:64] if client_ip else None,
                **usage.as_dict(),
            )
        )

        # Increment in SQL, not in Python: a read-modify-write here loses updates as
        # soon as two requests finish at once on a database that runs them in parallel.
        if account_id:
            await session.execute(
                update(Account)
                .where(Account.id == account_id)
                .values(
                    total_requests=Account.total_requests + 1,
                    total_input_tokens=Account.total_input_tokens + usage.input_tokens,
                    total_output_tokens=Account.total_output_tokens + usage.output_tokens,
                    total_cost_usd=Account.total_cost_usd + cost,
                )
            )

        if api_key_id:
            await session.execute(
                update(ApiKey)
                .where(ApiKey.id == api_key_id)
                .values(
                    total_requests=ApiKey.total_requests + 1,
                    total_cost_usd=ApiKey.total_cost_usd + cost,
                )
            )

        await rollup.apply(
            session,
            account_id=account_id,
            api_key_id=api_key_id,
            model=logged_model,
            usage=usage,
            cost_usd=cost,
            is_error=status_code >= 400,
        )


_MODEL_COLUMN_LENGTH = 128


def _clip_model(model: str | None) -> str | None:
    """The model string is client-controlled whenever upstream rejects the request
    before naming one, so it must fit the column rather than fail the log write."""
    return model[:_MODEL_COLUMN_LENGTH] if model else model


# Streams whose accounting outlived the request that started them. Held so the event
# loop does not garbage-collect a task mid-write.
_finalizers: set[asyncio.Task] = set()


def wrap_stream_for_accounting(
    stream: AsyncIterator[bytes],
    *,
    account_id: str,
    api_key_id: str | None,
    path: str,
    model: str | None,
    status_code: int,
    started_at: float,
    attempts: int,
    on_finished: Callable[[], None] | None = None,
    session_key: str | None = None,
    user_agent: str | None = None,
    client_ip: str | None = None,
) -> AsyncIterator[bytes]:
    """Pass SSE bytes through untouched, then log usage once the stream ends.

    "Ends" includes the client hanging up mid-stream, which is routine (a user
    pressing Esc). That arrives as a cancellation or ``GeneratorExit``, not an
    ``Exception``, and any ``await`` in a cancelled scope is itself cancelled — so the
    upstream close and the log write run in a task of their own that the cancellation
    cannot reach. Without that, every aborted stream went unlogged: its input tokens
    were still billed upstream, but never counted against spend or budgets.
    """
    collector = StreamUsageCollector()
    first_byte_at: list[float] = []

    async def _finalize(error: str | None) -> None:
        try:
            try:
                await stream.aclose()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - closing a dead upstream is best effort
                logger.debug("error closing upstream stream", exc_info=True)
            collector.close()
            usage = collector.usage
            if usage.model is None:
                usage.model = model
            await record_request(
                account_id=account_id,
                api_key_id=api_key_id,
                path=path,
                model=model,
                status_code=status_code,
                streaming=True,
                started_at=started_at,
                attempts=attempts,
                usage=usage,
                error=error,
                ttft_ms=int((first_byte_at[0] - started_at) * 1000) if first_byte_at else None,
                session_key=session_key,
                user_agent=user_agent,
                client_ip=client_ip,
            )
        except Exception:  # noqa: BLE001 - nothing upstream of a finalizer can handle it
            logger.exception("failed to record streamed request")
        finally:
            if on_finished is not None:
                on_finished()

    async def _generator() -> AsyncIterator[bytes]:
        error: str | None = None
        try:
            async for chunk in stream:
                if not first_byte_at:
                    first_byte_at.append(time.perf_counter())
                collector.feed(chunk)
                yield chunk
        except (asyncio.CancelledError, GeneratorExit):
            error = "client disconnected mid-stream"
            raise
        except Exception as exc:  # upstream reset, ...
            error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            task = asyncio.get_running_loop().create_task(_finalize(error))
            _finalizers.add(task)
            task.add_done_callback(_finalizers.discard)
            try:
                await asyncio.shield(task)
            except (asyncio.CancelledError, GeneratorExit):
                # Cancelled while waiting: the task carries on regardless.
                pass

    return _generator()
