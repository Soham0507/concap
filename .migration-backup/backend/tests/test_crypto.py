"""Tests for the at-rest token encryption used for HubSpot OAuth tokens."""
from __future__ import annotations

import pytest

from app.services.crypto import DecryptError, decrypt, encrypt


def test_encrypt_decrypt_round_trip():
    plaintext = "super-secret-hubspot-access-token"
    ciphertext = encrypt(plaintext)

    # Ciphertext must not expose the plaintext and must differ from it.
    assert ciphertext != plaintext
    assert plaintext not in ciphertext
    assert decrypt(ciphertext) == plaintext


def test_encrypt_is_non_deterministic():
    # Fernet embeds a random IV, so encrypting the same value twice yields
    # different ciphertext while still decrypting back to the original.
    a = encrypt("same-value")
    b = encrypt("same-value")
    assert a != b
    assert decrypt(a) == decrypt(b) == "same-value"


def test_decrypt_corrupted_ciphertext_raises():
    ciphertext = encrypt("token")
    # Flip a chunk in the middle to corrupt the HMAC/payload.
    corrupted = ciphertext[:-6] + ("A" if ciphertext[-1] != "A" else "B") * 6
    with pytest.raises(DecryptError):
        decrypt(corrupted)


def test_decrypt_garbage_raises():
    with pytest.raises(DecryptError):
        decrypt("not-a-valid-fernet-token")
