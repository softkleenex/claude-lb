"""Resolving an account's usable credential, refreshing OAuth tokens as needed.

claude-lb ships no first-party client constants. For `provider="oauth"` the operator
supplies the token endpoint, client id, and refresh token themselves; this module only
stores them, presents them, and runs the standard RFC 6749 refresh grant when the
access token is close to expiry.

Refreshes are serialized per account: without that, a burst of concurrent requests
against a just-expired token would all refresh at once, and a provider that rotates
refresh tokens would invalidate all but one of them.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx

from app.core.crypto import decrypt, encrypt, mask_secret
from app.db.models import Account
from app.db.session import session_scope

logger = logging.getLogger(__name__)

PROVIDER_API_KEY = "anthropic_api_key"
PROVIDER_OAUTH = "oauth"
PROVIDERS = (PROVIDER_API_KEY, PROVIDER_OAUTH)

AUTH_SCHEMES = ("x-api-key", "bearer")

# Refresh this far ahead of expiry so an in-flight request never races the deadline.
REFRESH_SKEW = timedelta(seconds=120)
# ...but never more than this fraction of the token's own lifetime. A provider that
# mints tokens shorter than REFRESH_SKEW would otherwise be re-granted on every single
# request, which is a fast way to get the token endpoint to start refusing you.
MAX_SKEW_FRACTION = 0.5
REFRESH_TIMEOUT_SECONDS = 30.0
MAX_REFRESH_FAILURES = 3

# One lock per account id. Bounded by the number of accounts, so it can live forever.
_refresh_locks: dict[str, asyncio.Lock] = {}


class CredentialError(RuntimeError):
    """The account's credential cannot be made usable."""


@dataclass
class ResolvedCredential:
    account_id: str
    token: str
    auth_scheme: str
    extra_headers: dict[str, str] = field(default_factory=dict)

    def apply(self, headers: dict[str, str]) -> dict[str, str]:
        """Return `headers` with this account's auth applied.

        Both auth headers are cleared first: leaving a stale `x-api-key` alongside a
        bearer token makes the upstream reject the request.
        """
        merged = {k: v for k, v in headers.items() if k.lower() not in ("x-api-key", "authorization")}
        merged.update(self.extra_headers)
        if self.auth_scheme == "bearer":
            merged["authorization"] = f"Bearer {self.token}"
        else:
            merged["x-api-key"] = self.token
        return merged


def parse_extra_headers(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        logger.warning("ignoring unparseable extra_headers_json")
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items()}


def _as_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def effective_skew(account: Account) -> timedelta:
    """How early to refresh this account's token."""
    lifetime = account.credential_lifetime_seconds
    if not lifetime or lifetime <= 0:
        return REFRESH_SKEW
    return min(REFRESH_SKEW, timedelta(seconds=lifetime * MAX_SKEW_FRACTION))


def needs_refresh(account: Account, *, now: datetime | None = None) -> bool:
    if account.provider != PROVIDER_OAUTH:
        return False
    if not account.oauth_refresh_token_encrypted or not account.oauth_token_endpoint:
        return False
    expires_at = _as_aware(account.credential_expires_at)
    if expires_at is None:
        # No expiry recorded: the operator is managing rotation, leave it alone.
        return False
    return (now or datetime.now(UTC)) + effective_skew(account) >= expires_at


def _lock_for(account_id: str) -> asyncio.Lock:
    lock = _refresh_locks.get(account_id)
    if lock is None:
        lock = _refresh_locks[account_id] = asyncio.Lock()
    return lock


