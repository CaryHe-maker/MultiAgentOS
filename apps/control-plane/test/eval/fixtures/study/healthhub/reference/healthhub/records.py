"""Vitals and medications; every change is an event in an outbox, delivered until acknowledged."""
import json
import re
import threading
import time

from .common import HttpError, Unavailable, call, check_reading, database, serve, valid_at

conn, lock = database("records")
conn.execute(
    "CREATE TABLE IF NOT EXISTS vitals (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, value REAL,"
    " at TEXT, source TEXT, deleted INTEGER DEFAULT 0)"
)
conn.execute("CREATE TABLE IF NOT EXISTS medications (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, dose TEXT, times TEXT)")
conn.execute("CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY, target TEXT, event TEXT, delivered INTEGER DEFAULT 0)")
TARGETS = ("analytics", "notify")


def emit(event):
    for target in TARGETS:
        conn.execute("INSERT INTO outbox (target, event) VALUES (?, ?)", (target, json.dumps(event)))


def add_vital(request):
    user = request.user()
    check_reading(request.body)
    source = "device" if request.body.get("source") == "device" else "manual"
    with lock:
        conn.execute("BEGIN")
        cursor = conn.execute(
            "INSERT INTO vitals (user_id, type, value, at, source) VALUES (?, ?, ?, ?, ?)",
            (user, request.body["type"], request.body["value"], request.body["at"], source),
        )
        vital = cursor.lastrowid
        emit({"kind": "vital_added", "id": vital, "user_id": user, "type": request.body["type"],
              "value": request.body["value"], "at": request.body["at"], "created": time.time()})
        conn.execute("COMMIT")
    return 201, {"id": vital}


def list_vitals(request):
    user = request.user()
    sql, args = "SELECT id, type, value, at, source FROM vitals WHERE user_id = ? AND deleted = 0", [user]
    kind = request.arg("type", False)
    if kind is not None:
        sql, args = sql + " AND type = ?", args + [kind]
    for name, op in (("from", ">="), ("to", "<=")):
        bound = request.arg(name, False)
        if bound is not None:
            if not valid_at(bound):
                raise HttpError(400, f"{name} must be YYYY-MM-DDTHH:MM:SSZ")
            sql, args = sql + f" AND at {op} ?", args + [bound]
    rows = conn.execute(sql + " ORDER BY at, id", args).fetchall()
    return 200, {"items": [{"id": r[0], "type": r[1], "value": r[2], "at": r[3], "source": r[4]} for r in rows]}


def delete_vital(request):
    user, vital = request.user(), int(request.match.group(1))
    with lock:
        conn.execute("BEGIN")
        cursor = conn.execute("UPDATE vitals SET deleted = 1 WHERE id = ? AND user_id = ? AND deleted = 0", (vital, user))
        if cursor.rowcount == 0:
            conn.execute("ROLLBACK")
            raise HttpError(404, "no such record")
        emit({"kind": "vital_deleted", "id": vital, "user_id": user})
        conn.execute("COMMIT")
    return 204, None


TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def add_medication(request):
    user = request.user()
    times = request.body.get("times")
    name, dose = request.body.get("name"), request.body.get("dose")
    if not isinstance(name, str) or not name or not isinstance(dose, str):
        raise HttpError(400, "name and dose are required")
    if not isinstance(times, list) or not times or not all(isinstance(t, str) and TIME.match(t) for t in times):
        raise HttpError(400, "times are HH:MM, at least one")
    with lock:
        cursor = conn.execute("INSERT INTO medications (user_id, name, dose, times) VALUES (?, ?, ?, ?)", (user, name, dose, json.dumps(times)))
    return 201, {"id": cursor.lastrowid}


def list_medications(request):
    rows = conn.execute("SELECT id, name, dose, times FROM medications WHERE user_id = ? ORDER BY id", (request.user(),)).fetchall()
    return 200, {"items": [{"id": r[0], "name": r[1], "dose": r[2], "times": json.loads(r[3])} for r in rows]}


def publish():
    while True:
        for target in TARGETS:
            rows = conn.execute("SELECT seq, event FROM outbox WHERE target = ? AND delivered = 0 ORDER BY seq LIMIT 100", (target,)).fetchall()
            if not rows:
                continue
            try:
                status, _ = call(target, "POST", "/events", {"events": [json.loads(r[1]) for r in rows]}, timeout=2)
            except Unavailable:
                continue
            if status == 200:
                with lock:
                    conn.executemany("UPDATE outbox SET delivered = 1 WHERE seq = ?", [(r[0],) for r in rows])
        time.sleep(0.3)


if __name__ == "__main__":
    serve(
        "records",
        [
            ("POST", "/vitals", add_vital),
            ("GET", "/vitals", list_vitals),
            ("DELETE", r"/vitals/(\d+)", delete_vital),
            ("POST", "/medications", add_medication),
            ("GET", "/medications", list_medications),
        ],
        on_start=lambda: threading.Thread(target=publish, daemon=True).start(),
    )
