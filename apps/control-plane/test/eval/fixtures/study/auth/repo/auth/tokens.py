"""Signed access tokens: base64url(JSON payload) + "." + hex HMAC-SHA256 of that part."""
import base64
import hashlib
import hmac
import json
import time

MAX_TTL = 24 * 3600


class InvalidToken(Exception):
    pass


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(payload: dict, secret: str) -> str:
    body = _b64(json.dumps(payload, sort_keys=True).encode())
    mac = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def make_token(user: str, secret: str, ttl: float = 3600, now: float = None) -> str:
    now = time.time() if now is None else now
    payload = {"u": user}
    if ttl:
        payload["exp"] = now + min(ttl, MAX_TTL)
    return sign(payload, secret)


def verify(token: str, secret: str, now: float = None) -> str:
    """The user the token was made for. Raises InvalidToken."""
    now = time.time() if now is None else now
    try:
        body, mac = token.split(".")
    except ValueError:
        raise InvalidToken("malformed") from None
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if mac != expected:
        raise InvalidToken("bad signature")
    payload = json.loads(_unb64(body))
    if "exp" in payload and payload["exp"] <= now:
        raise InvalidToken("expired")
    return payload["u"]
