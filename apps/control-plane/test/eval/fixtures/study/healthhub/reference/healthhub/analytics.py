"""Daily summaries and trends from its own copy of the readings, kept by the events of records."""
from datetime import date, timedelta

from .common import TYPES, HttpError, database, serve, valid_date

conn, lock = database("analytics")
conn.execute(
    "CREATE TABLE IF NOT EXISTS readings (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, value REAL,"
    " day TEXT, deleted INTEGER DEFAULT 0)"
)


def events(request):
    with lock:
        for event in request.body.get("events", []):
            if event["kind"] == "vital_added":
                conn.execute(
                    "INSERT OR IGNORE INTO readings (id, user_id, type, value, day) VALUES (?, ?, ?, ?, ?)",
                    (event["id"], event["user_id"], event["type"], event["value"], event["at"][:10]),
                )
            elif event["kind"] == "vital_deleted":
                conn.execute("UPDATE readings SET deleted = 1 WHERE id = ?", (event["id"],))
    return 200, {"ok": True}


def daily(request):
    day = request.arg("date")
    if not valid_date(day):
        raise HttpError(400, "date must be YYYY-MM-DD")
    rows = conn.execute(
        "SELECT type, COUNT(*), MIN(value), MAX(value), AVG(value) FROM readings"
        " WHERE user_id = ? AND day = ? AND deleted = 0 GROUP BY type",
        (request.user(), day),
    ).fetchall()
    return 200, {"date": day, "metrics": {r[0]: {"count": r[1], "min": r[2], "max": r[3], "avg": round(r[4], 2)} for r in rows}}


def trends(request):
    kind, end = request.arg("type"), request.arg("end")
    if kind not in TYPES or not valid_date(end):
        raise HttpError(400, "type and end are required")
    try:
        days = int(request.arg("days"))
    except ValueError:
        raise HttpError(400, "days must be a number") from None
    last = date.fromisoformat(end)
    first = (last - timedelta(days=days - 1)).isoformat()
    rows = conn.execute(
        "SELECT day, AVG(value) FROM readings WHERE user_id = ? AND type = ? AND deleted = 0 AND day BETWEEN ? AND ?"
        " GROUP BY day ORDER BY day",
        (request.user(), kind, first, end),
    ).fetchall()
    return 200, {"type": kind, "points": [{"date": r[0], "avg": round(r[1], 2)} for r in rows]}


if __name__ == "__main__":
    serve("analytics", [("POST", "/events", events), ("GET", "/summary/daily", daily), ("GET", "/trends", trends)])
