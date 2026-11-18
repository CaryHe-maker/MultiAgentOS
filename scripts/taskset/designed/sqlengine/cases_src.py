"""SQL scripts of the sqlengine task. build_cases.py runs each statement with Python's sqlite3 (SQLite 3.46)
in the task image and records the output in the task's format. Every multi-row query has a top-level
ORDER BY, so outputs compare exactly."""

COMPANY = [
    "CREATE TABLE dept(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, budget REAL)",
    "CREATE TABLE emp(id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept_id INTEGER, salary REAL, hired TEXT, "
    "manager INTEGER, email TEXT)",
    "INSERT INTO dept VALUES (1, 'eng', 500000), (2, 'ops', 120000.5), (3, 'hr', NULL), (4, 'empty', 10)",
    "INSERT INTO emp VALUES (1, 'Ann', 1, 120000, '2019-03-01', NULL, 'ann@x.com'), "
    "(2, 'Bob', 1, 95000, '2020-07-15', 1, 'bob@x.com'), (3, 'Cid', 2, 70000, '2018-01-20', 1, NULL), "
    "(4, 'Dee', 2, 82000.5, '2021-11-30', 3, 'dee@y.org'), (5, 'Eve', NULL, 50000, '2022-02-01', 1, 'eve@x.com'), "
    "(6, 'fay', 3, 61000, '2017-06-09', 1, 'FAY@X.COM'), (7, 'Gus', 1, 95000, '2023-01-05', 2, NULL)",
]
CASES = []


def c(name, statements, setup=COMPANY):
    CASES.append({"name": name, "statements": list(setup) + list(statements)})


# ---------------- basics, types and affinity
c("select_literals", ["SELECT 1, 2.5, 'text', NULL, x'0aff', 1 + 2 * 3, 7 / 2, 7.0 / 2, 7 % 3, -7 % 3, 2 || 3"], setup=[])
c("typeof_and_affinity", [
    "CREATE TABLE t(i INTEGER, r REAL, t TEXT, b BLOB, n NUMERIC, x)",
    "INSERT INTO t VALUES ('12', '12', 12, 12, '12.0', '12'), ('1.5', 3, 4.0, 'b', 'abc', 1.0), (NULL, '1e2', x'00', x'01', '0x10', x'02')",
    "SELECT typeof(i), i, typeof(r), r, typeof(t), t, typeof(b), typeof(n), n, typeof(x), x FROM t ORDER BY rowid",
], setup=[])
c("integer_overflow_and_division", [
    "SELECT 9223372036854775807 + 1, -9223372036854775808 - 1, 9223372036854775807 * 2, 5 / 0, 5 % 0, 5.0 / 0, "
    "-9223372036854775808 / -1, 1e308 * 10, typeof(9223372036854775807 + 0)"], setup=[])
c("comparison_rules", [
    "SELECT 1 = 1.0, '1' = 1, 1 < 'a', x'00' > 'z', NULL = NULL, NULL IS NULL, 1 IS 1, 'a' < 'b', 'B' < 'a', "
    "'a' = 'A' COLLATE NOCASE, 2 IS NOT DISTINCT FROM 2, NULL IS DISTINCT FROM 1",
    "CREATE TABLE t(a TEXT, b INTEGER)", "INSERT INTO t VALUES ('10', '10'), ('9', '9')",
    "SELECT a < '9', b < 9, a = 10, b = '10' FROM t ORDER BY rowid"], setup=[])
c("three_valued_logic", [
    "SELECT NULL AND 0, NULL AND 1, NULL OR 1, NULL OR 0, NOT NULL, 1 AND 2, 0 OR 0, NULL IN (1, 2), 1 IN (1, NULL), "
    "3 NOT IN (1, NULL), 3 BETWEEN 1 AND NULL"], setup=[])
c("cast_rules", [
    "SELECT CAST('12abc' AS INTEGER), CAST('  7 ' AS INTEGER), CAST(3.99 AS INTEGER), CAST(-3.99 AS INTEGER), "
    "CAST('1e3' AS REAL), CAST(12 AS TEXT) || 'x', CAST('abc' AS NUMERIC), CAST('3.0' AS NUMERIC), typeof(CAST('3.0' AS NUMERIC)), "
    "CAST(x'414243' AS TEXT), typeof(CAST('5' AS BLOB)), CAST(NULL AS INTEGER)"], setup=[])
