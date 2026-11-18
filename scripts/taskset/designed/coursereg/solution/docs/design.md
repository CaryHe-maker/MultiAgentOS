# coursereg design

## Data model
One JSON document: users (id, username, role, name, salted password hash), tokens (token to user
id), semesters (code to state) and courses keyed by `semester/code`. A course holds its attributes,
the ordered list of enrolled student ids, the ordered waitlist, and grades (student id to score).

## Persistence
After every change, before the response is sent, the whole document is written to `state.json.tmp`
and renamed over `state.json`. The rename is atomic, so a process killed at any moment leaves either
the previous or the new document, and every acknowledged change is on disk. Startup reads the file.

## Concurrency
`ThreadingHTTPServer` handles connections in threads; one lock around request handling makes every
request atomic, so concurrent requests behave as if executed one after another.

## Waitlist promotion
Whenever seats free up (a drop or a larger capacity), the waitlist is scanned from the front for the
first student whose enrolled courses do not clash with the course and whose credits stay within 25.
That student moves to the enrolled list; the scan repeats until no seat or no fitting student is
left. Students who do not fit keep their relative order.

## GPA
Points follow the table in the specification; GPA is the credit-weighted mean over graded semesters,
rounded half up with `decimal` to two places.
