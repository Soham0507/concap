"""Symmetric encryption for secrets stored at rest (HubSpot OAuth tokens).

Uses Fernet (AES-128-CBC + HMAC) from `cryptography`. The key is derived
from SECRET_ENCRYPTION_KEY when set, otherwise from the auth secret, so a
fresh deploy without extra config still encrypts tokens. Rotating either
value invalidates existing ciphertext — callers must handle DecryptError
by forcing a reconnect rather than crashing.
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from ..config import get_settings


class DecryptError(Exception):
    """Raised when stored ciphertext can't be decrypted (key rotated or
    corrupt data). Callers should treat the secret as lost."""


@lru_cache(maxsize=8)
def _fernet_for(key_material: str) -> Fernet:
    # Fernet wants a 32-byte urlsafe-base64 key; derive one deterministically
    # from arbitrary-length key material via SHA-256.
    digest = hashlib.sha256(key_material.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _fernet() -> Fernet:
    s = get_settings()
    material = s.secret_encryption_key or s.resolved_auth_secret()
    return _fernet_for(material)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise DecryptError("Could not decrypt stored secret") from exc
