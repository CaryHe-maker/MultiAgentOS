"""Devices and their batches of readings, passed on to records once per batch."""
import secrets

from .common import HttpError, call, check_reading, database, serve

conn, lock = database("ingest")
conn.execute("CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, user_id INTEGER, name TEXT, key TEXT UNIQUE)")
conn.execute("CREATE TABLE IF NOT EXISTS batches (device_id TEXT, batch_id TEXT, PRIMARY KEY (device_id, batch_id))")


def add_device(request):
    user = request.user()
    name = request.body.get("name")
    if not isinstance(name, str) or not name:
        raise HttpError(400, "name is required")
    device, key = f"dev_{secrets.token_hex(6)}", secrets.token_hex(16)
    with lock:
        conn.execute("INSERT INTO devices VALUES (?, ?, ?, ?)", (device, user, name, key))
    return 201, {"device_id": device, "device_key": key}


def batch(request):
    row = conn.execute("SELECT device_id, user_id FROM devices WHERE key = ?", (request.headers.get("X-Device-Key", ""),)).fetchone()
    if row is None:
        raise HttpError(401, "unknown device key")
    device, user = row
    batch_id, readings = request.body.get("batch_id"), request.body.get("readings")
    if not isinstance(batch_id, str) or not batch_id or not isinstance(readings, list):
        raise HttpError(400, "batch_id and readings are required")
    for reading in readings:
        check_reading(reading)
    if conn.execute("SELECT 1 FROM batches WHERE device_id = ? AND batch_id = ?", (device, batch_id)).fetchone():
        return 200, {"accepted": 0, "duplicate": True}
    for reading in readings:
        status, _ = call("records", "POST", "/vitals", dict(reading, source="device"), {"X-User": str(user)})
        if status != 201:
            raise HttpError(502, "records refused a reading")
    with lock:
        conn.execute("INSERT OR IGNORE INTO batches VALUES (?, ?)", (device, batch_id))
    return 202, {"accepted": len(readings), "duplicate": False}


if __name__ == "__main__":
    serve("ingest", [("POST", "/devices", add_device), ("POST", "/batch", batch)])
