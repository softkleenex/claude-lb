"""SQLAlchemy models. Schema is created with ``create_all`` — no migrations in v0.1."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class Account(Base):
    """An upstream Anthropic credential the balancer can route traffic to."""

    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    provider: Mapped[str] = mapped_column(String(32), default="anthropic_api_key")
    encrypted_credential: Mapped[str] = mapped_column(Text)
    credential_hint: Mapped[str] = mapped_column(String(64), default="")

    base_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    transport: Mapped[str] = mapped_column(String(32), default="http")
    """``http`` for direct API calls, ``claude_code`` for the native CLI transport."""

    # --- how the credential is presented upstream ---
    auth_scheme: Mapped[str] = mapped_column(String(16), default="x-api-key")
    """``x-api-key`` for Console keys, ``bearer`` for OAuth access tokens."""
    extra_headers_json: Mapped[str] = mapped_column(Text, default="{}")
    """Additional request headers this account needs (e.g. an anthropic-beta flag)."""

    # --- OAuth refresh, when provider == "oauth" ---
    oauth_refresh_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_token_endpoint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    oauth_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    oauth_client_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_scope: Mapped[str | None] = mapped_column(String(512), nullable=True)
    credential_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    """When the stored access token stops working. Null means it does not expire."""
    credential_lifetime_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """How long the token was minted for, used to scale the early-refresh window."""
    last_refresh_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refresh_failures: Mapped[int] = mapped_column(Integer, default=0)

    weight: Mapped[float] = mapped_column(Float, default=1.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    """Lower values are drained first by ordered strategies."""

    # Subscription plan & dual-window quota (5h primary / 7d secondary)
    plan_type: Mapped[str] = mapped_column(String(32), default="api")
    routing_policy: Mapped[str] = mapped_column(String(16), default="normal")
    capacity_credits: Mapped[float | None] = mapped_column(Float, nullable=True)
    primary_used_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    primary_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    primary_window_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    secondary_used_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    secondary_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    secondary_window_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unified_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    overage_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    quota_status: Mapped[str] = mapped_column(String(32), default="active")
    quota_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    model_blocks_json: Mapped[str] = mapped_column(Text, default="{}")
    """Temporarily unavailable models: {model: unix time the reroute lifts}."""
    spend_cap_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    """Stop routing to this account once its estimated lifetime spend reaches this. Null = no cap."""

    # Health / circuit breaker
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    disabled_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Last observed rate-limit headers from upstream
    rl_requests_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rl_requests_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rl_tokens_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rl_tokens_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rl_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rl_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Cumulative counters
    # Background health probe
    last_probe_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_probe_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_probe_detail: Mapped[str] = mapped_column(String(255), default="")
    models_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    total_requests: Mapped[int] = mapped_column(BigInteger, default=0)
    total_input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    request_logs: Mapped[list[RequestLog]] = relationship(back_populates="account")


class ApiKey(Base):
    """A locally issued key that clients present to the balancer."""

    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    key_hint: Mapped[str] = mapped_column(String(32), default="")

    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Optional per-key budget over a rolling window
    max_requests_per_window: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_tokens_per_window: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_cost_usd_per_window: Mapped[float | None] = mapped_column(Float, nullable=True)
    window_seconds: Mapped[int] = mapped_column(Integer, default=3600)

    pinned_account_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )

    allowed_models_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    """JSON list of model ids (or family prefixes) this key may call. Null = any model."""
    enforced_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    """Every request's ``model`` is rewritten to this. Null = leave the request alone."""
    assigned_account_ids_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    """JSON list of account ids this key may be routed to. Null = the whole pool."""

    total_requests: Mapped[int] = mapped_column(BigInteger, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    limit_rules: Mapped[list[ApiKeyLimitRule]] = relationship(
        back_populates="api_key",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="ApiKeyLimitRule.position",
    )

    @property
    def allowed_models(self) -> list[str] | None:
        return _json_list(self.allowed_models_json)

    @allowed_models.setter
    def allowed_models(self, value: list[str] | None) -> None:
        self.allowed_models_json = None if value is None else json.dumps(value)

    @property
    def assigned_account_ids(self) -> list[str] | None:
        return _json_list(self.assigned_account_ids_json)

    @assigned_account_ids.setter
    def assigned_account_ids(self, value: list[str] | None) -> None:
        self.assigned_account_ids_json = None if value is None else json.dumps(value)


def _json_list(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        # Unreadable restriction: fail closed rather than silently opening the key up.
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


class ApiKeyLimitRule(Base):
    """One usage limit on an API key. All of a key's rules must pass (AND).

    Counted from request logs over the rule's window, so a window longer than the log
    retention can only see what is still retained.
    """

    __tablename__ = "api_key_limit_rules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    api_key_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("api_keys.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)
    metric: Mapped[str] = mapped_column(String(16))
    """requests | total_tokens | input_tokens | output_tokens | cost_usd"""
    window: Mapped[str] = mapped_column(String(16))
    """5h | 7d (rolling) · daily | weekly | monthly (UTC calendar) · custom (rolling)"""
    window_seconds: Mapped[int] = mapped_column(Integer)
    """Length of a rolling window; for calendar windows, informational only."""
    max_value: Mapped[float] = mapped_column(Float)
    model_filter: Mapped[str | None] = mapped_column(String(128), nullable=True)
    """Only requests for this model (exact id, or a family prefix) count and are limited."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    api_key: Mapped[ApiKey] = relationship(back_populates="limit_rules")


class RequestLog(Base):
    """One proxied client request. Retained for `request_log_retention_days`."""

    __tablename__ = "request_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    account_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    api_key_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("api_keys.id", ondelete="SET NULL"), nullable=True
    )

    path: Mapped[str] = mapped_column(String(255))
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, default=0)
    streaming: Mapped[bool] = mapped_column(Boolean, default=False)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=1)

    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_creation_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)

    error: Mapped[str | None] = mapped_column(String(512), nullable=True)

    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """Time to the first streamed byte, measured from when the request arrived. Null for
    non-streaming responses and for rows written before this was recorded."""
    session_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    """Conversation key (hash of the cacheable prefix, see ``proxy.sticky.session_key``)."""
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    client_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)

    account: Mapped[Account | None] = relationship(back_populates="request_logs")


Index("ix_request_logs_account_created", RequestLog.account_id, RequestLog.created_at)
Index("ix_request_logs_session_created", RequestLog.session_key, RequestLog.created_at)
Index("ix_request_logs_key_created", RequestLog.api_key_id, RequestLog.created_at)


class Setting(Base):
    """Operator-editable configuration that overrides the env defaults at runtime.

    One row per key so a write touches only what changed; values are JSON-encoded
    so booleans and numbers survive the round trip.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DashboardCredential(Base):
    """Singleton row holding the dashboard operator's password and TOTP secret."""

    __tablename__ = "dashboard_credentials"

    id: Mapped[str] = mapped_column(String(16), primary_key=True, default="singleton")
    password_hash: Mapped[str] = mapped_column(String(255))
    password_salt: Mapped[str] = mapped_column(String(64))

    totp_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    """Set only after a code is confirmed, so a half-finished setup can't lock you out."""
    totp_pending_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    """A secret awaiting its first code. Kept apart from the live one, so starting an
    enrollment never switches off the second factor that is already protecting login."""
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    """The last TOTP time step accepted; a code for it or an earlier step is a replay."""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class DashboardSession(Base):
    """A logged-in dashboard browser session. Stored so it can be revoked."""

    __tablename__ = "dashboard_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    client: Mapped[str] = mapped_column(String(255), default="")
    role: Mapped[str] = mapped_column(String(16), default="admin")
    """``admin`` (signed in with the dashboard password) or ``guest`` (read-only)."""


class AuditEvent(Base):
    """Append-only record of management-plane changes."""

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str] = mapped_column(String(128), default="")
    detail: Mapped[str] = mapped_column(String(512), default="")
    actor: Mapped[str] = mapped_column(String(64), default="dashboard")
    client_ip: Mapped[str] = mapped_column(String(64), default="")
    ok: Mapped[bool] = mapped_column(Boolean, default=True)


