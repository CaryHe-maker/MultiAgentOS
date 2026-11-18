"""One test per planted problem; the judge reports which of them pass."""
import os
import tempfile
import unittest

from auth import tokens
from auth.login import Limiter, Locked, login
from auth.passwords import hash_password, verify_password
from auth.sessions import SessionStore
from auth.uploads import avatar_path
from auth.users import Users


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


class HiddenAuthTest(unittest.TestCase):
    def test_p1_salt_per_hash(self):
        first = hash_password("same password")
        second = hash_password("same password")
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("same password", first))
        self.assertTrue(verify_password("same password", second))
        # A hash written before the fix still verifies.
        old = "sha256$mbr-2019$" + __import__("hashlib").pbkdf2_hmac(
            "sha256", b"legacy pass", b"mbr-2019", 120_000
        ).hex()
        self.assertTrue(verify_password("legacy pass", old))

    def test_l1_limit_ignores_case(self):
        users = Users(os.path.join(tempfile.mkdtemp(), "users.json"))
        users.add("alice", "password-a")
        limiter = Limiter(max_failures=3, window=60, clock=Clock())
        for name in ("alice", "Alice", "ALICE"):
            self.assertFalse(login(users, limiter, name, "wrong-wrong"))
        with self.assertRaises(Locked):
            login(users, limiter, "aLiCe", "password-a")

    def test_s1_session_id_unguessable(self):
        store = SessionStore(os.path.join(tempfile.mkdtemp(), "s.json"), clock=Clock())
        ids = {store.create("alice") for _ in range(20)}
        self.assertEqual(len(ids), 20)
        for sid in ids:
            self.assertGreaterEqual(len(sid), 32)

    def test_s2_revoke_survives_reopen(self):
        path = os.path.join(tempfile.mkdtemp(), "s.json")
        clock = Clock()
        store = SessionStore(path, clock=clock)
        sid = store.create("alice")
        store.revoke(sid)
        self.assertIsNone(SessionStore(path, clock=clock).get(sid))

    def test_t1_every_token_expires(self):
        for ttl in (0, None):
            try:
                token = tokens.make_token("alice", "s3cret", ttl=ttl, now=0)
            except (ValueError, TypeError):
                continue
            with self.assertRaises(tokens.InvalidToken):
                tokens.verify(token, "s3cret", now=tokens.MAX_TTL + 1)
        unexpiring = tokens.sign({"u": "alice"}, "s3cret")
        with self.assertRaises(tokens.InvalidToken):
            tokens.verify(unexpiring, "s3cret", now=0)

    def test_f1_upload_stays_inside(self):
        root = tempfile.mkdtemp()
        for user, name in (
            ("alice", "../../etc/x.png"),
            ("alice", "/tmp/x.png"),
            ("..", "x.png"),
            ("alice/../../bob", "x.png"),
        ):
            with self.assertRaises(ValueError, msg=f"{user} {name}"):
                avatar_path(root, user, name)
        inside = avatar_path(root, "alice", "me.png")
        self.assertTrue(os.path.realpath(inside).startswith(os.path.realpath(root) + os.sep))


if __name__ == "__main__":
    unittest.main()
