"""Hidden tests of the coursereg task; PROJECT is the agent's project directory."""

import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

PROJECT = os.environ.get("PROJECT", os.getcwd())


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, data):
        self.data = data
        self.port = free_port()
        self.proc = subprocess.Popen([sys.executable, "-m", "coursereg", "--port", str(self.port), "--data", data],
                                     cwd=PROJECT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        ready = threading.Event()

        def watch():
            for line in self.proc.stdout:
                if line.strip() == "ready":
                    ready.set()
                    break

        threading.Thread(target=watch, daemon=True).start()
        if not ready.wait(20):
            self.stop()
            raise AssertionError("server did not print ready")

    def req(self, method, path, body=None, token=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = raw if raw is not None else (json.dumps(body) if body is not None else None)
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        text = r.read().decode()
        conn.close()
        try:
            payload = json.loads(text) if text else None
        except ValueError:
            payload = text
        return r.status, payload

    def stop(self, kill=False):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGKILL if kill else signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "data")
        self.srv = Server(self.data)
        self.admin = self.login("admin", "admin")

    def tearDown(self):
        self.srv.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def restart(self, kill=False):
        self.srv.stop(kill=kill)
        self.srv = Server(self.data)

    def r(self, method, path, body=None, token=None):
        return self.srv.req(method, path, body, token)

    def ok(self, status, method, path, body=None, token=None):
        st, p = self.r(method, path, body, token)
        self.assertEqual(st, status, p)
        return p

    def error(self, status, code, method, path, body=None, token=None):
        st, p = self.r(method, path, body, token)
        self.assertEqual((st, p), (status, {"error": code}))

    def login(self, user, pw):
        return self.ok(200, "POST", "/login", {"username": user, "password": pw})["token"]

    def user(self, username, role="student", name=None):
        u = self.ok(201, "POST", "/users", {"username": username, "password": "pw-" + username, "role": role,
                                            "name": name or username.title()}, self.admin)
        return u["id"], self.login(username, "pw-" + username)

    def semester(self, code, state="planning"):
        self.ok(201, "POST", "/semesters", {"code": code}, self.admin)
        for s in ["open", "closed", "graded"][: ["planning", "open", "closed", "graded"].index(state)]:
            self.ok(200, "POST", f"/semesters/{code}/state", {"state": s}, self.admin)

    def state(self, code, state):
        self.ok(200, "POST", f"/semesters/{code}/state", {"state": state}, self.admin)

    def course(self, sem, code, teacher, credits=3, capacity=30, slots=None, prereqs=None, title=None):
        return self.ok(201, "POST", "/courses", {
            "semester": sem, "code": code, "title": title or f"Course {code}", "credits": credits,
            "capacity": capacity, "teacher": teacher,
            "slots": slots if slots is not None else [{"day": 1, "start": "08:00", "end": "09:40"}],
            "prereqs": prereqs or []}, self.admin)

    def enroll(self, token, sem, code):
        return self.r("POST", "/enrollments", {"semester": sem, "code": code}, token)

    def slot(self, day, start, end):
        return [{"day": day, "start": start, "end": end}]


class Auth(Base):
    def test_login_and_bad_credentials(self):
        st, p = self.r("POST", "/login", {"username": "admin", "password": "admin"})
        self.assertEqual(st, 200)
        self.assertEqual((p["role"], p["id"]), ("admin", 1))
        self.assertIsInstance(p["token"], str)
        self.error(401, "bad_credentials", "POST", "/login", {"username": "admin", "password": "x"})
        self.error(401, "bad_credentials", "POST", "/login", {"username": "nobody", "password": "admin"})

    def test_missing_or_bad_token(self):
        self.error(401, "unauthorized", "GET", "/semesters")
        self.error(401, "unauthorized", "GET", "/semesters", token="not-a-token")

    def test_unauthorized_before_not_found(self):
        self.error(401, "unauthorized", "GET", "/no/such/path")

    def test_tokens_survive_restart(self):
        sid, st = self.user("stud01")
        self.restart()
        self.assertEqual(self.ok(200, "GET", f"/users/{sid}", token=st)["username"], "stud01")
        self.ok(200, "GET", "/semesters", token=self.admin)

    def test_only_admin_creates_users(self):
        _, st = self.user("stud01")
        _, tt = self.user("teach01", "teacher")
        for tok in (st, tt):
            self.error(403, "forbidden", "POST", "/users",
                       {"username": "x123", "password": "p", "role": "student", "name": "X"}, tok)


class Users(Base):
    def test_ids_in_creation_order(self):
        a = self.ok(201, "POST", "/users", {"username": "ann", "password": "p", "role": "teacher", "name": "Ann"},
                    self.admin)
        b = self.ok(201, "POST", "/users", {"username": "bob_2", "password": "p", "role": "student", "name": "Bob"},
                    self.admin)
        self.assertEqual(a, {"id": 2, "username": "ann", "role": "teacher", "name": "Ann"})
        self.assertEqual(b["id"], 3)

    def test_validation(self):
        bad = [{"username": "Ab", "password": "p", "role": "student", "name": "x"},
               {"username": "has space", "password": "p", "role": "student", "name": "x"},
               {"username": "a" * 21, "password": "p", "role": "student", "name": "x"},
               {"username": "okname", "password": "p", "role": "dean", "name": "x"},
               {"username": "okname", "password": "", "role": "student", "name": "x"},
               {"username": "okname", "password": "p", "role": "student"}]
        for body in bad:
            self.error(400, "invalid", "POST", "/users", body, self.admin)

    def test_duplicate_username(self):
        self.user("dup")
        self.error(409, "conflict", "POST", "/users", {"username": "dup", "password": "p", "role": "teacher",
                                                       "name": "D"}, self.admin)

    def test_get_user_permissions(self):
        a, at = self.user("stud01")
        b, _ = self.user("stud02")
        self.assertEqual(self.ok(200, "GET", f"/users/{a}", token=at)["username"], "stud01")
        self.error(403, "forbidden", "GET", f"/users/{b}", token=at)
        self.assertEqual(self.ok(200, "GET", f"/users/{b}", token=self.admin)["role"], "student")
        self.error(404, "not_found", "GET", "/users/999", token=self.admin)
        self.error(404, "not_found", "GET", "/users/999", token=at)

    def test_body_not_json(self):
        st, p = self.srv.req("POST", "/users", token=self.admin, raw="{not json")
        self.assertEqual((st, p), (400, {"error": "invalid"}))
        st, p = self.srv.req("POST", "/users", token=self.admin, raw="[1, 2]")
        self.assertEqual((st, p), (400, {"error": "invalid"}))


class Semesters(Base):
    def test_create_list_and_validation(self):
        self.semester("2026S2")
        self.semester("2025S1")
        self.error(409, "conflict", "POST", "/semesters", {"code": "2026S2"}, self.admin)
        for code in ("2026S3", "26S1", "2026s1", 2026):
            self.error(400, "invalid", "POST", "/semesters", {"code": code}, self.admin)
        self.assertEqual(self.ok(200, "GET", "/semesters", token=self.admin),
                         {"items": [{"code": "2025S1", "state": "planning"}, {"code": "2026S2", "state": "planning"}]})

    def test_state_machine(self):
        self.semester("2026S1")
        self.error(409, "bad_state", "POST", "/semesters/2026S1/state", {"state": "closed"}, self.admin)
        self.error(409, "bad_state", "POST", "/semesters/2026S1/state", {"state": "planning"}, self.admin)
        self.error(400, "invalid", "POST", "/semesters/2026S1/state", {"state": "done"}, self.admin)
        for s in ("open", "closed", "graded"):
            self.assertEqual(self.ok(200, "POST", "/semesters/2026S1/state", {"state": s}, self.admin),
                             {"code": "2026S1", "state": s})
        self.error(409, "bad_state", "POST", "/semesters/2026S1/state", {"state": "open"}, self.admin)
        self.error(404, "not_found", "POST", "/semesters/2030S1/state", {"state": "open"}, self.admin)

    def test_students_cannot_change_state(self):
        self.semester("2026S1")
        _, st = self.user("stud01")
        self.error(403, "forbidden", "POST", "/semesters/2026S1/state", {"state": "open"}, st)
        self.assertEqual(self.ok(200, "GET", "/semesters", token=st)["items"][0]["state"], "planning")


class Courses(Base):
    def setUp(self):
        super().setUp()
        self.t1, self.t1tok = self.user("teach01", "teacher")
        self.t2, _ = self.user("teach02", "teacher")
        self.s1, self.s1tok = self.user("stud01")
        self.semester("2026S1")

    def test_create_course_object(self):
        c = self.course("2026S1", "CS101", self.t1, credits=4, capacity=2,
                        slots=[{"day": 2, "start": "10:00", "end": "11:40"}, {"day": 4, "start": "10:00", "end": "11:40"}],
                        prereqs=["MA100"], title="Intro")
        self.assertEqual(c, {"semester": "2026S1", "code": "CS101", "title": "Intro", "credits": 4, "capacity": 2,
                             "teacher": self.t1, "slots": [{"day": 2, "start": "10:00", "end": "11:40"},
                                                           {"day": 4, "start": "10:00", "end": "11:40"}],
                             "prereqs": ["MA100"], "enrolled": 0, "waitlisted": 0})
        self.assertEqual(self.ok(200, "GET", "/courses/2026S1/CS101", token=self.s1tok), c)

    def test_course_validation(self):
        base = {"semester": "2026S1", "code": "CS102", "title": "T", "credits": 3, "capacity": 10, "teacher": self.t1,
                "slots": [{"day": 1, "start": "08:00", "end": "09:00"}], "prereqs": []}
        bad = [dict(base, code="cs102"), dict(base, code="C102"), dict(base, title=""), dict(base, credits=0),
               dict(base, credits=7), dict(base, credits=2.5), dict(base, capacity=0), dict(base, teacher=self.s1),
               dict(base, teacher=999), dict(base, slots=[]), dict(base, slots=[{"day": 6, "start": "08:00", "end": "09:00"}]),
               dict(base, slots=[{"day": 1, "start": "09:00", "end": "09:00"}]),
               dict(base, slots=[{"day": 1, "start": "8:00", "end": "09:00"}]),
               dict(base, slots=[{"day": 1, "start": "08:00", "end": "10:00"}, {"day": 1, "start": "09:30", "end": "11:00"}]),
               dict(base, prereqs=["bad"])]
        for body in bad:
            self.error(400, "invalid", "POST", "/courses", body, self.admin)
        ok = dict(base, slots=[{"day": 1, "start": "08:00", "end": "09:00"}, {"day": 1, "start": "09:00", "end": "10:00"}])
        self.ok(201, "POST", "/courses", ok, self.admin)

    def test_course_semester_rules(self):
        self.error(404, "not_found", "POST", "/courses", {"semester": "2030S1", "code": "CS101", "title": "T", "credits": 3,
                                                         "capacity": 5, "teacher": self.t1,
                                                         "slots": self.slot(1, "08:00", "09:00"), "prereqs": []}, self.admin)
        self.course("2026S1", "CS101", self.t1)
        self.error(409, "conflict", "POST", "/courses", {"semester": "2026S1", "code": "CS101", "title": "T", "credits": 3,
                                                         "capacity": 5, "teacher": self.t1,
                                                         "slots": self.slot(1, "08:00", "09:00"), "prereqs": []}, self.admin)
        self.state("2026S1", "open")
        self.error(409, "bad_state", "POST", "/courses", {"semester": "2026S1", "code": "CS103", "title": "T", "credits": 3,
                                                          "capacity": 5, "teacher": self.t1,
                                                          "slots": self.slot(1, "08:00", "09:00"), "prereqs": []}, self.admin)
        self.error(403, "forbidden", "POST", "/courses", {"semester": "2026S1", "code": "CS104", "title": "T", "credits": 3,
                                                          "capacity": 5, "teacher": self.t1,
                                                          "slots": self.slot(1, "08:00", "09:00"), "prereqs": []}, self.t1tok)

    def test_list_filter_and_pages(self):
        self.semester("2025S2")
        for code in ("MA201", "CS101", "CS301", "PHY100"):
            self.course("2026S1", code, self.t1 if code != "MA201" else self.t2, title=f"Title of {code}")
        self.course("2025S2", "CS101", self.t1, title="Old intro")
        p = self.ok(200, "GET", "/courses", token=self.s1tok)
        self.assertEqual(p["total"], 5)
        self.assertEqual([(c["semester"], c["code"]) for c in p["items"]],
                         [("2025S2", "CS101"), ("2026S1", "CS101"), ("2026S1", "CS301"), ("2026S1", "MA201"),
                          ("2026S1", "PHY100")])
        p = self.ok(200, "GET", "/courses?semester=2026S1&per_page=2&page=2", token=self.s1tok)
        self.assertEqual((p["total"], [c["code"] for c in p["items"]]), (4, ["MA201", "PHY100"]))
        p = self.ok(200, "GET", f"/courses?teacher={self.t2}", token=self.s1tok)
        self.assertEqual([c["code"] for c in p["items"]], ["MA201"])
        p = self.ok(200, "GET", "/courses?q=cs", token=self.s1tok)
        self.assertEqual(p["total"], 3)
        p = self.ok(200, "GET", "/courses?q=INTRO", token=self.s1tok)
        self.assertEqual([c["semester"] for c in p["items"]], ["2025S2"])
        p = self.ok(200, "GET", "/courses?semester=2026S1&page=9", token=self.s1tok)
        self.assertEqual((p["total"], p["items"]), (4, []))
        for q in ("page=0", "per_page=0", "per_page=101", "page=x"):
            self.error(400, "invalid", "GET", f"/courses?{q}", token=self.s1tok)

    def test_get_unknown_course(self):
        self.error(404, "not_found", "GET", "/courses/2026S1/CS999", token=self.s1tok)

    def test_patch_capacity(self):
        self.course("2026S1", "CS101", self.t1, capacity=1)
        self.error(403, "forbidden", "PATCH", "/courses/2026S1/CS101", {"capacity": 5}, self.t1tok)
        self.error(400, "invalid", "PATCH", "/courses/2026S1/CS101", {"capacity": 0}, self.admin)
        self.state("2026S1", "open")
        _, a = self.user("stud02")
        _, b = self.user("stud03")
        self.enroll(a, "2026S1", "CS101")
        self.enroll(b, "2026S1", "CS101")
        self.enroll(self.s1tok, "2026S1", "CS101")
        c = self.ok(200, "PATCH", "/courses/2026S1/CS101", {"capacity": 2}, self.admin)
        self.assertEqual((c["capacity"], c["enrolled"], c["waitlisted"]), (2, 2, 1))
        self.error(409, "capacity_below_enrolled", "PATCH", "/courses/2026S1/CS101", {"capacity": 1}, self.admin)
        self.state("2026S1", "closed")
        self.error(409, "bad_state", "PATCH", "/courses/2026S1/CS101", {"capacity": 9}, self.admin)


class Enrolment(Base):
    def setUp(self):
        super().setUp()
        self.t, self.ttok = self.user("teach01", "teacher")
        self.studs = [self.user(f"stud{i:02d}") for i in range(1, 7)]
        self.sid, self.stok = self.studs[0]
        self.semester("2026S1")

    def open(self):
        self.state("2026S1", "open")

    def test_enroll_and_waitlist_positions(self):
        self.course("2026S1", "CS101", self.t, capacity=2)
        self.open()
        results = [self.enroll(tok, "2026S1", "CS101") for _, tok in self.studs[:5]]
        self.assertEqual(results, [(201, {"status": "enrolled"}), (201, {"status": "enrolled"}),
                                   (201, {"status": "waitlisted", "position": 1}),
                                   (201, {"status": "waitlisted", "position": 2}),
                                   (201, {"status": "waitlisted", "position": 3})])
        c = self.ok(200, "GET", "/courses/2026S1/CS101", token=self.stok)
        self.assertEqual((c["enrolled"], c["waitlisted"]), (2, 3))

    def test_errors_in_order(self):
        self.course("2026S1", "CS101", self.t)
        self.error(409, "bad_state", "POST", "/enrollments", {"semester": "2026S1", "code": "CS101"}, self.stok)
        self.open()
        self.error(403, "forbidden", "POST", "/enrollments", {"semester": "2026S1", "code": "CS101"}, self.ttok)
        self.error(400, "invalid", "POST", "/enrollments", {"semester": "2026S1"}, self.stok)
        self.error(404, "not_found", "POST", "/enrollments", {"semester": "2026S1", "code": "CS999"}, self.stok)
        self.assertEqual(self.enroll(self.stok, "2026S1", "CS101")[0], 201)
        self.error(409, "already_enrolled", "POST", "/enrollments", {"semester": "2026S1", "code": "CS101"}, self.stok)

    def test_prerequisites_need_a_graded_pass(self):
        self.semester("2025S2", "planning")
        self.course("2025S2", "MA100", self.t)
        self.course("2026S1", "MA200", self.t, prereqs=["MA100"], slots=self.slot(3, "08:00", "09:00"))
        self.state("2025S2", "open")
        (pa, pat), (fa, fat), (na, nat) = self.studs[1], self.studs[2], self.studs[3]
        for tok in (pat, fat):
            self.assertEqual(self.enroll(tok, "2025S2", "MA100")[0], 201)
        self.state("2025S2", "closed")
        self.ok(200, "PUT", "/courses/2025S2/MA100/grades", {"grades": {str(pa): 60, str(fa): 59}}, self.ttok)
        self.open()
        self.error(409, "prereq_missing", "POST", "/enrollments", {"semester": "2026S1", "code": "MA200"}, pat)
        self.state("2025S2", "graded")
        self.assertEqual(self.enroll(pat, "2026S1", "MA200"), (201, {"status": "enrolled"}))
        self.error(409, "prereq_missing", "POST", "/enrollments", {"semester": "2026S1", "code": "MA200"}, fat)
        self.error(409, "prereq_missing", "POST", "/enrollments", {"semester": "2026S1", "code": "MA200"}, nat)

    def test_already_passed_comes_before_prerequisites(self):
        self.semester("2025S2")
        self.course("2025S2", "CS101", self.t)
        self.course("2026S1", "CS101", self.t, prereqs=["MA999"])
        self.course("2026S1", "CS102", self.t, slots=self.slot(2, "08:00", "09:00"))
        self.state("2025S2", "open")
        self.enroll(self.stok, "2025S2", "CS101")
        self.state("2025S2", "closed")
        self.ok(200, "PUT", "/courses/2025S2/CS101/grades", {"grades": {str(self.sid): 95}}, self.ttok)
        self.state("2025S2", "graded")
        self.open()
        self.error(409, "already_passed", "POST", "/enrollments", {"semester": "2026S1", "code": "CS101"}, self.stok)

    def test_schedule_conflicts(self):
        self.course("2026S1", "CS101", self.t, slots=[{"day": 1, "start": "08:00", "end": "09:40"}])
        self.course("2026S1", "CS102", self.t, slots=[{"day": 1, "start": "09:30", "end": "10:30"}])
        self.course("2026S1", "CS103", self.t, slots=[{"day": 1, "start": "09:40", "end": "11:00"}])
        self.course("2026S1", "CS104", self.t, slots=[{"day": 2, "start": "08:00", "end": "09:40"}])
        self.open()
        self.enroll(self.stok, "2026S1", "CS101")
        self.error(409, "schedule_conflict", "POST", "/enrollments", {"semester": "2026S1", "code": "CS102"}, self.stok)
        self.assertEqual(self.enroll(self.stok, "2026S1", "CS103")[0], 201)
        self.assertEqual(self.enroll(self.stok, "2026S1", "CS104")[0], 201)

    def test_credit_limit(self):
        for i in range(5):
            self.course("2026S1", f"EE10{i}", self.t, credits=5, slots=self.slot(1 + i, "08:00", "09:00"))
        self.course("2026S1", "EE200", self.t, credits=1, slots=self.slot(1, "10:00", "11:00"))
        self.open()
        for i in range(5):
            self.assertEqual(self.enroll(self.stok, "2026S1", f"EE10{i}")[0], 201)
        self.error(409, "credit_limit", "POST", "/enrollments", {"semester": "2026S1", "code": "EE200"}, self.stok)

    def test_waitlisted_courses_do_not_count(self):
        self.course("2026S1", "CS101", self.t, capacity=1, credits=6)
        self.course("2026S1", "CS102", self.t, credits=6)
        other = self.studs[1][1]
        self.open()
        self.enroll(other, "2026S1", "CS101")
        self.assertEqual(self.enroll(self.stok, "2026S1", "CS101")[1]["status"], "waitlisted")
        self.assertEqual(self.enroll(self.stok, "2026S1", "CS102"), (201, {"status": "enrolled"}))

    def test_drop_promotes_first_eligible(self):
        self.course("2026S1", "CS101", self.t, capacity=1, slots=self.slot(1, "08:00", "09:00"))
        self.course("2026S1", "CS102", self.t, capacity=5, slots=self.slot(1, "08:30", "09:30"))
        (a, at), (b, bt), (c, ct), (d, dt) = self.studs[1:5]
        self.open()
        self.enroll(at, "2026S1", "CS101")
        self.enroll(bt, "2026S1", "CS101")      # waitlist 1
        self.enroll(ct, "2026S1", "CS101")      # waitlist 2
        self.enroll(dt, "2026S1", "CS101")      # waitlist 3
        self.ok(200, "DELETE", "/enrollments/2026S1/CS101", token=bt)       # b leaves the waitlist
        self.enroll(ct, "2026S1", "CS102")  # c is waitlisted for CS101 but enrolls in a clashing course
        self.assertEqual(self.ok(200, "DELETE", "/enrollments/2026S1/CS101", token=at), {"status": "dropped"})
        roster = self.ok(200, "GET", "/courses/2026S1/CS101/roster", token=self.ttok)
        self.assertEqual([u["id"] for u in roster["enrolled"]], [d])
        self.assertEqual([u["id"] for u in roster["waitlist"]], [c])
        sched = self.ok(200, "GET", f"/students/{c}/schedule?semester=2026S1", token=ct)
        self.assertEqual(sched["waitlisted"], [{"code": "CS101", "position": 1}])

    def test_capacity_increase_promotes_in_order(self):
        self.course("2026S1", "CS101", self.t, capacity=1)
        self.open()
        ids = []
        for sid, tok in self.studs[:4]:
            self.enroll(tok, "2026S1", "CS101")
            ids.append(sid)
        self.ok(200, "PATCH", "/courses/2026S1/CS101", {"capacity": 3}, self.admin)
        roster = self.ok(200, "GET", "/courses/2026S1/CS101/roster", token=self.admin)
        self.assertEqual(sorted(u["id"] for u in roster["enrolled"]), sorted(ids[:3]))
        self.assertEqual([u["id"] for u in roster["waitlist"]], [ids[3]])

    def test_drop_errors(self):
        self.course("2026S1", "CS101", self.t)
        self.open()
        self.error(404, "not_found", "DELETE", "/enrollments/2026S1/CS101", token=self.stok)
        self.error(404, "not_found", "DELETE", "/enrollments/2026S1/CS999", token=self.stok)
        self.enroll(self.stok, "2026S1", "CS101")
        self.state("2026S1", "closed")
        self.error(409, "bad_state", "DELETE", "/enrollments/2026S1/CS101", token=self.stok)

    def test_schedule_view(self):
        self.course("2026S1", "CS201", self.t, credits=4, slots=self.slot(2, "08:00", "09:00"), title="B")
        self.course("2026S1", "CS101", self.t, credits=2, slots=self.slot(1, "08:00", "09:00"), title="A")
        self.course("2026S1", "CS301", self.t, capacity=1, slots=self.slot(3, "08:00", "09:00"))
        self.open()
        self.enroll(self.studs[1][1], "2026S1", "CS301")
        for code in ("CS201", "CS101", "CS301"):
            self.enroll(self.stok, "2026S1", code)
        s = self.ok(200, "GET", f"/students/{self.sid}/schedule?semester=2026S1", token=self.stok)
        self.assertEqual(s, {"enrolled": [{"code": "CS101", "title": "A", "credits": 2, "slots": self.slot(1, "08:00", "09:00")},
                                          {"code": "CS201", "title": "B", "credits": 4, "slots": self.slot(2, "08:00", "09:00")}],
                             "waitlisted": [{"code": "CS301", "position": 1}], "credits": 6})
        self.error(403, "forbidden", "GET", f"/students/{self.sid}/schedule?semester=2026S1", token=self.studs[1][1])
        self.ok(200, "GET", f"/students/{self.sid}/schedule?semester=2026S1", token=self.admin)
        self.error(404, "not_found", "GET", f"/students/{self.sid}/schedule?semester=2031S1", token=self.stok)


class Grades(Base):
    def setUp(self):
        super().setUp()
        self.t, self.ttok = self.user("teach01", "teacher")
        self.t2, self.t2tok = self.user("teach02", "teacher")
        self.studs = [self.user(name) for name in ("zed", "amy", "kim", "bob")]
        self.semester("2026S1")

    def test_roster_and_permissions(self):
        self.course("2026S1", "CS101", self.t, capacity=2)
        self.state("2026S1", "open")
        for sid, tok in self.studs:
            self.enroll(tok, "2026S1", "CS101")
        r = self.ok(200, "GET", "/courses/2026S1/CS101/roster", token=self.ttok)
        self.assertEqual([u["username"] for u in r["enrolled"]], ["amy", "zed"])
        self.assertEqual(r["enrolled"][0], {"id": self.studs[1][0], "username": "amy", "name": "Amy"})
        self.assertEqual([u["username"] for u in r["waitlist"]], ["kim", "bob"])
        self.error(403, "forbidden", "GET", "/courses/2026S1/CS101/roster", token=self.t2tok)
        self.error(403, "forbidden", "GET", "/courses/2026S1/CS101/roster", token=self.studs[0][1])

    def test_grades_rules(self):
        self.course("2026S1", "CS101", self.t, capacity=2)
        self.state("2026S1", "open")
        for sid, tok in self.studs[:3]:
            self.enroll(tok, "2026S1", "CS101")
        z, a, k = (s[0] for s in self.studs[:3])
        self.error(409, "bad_state", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 80}}, self.ttok)
        self.state("2026S1", "closed")
        self.error(403, "forbidden", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 80}}, self.t2tok)
        self.error(403, "forbidden", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 80}}, self.admin)
        self.error(400, "invalid", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 80, str(k): 70}}, self.ttok)
        self.error(400, "invalid", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 101}}, self.ttok)
        self.error(400, "invalid", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 79.5}}, self.ttok)
        self.assertEqual(self.ok(200, "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 80, str(a): 50}},
                                 self.ttok), {"updated": 2})
        self.ok(200, "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(a): 91}}, self.ttok)
        self.state("2026S1", "graded")
        self.error(409, "bad_state", "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 81}}, self.ttok)
        tr = self.ok(200, "GET", f"/students/{a}/transcript", token=self.studs[1][1])
        self.assertEqual([c["score"] for c in tr["courses"]], [91])

    def test_transcript_gpa(self):
        specs = [("CS101", 3), ("CS102", 2), ("CS103", 4), ("CS104", 1)]
        for i, (code, credits) in enumerate(specs):
            self.course("2026S1", code, self.t, credits=credits, slots=self.slot(i + 1, "08:00", "09:00"))
        self.state("2026S1", "open")
        z, zt = self.studs[0]
        for code, _ in specs:
            self.enroll(zt, "2026S1", code)
        self.state("2026S1", "closed")
        for code, score in (("CS101", 91), ("CS102", 77), ("CS103", 59)):
            self.ok(200, "PUT", f"/courses/2026S1/{code}/grades", {"grades": {str(z): score}}, self.ttok)
        self.assertEqual(self.ok(200, "GET", f"/students/{z}/transcript", token=zt),
                         {"courses": [], "gpa": 0.0, "credits_earned": 0})
        self.state("2026S1", "graded")
        tr = self.ok(200, "GET", f"/students/{z}/transcript", token=zt)
        self.assertEqual(tr["courses"], [
            {"semester": "2026S1", "code": "CS101", "title": "Course CS101", "credits": 3, "score": 91, "points": 4.0},
            {"semester": "2026S1", "code": "CS102", "title": "Course CS102", "credits": 2, "score": 77, "points": 2.7},
            {"semester": "2026S1", "code": "CS103", "title": "Course CS103", "credits": 4, "score": 59, "points": 0.0}])
        self.assertEqual((tr["gpa"], tr["credits_earned"]), (1.93, 5))

    def test_points_table_and_half_up_rounding(self):
        table = [(100, 4.0), (90, 4.0), (89, 3.7), (85, 3.7), (84, 3.3), (82, 3.3), (81, 3.0), (78, 3.0), (77, 2.7),
                 (75, 2.7), (74, 2.3), (72, 2.3), (71, 2.0), (68, 2.0), (67, 1.5), (64, 1.5), (63, 1.0), (60, 1.0),
                 (59, 0.0), (0, 0.0)]
        studs = [self.user(f"p{i:03d}") for i in range(len(table))]
        self.course("2026S1", "CS101", self.t, capacity=50)
        self.state("2026S1", "open")
        for _, tok in studs:
            self.enroll(tok, "2026S1", "CS101")
        self.state("2026S1", "closed")
        self.ok(200, "PUT", "/courses/2026S1/CS101/grades",
                {"grades": {str(sid): score for (sid, _), (score, _) in zip(studs, table)}}, self.ttok)
        self.state("2026S1", "graded")
        for (sid, tok), (score, pts) in zip(studs, table):
            tr = self.ok(200, "GET", f"/students/{sid}/transcript", token=tok)
            self.assertEqual((tr["courses"][0]["points"], tr["gpa"]), (pts, pts), score)

    def test_gpa_rounds_half_up(self):
        self.course("2026S1", "CS101", self.t, credits=3, slots=self.slot(1, "08:00", "09:00"))
        self.course("2026S1", "CS102", self.t, credits=1, slots=self.slot(2, "08:00", "09:00"))
        self.state("2026S1", "open")
        z, zt = self.studs[0]
        self.enroll(zt, "2026S1", "CS101")
        self.enroll(zt, "2026S1", "CS102")
        self.state("2026S1", "closed")
        self.ok(200, "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 95}}, self.ttok)
        self.ok(200, "PUT", "/courses/2026S1/CS102/grades", {"grades": {str(z): 86}}, self.ttok)
        self.state("2026S1", "graded")
        self.assertEqual(self.ok(200, "GET", f"/students/{z}/transcript", token=zt)["gpa"], 3.93)

    def test_retake_counts_both_attempts(self):
        self.semester("2026S2")
        self.course("2026S1", "CS101", self.t, credits=2)
        self.course("2026S2", "CS101", self.t, credits=2)
        z, zt = self.studs[0]
        self.state("2026S1", "open")
        self.enroll(zt, "2026S1", "CS101")
        self.state("2026S1", "closed")
        self.ok(200, "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(z): 40}}, self.ttok)
        self.state("2026S1", "graded")
        self.state("2026S2", "open")
        self.assertEqual(self.enroll(zt, "2026S2", "CS101")[0], 201)
        self.state("2026S2", "closed")
        self.ok(200, "PUT", "/courses/2026S2/CS101/grades", {"grades": {str(z): 90}}, self.ttok)
        self.state("2026S2", "graded")
        tr = self.ok(200, "GET", f"/students/{z}/transcript", token=self.admin)
        self.assertEqual([(c["semester"], c["score"]) for c in tr["courses"]], [("2026S1", 40), ("2026S2", 90)])
        self.assertEqual((tr["gpa"], tr["credits_earned"]), (2.0, 2))
        self.error(403, "forbidden", "GET", f"/students/{z}/transcript", token=self.studs[1][1])


class Reports(Base):
    def setUp(self):
        super().setUp()
        self.t, self.ttok = self.user("teach01", "teacher")
        self.studs = [self.user(n) for n in ("ana", "ben", "cai", "dov")]
        self.semester("2026S1")
        self.course("2026S1", "CS101", self.t, capacity=2, credits=3, slots=self.slot(1, "08:00", "09:00"))
        self.course("2026S1", "CS102", self.t, capacity=4, credits=1, slots=self.slot(2, "08:00", "09:00"))
        self.course("2026S1", "CS103", self.t, capacity=3, credits=2, slots=self.slot(3, "08:00", "09:00"))
        self.state("2026S1", "open")
        for sid, tok in self.studs:
            self.enroll(tok, "2026S1", "CS101")
        for sid, tok in self.studs[:1]:
            self.enroll(tok, "2026S1", "CS102")

    def test_semester_report(self):
        self.assertEqual(self.ok(200, "GET", "/reports/semester/2026S1", token=self.admin),
                         {"courses": 3, "enrolled": 3, "waitlisted": 2, "full": ["CS101"], "fill_rate": 0.42})
        self.error(403, "forbidden", "GET", "/reports/semester/2026S1", token=self.ttok)
        self.error(404, "not_found", "GET", "/reports/semester/2031S1", token=self.admin)

    def test_top_students(self):
        self.error(409, "bad_state", "GET", "/reports/top-students?semester=2026S1", token=self.admin)
        (a, _), (b, _) = self.studs[:2]
        self.state("2026S1", "closed")
        self.ok(200, "PUT", "/courses/2026S1/CS101/grades", {"grades": {str(a): 80, str(b): 95}}, self.ttok)
        self.ok(200, "PUT", "/courses/2026S1/CS102/grades", {"grades": {str(a): 100}}, self.ttok)
        self.state("2026S1", "graded")
        p = self.ok(200, "GET", "/reports/top-students?semester=2026S1", token=self.admin)
        self.assertEqual(p, {"items": [{"id": b, "username": "ben", "gpa": 4.0}, {"id": a, "username": "ana", "gpa": 3.25}]})
        p = self.ok(200, "GET", "/reports/top-students?semester=2026S1&n=1", token=self.admin)
        self.assertEqual([x["username"] for x in p["items"]], ["ben"])
        self.error(400, "invalid", "GET", "/reports/top-students?semester=2026S1&n=0", token=self.admin)
        self.error(403, "forbidden", "GET", "/reports/top-students?semester=2026S1", token=self.ttok)


class Routing(Base):
    def test_unknown_path_and_method(self):
        self.error(404, "not_found", "GET", "/nothing", token=self.admin)
        self.error(404, "not_found", "DELETE", "/semesters", token=self.admin)
        self.error(404, "not_found", "GET", "/courses/2026S1", token=self.admin)


class Concurrency(Base):
    def test_last_seats(self):
        t, _ = self.user("teach01", "teacher")
        self.semester("2026S1")
        self.course("2026S1", "CS101", t, capacity=5)
        self.state("2026S1", "open")
        studs = [self.user(f"c{i:03d}") for i in range(30)]
        with ThreadPoolExecutor(30) as pool:
            results = list(pool.map(lambda s: self.enroll(s[1], "2026S1", "CS101"), studs))
        statuses = [p["status"] for st, p in results if st == 201]
        self.assertEqual(len(statuses), 30)
        self.assertEqual(statuses.count("enrolled"), 5)
        self.assertEqual(sorted(p["position"] for _, p in results if p["status"] == "waitlisted"), list(range(1, 26)))
        roster = self.ok(200, "GET", "/courses/2026S1/CS101/roster", token=self.admin)
        self.assertEqual((len(roster["enrolled"]), len(roster["waitlist"])), (5, 25))

    def test_concurrent_user_creation(self):
        def make(i):
            return self.r("POST", "/users", {"username": f"u{i:03d}", "password": "p", "role": "student", "name": "U"},
                          self.admin)

        with ThreadPoolExecutor(20) as pool:
            results = list(pool.map(make, range(40)))
        ids = sorted(p["id"] for st, p in results if st == 201)
        self.assertEqual(ids, list(range(2, 42)))


class Persistence(Base):
    def test_everything_survives_restart(self):
        t, tt = self.user("teach01", "teacher")
        s, stok = self.user("stud01")
        s2, s2tok = self.user("stud02")
        self.semester("2026S1")
        self.course("2026S1", "CS101", t, capacity=1)
        self.state("2026S1", "open")
        self.enroll(stok, "2026S1", "CS101")
        self.enroll(s2tok, "2026S1", "CS101")
        self.restart()
        roster = self.ok(200, "GET", "/courses/2026S1/CS101/roster", token=tt)
        self.assertEqual(([u["id"] for u in roster["enrolled"]], [u["id"] for u in roster["waitlist"]]), ([s], [s2]))
        self.assertEqual(self.ok(200, "GET", "/semesters", token=stok)["items"], [{"code": "2026S1", "state": "open"}])
        self.ok(200, "DELETE", "/enrollments/2026S1/CS101", token=stok)
        self.restart()
        self.assertEqual(self.ok(200, "GET", f"/students/{s2}/schedule?semester=2026S1", token=s2tok)["credits"], 3)

    def test_kill_keeps_acknowledged_writes(self):
        t, _ = self.user("teach01", "teacher")
        self.semester("2026S1")
        for i in range(4):
            self.course("2026S1", f"CS10{i}", t, capacity=10, slots=self.slot(i + 1, "08:00", "09:00"))
        self.state("2026S1", "open")
        studs = [self.user(f"k{i:03d}") for i in range(40)]
        acked = []
        stop = threading.Event()

        def worker(chunk):
            for sid, tok in chunk:
                for i in range(4):
                    if stop.is_set():
                        return
                    try:
                        st, p = self.enroll(tok, "2026S1", f"CS10{i}")
                    except Exception:
                        return
                    if st == 201:
                        acked.append((sid, f"CS10{i}", p["status"]))

        threads = [threading.Thread(target=worker, args=(studs[i::4],)) for i in range(4)]
        for th in threads:
            th.start()
        time.sleep(1.0)
        self.srv.stop(kill=True)
        stop.set()
        for th in threads:
            th.join(30)
        self.srv = Server(self.data)
        for i in range(4):
            r = self.ok(200, "GET", f"/courses/2026S1/CS10{i}/roster", token=self.admin)
            ids = [u["id"] for u in r["enrolled"] + r["waitlist"]]
            self.assertEqual(len(ids), len(set(ids)))
            self.assertLessEqual(len(r["enrolled"]), 10)
            if r["waitlist"]:
                self.assertEqual(len(r["enrolled"]), 10)
            for sid, code, _ in acked:
                if code == f"CS10{i}":
                    self.assertIn(sid, ids)


class Performance(Base):
    def test_sequential_and_concurrent_load(self):
        t, _ = self.user("teach01", "teacher")
        self.semester("2026S1")
        for i in range(60):
            self.course("2026S1", f"PF{i:03d}", t, credits=1, capacity=40,
                        slots=self.slot(1 + i % 5, f"{8 + (i // 5) % 12:02d}:00", f"{8 + (i // 5) % 12:02d}:50"))
        self.state("2026S1", "open")
        studs = []
        for i in range(300):
            studs.append(self.user(f"pf{i:03d}"))
        start = time.time()
        for n in range(1000):
            _, tok = studs[n % 300]
            st, _ = self.enroll(tok, "2026S1", f"PF{(n * 7) % 60:03d}")
            self.assertIn(st, (201, 409))
        self.assertLess(time.time() - start, 30)
        start = time.time()
        with ThreadPoolExecutor(50) as pool:
            res = list(pool.map(lambda n: self.enroll(studs[n][1], "2026S1", f"PF{(n * 11 + 3) % 60:03d}"), range(50)))
        self.assertTrue(all(st in (201, 409) for st, _ in res))
        self.assertLess(time.time() - start, 10)


class Delivery(unittest.TestCase):
    def test_package(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "coursereg", "__main__.py")))

    def test_own_tests(self):
        p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=PROJECT,
                           capture_output=True, text=True, timeout=900)
        m = re.search(r"Ran (\d+) tests?", p.stderr)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        self.assertTrue(m and int(m.group(1)) >= 40, p.stderr[-500:])

    def test_docs(self):
        for name in ("README.md", os.path.join("docs", "design.md")):
            path = os.path.join(PROJECT, name)
            self.assertTrue(os.path.isfile(path), name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                self.assertGreater(len(fh.read().strip()), 300, name)


if __name__ == "__main__":
    unittest.main()