class ModelCatalogEntry(Base):
    """A model an account's organization can actually reach.

    Populated by the background sync from upstream ``GET /v1/models``. Used to skip
    accounts whose org has no access to the requested model instead of discovering
    that with a 404 mid-request.
    """

    __tablename__ = "model_catalog"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    model_id: Mapped[str] = mapped_column(String(128), index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    max_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


Index("ix_model_catalog_account_model", ModelCatalogEntry.account_id, ModelCatalogEntry.model_id, unique=True)


class UsageDaily(Base):
    """Per-account, per-model daily totals.

    Request logs are pruned after `request_log_retention_days`, which would take the
    long-range trend with them. These rollups are small and kept indefinitely, so a
    28-day chart survives a 7-day log retention.
    """

    __tablename__ = "usage_daily"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    day: Mapped[str] = mapped_column(String(10), index=True)
    """ISO date (YYYY-MM-DD) in UTC. Stored as text so the grouping key is unambiguous."""
    account_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    api_key_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    """Which client key drove the spend — the dimension chargeback actually needs."""
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)

    requests: Mapped[int] = mapped_column(Integer, default=0)
    errors: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_creation_input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_read_input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)

    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


Index(
    "ix_usage_daily_key",
    UsageDaily.day,
    UsageDaily.account_id,
    UsageDaily.api_key_id,
    UsageDaily.model,
    unique=True,
)