c("rowid_and_integer_primary_key", [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)",
    "INSERT INTO t(v) VALUES ('a'), ('b')", "INSERT INTO t VALUES (10, 'c')", "INSERT INTO t(v) VALUES ('d')",
    "SELECT rowid, id, v FROM t ORDER BY id", "INSERT INTO t VALUES ('x', 'bad')", "INSERT INTO t VALUES (10, 'dup')",
    "DELETE FROM t WHERE id = 11", "INSERT INTO t(v) VALUES ('e')", "SELECT id, v FROM t ORDER BY id"], setup=[])
c("constraints", [
    "CREATE TABLE t(a INTEGER NOT NULL, b TEXT UNIQUE, c INTEGER CHECK (c > 0), d TEXT DEFAULT 'dflt', "
    "e REAL DEFAULT (1.5 * 2), UNIQUE(a, c))",
    "INSERT INTO t(a, b, c) VALUES (1, 'x', 5)", "INSERT INTO t(a, b, c) VALUES (NULL, 'y', 5)",
    "INSERT INTO t(a, b, c) VALUES (2, 'x', 5)", "INSERT INTO t(a, b, c) VALUES (2, 'z', 0)",
    "INSERT INTO t(a, b, c) VALUES (1, 'w', 5)", "INSERT INTO t(a, b, c) VALUES (2, NULL, 6), (3, NULL, 7)",
    "SELECT * FROM t ORDER BY a"], setup=[])
c("insert_or_replace_ignore", [
    "CREATE TABLE kv(k TEXT PRIMARY KEY, v INTEGER)", "INSERT INTO kv VALUES ('a', 1), ('b', 2)",
    "INSERT OR REPLACE INTO kv VALUES ('a', 10)", "INSERT OR IGNORE INTO kv VALUES ('b', 20), ('c', 3)",
    "REPLACE INTO kv VALUES ('d', 4)", "SELECT * FROM kv ORDER BY k"], setup=[])
c("upsert", [
    "CREATE TABLE stock(item TEXT PRIMARY KEY, qty INTEGER, updated INTEGER DEFAULT 0)",
    "INSERT INTO stock VALUES ('apple', 5, 0)",
    "INSERT INTO stock(item, qty) VALUES ('apple', 3), ('pear', 2) ON CONFLICT(item) DO UPDATE SET qty = qty + excluded.qty, updated = 1",
    "INSERT INTO stock(item, qty) VALUES ('pear', 100) ON CONFLICT DO NOTHING",
    "INSERT INTO stock(item, qty) VALUES ('kiwi', 1) ON CONFLICT(item) DO UPDATE SET qty = 0 WHERE excluded.qty > 5",
    "SELECT * FROM stock ORDER BY item"], setup=[])
c("returning", [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, n INTEGER DEFAULT 0)",
    "INSERT INTO t(v) VALUES ('a') RETURNING id, v, n", "INSERT INTO t(v) VALUES ('b') RETURNING id, v, n",
    "UPDATE t SET n = n + 5 WHERE v = 'b' RETURNING id, n * 2",
    "DELETE FROM t WHERE id = 1 RETURNING *", "SELECT * FROM t"], setup=[])
c("default_values_and_expressions", [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT DEFAULT 'x', b INTEGER DEFAULT -1, c REAL)",
    "INSERT INTO t DEFAULT VALUES", "INSERT INTO t(c) VALUES (2.5)", "SELECT * FROM t ORDER BY id"], setup=[])

# ---------------- select and filtering
c("where_order_limit", [
    "SELECT name, salary FROM emp WHERE salary > 60000 ORDER BY salary DESC, name LIMIT 3",
    "SELECT name FROM emp ORDER BY name LIMIT 2 OFFSET 2", "SELECT name FROM emp ORDER BY name COLLATE NOCASE",
    "SELECT name, dept_id FROM emp ORDER BY dept_id NULLS LAST, name", "SELECT name, dept_id FROM emp ORDER BY dept_id DESC NULLS FIRST, id",
    "SELECT name FROM emp ORDER BY 1 DESC LIMIT 1", "SELECT name AS n FROM emp ORDER BY n LIMIT 1",
    "SELECT name FROM emp ORDER BY id LIMIT -1 OFFSET 5"])
