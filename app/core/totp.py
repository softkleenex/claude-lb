"""RFC 6238 TOTP, implemented against RFC 4226 HOTP.

Self-contained rather than pulling in `pyotp`: it is ~40 lines of stdlib hmac, and the
dependency would otherwise exist solely for this.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote, urlencode

DIGITS = 6
PERIOD_SECONDS = 30
# Accept the neighbouring steps so a phone whose clock drifts by a few seconds still works.
DEFAULT_WINDOW = 1


def generate_secret(length: int = 20) -> str:
    """Base32 secret, the encoding every authenticator app expects."""
    return base64.b32encode(secrets.token_bytes(length)).decode().rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    padding = "=" * (-len(secret) % 8)
    key = base64.b32decode(secret.upper() + padding, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(truncated % (10**DIGITS)).zfill(DIGITS)


def now_code(secret: str, *, at: float | None = None) -> str:
    at = time.time() if at is None else at
    return _hotp(secret, int(at // PERIOD_SECONDS))


def verify(secret: str, code: str, *, at: float | None = None, window: int = DEFAULT_WINDOW) -> bool:
    """Constant-time check of ``code`` against the current step ± ``window``."""
    if not secret or not code:
        return False
    candidate = code.strip().replace(" ", "")
    if not candidate.isdigit() or len(candidate) != DIGITS:
        return False

    at = time.time() if at is None else at
    counter = int(at // PERIOD_SECONDS)
    # Compare every candidate rather than returning early, so timing does not leak
    # which step matched.
    matched = False
    for drift in range(-window, window + 1):
        try:
            expected = _hotp(secret, counter + drift)
        except (ValueError, TypeError):
            return False
        matched |= hmac.compare_digest(expected, candidate)
    return matched


def provisioning_uri(secret: str, *, account_name: str, issuer: str = "claude-lb") -> str:
    """`otpauth://` URI for an authenticator app's QR code."""
    label = quote(f"{issuer}:{account_name}", safe="")
    params = urlencode(
        {"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS, "period": PERIOD_SECONDS}
    )
    return f"otpauth://totp/{label}?{params}"