class QuotaHistory(Base):
    """Time-series snapshots of dual-window subscription quota utilization.

    Used to compute EWMA burn rate, depletion risk, and weekly pacing per account.
    """

    __tablename__ = "quota_history"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    primary_used_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    primary_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    secondary_used_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    secondary_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    unified_status: Mapped[str | None] = mapped_column(String(32), nullable=True)


Index("ix_quota_history_account_recorded", QuotaHistory.account_id, QuotaHistory.recorded_at)


class FirewallEntry(Base):
    """One IP address or CIDR range allowed to call the proxy (`/v1/*`) in allowlist mode."""

    __tablename__ = "firewall_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    network: Mapped[str] = mapped_column(String(64), unique=True)
    """Normalized: a bare address for a single host (``10.0.0.5``), else ``net/prefix``."""
    note: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AutomationJob(Base):
    """A prompt sent through the pool on a weekly schedule, one request per target account."""

    __tablename__ = "automation_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(128))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    schedule_days: Mapped[str] = mapped_column(String(64), default="mon,tue,wed,thu,fri,sat,sun")
    schedule_time: Mapped[str] = mapped_column(String(5), default="07:00")
    """Local wall-clock time ``HH:MM`` in ``schedule_timezone``."""
    schedule_timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    spread_minutes: Mapped[int] = mapped_column(Integer, default=0)
    """Each account's request is sent at a random offset in ``[0, spread]`` minutes."""
    model: Mapped[str] = mapped_column(String(128))
    prompt: Mapped[str] = mapped_column(Text, default="ping")
    max_tokens: Mapped[int] = mapped_column(Integer, default=16)
    account_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    """JSON list of target account ids. Empty = every account."""
    include_paused_accounts: Mapped[bool] = mapped_column(Boolean, default=False)
    armed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    """Slots before this instant never fire (set on create, enable and schedule change)."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    @property
    def account_ids(self) -> list[str]:
        return _json_list(self.account_ids_json) or []

    @account_ids.setter
    def account_ids(self, value: list[str]) -> None:
        self.account_ids_json = json.dumps(list(value))


class AutomationRun(Base):
    """One request of an automation cycle, sent through one account.

    A cycle (``cycle_key``) is every account's run for one scheduled slot or one manual
    trigger. ``slot_key`` is unique, which is what keeps a slot from firing twice — across
    restarts and across workers.
    """

    __tablename__ = "automation_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    job_id: Mapped[str] = mapped_column(String(32), index=True)
    job_name: Mapped[str] = mapped_column(String(128), default="")
    cycle_key: Mapped[str] = mapped_column(String(160), index=True)
    slot_key: Mapped[str] = mapped_column(String(200), unique=True)
    trigger: Mapped[str] = mapped_column(String(16), default="scheduled")
    """scheduled | manual"""
    status: Mapped[str] = mapped_column(String(16), default="pending")
    """pending | running | success | failed | skipped"""
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    account_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    account_name: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


Index("ix_automation_runs_job_scheduled", AutomationRun.job_id, AutomationRun.scheduled_for)
