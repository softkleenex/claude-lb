"""Runtime settings. Environment variables use the ``CLAUDE_LB_`` prefix."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    if os.environ.get("CLAUDE_LB_IN_DOCKER") == "1":
        return Path("/var/lib/claude-lb")
    return Path.home() / ".claude-lb"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CLAUDE_LB_",
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 2456

    data_dir: Path = Field(default_factory=_default_data_dir)
    database_url: str | None = None

    upstream_base_url: str = "https://api.anthropic.com"
    upstream_timeout_seconds: float = 600.0
    upstream_connect_timeout_seconds: float = 10.0

    routing_strategy: str = "capacity_weighted"
    max_attempts: int = 3
    """Upstream accounts tried per client request before giving up."""

    require_api_key: bool = True
    """When false, proxy routes accept unauthenticated requests (local dev only)."""

    dashboard_enabled: bool = True

    secret_key: str | None = None
    """Fernet key for encrypting upstream credentials. Generated on first run if unset."""

    log_level: str = "INFO"
    request_log_retention_days: int = 30

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.data_dir / 'claude-lb.db'}"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings
