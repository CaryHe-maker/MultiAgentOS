"""The only public entry: checks tokens and passes requests on with the user."""
from urllib.parse import quote, urlencode

from .common import HttpError, call, serve

ROUTES = [
    ("/vitals", "records"),
    ("/medications", "records"),
    ("/devices", "ingest"),
    ("/summary", "analytics"),
    ("/trends", "analytics"),
    ("/thresholds", "notify"),
    ("/alerts", "notify"),
    ("/reminders", "notify"),
]


def query_of(request):
    pairs = [(key, value) for key, values in request.query.items() for value in values]
    return f"?{urlencode(pairs)}" if pairs else ""


def public(service, path):
    return lambda request: call(service, "POST", path, request.body)


def authenticated(method):
    def handle(request):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise HttpError(401, "log in first")
        token = header[len("Bearer "):]
        status, who = call("identity", "GET", f"/verify?token={quote(token)}")
        if status != 200:
            raise HttpError(401, "invalid token")
        rest = request.match.group(1)
        if rest == "/me" and method == "GET":
            return 200, who
        if rest == "/logout" and method == "POST":
            return call("identity", "POST", "/logout", {"token": token})
        for prefix, service in ROUTES:
            if rest == prefix or rest.startswith(prefix + "/"):
                return call(
                    service,
                    method,
                    rest + query_of(request),
                    request.body if method in ("POST", "PUT") else None,
                    {"X-User": str(who["user_id"])},
                )
        raise HttpError(404, "not found")

    return handle


def ingest(request):
    return call("ingest", "POST", "/batch", request.body, {"X-Device-Key": request.headers.get("X-Device-Key", "")})


if __name__ == "__main__":
    serve(
        "gateway",
        [
            ("POST", "/api/register", public("identity", "/register")),
            ("POST", "/api/login", public("identity", "/login")),
            ("POST", "/ingest/batch", ingest),
        ]
        + [(method, "/api(/.*)", authenticated(method)) for method in ("GET", "POST", "PUT", "DELETE")],
    )
