"""Request forwarding: pick an account, replay the request upstream, retry on failure."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.crypto import decrypt
from app.core.pricing import estimate_cost_usd
from app.db.models import Account, ApiKey, RequestLog
from app.db.session import session_scope
from app.modules.proxy import load_balancer as lb
from app.modules.proxy.usage_parser import StreamUsageCollector, Usage, parse_json_usage

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
    }
)
_STRIPPED_RESPONSE_HEADERS = frozenset(
    {"content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"}
)

RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504, 529})


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

    # ---- request shaping -------------------------------------------------

    @staticmethod
    def _build_upstream_headers(client_headers: dict[str, str], credential: str) -> dict[str, str]:
        headers = {k: v for k, v in client_headers.items() if k.lower() not in _STRIPPED_REQUEST_HEADERS}
        headers["x-api-key"] = credential
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
    ) -> ProxyOutcome:
        settings = get_settings()
        model, wants_stream = self._peek_request(body)
        tried: list[str] = []
        last_error: str = "no upstream attempt was made"
        last_status = 503
        last_body: bytes | None = None

        for attempt in range(1, settings.max_attempts + 1):
            async with session_scope() as session:
                accounts = await self._load_accounts(session)
                try:
                    account = lb.select_account(
                        accounts,
                        strategy=settings.routing_strategy,
                        exclude_ids=tried,
                        pinned_account_id=api_key.pinned_account_id if api_key else None,
                    )
                except lb.NoAccountAvailable as exc:
                    if tried:
                        break
                    raise UpstreamExhausted(str(exc), status_code=503) from exc
                account_id = account.id
                credential = decrypt(account.encrypted_credential)
                base_url = (account.base_url or settings.upstream_base_url).rstrip("/")

            tried.append(account_id)
            url = f"{base_url}{path}" + (f"?{query}" if query else "")
            upstream_headers = self._build_upstream_headers(headers, credential)

            request = self._client.build_request(method, url, headers=upstream_headers, content=body or None)
            try:
                response = await self._client.send(request, stream=True)
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                last_status = 502
                await self._record_attempt_failure(account_id, status_code=None, reason=last_error)
                logger.warning("upstream transport error on account=%s: %s", account_id, last_error)
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

            if response.status_code in (401, 403):
                error_body = await response.aread()
                await response.aclose()
                last_status = response.status_code
                last_body = error_body
                last_error = f"upstream rejected credentials ({response.status_code})"
                await self._record_attempt_failure(
                    account_id, status_code=response.status_code, reason=last_error
                )
                logger.warning("disabling account=%s: %s", account_id, last_error)
                continue

            # Success, or a non-retryable client error (4xx) that belongs to the caller.
            account_obj = await self._refresh_account(account_id, dict(response.headers))
            is_stream = wants_stream or "text/event-stream" in response.headers.get("content-type", "")

            if is_stream and response.status_code < 400:
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
            await session.flush()
            session.expunge(account)
            return account

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
) -> None:
    """Write the request log and roll the counters onto the account and API key."""
    cost = estimate_cost_usd(usage.model or model, **usage.as_dict())
    duration_ms = int((time.perf_counter() - started_at) * 1000)

    async with session_scope() as session:
        session.add(
            RequestLog(
                account_id=account_id,
                api_key_id=api_key_id,
                path=path,
                model=usage.model or model,
                status_code=status_code,
                streaming=streaming,
                duration_ms=duration_ms,
                attempts=attempts,
                cost_usd=cost,
                error=error[:512] if error else None,
                **usage.as_dict(),
            )
        )

        if account_id:
            account = await session.get(Account, account_id)
            if account is not None:
                account.total_requests += 1
                account.total_input_tokens += usage.input_tokens
                account.total_output_tokens += usage.output_tokens
                account.total_cost_usd += cost

        if api_key_id:
            key = await session.get(ApiKey, api_key_id)
            if key is not None:
                key.total_requests += 1
                key.total_cost_usd += cost


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
) -> AsyncIterator[bytes]:
    """Pass SSE bytes through untouched, then log usage once the stream completes."""
    collector = StreamUsageCollector()

    async def _generator() -> AsyncIterator[bytes]:
        error: str | None = None
        try:
            async for chunk in stream:
                collector.feed(chunk)
                yield chunk
        except Exception as exc:  # client disconnect, upstream reset, ...
            error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
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
            )

    return _generator()
