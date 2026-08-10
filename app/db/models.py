"""SQLAlchemy models. Schema is created with ``create_all`` — no migrations in v0.1."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
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
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    """Lower values are drained first by ordered strategies."""

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
    total_requests: Mapped[int] = mapped_column(Integer, default=0)
    total_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_output_tokens: Mapped[int] = mapped_column(Integer, default=0)
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

    total_requests: Mapped[int] = mapped_column(Integer, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


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

    account: Mapped[Account | None] = relationship(back_populates="request_logs")


Index("ix_request_logs_account_created", RequestLog.account_id, RequestLog.created_at)
Index("ix_request_logs_key_created", RequestLog.api_key_id, RequestLog.created_at)
