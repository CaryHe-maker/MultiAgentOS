"""What every service shares: ports, data folders, a JSON HTTP server and client, validation."""
import json
import os
import re
import sqlite3
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SERVICES = ["gateway", "identity", "records", "ingest", "analytics", "notify"]
TYPES = {"heart_rate", "steps", "weight", "systolic", "glucose"}


def port(name):
    return int(os.environ.get("HH_PORT_BASE", "8700")) + SERVICES.index(name)


def database(name):
    folder = os.path.join(os.environ.get("HH_DATA", "./data"), name)
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(os.path.join(folder, "db.sqlite"), check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn, threading.Lock()


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Unavailable(Exception):
    pass


def call(service, method, path, body=None, headers=None, timeout=3):
    """(status, json) of a request to another service; Unavailable when it cannot be reached."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port(service)}{path}", data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, (json.loads(raw) if raw else None)
        except ValueError:
            return error.code, {"error": raw.decode(errors="replace")}
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as error:
        raise Unavailable(str(error)) from None


class Request:
    def __init__(self, handler, match, query, body):
        self.headers = handler.headers
        self.match = match
        self.query = query
        self.body = body

    def arg(self, name, required=True):
        values = self.query.get(name)
        if not values:
            if required:
                raise HttpError(400, f"{name} is required")
            return None
        return values[0]

    def user(self):
        user = self.headers.get("X-User")
        if not user:
            raise HttpError(401, "no user")
        return int(user)


def serve(name, routes, on_start=None):
    """Serves `routes`: (method, regex of the path, handler(request) -> (status, body))."""
    compiled = [(method, re.compile(f"^{pattern}$"), handler) for method, pattern, handler in routes]
    compiled.append(("GET", re.compile("^/health$"), lambda request: (200, {"service": name, "status": "ok"})))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_any(self, method):
            parts = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                return self.reply(400, {"error": "the body is not JSON"})
            for wanted, pattern, handler in compiled:
                match = pattern.match(parts.path)
                if match and wanted == method:
                    try:
                        status, out = handler(Request(self, match, parse_qs(parts.query), body))
                    except HttpError as error:
                        status, out = error.status, {"error": error.message}
                    except Unavailable:
                        status, out = 503, {"error": "unavailable"}
                    return self.reply(status, out)
            return self.reply(404, {"error": "not found"})

        def reply(self, status, out):
            data = b"" if status == 204 or out is None else json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PUT(self):
            self.handle_any("PUT")

        def do_DELETE(self):
            self.handle_any("DELETE")

    server = ThreadingHTTPServer(("127.0.0.1", port(name)), Handler)
    server.daemon_threads = True
    if on_start is not None:
        on_start()
    server.serve_forever()


AT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def valid_at(text):
    if not isinstance(text, str) or not AT.match(text):
        return False
    try:
        datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
        return True
    except ValueError:
        return False


def valid_date(text):
    try:
        datetime.strptime(text or "", "%Y-%m-%d")
        return True
    except ValueError:
        return False


def check_reading(reading):
    if not isinstance(reading, dict) or reading.get("type") not in TYPES:
        raise HttpError(400, "unknown type")
    value = reading.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HttpError(400, "value must be a number")
    if not valid_at(reading.get("at")):
        raise HttpError(400, "at must be YYYY-MM-DDTHH:MM:SSZ")