c("distinct_and_expressions", [
    "SELECT DISTINCT dept_id FROM emp ORDER BY dept_id", "SELECT DISTINCT salary > 80000, dept_id IS NULL FROM emp ORDER BY 1, 2",
    "SELECT id, salary * 1.1, salary / 1000, name || '<' || coalesce(email, '-') || '>' FROM emp ORDER BY id"])
c("like_glob_escape", [
    "SELECT name FROM emp WHERE name LIKE 'f%' ORDER BY name", "SELECT name FROM emp WHERE email LIKE '%@x.com' ORDER BY name",
    "SELECT name FROM emp WHERE name GLOB '[A-C]*' ORDER BY name", "SELECT name FROM emp WHERE name GLOB '?u?'",
    "SELECT '50%' LIKE '50!%' ESCAPE '!', 'abc' LIKE 'a_c', 'ABC' LIKE 'abc', 'ABC' GLOB 'abc', 'a.c' GLOB 'a?c'"])
c("in_between_case", [
    "SELECT name FROM emp WHERE dept_id IN (2, 3) ORDER BY name", "SELECT name FROM emp WHERE dept_id NOT IN (1, 2) ORDER BY name",
    "SELECT name FROM emp WHERE salary BETWEEN 60000 AND 90000 ORDER BY salary",
    "SELECT name, CASE WHEN salary >= 95000 THEN 'high' WHEN salary >= 70000 THEN 'mid' ELSE 'low' END, "
    "CASE dept_id WHEN 1 THEN 'eng' WHEN 2 THEN 'ops' END FROM emp ORDER BY id"])

# ---------------- joins
c("inner_left_cross_joins", [
    "SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id ORDER BY e.id",
    "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id ORDER BY e.id",
    "SELECT d.name, count(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.id ORDER BY d.id",
    "SELECT count(*) FROM emp CROSS JOIN dept", "SELECT e.name, m.name FROM emp e LEFT JOIN emp m ON e.manager = m.id ORDER BY e.id",
    "SELECT e.name FROM emp e, dept d WHERE e.dept_id = d.id AND d.budget > 200000 ORDER BY e.name"])
c("using_and_natural_join", [
    "CREATE TABLE a(k INTEGER, x TEXT)", "CREATE TABLE b(k INTEGER, y TEXT)",
    "INSERT INTO a VALUES (1, 'a1'), (2, 'a2'), (3, 'a3')", "INSERT INTO b VALUES (2, 'b2'), (3, 'b3'), (3, 'b3b'), (4, 'b4')",
    "SELECT * FROM a JOIN b USING (k) ORDER BY k, y", "SELECT * FROM a NATURAL JOIN b ORDER BY k, y",
    "SELECT * FROM a LEFT JOIN b USING (k) ORDER BY k, y", "SELECT a.*, b.y FROM a JOIN b ON a.k < b.k ORDER BY a.k, b.y"], setup=[])
c("join_with_subquery_table", [
    "SELECT d.name, s.total FROM dept d JOIN (SELECT dept_id, sum(salary) AS total FROM emp GROUP BY dept_id) s "
    "ON s.dept_id = d.id ORDER BY s.total DESC"])

# ---------------- grouping and aggregates
c("group_by_having", [
    "SELECT dept_id, count(*), sum(salary), avg(salary), min(name), max(hired) FROM emp GROUP BY dept_id ORDER BY dept_id",
    "SELECT dept_id, count(*) AS n FROM emp GROUP BY dept_id HAVING n > 1 ORDER BY n DESC, dept_id",
    "SELECT count(*), count(email), count(DISTINCT dept_id), sum(dept_id), total(dept_id), avg(dept_id) FROM emp",
    "SELECT sum(x), total(x), avg(x), max(x), count(x) FROM (SELECT NULL AS x)",
    "SELECT group_concat(name), group_concat(name, '; ') FROM (SELECT name FROM emp ORDER BY id)",
    "SELECT dept_id, group_concat(DISTINCT salary) FROM emp WHERE dept_id = 1 GROUP BY dept_id",
    "SELECT count(*) FILTER (WHERE salary > 80000), sum(salary) FILTER (WHERE dept_id = 1) FROM emp",
    "SELECT salary > 80000 AS high, count(*) FROM emp GROUP BY high ORDER BY high"])
