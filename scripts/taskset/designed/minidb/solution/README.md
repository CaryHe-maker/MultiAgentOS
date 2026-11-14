# minidb

A small relational database written with the Python 3 standard library only.

    python3 -m minidb <database directory> [SQL]

Without the SQL argument the script is read from standard input. Statements are separated by
semicolons. `SELECT` prints a header line and one line per row, values joined by `|`; `INSERT`,
`UPDATE` and `DELETE` print `inserted N`, `updated N` and `deleted N`. Errors go to stderr as
`error: ...` with exit code 1 and stop the script.

Supported SQL: `CREATE TABLE` (INTEGER, REAL, TEXT; PRIMARY KEY, NOT NULL, UNIQUE, DEFAULT),
`DROP TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX`, `DROP INDEX`, `INSERT`, `UPDATE`,
`DELETE`, `BEGIN`/`COMMIT`/`ROLLBACK`, and `SELECT` with DISTINCT, inner and left joins, WHERE,
GROUP BY, HAVING, ORDER BY and LIMIT/OFFSET. Expressions have SQL three-valued logic, arithmetic,
`||`, comparisons, LIKE, IN, BETWEEN, CASE, LENGTH, UPPER, LOWER, ABS, ROUND, SUBSTR, COALESCE and
the aggregates COUNT, SUM, AVG, MIN and MAX.

Run the tests with `python3 -m unittest discover -s tests -t .`.
