# coursereg

Course registration service (HTTP + JSON), Python 3 standard library only.

    python3 -m coursereg --port 8080 --data ./data

The server prints `ready` once it accepts requests. Log in as `admin`/`admin` with `POST /login`
and send `Authorization: Bearer <token>` on every other request. Errors are `{"error": code}`.

Endpoints: `POST /login`; `POST /users`, `GET /users/{id}`; `POST /semesters`, `GET /semesters`,
`POST /semesters/{code}/state`; `POST /courses`, `GET /courses`, `GET|PATCH /courses/{sem}/{code}`,
`GET /courses/{sem}/{code}/roster`, `PUT /courses/{sem}/{code}/grades`; `POST /enrollments`,
`DELETE /enrollments/{sem}/{code}`; `GET /students/{id}/schedule?semester=`,
`GET /students/{id}/transcript`; `GET /reports/semester/{code}`, `GET /reports/top-students`.

Enrolment checks, in order: semester open, not already enrolled or waitlisted, not already passed,
prerequisites passed in a graded semester, no clash with enrolled courses, at most 25 credits. A full
course puts the student on its waitlist; free seats go to the first waitlisted student who still fits.

Tests: `python3 -m unittest discover -s tests -t .`.