c("bare_column_with_max", ["SELECT name, max(salary) FROM emp", "SELECT dept_id, name, min(salary) FROM emp GROUP BY dept_id ORDER BY dept_id"])
c("sum_integer_vs_real", [
    "CREATE TABLE n(v)", "INSERT INTO n VALUES (1), (2), (3)", "SELECT sum(v), typeof(sum(v)), avg(v), total(v) FROM n",
    "INSERT INTO n VALUES (0.5)", "SELECT sum(v), typeof(sum(v)) FROM n",
    "INSERT INTO n VALUES (9223372036854775807)", "SELECT sum(v) FROM n", "SELECT total(v) FROM n"], setup=[])

# ---------------- subqueries and set operations
c("scalar_and_correlated_subqueries", [
    "SELECT name, (SELECT name FROM dept WHERE id = emp.dept_id) FROM emp ORDER BY id",
    "SELECT name FROM emp e WHERE salary > (SELECT avg(salary) FROM emp WHERE dept_id = e.dept_id) ORDER BY name",
    "SELECT name FROM dept d WHERE EXISTS (SELECT 1 FROM emp WHERE dept_id = d.id) ORDER BY name",
    "SELECT name FROM dept d WHERE NOT EXISTS (SELECT 1 FROM emp WHERE dept_id = d.id) ORDER BY name",
    "SELECT name FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE budget > 100000) ORDER BY name",
    "SELECT (SELECT max(salary) FROM emp), (SELECT name FROM emp WHERE id = 99)"])
c("set_operations", [
    "SELECT dept_id FROM emp UNION SELECT id FROM dept ORDER BY 1",
    "SELECT dept_id FROM emp UNION ALL SELECT id FROM dept ORDER BY 1",
    "SELECT dept_id FROM emp INTERSECT SELECT id FROM dept ORDER BY 1",
    "SELECT id FROM dept EXCEPT SELECT dept_id FROM emp ORDER BY 1",
    "SELECT name FROM emp WHERE id < 3 UNION SELECT name FROM dept ORDER BY name LIMIT 4",
    "VALUES (1, 'a')", "SELECT * FROM (VALUES (3), (1), (2)) ORDER BY 1"])
c("cte_and_recursive", [
    "WITH big AS (SELECT * FROM emp WHERE salary > 90000) SELECT name FROM big ORDER BY name",
    "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT group_concat(x) FROM cnt",
    "WITH RECURSIVE chain(id, name, depth) AS (SELECT id, name, 0 FROM emp WHERE manager IS NULL "
    "UNION ALL SELECT e.id, e.name, c.depth + 1 FROM emp e JOIN chain c ON e.manager = c.id) "
    "SELECT name, depth FROM chain ORDER BY depth, name",
    "WITH RECURSIVE fib(a, b, n) AS (SELECT 0, 1, 1 UNION ALL SELECT b, a + b, n + 1 FROM fib WHERE n < 30) "
    "SELECT max(a) FROM fib",
    "WITH a AS (SELECT 1 AS x), b AS (SELECT x + 1 AS y FROM a) SELECT * FROM a, b"])

# ---------------- window functions
c("window_ranking", [
    "SELECT name, dept_id, salary, row_number() OVER (PARTITION BY dept_id ORDER BY salary DESC, id), "
    "rank() OVER (ORDER BY salary DESC), dense_rank() OVER (ORDER BY salary DESC) FROM emp ORDER BY id",
    "SELECT name, ntile(3) OVER (ORDER BY id) FROM emp ORDER BY id"])
