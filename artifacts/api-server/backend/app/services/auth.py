"""Authentication primitives — stdlib only, no native dependencies.

Password hashing: PBKDF2-HMAC-SHA256 (hashlib). Stored as
    pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>

Tokens: a hand-rolled JWT (HS256). This is wire-compatible with the JWT
spec but implemented with hmac/hashlib/base64 so we don't pull in PyJWT
(and its build chain) on a Python 3.14 box.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

from ..config import get_settings

_PBKDF2_ITERATIONS = 200_000
_ALG = "HS256"


# -- Password hashing -------------------------------------------------------

def hash_password(password: str) -> str:
    if not password or len(password) < 8:
        raise ValueError("Password must be at least 8 characters")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iterations_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(dk, expected)


# -- JWT (HS256) ------------------------------------------------------------

def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(message: bytes) -> str:
    secret = get_settings().resolved_auth_secret().encode("utf-8")
    sig = hmac.new(secret, message, hashlib.sha256).digest()
    return _b64url_encode(sig)


class TokenError(Exception):
    pass


def create_token(user_id: int, email: str, *, preview: bool = False) -> str:
    now = int(time.time())
    ttl = get_settings().auth_token_ttl_hours * 3600
    header = {"alg": _ALG, "typ": "JWT"}
    payload = {"sub": str(user_id), "email": email, "iat": now, "exp": now + ttl}
    if preview:
        payload["preview"] = True

    header_b64 = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = _sign(signing_input)
    return f"{header_b64}.{payload_b64}.{signature}"


def decode_token(token: str) -> dict:
    """Verify signature + expiry. Raises TokenError on any problem."""
    try:
        header_b64, payload_b64, signature = token.split(".")
    except ValueError:
        raise TokenError("Malformed token")

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected_sig = _sign(signing_input)
    if not hmac.compare_digest(expected_sig, signature):
        raise TokenError("Bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError):
        raise TokenError("Bad payload")

    if int(payload.get("exp", 0)) < int(time.time()):
        raise TokenError("Token expired")

    return payload
