import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            cls.port = s.getsockname()[1]
        cls.proc = subprocess.Popen([sys.executable, "-m", "coursereg", "--port", str(cls.port), "--data", cls.tmp],
                                    cwd=ROOT, stdout=subprocess.PIPE, text=True)
        assert cls.proc.stdout.readline().strip() == "ready"
        cls.admin = cls.call("POST", "/login", {"username": "admin", "password": "admin"})[1]["token"]
        cls.call("POST", "/users", {"username": "teach", "password": "p", "role": "teacher", "name": "T"}, cls.admin)
        cls.call("POST", "/users", {"username": "stud", "password": "p", "role": "student", "name": "S"}, cls.admin)
        cls.stud = cls.call("POST", "/login", {"username": "stud", "password": "p"})[1]["token"]
        cls.call("POST", "/semesters", {"code": "2026S1"}, cls.admin)
        for i in range(6):
            cls.call("POST", "/courses", {"semester": "2026S1", "code": f"CS10{i}", "title": f"C{i}", "credits": 5,
                                          "capacity": 1, "teacher": 2, "prereqs": [],
                                          "slots": [{"day": 1 + i % 5, "start": "08:00", "end": "09:00"}]}, cls.admin)
        cls.call("POST", "/semesters/2026S1/state", {"state": "open"}, cls.admin)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        shutil.rmtree(cls.tmp)

    @classmethod
    def call(cls, method, path, body=None, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        conn.request(method, path, json.dumps(body) if body is not None else None, headers)
        r = conn.getresponse()
        data = json.loads(r.read() or b"null")
        conn.close()
        return r.status, data


# (method, path, body, token attribute or None, expected status, expected error code or None)
CASES = [
    ("POST", "/login", {"username": "admin", "password": "bad"}, None, 401, "bad_credentials"),
    ("GET", "/semesters", None, None, 401, "unauthorized"),
    ("GET", "/semesters", None, "stud", 200, None),
    ("GET", "/nothing", None, "admin", 404, "not_found"),
    ("POST", "/users", {"username": "x", "password": "p", "role": "student", "name": "X"}, "admin", 400, "invalid"),
    ("POST", "/users", {"username": "xyz", "password": "p", "role": "boss", "name": "X"}, "admin", 400, "invalid"),
    ("POST", "/users", {"username": "teach", "password": "p", "role": "student", "name": "X"}, "admin", 409, "conflict"),
    ("POST", "/users", {"username": "abc", "password": "p", "role": "student", "name": "X"}, "stud", 403, "forbidden"),
    ("GET", "/users/1", None, "stud", 403, "forbidden"),
    ("GET", "/users/3", None, "stud", 200, None),
    ("GET", "/users/99", None, "admin", 404, "not_found"),
    ("POST", "/semesters", {"code": "2026S3"}, "admin", 400, "invalid"),
    ("POST", "/semesters", {"code": "2026S1"}, "admin", 409, "conflict"),
    ("POST", "/semesters", {"code": "2027S1"}, "stud", 403, "forbidden"),
    ("POST", "/semesters/2026S1/state", {"state": "graded"}, "admin", 409, "bad_state"),
    ("POST", "/semesters/2026S1/state", {"state": "nope"}, "admin", 400, "invalid"),
    ("POST", "/semesters/2099S1/state", {"state": "open"}, "admin", 404, "not_found"),
    ("POST", "/courses", {"semester": "2026S1"}, "admin", 400, "invalid"),
    ("POST", "/courses", {"semester": "2026S1", "code": "CS999", "title": "T", "credits": 3, "capacity": 1,
                          "teacher": 2, "prereqs": [], "slots": [{"day": 1, "start": "08:00", "end": "09:00"}]},
     "admin", 409, "bad_state"),
    ("POST", "/courses", {"semester": "2099S1", "code": "CS999", "title": "T", "credits": 3, "capacity": 1,
                          "teacher": 2, "prereqs": [], "slots": [{"day": 1, "start": "08:00", "end": "09:00"}]},
     "admin", 404, "not_found"),
    ("POST", "/courses", {"semester": "2026S1", "code": "CS999", "title": "T", "credits": 3, "capacity": 1,
                          "teacher": 3, "prereqs": [], "slots": [{"day": 1, "start": "08:00", "end": "09:00"}]},
     "admin", 400, "invalid"),
    ("GET", "/courses?per_page=0", None, "stud", 400, "invalid"),
    ("GET", "/courses?page=x", None, "stud", 400, "invalid"),
    ("GET", "/courses?q=cs", None, "stud", 200, None),
    ("GET", "/courses/2026S1/CS100", None, "stud", 200, None),
    ("GET", "/courses/2026S1/CS999", None, "stud", 404, "not_found"),
    ("PATCH", "/courses/2026S1/CS100", {"capacity": 0}, "admin", 400, "invalid"),
    ("PATCH", "/courses/2026S1/CS100", {"capacity": 2}, "stud", 403, "forbidden"),
    ("POST", "/enrollments", {"semester": "2026S1"}, "stud", 400, "invalid"),
    ("POST", "/enrollments", {"semester": "2026S1", "code": "CS999"}, "stud", 404, "not_found"),
    ("POST", "/enrollments", {"semester": "2026S1", "code": "CS100"}, "admin", 403, "forbidden"),
    ("DELETE", "/enrollments/2026S1/CS104", None, "stud", 404, "not_found"),
    ("GET", "/students/3/schedule", None, "stud", 400, "invalid"),
    ("GET", "/students/3/schedule?semester=2099S1", None, "stud", 404, "not_found"),
    ("GET", "/students/3/schedule?semester=2026S1", None, "stud", 200, None),
    ("GET", "/students/3/transcript", None, "stud", 200, None),
    ("GET", "/students/3/transcript", None, "admin", 200, None),
    ("GET", "/courses/2026S1/CS100/roster", None, "stud", 403, "forbidden"),
    ("GET", "/courses/2026S1/CS100/roster", None, "admin", 200, None),
    ("PUT", "/courses/2026S1/CS100/grades", {"grades": {}}, "stud", 403, "forbidden"),
    ("GET", "/reports/semester/2026S1", None, "admin", 200, None),
    ("GET", "/reports/semester/2026S1", None, "stud", 403, "forbidden"),
    ("GET", "/reports/top-students?semester=2026S1", None, "admin", 409, "bad_state"),
    ("GET", "/reports/top-students?semester=2026S1&n=0", None, "admin", 400, "invalid"),
]


def _case(method, path, body, who, status, code):
    def test(self):
        token = getattr(self, who) if who else None
        st, data = self.call(method, path, body, token)
        self.assertEqual(st, status, data)
        if code:
            self.assertEqual(data, {"error": code})

    return test


for n, c in enumerate(CASES):
    setattr(Api, f"test_case_{n:02d}", _case(*c))


class Flow(Api):
    def test_enroll_waitlist_drop(self):
        st, data = self.call("POST", "/enrollments", {"semester": "2026S1", "code": "CS105"}, self.stud)
        self.assertEqual((st, data), (201, {"status": "enrolled"}))
        st, data = self.call("POST", "/enrollments", {"semester": "2026S1", "code": "CS105"}, self.stud)
        self.assertEqual((st, data), (409, {"error": "already_enrolled"}))
        st, data = self.call("DELETE", "/enrollments/2026S1/CS105", None, self.stud)
        self.assertEqual((st, data), (200, {"status": "dropped"}))


if __name__ == "__main__":
    unittest.main()
