import os
import tempfile
import unittest

from auth.login import Limiter, Locked, login
from auth.passwords import hash_password, verify_password
from auth.sessions import SessionStore
from auth.tokens import InvalidToken, make_token, verify
from auth.uploads import avatar_path, save_avatar
from auth.users import Users


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


class PasswordTest(unittest.TestCase):
    def test_round_trip(self):
        stored = hash_password("correct horse")
        self.assertTrue(verify_password("correct horse", stored))
        self.assertFalse(verify_password("wrong horse!", stored))

    def test_too_short(self):
        with self.assertRaises(ValueError):
            hash_password("short")

    def test_garbage_hash(self):
        self.assertFalse(verify_password("anything1", "not-a-hash"))


class LoginTest(unittest.TestCase):
    def setUp(self):
        self.users = Users(os.path.join(tempfile.mkdtemp(), "users.json"))
        self.users.add("Alice", "password-a")
        self.clock = Clock()
        self.limiter = Limiter(max_failures=3, window=60, clock=self.clock)

    def test_success_any_case(self):
        self.assertTrue(login(self.users, self.limiter, "alice", "password-a"))
        self.assertTrue(login(self.users, self.limiter, "ALICE", "password-a"))

    def test_locks_after_failures(self):
        for _ in range(3):
            self.assertFalse(login(self.users, self.limiter, "alice", "nope-nope"))
        with self.assertRaises(Locked):
            login(self.users, self.limiter, "alice", "password-a")
        self.clock.now += 61
        self.assertTrue(login(self.users, self.limiter, "alice", "password-a"))


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "sessions.json")
        self.clock = Clock()

    def test_create_get_expire(self):
        store = SessionStore(self.path, lifetime=100, clock=self.clock)
        sid = store.create("alice")
        self.assertEqual(store.get(sid), "alice")
        self.clock.now += 100
        self.assertIsNone(store.get(sid))

    def test_revoke(self):
        store = SessionStore(self.path, clock=self.clock)
        sid = store.create("alice")
        store.revoke(sid)
        self.assertIsNone(store.get(sid))

    def test_revoke_all_survives_reopen(self):
        store = SessionStore(self.path, clock=self.clock)
        store.create("alice")
        store.create("alice")
        kept = store.create("bob")
        store.revoke_all("alice")
        again = SessionStore(self.path, clock=self.clock)
        self.assertEqual(again.get(kept), "bob")
        self.assertEqual(len(again._sessions), 1)


class TokenTest(unittest.TestCase):
    def test_round_trip_and_expiry(self):
        token = make_token("alice", "s3cret", ttl=60, now=1000)
        self.assertEqual(verify(token, "s3cret", now=1059), "alice")
        with self.assertRaises(InvalidToken):
            verify(token, "s3cret", now=1060)

    def test_tampered(self):
        token = make_token("alice", "s3cret", now=1000)
        with self.assertRaises(InvalidToken):
            verify(token, "other", now=1001)
        with self.assertRaises(InvalidToken):
            verify("garbage", "s3cret")

    def test_ttl_capped(self):
        token = make_token("alice", "s3cret", ttl=10**9, now=0)
        with self.assertRaises(InvalidToken):
            verify(token, "s3cret", now=24 * 3600)


class UploadTest(unittest.TestCase):
    def test_path_and_save(self):
        root = tempfile.mkdtemp()
        self.assertEqual(avatar_path(root, "alice", "me.png"), os.path.join(root, "alice", "me.png"))
        saved = save_avatar(root, "alice", "me.png", b"\x89PNG")
        with open(saved, "rb") as handle:
            self.assertEqual(handle.read(), b"\x89PNG")

    def test_not_an_image(self):
        with self.assertRaises(ValueError):
            avatar_path(tempfile.mkdtemp(), "alice", "run.sh")


if __name__ == "__main__":
    unittest.main()
