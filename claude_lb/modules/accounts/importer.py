"""Parse exported OAuth / subscription credential JSON bundles without hardcoding provider constants."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from claude_lb.modules.proxy.quota import PLAN_TYPES


@dataclass(frozen=True, slots=True)
class ImportedCredential:
    access_token: str
    refresh_token: str | None = None
    token_endpoint: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    scope: str | None = None
    expires_at: datetime | None = None
    lifetime_seconds: int | None = None
    plan_type: str = "pro"
    base_url: str | None = None
    extra_headers: dict[str, str] = field(default_factory=dict)


def _infer_plan_type(subscription_type: str | None, rate_limit_tier: str | None) -> str:
    tier = (rate_limit_tier or "").lower()
    sub = (subscription_type or "").strip().lower()
    if "20x" in tier:
        return "max_20x"
    if "5x" in tier:
        return "max_5x"
    if sub in PLAN_TYPES:
        return sub
    return "pro"


def _parse_expiry(raw: dict[str, Any]) -> tuple[datetime | None, int | None]:
    now = datetime.now(UTC)
    expires_in = raw.get("expires_in") or raw.get("expiresIn")
    if isinstance(expires_in, (int, float)) and expires_in > 0:
        secs = int(expires_in)
        return now + timedelta(seconds=secs), secs

    expires_at = raw.get("expires_at") or raw.get("expiresAt")
    if isinstance(expires_at, (int, float)) and expires_at > 0:
        epoch = float(expires_at) / 1000.0 if expires_at > 1e12 else float(expires_at)
        dt = datetime.fromtimestamp(epoch, tz=UTC)
        secs = max(1, int((dt - now).total_seconds())) if dt > now else None
        return dt, secs
    if isinstance(expires_at, str) and expires_at.strip():
        try:
            dt = datetime.fromisoformat(expires_at.strip().replace("Z", "+00:00"))
            dt = dt if dt.tzinfo else dt.replace(tzinfo=UTC)
            secs = max(1, int((dt - now).total_seconds())) if dt > now else None
            return dt, secs
        except ValueError:
            pass
    return None, None


def parse_credential_bundle(payload: dict[str, Any]) -> ImportedCredential:
    """Extract OAuth tokens and subscription tier from a user-supplied JSON object.

    Supports both Claude Code's ``claudeAiOauth`` structure and generic OAuth JSON.
    """
    source = payload.get("claudeAiOauth")
    if not isinstance(source, dict):
        source = payload

    access_token = source.get("access_token") or source.get("accessToken")
    if not isinstance(access_token, str) or len(access_token.strip()) < 8:
        raise ValueError("credential JSON must include a valid access_token / accessToken")

    refresh_token = source.get("refresh_token") or source.get("refreshToken")
    token_endpoint = source.get("token_endpoint") or source.get("tokenEndpoint")
    client_id = source.get("client_id") or source.get("clientId")
    client_secret = source.get("client_secret") or source.get("clientSecret")
    scope = source.get("scope")
    if isinstance(scope, list):
        scope = " ".join(str(s) for s in scope)

    expires_at, lifetime = _parse_expiry(source)
    plan_type = _infer_plan_type(
        source.get("plan_type") or source.get("subscriptionType"),
        source.get("rateLimitTier"),
    )
    extra_raw = source.get("extra_headers") or source.get("extraHeaders")
    extra_headers = {str(k): str(v) for k, v in extra_raw.items()} if isinstance(extra_raw, dict) else {}
    base_url = source.get("base_url") or source.get("baseUrl")

    return ImportedCredential(
        access_token=access_token.strip(),
        refresh_token=(
            str(refresh_token).strip() if isinstance(refresh_token, str) and refresh_token else None
        ),
        token_endpoint=(
            str(token_endpoint).strip() if isinstance(token_endpoint, str) and token_endpoint else None
        ),
        client_id=str(client_id).strip() if isinstance(client_id, str) and client_id else None,
        client_secret=(
            str(client_secret).strip() if isinstance(client_secret, str) and client_secret else None
        ),
        scope=str(scope).strip() if isinstance(scope, str) and scope else None,
        expires_at=expires_at,
        lifetime_seconds=lifetime,
        plan_type=plan_type,
        base_url=str(base_url).strip() if isinstance(base_url, str) and base_url else None,
        extra_headers=extra_headers,
    )
