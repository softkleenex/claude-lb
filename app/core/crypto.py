"""Encryption for upstream credentials at rest, plus local API key hashing.

Upstream Anthropic keys are reversibly encrypted because the proxy has to replay them
upstream. Locally issued proxy keys are only ever compared, so those are hashed.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

_KEY_FILENAME = "secret.key"
_LOCAL_KEY_PREFIX = "clb_"


def _load_or_create_key(data_dir: Path) -> bytes:
    settings = get_settings()
    if settings.secret_key:
        return settings.secret_key.encode()

    key_path = data_dir / _KEY_FILENAME
    if key_path.exists():
        return key_path.read_bytes().strip()

    key = Fernet.generate_key()
    key_path.write_bytes(key)
    key_path.chmod(0o600)
    return key


@lru_cache
def _fernet() -> Fernet:
    settings = get_settings()
    return Fernet(_load_or_create_key(settings.data_dir))


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:  # pragma: no cover - depends on operator error
        raise RuntimeError(
            "Failed to decrypt a stored credential. The secret key changed or the data "
            "directory was moved without its secret.key."
        ) from exc


def mask_secret(value: str, *, keep: int = 6, prefix: int = 10) -> str:
    """Render a credential for display: ``sk-ant-api…Ab12Cd``.

    Never reveals more than half the string, so a short or unexpected credential
    cannot be reconstructed from the hint stored alongside it.
    """
    if not value:
        return ""
    budget = max(0, len(value) // 2)
    keep = min(keep, budget)
    prefix = min(prefix, budget - keep)
    if prefix <= 0:
        return "…" + value[-keep:] if keep else "…"
    return f"{value[:prefix]}…{value[-keep:]}"


def generate_local_api_key() -> str:
    return _LOCAL_KEY_PREFIX + secrets.token_urlsafe(32)


def hash_local_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def verify_local_api_key(key: str, key_hash: str) -> bool:
    return hmac.compare_digest(hash_local_api_key(key), key_hash)
