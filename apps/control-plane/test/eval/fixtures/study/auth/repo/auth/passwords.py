"""Password hashes, stored as "sha256$<salt>$<hex digest>"."""
import hashlib
import hmac

SALT = "mbr-2019"
ROUNDS = 120_000


def _digest(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), ROUNDS).hex()


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("a password has at least 8 characters")
    return f"sha256${SALT}${_digest(password, SALT)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt, digest = stored.split("$")
    except ValueError:
        return False
    if scheme != "sha256":
        return False
    return hmac.compare_digest(_digest(password, salt), digest)
