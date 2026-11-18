"""The acceptance of healthhub: the whole system started with ./run.sh, used through the gateway.

The tests that stop services run last (test_z*) and start what they stopped again.
"""
import json
import os
import random
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

SERVICES = ["gateway", "identity", "records", "ingest", "analytics", "notify"]


def free_base():
    for _ in range(200):
        base = random.randint(20000, 40000)
        try:
            for offset in range(len(SERVICES)):
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", base + offset))
            return base
        except OSError:
            continue
    raise RuntimeError("no free ports")


BASE = free_base()
ENV = dict(os.environ, HH_PORT_BASE=str(BASE), HH_DATA=tempfile.mkdtemp(prefix="hh-data-"))


def run(*args, timeout=90):
    return subprocess.run(["bash", "./run.sh", *args], env=ENV, capture_output=True, text=True, timeout=timeout)


def api(method, path, body=None, token=None, headers=None, port=BASE):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, (json.loads(raw) if raw else None)
        except ValueError:
            return error.code, None


def eventually(check, seconds=5.0):
    """The last value of check() once it is truthy, within `seconds` (plus a little slack)."""
    deadline = time.time() + seconds + 1.0
    while True:
        value = check()
        if value or time.time() > deadline:
            return value
        time.sleep(0.2)


_users = iter(range(1, 10_000))


def user():
    name = f"user{next(_users)}-{random.randint(0, 10**6)}"
    status, _ = api("POST", "/api/register", {"username": name, "password": "password-1"})
    assert status == 201, status
    status, body = api("POST", "/api/login", {"username": name, "password": "password-1"})
    assert status == 200, status
    return body["token"]


class HealthhubAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        started = run("start")
        if started.returncode != 0:
            raise RuntimeError(f"./run.sh start failed: {started.stdout}{started.stderr}")

    @classmethod
    def tearDownClass(cls):
        run("stop")

    def test_a_every_service_is_healthy(self):
        for offset, name in enumerate(SERVICES):
            status, body = api("GET", "/health", port=BASE + offset)
            self.assertEqual((status, body), (200, {"service": name, "status": "ok"}))

    def test_b_accounts(self):
        name = f"Alice{random.randint(0, 10**6)}"
        self.assertEqual(api("POST", "/api/register", {"username": name, "password": "short"})[0], 400)
        status, body = api("POST", "/api/register", {"username": name, "password": "password-a"})
        self.assertEqual(status, 201)
        self.assertIn("user_id", body)
        self.assertEqual(api("POST", "/api/register", {"username": name.lower(), "password": "password-b"})[0], 409)
        self.assertEqual(api("POST", "/api/login", {"username": name, "password": "wrong-password"})[0], 401)
        status, body = api("POST", "/api/login", {"username": name.upper(), "password": "password-a"})
        self.assertEqual(status, 200)
        token = body["token"]
        status, me = api("GET", "/api/me", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(me["username"], name.lower())
        self.assertEqual(api("GET", "/api/me")[0], 401)
        self.assertEqual(api("GET", "/api/vitals", token="not-a-token")[0], 401)
        self.assertEqual(api("POST", "/api/logout", token=token)[0], 204)
        self.assertEqual(api("GET", "/api/me", token=token)[0], 401)

    def test_c_vitals(self):
        token = user()
        for bad in (
            {"type": "mood", "value": 1, "at": "2026-05-01T08:00:00Z"},
            {"type": "weight", "value": "70", "at": "2026-05-01T08:00:00Z"},
            {"type": "weight", "value": 70, "at": "2026-05-01 08:00:00"},
            {"type": "weight", "value": 70, "at": "2026-02-30T08:00:00Z"},
        ):
            self.assertEqual(api("POST", "/api/vitals", bad, token)[0], 400, bad)
        ids = []
        for kind, value, at in (
            ("weight", 70.5, "2026-05-02T08:00:00Z"),
            ("heart_rate", 61, "2026-05-01T07:00:00Z"),
            ("weight", 70.1, "2026-05-01T08:00:00Z"),
        ):
            status, body = api("POST", "/api/vitals", {"type": kind, "value": value, "at": at}, token)
            self.assertEqual(status, 201)
            ids.append(body["id"])
        status, body = api("GET", "/api/vitals", token=token)
        self.assertEqual(status, 200)
        self.assertEqual([item["at"] for item in body["items"]], ["2026-05-01T07:00:00Z", "2026-05-01T08:00:00Z", "2026-05-02T08:00:00Z"])
        self.assertEqual({item["source"] for item in body["items"]}, {"manual"})
        weights = api("GET", "/api/vitals?type=weight&from=2026-05-01T08:00:00Z&to=2026-05-01T08:00:00Z", token=token)[1]
        self.assertEqual([(item["type"], item["value"]) for item in weights["items"]], [("weight", 70.1)])
        self.assertEqual(api("DELETE", f"/api/vitals/{ids[0]}", token=token)[0], 204)
        self.assertEqual(len(api("GET", "/api/vitals", token=token)[1]["items"]), 2)
        self.assertEqual(api("DELETE", f"/api/vitals/{ids[0]}", token=token)[0], 404)

    def test_d_users_are_isolated(self):
        mine, theirs = user(), user()
        _, body = api("POST", "/api/vitals", {"type": "steps", "value": 1000, "at": "2026-05-03T10:00:00Z"}, mine)
        self.assertEqual(api("GET", "/api/vitals", token=theirs)[1]["items"], [])
        self.assertEqual(api("DELETE", f"/api/vitals/{body['id']}", token=theirs)[0], 404)
        api("POST", "/api/medications", {"name": "A", "dose": "1", "times": ["09:00"]}, mine)
        self.assertEqual(api("GET", "/api/medications", token=theirs)[1]["items"], [])
        self.assertEqual(len(api("GET", "/api/vitals", token=mine)[1]["items"]), 1)

    def test_e_medications_and_reminders(self):
        token = user()
        self.assertEqual(api("POST", "/api/medications", {"name": "X", "dose": "1", "times": ["25:00"]}, token)[0], 400)
        self.assertEqual(api("POST", "/api/medications", {"name": "X", "dose": "1", "times": []}, token)[0], 400)
        first = api("POST", "/api/medications", {"name": "Metformin", "dose": "500 mg", "times": ["20:00", "08:00"]}, token)[1]["id"]
        second = api("POST", "/api/medications", {"name": "Aspirin", "dose": "81 mg", "times": ["08:00"]}, token)[1]["id"]
        items = api("GET", "/api/medications", token=token)[1]["items"]
        self.assertEqual([item["id"] for item in items], [first, second])
        self.assertEqual(items[0]["times"], ["20:00", "08:00"])
        status, body = api("GET", "/api/reminders?date=2026-05-04", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(body["date"], "2026-05-04")
        self.assertEqual(
            [(item["time"], item["medication_id"], item["name"], item["dose"]) for item in body["items"]],
            [("08:00", first, "Metformin", "500 mg"), ("08:00", second, "Aspirin", "81 mg"), ("20:00", first, "Metformin", "500 mg")],
        )

    def test_f_device_batches(self):
        token = user()
        status, device = api("POST", "/api/devices", {"name": "watch"}, token)
        self.assertEqual(status, 201)
        key = {"X-Device-Key": device["device_key"]}
        readings = [
            {"type": "heart_rate", "value": 72, "at": "2026-05-05T06:00:00Z"},
            {"type": "steps", "value": 4200, "at": "2026-05-05T07:00:00Z"},
        ]
        self.assertEqual(api("POST", "/ingest/batch", {"batch_id": "b1", "readings": readings}, headers={"X-Device-Key": "nope"})[0], 401)
        bad = readings + [{"type": "heart_rate", "value": 70, "at": "yesterday"}]
        self.assertEqual(api("POST", "/ingest/batch", {"batch_id": "b0", "readings": bad}, headers=key)[0], 400)
        self.assertEqual(api("POST", "/ingest/batch", {"batch_id": "b1", "readings": readings}, headers=key), (202, {"accepted": 2, "duplicate": False}))
        self.assertEqual(api("POST", "/ingest/batch", {"batch_id": "b1", "readings": readings}, headers=key), (200, {"accepted": 0, "duplicate": True}))
        items = eventually(lambda: (lambda got: got if len(got) == 2 else None)(api("GET", "/api/vitals", token=token)[1]["items"]))
        self.assertIsNotNone(items)
        self.assertEqual([(i["type"], i["value"], i["source"]) for i in items], [("heart_rate", 72, "device"), ("steps", 4200, "device")])

    def test_g_daily_summary(self):
        token = user()
        for value, at in ((70, "2026-05-06T06:00:00Z"), (71, "2026-05-06T12:00:00Z"), (75, "2026-05-07T00:00:00Z")):
            api("POST", "/api/vitals", {"type": "heart_rate", "value": value, "at": at}, token)
        dropped = api("POST", "/api/vitals", {"type": "heart_rate", "value": 200, "at": "2026-05-06T13:00:00Z"}, token)[1]["id"]
        _, device = api("POST", "/api/devices", {"name": "scale"}, token)
        api("POST", "/ingest/batch", {"batch_id": "s1", "readings": [{"type": "weight", "value": 80.333, "at": "2026-05-06T07:00:00Z"}]},
            headers={"X-Device-Key": device["device_key"]})
        api("DELETE", f"/api/vitals/{dropped}", token=token)
        want = {"heart_rate": {"count": 2, "min": 70, "max": 71, "avg": 70.5}, "weight": {"count": 1, "min": 80.333, "max": 80.333, "avg": 80.33}}
        body = eventually(lambda: (lambda got: got if got[0] == 200 and got[1]["metrics"] == want else None)(
            api("GET", "/api/summary/daily?date=2026-05-06", token=token)))
        self.assertIsNotNone(body, api("GET", "/api/summary/daily?date=2026-05-06", token=token))
        self.assertEqual(body[1]["date"], "2026-05-06")

    def test_h_trends(self):
        token = user()
        for value, at in ((80, "2026-04-28T08:00:00Z"), (79, "2026-05-01T08:00:00Z"), (78, "2026-05-01T20:00:00Z"), (77, "2026-05-02T08:00:00Z"), (60, "2026-05-03T08:00:00Z")):
            api("POST", "/api/vitals", {"type": "weight", "value": value, "at": at}, token)
        want = [{"date": "2026-05-01", "avg": 78.5}, {"date": "2026-05-02", "avg": 77}]
        got = eventually(lambda: (lambda r: r if r[0] == 200 and r[1]["points"] == want else None)(
            api("GET", "/api/trends?type=weight&days=3&end=2026-05-02", token=token)))
        self.assertIsNotNone(got, api("GET", "/api/trends?type=weight&days=3&end=2026-05-02", token=token))
        self.assertEqual(got[1]["type"], "weight")

    def test_i_thresholds_and_alerts(self):
        token = user()
        api("POST", "/api/vitals", {"type": "systolic", "value": 190, "at": "2026-05-08T08:00:00Z"}, token)
        status, body = api("PUT", "/api/thresholds", {"type": "systolic", "max": 140}, token)
        self.assertEqual((status, body), (200, {"type": "systolic", "min": None, "max": 140}))
        api("PUT", "/api/thresholds", {"type": "glucose", "min": 4, "max": 10}, token)
        time.sleep(1.5)  # the reading before the threshold must not count, even if it arrives late
        api("POST", "/api/vitals", {"type": "systolic", "value": 150, "at": "2026-05-08T09:00:00Z"}, token)
        api("POST", "/api/vitals", {"type": "systolic", "value": 120, "at": "2026-05-08T10:00:00Z"}, token)
        _, device = api("POST", "/api/devices", {"name": "meter"}, token)
        api("POST", "/ingest/batch", {"batch_id": "g1", "readings": [{"type": "glucose", "value": 3.2, "at": "2026-05-08T11:00:00Z"}]},
            headers={"X-Device-Key": device["device_key"]})
        items = eventually(lambda: (lambda got: got if len(got) >= 2 else None)(api("GET", "/api/alerts", token=token)[1]["items"]))
        self.assertIsNotNone(items)
        time.sleep(1)
        items = api("GET", "/api/alerts", token=token)[1]["items"]
        self.assertEqual([(i["type"], i["value"], i["kind"]) for i in items], [("systolic", 150, "high"), ("glucose", 3.2, "low")])

    def test_z1_everything_survives_a_restart(self):
        token = user()
        api("POST", "/api/vitals", {"type": "steps", "value": 9000, "at": "2026-05-09T21:00:00Z"}, token)
        api("POST", "/api/medications", {"name": "D", "dose": "1", "times": ["07:30"]}, token)
        api("PUT", "/api/thresholds", {"type": "steps", "min": 10000}, token)
        time.sleep(1.2)
        api("POST", "/api/vitals", {"type": "steps", "value": 500, "at": "2026-05-10T21:00:00Z"}, token)
        self.assertTrue(eventually(lambda: len(api("GET", "/api/alerts", token=token)[1]["items"]) == 1))
        self.assertEqual(run("stop").returncode, 0)
        self.assertEqual(run("start").returncode, 0)
        self.assertEqual(api("GET", "/api/me", token=token)[0], 200)
        self.assertEqual([i["value"] for i in api("GET", "/api/vitals", token=token)[1]["items"]], [9000, 500])
        self.assertEqual(len(api("GET", "/api/medications", token=token)[1]["items"]), 1)
        self.assertEqual(len(api("GET", "/api/alerts", token=token)[1]["items"]), 1)
        summary = eventually(lambda: (lambda r: r if r[0] == 200 and r[1]["metrics"] else None)(api("GET", "/api/summary/daily?date=2026-05-09", token=token)))
        self.assertIsNotNone(summary)

    def test_z2_analytics_down(self):
        token = user()
        kept = api("POST", "/api/vitals", {"type": "glucose", "value": 5, "at": "2026-05-11T08:00:00Z"}, token)[1]["id"]
        self.assertTrue(eventually(lambda: api("GET", "/api/summary/daily?date=2026-05-11", token=token)[1].get("metrics")))
        self.assertEqual(run("stop", "analytics").returncode, 0)
        try:
            self.assertEqual(api("POST", "/api/vitals", {"type": "glucose", "value": 7, "at": "2026-05-11T09:00:00Z"}, token)[0], 201)
            self.assertEqual(api("DELETE", f"/api/vitals/{kept}", token=token)[0], 204)
            self.assertEqual(len(api("GET", "/api/vitals", token=token)[1]["items"]), 1)
            self.assertEqual(api("GET", "/api/summary/daily?date=2026-05-11", token=token)[0], 503)
            self.assertEqual(api("GET", "/api/trends?type=glucose&days=1&end=2026-05-11", token=token)[0], 503)
        finally:
            self.assertEqual(run("start", "analytics").returncode, 0)
        want = {"glucose": {"count": 1, "min": 7, "max": 7, "avg": 7}}
        got = eventually(lambda: (lambda r: r if r[0] == 200 and r[1]["metrics"] == want else None)(
            api("GET", "/api/summary/daily?date=2026-05-11", token=token)), seconds=10)
        self.assertIsNotNone(got, api("GET", "/api/summary/daily?date=2026-05-11", token=token))

    def test_z3_notify_down(self):
        token = user()
        api("PUT", "/api/thresholds", {"type": "heart_rate", "max": 100}, token)
        time.sleep(1.2)
        self.assertEqual(run("stop", "notify").returncode, 0)
        try:
            self.assertEqual(api("POST", "/api/vitals", {"type": "heart_rate", "value": 130, "at": "2026-05-12T08:00:00Z"}, token)[0], 201)
            self.assertEqual(api("GET", "/api/alerts", token=token)[0], 503)
            self.assertEqual(api("GET", "/api/reminders?date=2026-05-12", token=token)[0], 503)
        finally:
            self.assertEqual(run("start", "notify").returncode, 0)
        items = eventually(lambda: (lambda r: r[1]["items"] if r[0] == 200 and r[1]["items"] else None)(api("GET", "/api/alerts", token=token)), seconds=10)
        self.assertIsNotNone(items)
        self.assertEqual([(i["value"], i["kind"]) for i in items], [(130, "high")])


if __name__ == "__main__":
    unittest.main()
