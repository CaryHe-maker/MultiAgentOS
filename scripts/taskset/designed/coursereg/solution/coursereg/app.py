"""Reference solution of the coursereg task: the whole service (instruction.md sections 1-7).

All state lives in one dict, saved to <data>/state.json through a temporary file and os.replace
after every change, before the response is sent. One lock serialises requests.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
from decimal import ROUND_HALF_UP, Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

STATES = ["planning", "open", "closed", "graded"]
CREDIT_LIMIT = 25


class ApiError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def invalid():
    return ApiError(400, "invalid")


def not_found():
    return ApiError(404, "not_found")


def forbidden():
    return ApiError(403, "forbidden")


def conflict(code="conflict"):
    return ApiError(409, code)


def hash_password(password, salt):
    return hashlib.sha256((salt + password).encode()).hexdigest()


def points(score):
    for low, p in ((90, 4.0), (85, 3.7), (82, 3.3), (78, 3.0), (75, 2.7), (72, 2.3), (68, 2.0), (64, 1.5),
                   (60, 1.0)):
        if score >= low:
            return p
    return 0.0


def round2(x):
    return float(Decimal(repr(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def minutes(hhmm):
    if not isinstance(hhmm, str) or not re.fullmatch(r"([01][0-9]|2[0-3]):[0-5][0-9]", hhmm):
        raise invalid()
    return int(hhmm[:2]) * 60 + int(hhmm[3:])


def overlap(a, b):
    return a["day"] == b["day"] and minutes(a["start"]) < minutes(b["end"]) and minutes(b["start"]) < minutes(a["end"])


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


class Service:
    def __init__(self, data_dir):
        self.dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.path = os.path.join(data_dir, "state.json")
        self.lock = threading.Lock()
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self.s = json.load(f)
        else:
            salt = secrets.token_hex(8)
            self.s = {"users": {"1": {"id": 1, "username": "admin", "role": "admin", "name": "Administrator",
                                      "salt": salt, "hash": hash_password("admin", salt)}},
                      "next_user": 2, "tokens": {}, "semesters": {}, "courses": {}}
            self.save()

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.s, f)
        # A killed process cannot leave a half file: the rename is atomic and the data is in the page
        # cache once written (the task covers process kills, not power loss).
        os.replace(tmp, self.path)

    # -- helpers --
    def user_public(self, u):
        return {"id": u["id"], "username": u["username"], "role": u["role"], "name": u["name"]}

    def course_key(self, sem, code):
        return f"{sem}/{code}"

    def course(self, sem, code):
        c = self.s["courses"].get(self.course_key(sem, code))
        if c is None:
            raise not_found()
        return c

    def course_public(self, c):
        out = {k: c[k] for k in ("semester", "code", "title", "credits", "capacity", "teacher", "slots", "prereqs")}
        out["enrolled"] = len(c["enrolled"])
        out["waitlisted"] = len(c["waitlist"])
        return out

    def student_courses(self, sid, sem):
        return [c for c in self.s["courses"].values() if c["semester"] == sem and sid in c["enrolled"]]

    def passed(self, sid, code):
        for c in self.s["courses"].values():
            if c["code"] == code and self.s["semesters"][c["semester"]] == "graded":
                score = c["grades"].get(str(sid))
                if score is not None and score >= 60:
                    return True
        return False

    def fits(self, sid, c):
        """Rules 5 and 6 of section 5: schedule and credit limit against enrolled courses."""
        mine = self.student_courses(sid, c["semester"])
        for other in mine:
            if any(overlap(a, b) for a in c["slots"] for b in other["slots"]):
                return "schedule_conflict"
        if sum(o["credits"] for o in mine) + c["credits"] > CREDIT_LIMIT:
            return "credit_limit"
        return None

    def promote(self, c):
        changed = True
        while changed and len(c["enrolled"]) < c["capacity"]:
            changed = False
            for sid in list(c["waitlist"]):
                if self.fits(sid, c) is None:
                    c["waitlist"].remove(sid)
                    c["enrolled"].append(sid)
                    changed = True
                    break

    def gpa(self, records):
        credits = sum(r["credits"] for r in records)
        if not credits:
            return 0.0
        return round2(sum(r["points"] * r["credits"] for r in records) / credits)

    def records(self, sid, semester=None):
        out = []
        for c in self.s["courses"].values():
            if self.s["semesters"][c["semester"]] != "graded" or (semester and c["semester"] != semester):
                continue
            score = c["grades"].get(str(sid))
            if score is not None and sid in c["enrolled"]:
                out.append({"semester": c["semester"], "code": c["code"], "title": c["title"],
                            "credits": c["credits"], "score": score, "points": points(score)})
        return sorted(out, key=lambda r: (r["semester"], r["code"]))

    # -- dispatch --
    def handle(self, method, path, query, headers, body):
        parts = [p for p in path.split("/") if p]
        if method == "POST" and parts == ["login"]:
            return self.login(self.json(body))
        user = self.auth(headers)
        routes = [
            ("POST", ["users"], self.create_user),
            ("GET", ["users", None], self.get_user),
            ("POST", ["semesters"], self.create_semester),
            ("GET", ["semesters"], self.list_semesters),
            ("POST", ["semesters", None, "state"], self.set_state),
            ("POST", ["courses"], self.create_course),
            ("GET", ["courses"], self.list_courses),
            ("GET", ["courses", None, None], self.get_course),
            ("PATCH", ["courses", None, None], self.patch_course),
            ("GET", ["courses", None, None, "roster"], self.roster),
            ("PUT", ["courses", None, None, "grades"], self.put_grades),
            ("POST", ["enrollments"], self.enroll),
            ("DELETE", ["enrollments", None, None], self.drop),
            ("GET", ["students", None, "schedule"], self.schedule),
            ("GET", ["students", None, "transcript"], self.transcript),
            ("GET", ["reports", "semester", None], self.semester_report),
            ("GET", ["reports", "top-students"], self.top_students),
        ]
        for m, pattern, fn in routes:
            if len(pattern) == len(parts) and all(p is None or p == q for p, q in zip(pattern, parts)):
                if m != method:
                    continue
                args = [q for p, q in zip(pattern, parts) if p is None]
                return fn(user, *args, query=query, body=body)
        raise not_found()

    def json(self, body):
        try:
            data = json.loads(body.decode("utf-8") if body else "")
        except (ValueError, UnicodeDecodeError):
            raise invalid()
        if not isinstance(data, dict):
            raise invalid()
        return data

    def auth(self, headers):
        h = headers.get("Authorization") or ""
        token = h[7:] if h.startswith("Bearer ") else None
        uid = self.s["tokens"].get(token) if token else None
        if uid is None:
            raise ApiError(401, "unauthorized")
        return self.s["users"][str(uid)]

    def require(self, user, *roles):
        if user["role"] not in roles:
            raise forbidden()

    # -- users --
    def login(self, data):
        name, pw = data.get("username"), data.get("password")
        for u in self.s["users"].values():
            if u["username"] == name and isinstance(pw, str) and hash_password(pw, u["salt"]) == u["hash"]:
                token = secrets.token_hex(16)
                self.s["tokens"][token] = u["id"]
                self.save()
                return 200, {"token": token, "role": u["role"], "id": u["id"]}
        raise ApiError(401, "bad_credentials")

    def create_user(self, user, query, body):
        self.require(user, "admin")
        d = self.json(body)
        username, pw, role, name = d.get("username"), d.get("password"), d.get("role"), d.get("name")
        if not (isinstance(username, str) and re.fullmatch(r"[a-z0-9_]{3,20}", username)
                and role in ("admin", "teacher", "student") and isinstance(pw, str) and pw
                and isinstance(name, str) and name):
            raise invalid()
        if any(u["username"] == username for u in self.s["users"].values()):
            raise conflict()
        uid = self.s["next_user"]
        salt = secrets.token_hex(8)
        u = {"id": uid, "username": username, "role": role, "name": name, "salt": salt,
             "hash": hash_password(pw, salt)}
        self.s["users"][str(uid)] = u
        self.s["next_user"] = uid + 1
        self.save()
        return 201, self.user_public(u)

    def target_user(self, uid):
        u = self.s["users"].get(uid) if re.fullmatch(r"[0-9]+", uid) else None
        if u is None:
            raise not_found()
        return u

    def get_user(self, user, uid, query, body):
        u = self.target_user(uid)
        if user["role"] != "admin" and user["id"] != u["id"]:
            raise forbidden()
        return 200, self.user_public(u)

    # -- semesters --
    def create_semester(self, user, query, body):
        self.require(user, "admin")
        code = self.json(body).get("code")
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{4}S[12]", code):
            raise invalid()
        if code in self.s["semesters"]:
            raise conflict()
        self.s["semesters"][code] = "planning"
        self.save()
        return 201, {"code": code, "state": "planning"}

    def list_semesters(self, user, query, body):
        return 200, {"items": [{"code": k, "state": v} for k, v in sorted(self.s["semesters"].items())]}

    def set_state(self, user, code, query, body):
        if code not in self.s["semesters"]:
            raise not_found()
        self.require(user, "admin")
        state = self.json(body).get("state")
        if state not in STATES:
            raise invalid()
        cur = self.s["semesters"][code]
        if STATES.index(state) != STATES.index(cur) + 1:
            raise conflict("bad_state")
        self.s["semesters"][code] = state
        self.save()
        return 200, {"code": code, "state": state}

    # -- courses --
    def create_course(self, user, query, body):
        self.require(user, "admin")
        d = self.json(body)
        sem, code, title = d.get("semester"), d.get("code"), d.get("title")
        credits, cap, teacher, slots, prereqs = (d.get(k) for k in ("credits", "capacity", "teacher", "slots", "prereqs"))
        ok = (isinstance(sem, str) and isinstance(code, str) and re.fullmatch(r"[A-Z]{2,4}[0-9]{3}", code)
              and isinstance(title, str) and title and is_int(credits) and 1 <= credits <= 6
              and is_int(cap) and cap >= 1 and is_int(teacher)
              and isinstance(slots, list) and slots and isinstance(prereqs, list)
              and all(isinstance(p, str) and re.fullmatch(r"[A-Z]{2,4}[0-9]{3}", p) for p in prereqs))
        if not ok:
            raise invalid()
        t = self.s["users"].get(str(teacher))
        if t is None or t["role"] != "teacher":
            raise invalid()
        clean = []
        for sl in slots:
            if not isinstance(sl, dict) or not is_int(sl.get("day")) or not 1 <= sl["day"] <= 5:
                raise invalid()
            if minutes(sl.get("start")) >= minutes(sl.get("end")):
                raise invalid()
            clean.append({"day": sl["day"], "start": sl["start"], "end": sl["end"]})
        for i in range(len(clean)):
            for j in range(i + 1, len(clean)):
                if overlap(clean[i], clean[j]):
                    raise invalid()
        if sem not in self.s["semesters"]:
            raise not_found()
        if self.s["semesters"][sem] != "planning":
            raise conflict("bad_state")
        key = self.course_key(sem, code)
        if key in self.s["courses"]:
            raise conflict()
        c = {"semester": sem, "code": code, "title": title, "credits": credits, "capacity": cap,
             "teacher": teacher, "slots": clean, "prereqs": list(prereqs), "enrolled": [], "waitlist": [],
             "grades": {}}
        self.s["courses"][key] = c
        self.save()
        return 201, self.course_public(c)

    def list_courses(self, user, query, body):
        def one(name):
            v = query.get(name)
            return v[-1] if v else None

        sem, teacher, q = one("semester"), one("teacher"), one("q")
        try:
            page = int(one("page") or 1)
            per = int(one("per_page") or 20)
            teacher_id = int(teacher) if teacher is not None else None
        except ValueError:
            raise invalid()
        if page < 1 or not 1 <= per <= 100:
            raise invalid()
        items = [c for c in self.s["courses"].values()
                 if (sem is None or c["semester"] == sem) and (teacher_id is None or c["teacher"] == teacher_id)
                 and (q is None or q.lower() in c["code"].lower() or q.lower() in c["title"].lower())]
        items.sort(key=lambda c: (c["semester"], c["code"]))
        page_items = items[(page - 1) * per: page * per]
        return 200, {"items": [self.course_public(c) for c in page_items], "total": len(items)}

    def get_course(self, user, sem, code, query, body):
        return 200, self.course_public(self.course(sem, code))

    def patch_course(self, user, sem, code, query, body):
        c = self.course(sem, code)
        self.require(user, "admin")
        cap = self.json(body).get("capacity")
        if not is_int(cap) or cap < 1:
            raise invalid()
        if self.s["semesters"][sem] not in ("planning", "open"):
            raise conflict("bad_state")
        if cap < len(c["enrolled"]):
            raise conflict("capacity_below_enrolled")
        c["capacity"] = cap
        self.promote(c)
        self.save()
        return 200, self.course_public(c)

    # -- enrolment --
    def enroll(self, user, query, body):
        self.require(user, "student")
        d = self.json(body)
        sem, code = d.get("semester"), d.get("code")
        if not isinstance(sem, str) or not isinstance(code, str):
            raise invalid()
        c = self.course(sem, code)
        sid = user["id"]
        if self.s["semesters"][sem] != "open":
            raise conflict("bad_state")
        if sid in c["enrolled"] or sid in c["waitlist"]:
            raise conflict("already_enrolled")
        if self.passed(sid, code):
            raise conflict("already_passed")
        if not all(self.passed(sid, p) for p in c["prereqs"]):
            raise conflict("prereq_missing")
        problem = self.fits(sid, c)
        if problem:
            raise conflict(problem)
        if len(c["enrolled"]) < c["capacity"]:
            c["enrolled"].append(sid)
            self.save()
            return 201, {"status": "enrolled"}
        c["waitlist"].append(sid)
        self.save()
        return 201, {"status": "waitlisted", "position": len(c["waitlist"])}

    def drop(self, user, sem, code, query, body):
        c = self.course(sem, code)
        self.require(user, "student")
        if self.s["semesters"][sem] != "open":
            raise conflict("bad_state")
        sid = user["id"]
        if sid in c["enrolled"]:
            c["enrolled"].remove(sid)
            self.promote(c)
        elif sid in c["waitlist"]:
            c["waitlist"].remove(sid)
        else:
            raise not_found()
        self.save()
        return 200, {"status": "dropped"}

    def schedule(self, user, uid, query, body):
        u = self.target_user(uid)
        if user["role"] != "admin" and user["id"] != u["id"]:
            raise forbidden()
        sem = (query.get("semester") or [None])[-1]
        if sem is None:
            raise invalid()
        if sem not in self.s["semesters"]:
            raise not_found()
        enrolled = sorted(self.student_courses(u["id"], sem), key=lambda c: c["code"])
        waiting = sorted((c for c in self.s["courses"].values() if c["semester"] == sem and u["id"] in c["waitlist"]),
                         key=lambda c: c["code"])
        return 200, {"enrolled": [{"code": c["code"], "title": c["title"], "credits": c["credits"],
                                   "slots": c["slots"]} for c in enrolled],
                     "waitlisted": [{"code": c["code"], "position": c["waitlist"].index(u["id"]) + 1} for c in waiting],
                     "credits": sum(c["credits"] for c in enrolled)}

    # -- roster and grades --
    def roster(self, user, sem, code, query, body):
        c = self.course(sem, code)
        if user["role"] != "admin" and user["id"] != c["teacher"]:
            raise forbidden()
        people = lambda ids: [self.user_public(self.s["users"][str(i)]) for i in ids]  # noqa: E731
        enrolled = sorted(people(c["enrolled"]), key=lambda u: u["username"])
        strip = lambda u: {"id": u["id"], "username": u["username"], "name": u["name"]}  # noqa: E731
        return 200, {"enrolled": [strip(u) for u in enrolled], "waitlist": [strip(u) for u in people(c["waitlist"])]}

    def put_grades(self, user, sem, code, query, body):
        c = self.course(sem, code)
        if user["id"] != c["teacher"]:
            raise forbidden()
        grades = self.json(body).get("grades")
        if not isinstance(grades, dict):
            raise invalid()
        clean = {}
        for k, v in grades.items():
            if not re.fullmatch(r"[0-9]+", k) or int(k) not in c["enrolled"] or not is_int(v) or not 0 <= v <= 100:
                raise invalid()
            clean[str(int(k))] = v
        if self.s["semesters"][sem] != "closed":
            raise conflict("bad_state")
        c["grades"].update(clean)
        self.save()
        return 200, {"updated": len(clean)}

    def transcript(self, user, uid, query, body):
        u = self.target_user(uid)
        if user["role"] != "admin" and user["id"] != u["id"]:
            raise forbidden()
        recs = self.records(u["id"])
        return 200, {"courses": recs, "gpa": self.gpa(recs),
                     "credits_earned": sum(r["credits"] for r in recs if r["score"] >= 60)}

    # -- reports --
    def semester_report(self, user, code, query, body):
        if code not in self.s["semesters"]:
            raise not_found()
        self.require(user, "admin")
        cs = [c for c in self.s["courses"].values() if c["semester"] == code]
        fill = round2(sum(len(c["enrolled"]) / c["capacity"] for c in cs) / len(cs)) if cs else 0.0
        return 200, {"courses": len(cs), "enrolled": sum(len(c["enrolled"]) for c in cs),
                     "waitlisted": sum(len(c["waitlist"]) for c in cs),
                     "full": sorted(c["code"] for c in cs if len(c["enrolled"]) == c["capacity"]),
                     "fill_rate": fill}

    def top_students(self, user, query, body):
        self.require(user, "admin")
        sem = (query.get("semester") or [None])[-1]
        try:
            n = int((query.get("n") or ["10"])[-1])
        except ValueError:
            raise invalid()
        if sem is None or not 1 <= n <= 100:
            raise invalid()
        if sem not in self.s["semesters"]:
            raise not_found()
        if self.s["semesters"][sem] != "graded":
            raise conflict("bad_state")
        items = []
        for u in self.s["users"].values():
            if u["role"] != "student":
                continue
            recs = self.records(u["id"], sem)
            if recs:
                items.append({"id": u["id"], "username": u["username"], "gpa": self.gpa(recs)})
        items.sort(key=lambda x: (-x["gpa"], x["username"]))
        return 200, {"items": items[:n]}


def make_handler(service: Service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _do(self):
            url = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            with service.lock:
                try:
                    status, payload = service.handle(self.command, url.path, parse_qs(url.query), self.headers, body)
                except ApiError as e:
                    status, payload = e.status, {"error": e.code}
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _do

    return Handler


def serve(port, data_dir):
    service = Service(data_dir)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(service))
    server.daemon_threads = True
    print("ready", flush=True)
    server.serve_forever()