async def _post_refresh(client: httpx.AsyncClient, account: Account) -> dict:
    """Run the RFC 6749 refresh_token grant against the operator-supplied endpoint."""
    form = {
        "grant_type": "refresh_token",
        "refresh_token": decrypt(account.oauth_refresh_token_encrypted or ""),
    }
    if account.oauth_client_id:
        form["client_id"] = account.oauth_client_id
    if account.oauth_client_secret_encrypted:
        form["client_secret"] = decrypt(account.oauth_client_secret_encrypted)
    if account.oauth_scope:
        form["scope"] = account.oauth_scope

    response = await client.post(
        account.oauth_token_endpoint or "",
        data=form,
        headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
        timeout=REFRESH_TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        raise CredentialError(f"token endpoint returned {response.status_code}: {response.text[:200]}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise CredentialError("token endpoint did not return JSON") from exc
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise CredentialError("token response has no access_token")
    return payload


async def refresh(
    client: httpx.AsyncClient,
    account_id: str,
    *,
    force: bool = False,
    stale_token: str | None = None,
) -> str:
    """Refresh one account's access token and persist the result.

    Serialized per account. Queued callers re-check inside the lock and reuse whatever
    the first one obtained rather than issuing a second grant.

    ``force`` is for the 401 path: the upstream rejected a token that has not reached
    its advertised expiry, so the freshness check would otherwise short-circuit and no
    refresh would happen at all. ``stale_token`` keeps that path concurrency-safe —
    if the stored token already changed while this caller waited on the lock, someone
    else refreshed and there is nothing left to do.
    """
    async with _lock_for(account_id):
        async with session_scope() as session:
            account = await session.get(Account, account_id)
            if account is None:
                raise CredentialError("account no longer exists")

            current = decrypt(account.encrypted_credential)
            if force:
                if stale_token is not None and current != stale_token:
                    return current
            elif not needs_refresh(account):
                return current

            if not account.oauth_refresh_token_encrypted or not account.oauth_token_endpoint:
                raise CredentialError("no refresh token configured for this account")

            try:
                payload = await _post_refresh(client, account)
            except (CredentialError, httpx.HTTPError) as exc:
                account.refresh_failures += 1
                detail = f"token refresh failed: {exc}"
                if account.refresh_failures >= MAX_REFRESH_FAILURES:
                    # A refresh token that keeps being rejected will not fix itself.
                    account.enabled = False
                    account.disabled_reason = detail[:255]
                    logger.error("disabling account %s: %s", account.name, detail)
                # Commit before raising: the exception would otherwise roll the
                # counter back and the breaker would never trip.
                await session.commit()
                raise CredentialError(detail) from exc

            access_token = str(payload["access_token"])
            account.encrypted_credential = encrypt(access_token)
            account.credential_hint = mask_secret(access_token)
            account.refresh_failures = 0
            account.last_refresh_at = datetime.now(UTC)

            expires_in = payload.get("expires_in")
            lifetime = (
                int(expires_in)
                if isinstance(expires_in, (int, float, str)) and str(expires_in).isdigit()
                else None
            )
            account.credential_lifetime_seconds = lifetime
            account.credential_expires_at = (
                datetime.now(UTC) + timedelta(seconds=lifetime) if lifetime else None
            )

            # Providers that rotate refresh tokens invalidate the old one on use.
            rotated = payload.get("refresh_token")
            if isinstance(rotated, str) and rotated:
                account.oauth_refresh_token_encrypted = encrypt(rotated)

            logger.info("refreshed credential for account %s", account.name)
            return access_token


async def resolve(
    client: httpx.AsyncClient, account: Account, *, force_refresh: bool = False
) -> ResolvedCredential:
    """The credential to use for this request, refreshing first if it is due."""
    token: str | None = None

    if force_refresh and account.provider == PROVIDER_OAUTH:
        token = await refresh(client, account.id, force=True)
    elif needs_refresh(account):
        token = await refresh(client, account.id)

    if token is None:
        token = decrypt(account.encrypted_credential)

    return ResolvedCredential(
        account_id=account.id,
        token=token,
        auth_scheme=account.auth_scheme or "x-api-key",
        extra_headers=parse_extra_headers(account.extra_headers_json),
    )


def can_retry_after_auth_failure(account: Account) -> bool:
    """Whether a 401 is worth one forced refresh before giving up on the account.

    Only for OAuth accounts with a refresh token: a rejected static API key will be
    rejected again no matter how many times it is replayed.
    """
    return (
        account.provider == PROVIDER_OAUTH
        and bool(account.oauth_refresh_token_encrypted)
        and bool(account.oauth_token_endpoint)
    )
