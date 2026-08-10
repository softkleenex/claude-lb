from __future__ import annotations

import pytest

from app.core.crypto import (
    decrypt,
    encrypt,
    generate_local_api_key,
    hash_local_api_key,
    mask_secret,
    verify_local_api_key,
)

# Shape of a real Anthropic key: long, with a recognisable non-secret prefix.
REAL_KEY = "sk-ant-api03-" + "x9Zq" * 24 + "AbCdEf"


class TestEncryption:
    def test_round_trips(self):
        assert decrypt(encrypt(REAL_KEY)) == REAL_KEY

    def test_ciphertext_does_not_contain_the_plaintext(self):
        assert REAL_KEY not in encrypt(REAL_KEY)

    def test_same_plaintext_encrypts_differently_each_time(self):
        # Fernet includes a random IV; identical keys must not produce identical rows.
        assert encrypt(REAL_KEY) != encrypt(REAL_KEY)

    def test_unicode_survives(self):
        assert decrypt(encrypt("ключ-🔑-키")) == "ключ-🔑-키"


class TestMasking:
    def test_keeps_a_recognisable_prefix_and_suffix_for_a_real_key(self):
        hint = mask_secret(REAL_KEY)
        assert hint.startswith("sk-ant-api")
        assert hint.endswith("AbCdEf")
        assert "…" in hint

    @pytest.mark.parametrize(
        "value",
        ["", "a", "abcd", "sk-ant-GOOD", "short-key", "sk-ant-" + "y" * 20, REAL_KEY],
        ids=["empty", "1", "4", "11", "9", "27", "real"],
    )
    def test_never_reveals_more_than_half_the_secret(self, value):
        revealed = mask_secret(value).replace("…", "")
        assert len(revealed) <= len(value) / 2 + 0.5, f"{value!r} → {mask_secret(value)!r}"

    def test_a_short_credential_is_not_reconstructable(self):
        assert mask_secret("sk-ant-GOOD") != "sk-ant-GOOD"
        assert "sk-ant-GOOD" not in mask_secret("sk-ant-GOOD")

    def test_empty_input_is_handled(self):
        assert mask_secret("") == ""


class TestLocalApiKeys:
    def test_generated_keys_are_prefixed_and_unique(self):
        keys = {generate_local_api_key() for _ in range(50)}
        assert len(keys) == 50
        assert all(k.startswith("clb_") for k in keys)

    def test_verification_accepts_the_right_key(self):
        key = generate_local_api_key()
        assert verify_local_api_key(key, hash_local_api_key(key))

    def test_verification_rejects_a_different_key(self):
        assert not verify_local_api_key(
            generate_local_api_key(), hash_local_api_key(generate_local_api_key())
        )

    def test_hash_is_not_the_key(self):
        key = generate_local_api_key()
        assert key not in hash_local_api_key(key)
