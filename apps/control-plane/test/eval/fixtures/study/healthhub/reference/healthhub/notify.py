"""Thresholds, alerts from the events of records, and medication reminders."""
import time

from .common import TYPES, HttpError, call, database, serve, valid_date

conn, lock = database("notify")
conn.execute("CREATE TABLE IF NOT EXISTS thresholds (user_id INTEGER, type TEXT, min REAL, max REAL, since REAL, PRIMARY KEY (user_id, type))")
conn.execute(
    "CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, value REAL, at TEXT,"
    " kind TEXT, vital_id INTEGER UNIQUE)"
)


def number_or_none(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HttpError(400, "min and max are numbers")
    return value


def put_threshold(request):
    user, kind = request.user(), request.body.get("type")
    if kind not in TYPES:
        raise HttpError(400, "unknown type")
    low, high = number_or_none(request.body.get("min")), number_or_none(request.body.get("max"))
    with lock:
        conn.execute("INSERT OR REPLACE INTO thresholds VALUES (?, ?, ?, ?, ?)", (user, kind, low, high, time.time()))
    return 200, {"type": kind, "min": low, "max": high}


def events(request):
    with lock:
        for event in request.body.get("events", []):
            if event["kind"] != "vital_added":
                continue
            row = conn.execute("SELECT min, max, since FROM thresholds WHERE user_id = ? AND type = ?", (event["user_id"], event["type"])).fetchone()
            if row is None or event.get("created", 0) < row[2]:
                continue
            low, high, _ = row
            kind = "low" if low is not None and event["value"] < low else "high" if high is not None and event["value"] > high else None
            if kind is not None:
                conn.execute(
                    "INSERT OR IGNORE INTO alerts (user_id, type, value, at, kind, vital_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (event["user_id"], event["type"], event["value"], event["at"], kind, event["id"]),
                )
    return 200, {"ok": True}


def alerts(request):
    rows = conn.execute("SELECT id, type, value, at, kind FROM alerts WHERE user_id = ? ORDER BY id", (request.user(),)).fetchall()
    return 200, {"items": [{"id": r[0], "type": r[1], "value": r[2], "at": r[3], "kind": r[4]} for r in rows]}


def reminders(request):
    day = request.arg("date")
    if not valid_date(day):
        raise HttpError(400, "date must be YYYY-MM-DD")
    status, body = call("records", "GET", "/medications", headers={"X-User": str(request.user())})
    if status != 200:
        raise HttpError(503, "records unavailable")
    items = [
        {"medication_id": m["id"], "name": m["name"], "dose": m["dose"], "time": t}
        for m in body["items"]
        for t in m["times"]
    ]
    items.sort(key=lambda item: (item["time"], item["medication_id"]))
    return 200, {"date": day, "items": items}


if __name__ == "__main__":
    serve(
        "notify",
        [
            ("POST", "/events", events),
            ("PUT", "/thresholds", put_threshold),
            ("GET", "/alerts", alerts),
            ("GET", "/reminders", reminders),
        ],
    )