c("window_aggregates_and_frames", [
    "SELECT id, salary, sum(salary) OVER (ORDER BY id), avg(salary) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), "
    "count(*) OVER () FROM emp ORDER BY id",
    "SELECT id, lag(name) OVER (ORDER BY id), lead(name, 2, 'none') OVER (ORDER BY id), "
    "first_value(name) OVER (PARTITION BY dept_id ORDER BY id), last_value(name) OVER (PARTITION BY dept_id ORDER BY id "
    "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM emp ORDER BY id",
    "SELECT dept_id, salary, max(salary) OVER (PARTITION BY dept_id) - salary FROM emp ORDER BY id"])

# ---------------- functions
c("string_functions", [
    "SELECT length('héllo'), upper('abc'), lower('ÀBC'), substr('hello', 2, 3), substr('hello', -3), substr('hello', 0, 2), "
    "substring('hello', 2), instr('banana', 'na'), replace('aaa', 'a', 'bb'), trim('  x  '), ltrim('xxa', 'x'), "
    "rtrim('ayy', 'y'), trim('--a--', '-')",
    "SELECT hex('abc'), hex(255), unhex('414243'), quote('it''s'), quote(NULL), quote(1.5), quote(x'01'), char(72, 105), "
    "unicode('A'), length(x'0102'), typeof(zeroblob(2)), length(12345), length(NULL)",
    "SELECT printf('%5.2f|%-4s|%04d|%x|%s|%%', 3.14159, 'ab', 42, 255, NULL), format('%d items', 3), "
    "printf('%.3e', 12345.678), printf('%c', 'hello')"])
c("numeric_functions", [
    "SELECT abs(-5), abs(-2.5), round(2.5), round(-2.5), round(3.14159, 2), round(1234.5678, -2), sign(-3), sign(0), "
    "max(3, 7, 5), min(3, 'a', 1), coalesce(NULL, NULL, 'z'), ifnull(NULL, 4), nullif(5, 5), nullif(5, 6), iif(1 > 2, 'y', 'n')",
    "SELECT ceil(1.2), floor(-1.2), sqrt(16), pow(2, 10), mod(7, 3), exp(0), ln(1), log10(1000), log2(8), log(2, 8), "
    "round(pi(), 5), typeof(ceil(1.2))",
    "SELECT 5 & 3, 5 | 3, ~5, 1 << 4, -16 >> 2"], setup=[])
c("date_functions", [
    "SELECT date('2024-01-31', '+1 month'), date('2024-03-15', 'start of month'), date('2024-03-15', '-1 day', 'weekday 0'), "
    "time('12:34:56', '+30 minutes'), datetime('2024-02-28 23:00:00', '+2 hours'), julianday('2000-01-01'), "
    "strftime('%Y/%m/%d %H:%M %j %w', '2024-12-31 08:05:00'), unixepoch('2024-01-01 00:00:00'), date(1700000000, 'unixepoch'), "
    "date('2023-02-29'), date('2024-01-01', '+1 year', '-1 day')",
    "SELECT name, strftime('%Y', hired) AS y FROM emp WHERE hired >= '2020-01-01' ORDER BY hired"], setup=COMPANY)
c("typeof_of_functions", ["SELECT typeof(1/2), typeof(1/2.0), typeof('1' + 1), typeof('a' || 1), typeof(x'00' || 'a'), "
                          "'1' + '2', 'abc' + 1, '3x' * 2, typeof(max(1, 2.0))"], setup=[])
c("changes_function", ["UPDATE emp SET salary = salary + 1 WHERE dept_id = 1", "SELECT changes()",
                       "DELETE FROM emp WHERE id > 100", "SELECT changes()"])

# ---------------- DML
c("update_and_delete", [
    "UPDATE emp SET salary = salary * 1.1, email = lower(email) WHERE dept_id = 1",
    "UPDATE emp SET manager = (SELECT id FROM emp WHERE name = 'Dee') WHERE name = 'Gus'",
    "DELETE FROM emp WHERE email IS NULL", "SELECT id, name, salary, email, manager FROM emp ORDER BY id",
    "UPDATE emp SET name = NULL WHERE id = 1", "SELECT count(*) FROM emp"])
