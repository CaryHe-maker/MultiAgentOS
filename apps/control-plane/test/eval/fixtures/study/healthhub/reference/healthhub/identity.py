"""Accounts and tokens."""
import hashlib
import secrets

from .common import HttpError, database, serve

conn, lock = database("identity")
conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT)")
conn.execute("CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id INTEGER)")


def digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 50_000).hex()


def register(request):
    name = str(request.body.get("username", "")).strip().lower()
    password = request.body.get("password")
    if not name or not isinstance(password, str) or len(password) < 8:
        raise HttpError(400, "a user name and a password of at least 8 characters")
    salt = secrets.token_hex(8)
    with lock:
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone():
            raise HttpError(409, "the user name is taken")
        cursor = conn.execute("INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)", (name, salt, digest(password, salt)))
    return 201, {"user_id": cursor.lastrowid}


def login(request):
    name = str(request.body.get("username", "")).strip().lower()
    row = conn.execute("SELECT id, salt, hash FROM users WHERE username = ?", (name,)).fetchone()
    if row is None or digest(str(request.body.get("password", "")), row[1]) != row[2]:
        raise HttpError(401, "wrong user name or password")
    token = secrets.token_hex(24)
    with lock:
        conn.execute("INSERT INTO tokens VALUES (?, ?)", (token, row[0]))
    return 200, {"token": token}


def logout(request):
    with lock:
        conn.execute("DELETE FROM tokens WHERE token = ?", (request.body.get("token", ""),))
    return 204, None


def verify(request):
    row = conn.execute(
        "SELECT users.id, users.username FROM tokens JOIN users ON users.id = tokens.user_id WHERE token = ?",
        (request.arg("token"),),
    ).fetchone()
    if row is None:
        raise HttpError(401, "invalid token")
    return 200, {"user_id": row[0], "username": row[1]}


if __name__ == "__main__":
    serve(
        "identity",
        [
            ("POST", "/register", register),
            ("POST", "/login", login),
            ("POST", "/logout", logout),
            ("GET", "/verify", verify),
        ],
    )