c("update_from", [
    "CREATE TABLE raise(dept_id INTEGER, pct REAL)", "INSERT INTO raise VALUES (1, 0.1), (2, 0.2)",
    "UPDATE emp SET salary = salary * (1 + raise.pct) FROM raise WHERE raise.dept_id = emp.dept_id",
    "SELECT id, salary FROM emp ORDER BY id"])
c("insert_select_and_ctas", [
    "CREATE TABLE archive(name TEXT, salary REAL)", "INSERT INTO archive SELECT name, salary FROM emp WHERE salary < 70000",
    "SELECT * FROM archive ORDER BY name", "CREATE TABLE summary AS SELECT dept_id, count(*) AS n FROM emp GROUP BY dept_id",
    "SELECT * FROM summary ORDER BY dept_id", "SELECT typeof(n) FROM summary LIMIT 1"])

# ---------------- schema changes and views
c("alter_table", [
    "ALTER TABLE dept ADD COLUMN floor INTEGER DEFAULT 1", "ALTER TABLE dept RENAME COLUMN name TO title",
    "ALTER TABLE dept RENAME TO department", "SELECT id, title, floor FROM department ORDER BY id",
    "SELECT * FROM dept", "ALTER TABLE department ADD COLUMN code TEXT NOT NULL", "INSERT INTO department(id, title) VALUES (9, 'new')",
    "SELECT title, floor FROM department WHERE id = 9"])
c("views", [
    "CREATE VIEW eng AS SELECT name, salary FROM emp WHERE dept_id = 1", "SELECT * FROM eng ORDER BY name",
    "INSERT INTO emp(name, dept_id, salary) VALUES ('Hal', 1, 1)", "SELECT count(*) FROM eng",
    "CREATE VIEW dept_stats(d, n, top) AS SELECT dept_id, count(*), max(salary) FROM emp GROUP BY dept_id",
    "SELECT * FROM dept_stats WHERE n > 1 ORDER BY d", "DROP VIEW eng", "SELECT * FROM eng"])
c("indexes", [
    "CREATE INDEX emp_salary ON emp(salary)", "CREATE UNIQUE INDEX emp_email ON emp(email)",
    "INSERT INTO emp(name, email) VALUES ('Dup', 'ann@x.com')", "INSERT INTO emp(name, email) VALUES ('NoMail1', NULL), ('NoMail2', NULL)",
    "SELECT name FROM emp WHERE salary = 95000 ORDER BY name", "CREATE INDEX emp_salary ON emp(name)", "DROP INDEX emp_salary",
    "CREATE INDEX IF NOT EXISTS emp_name ON emp(name)", "SELECT count(*) FROM emp"])
c("drop_and_if_exists", [
    "CREATE TABLE IF NOT EXISTS dept(x)", "SELECT count(*) FROM dept", "DROP TABLE missing", "DROP TABLE IF EXISTS missing",
    "DROP TABLE dept", "SELECT * FROM dept", "CREATE TABLE dept(x)", "SELECT count(*) FROM dept"])

# ---------------- transactions
c("transactions", [
    "BEGIN", "DELETE FROM emp", "SELECT count(*) FROM emp", "ROLLBACK", "SELECT count(*) FROM emp",
    "BEGIN", "UPDATE emp SET salary = 1", "COMMIT", "SELECT sum(salary) FROM emp", "COMMIT", "ROLLBACK"])
c("savepoints", [
    "BEGIN", "INSERT INTO dept VALUES (10, 'a', 1)", "SAVEPOINT s1", "INSERT INTO dept VALUES (11, 'b', 1)",
    "ROLLBACK TO s1", "INSERT INTO dept VALUES (12, 'c', 1)", "RELEASE s1", "COMMIT", "SELECT id FROM dept WHERE id >= 10 ORDER BY id"])
c("statement_atomicity", [
    "INSERT INTO dept VALUES (20, 'x', 1), (21, 'eng', 1)", "SELECT count(*) FROM dept",
    "UPDATE dept SET name = 'same' WHERE id IN (1, 2)", "SELECT name FROM dept ORDER BY id"])
c("syntax_errors_continue", ["SELEC 1", "SELECT 1 +", "SELECT * FROM nothere", "SELECT 'still running'"], setup=[])
