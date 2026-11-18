"""Hidden tests of the minidb task. Run from the project directory (the agent's work):
    python3 -m unittest tests_hidden.test_hidden_minidb -v
"""

import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())


def run(db, sql=None, stdin=None, timeout=60):
    args = [sys.executable, "-m", "minidb", db] + ([sql] if sql is not None else [])
    p = subprocess.run(args, cwd=PROJECT, input=stdin, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "db")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ok(self, sql):
        code, out, err = run(self.db, sql)
        self.assertEqual(code, 0, f"stderr: {err}")
        return out.splitlines()

    def err(self, sql):
        code, out, err = run(self.db, sql)
        self.assertEqual(code, 1, f"expected an error; stdout: {out}")
        self.assertTrue(err.startswith("error:"), err)
        return out.splitlines()

    def rows(self, sql):
        """Header plus the rows sorted, for queries without ORDER BY."""
        lines = self.ok(sql)
        return [lines[0]] + sorted(lines[1:])

    def people(self):
        self.ok(
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, city TEXT, score REAL);"
            "INSERT INTO people VALUES (1, 'Ann', 31, 'Oslo', 88.5), (2, 'bob', 25, 'Rome', 72.0),"
            "(3, 'Cid', NULL, 'Oslo', NULL), (4, 'dee', 40, NULL, 91.25), (5, 'Eve', 25, 'Rome', 60.0)"
        )


class Output(Base):
    def test_create_insert_select_format(self):
        out = self.ok("CREATE TABLE t (a INTEGER, b TEXT, c REAL); INSERT INTO t VALUES (1, 'x', 2.5), (2, NULL, 3);"
                      "SELECT * FROM t ORDER BY a")
        self.assertEqual(out, ["inserted 2", "a|b|c", "1|x|2.5", "2|NULL|3.0"])

    def test_stdin_script_and_comments(self):
        code, out, err = run(self.db, stdin="-- setup\nCREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1);;\n"
                                           "SELECT a FROM t -- trailing\n")
        self.assertEqual((code, out.splitlines()), (0, ["inserted 1", "a", "1"]), err)

    def test_semicolon_inside_string(self):
        out = self.ok("CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('a;b'), ('it''s'); SELECT s FROM t ORDER BY s")
        self.assertEqual(out, ["inserted 2", "s", "a;b", "it's"])

    def test_headers_alias_and_expr_numbering(self):
        self.people()
        out = self.ok("SELECT name, age + 1, age AS years, UPPER(city) FROM people WHERE id = 1")
        self.assertEqual(out, ["name|expr2|years|expr4", "Ann|32|31|OSLO"])

    def test_header_uses_declared_case(self):
        self.ok("CREATE TABLE T1 (MixedCase INTEGER)")
        self.assertEqual(self.ok("insert into t1 values (5); select mixedcase from T1"),
                         ["inserted 1", "MixedCase", "5"])

    def test_real_formatting(self):
        out = self.ok("SELECT 0.1 + 0.2, 1.5 * 2, 100000000000000000000.0, 10 / 4, 10.0 / 4")
        self.assertEqual(out[1], "0.30000000000000004|3.0|1e+20|2|2.5")

    def test_select_without_from(self):
        self.assertEqual(self.ok("SELECT 1 + 2, 'a' || 'b', NULL"), ["expr1|expr2|expr3", "3|ab|NULL"])

    def test_update_delete_counts(self):
        self.people()
        self.assertEqual(self.ok("UPDATE people SET age = age + 1 WHERE city = 'Rome'"), ["updated 2"])
        self.assertEqual(self.ok("DELETE FROM people WHERE age IS NULL"), ["deleted 1"])
        self.assertEqual(self.ok("SELECT COUNT(*) FROM people"), ["expr1", "4"])


class TypesAndConstraints(Base):
    def test_integer_column_rejects_real_and_text(self):
        self.ok("CREATE TABLE t (a INTEGER)")
        self.err("INSERT INTO t VALUES (1.5)")
        self.err("INSERT INTO t VALUES ('1')")
        self.assertEqual(self.ok("SELECT COUNT(*) FROM t"), ["expr1", "0"])

    def test_real_column_converts_integer(self):
        self.ok("CREATE TABLE t (r REAL); INSERT INTO t VALUES (3)")
        self.assertEqual(self.ok("SELECT r, r / 2 FROM t"), ["r|expr2", "3.0|1.5"])

    def test_text_column_rejects_number(self):
        self.ok("CREATE TABLE t (s TEXT)")
        self.err("INSERT INTO t VALUES (12)")

    def test_big_integers(self):
        self.ok("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (123456789012345678901234567890)")
        self.assertEqual(self.ok("SELECT a * 10 FROM t")[1], "1234567890123456789012345678900")

    def test_primary_key_unique_and_not_null(self):
        self.ok("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        self.ok("INSERT INTO t VALUES (1, 'a')")
        self.err("INSERT INTO t VALUES (1, 'b')")
        self.err("INSERT INTO t VALUES (NULL, 'c')")
        self.assertEqual(self.ok("SELECT * FROM t"), ["id|v", "1|a"])

    def test_unique_allows_many_nulls(self):
        self.ok("CREATE TABLE t (u TEXT UNIQUE); INSERT INTO t VALUES (NULL), (NULL), ('x')")
        self.err("INSERT INTO t VALUES ('x')")
        self.assertEqual(self.ok("SELECT COUNT(*), COUNT(u) FROM t")[1], "3|1")

    def test_multi_row_insert_is_all_or_nothing(self):
        self.ok("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        self.err("INSERT INTO t VALUES (1), (2), (2)")
        self.assertEqual(self.ok("SELECT COUNT(*) FROM t"), ["expr1", "0"])

    def test_defaults_and_column_list(self):
        self.ok("CREATE TABLE t (a INTEGER, b TEXT DEFAULT 'none', c INTEGER DEFAULT -1, d REAL)")
        self.ok("INSERT INTO t (a) VALUES (1); INSERT INTO t (d, a) VALUES (2, 5)")
        self.assertEqual(self.ok("SELECT * FROM t ORDER BY a"), ["a|b|c|d", "1|none|-1|NULL", "5|none|-1|2.0"])

    def test_wrong_value_count(self):
        self.ok("CREATE TABLE t (a INTEGER, b INTEGER)")
        self.err("INSERT INTO t VALUES (1)")
        self.err("INSERT INTO t (a) VALUES (1, 2)")

    def test_update_checks_constraints_after_all_rows(self):
        self.ok("CREATE TABLE t (id INTEGER UNIQUE); INSERT INTO t VALUES (1), (2), (3)")
        self.assertEqual(self.ok("UPDATE t SET id = id + 1"), ["updated 3"])
        self.assertEqual(self.ok("SELECT id FROM t ORDER BY id")[1:], ["2", "3", "4"])
        self.err("UPDATE t SET id = 9 WHERE id >= 3")
        self.assertEqual(self.ok("SELECT id FROM t ORDER BY id")[1:], ["2", "3", "4"])

    def test_update_uses_old_row_values(self):
        self.ok("CREATE TABLE t (a INTEGER, b INTEGER); INSERT INTO t VALUES (1, 2)")
        self.ok("UPDATE t SET a = b, b = a")
        self.assertEqual(self.ok("SELECT a, b FROM t")[1], "2|1")


class Ddl(Base):
    def test_create_twice_and_if_not_exists(self):
        self.ok("CREATE TABLE t (a INTEGER)")
        self.err("CREATE TABLE t (a INTEGER)")
        self.assertEqual(self.ok("CREATE TABLE IF NOT EXISTS t (b TEXT); SELECT * FROM t"), ["a"])

    def test_duplicate_column_name(self):
        self.err("CREATE TABLE t (a INTEGER, A TEXT)")

    def test_drop_table_and_if_exists(self):
        self.ok("CREATE TABLE t (a INTEGER); CREATE INDEX ia ON t (a); DROP TABLE t")
        self.err("SELECT * FROM t")
        self.ok("DROP TABLE IF EXISTS t")
        self.err("DROP TABLE t")
        self.ok("CREATE TABLE t (b INTEGER); CREATE INDEX ia ON t (b)")

    def test_add_column(self):
        self.ok("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)")
        self.ok("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'z'; ALTER TABLE t ADD COLUMN c INTEGER")
        self.assertEqual(self.ok("SELECT * FROM t"), ["a|b|c", "1|z|NULL"])
        self.err("ALTER TABLE t ADD COLUMN d INTEGER NOT NULL")
        self.err("ALTER TABLE t ADD COLUMN e INTEGER UNIQUE")
        self.err("ALTER TABLE t ADD COLUMN a INTEGER")

    def test_index_names_and_results_unchanged(self):
        self.people()
        before = self.ok("SELECT name FROM people WHERE city = 'Rome' ORDER BY name")
        self.ok("CREATE INDEX pc ON people (city)")
        self.err("CREATE INDEX pc ON people (age)")
        self.err("CREATE INDEX px ON people (nope)")
        self.assertEqual(self.ok("SELECT name FROM people WHERE city = 'Rome' ORDER BY name"), before)
        self.ok("INSERT INTO people VALUES (6, 'Fay', 20, 'Rome', 1.0); UPDATE people SET city = 'Oslo' WHERE id = 2")
        self.assertEqual(self.ok("SELECT name FROM people WHERE city = 'Rome' ORDER BY name"),
                         ["name", "Eve", "Fay"])
        self.ok("DROP INDEX pc")
        self.err("DROP INDEX pc")

    def test_identifiers_case_insensitive_and_keywords(self):
        self.ok("create table Items (Qty integer)")
        self.assertEqual(self.ok("INSERT INTO ITEMS (qty) VALUES (2); SELECT items.QTY FROM items"),
                         ["inserted 1", "Qty", "2"])
        self.err("CREATE TABLE select (a INTEGER)")


class Expressions(Base):
    def test_integer_division_and_modulo(self):
        self.assertEqual(self.ok("SELECT 7 / 2, -7 / 2, 7 % 3, -7 % 3, 7 % -3, 7.5 % 2")[1], "3|-3|1|-1|1|1.5")

    def test_division_by_zero_is_null(self):
        self.assertEqual(self.ok("SELECT 1 / 0, 1.0 / 0, 5 % 0")[1], "NULL|NULL|NULL")

    def test_precedence(self):
        self.assertEqual(self.ok("SELECT 2 + 3 * 4, (2 + 3) * 4, -2 * -3, 10 - 2 - 3, 2 * 3 % 4")[1], "14|20|6|5|2")

    def test_concat(self):
        self.assertEqual(self.ok("SELECT 'n=' || 5, 1 || 2.0, 'a' || NULL, 1 + 2 || 'x'")[1], "n=5|12.0|NULL|3x")

    def test_text_arithmetic_is_error(self):
        self.err("SELECT 'a' + 1")

    def test_comparisons(self):
        self.assertEqual(self.ok("SELECT 1 = 1.0, 2 > 1.5, 'b' > 'a', 'B' < 'a', 3 <> 3, 3 != 4, NULL = NULL")[1],
                         "1|1|1|1|0|1|NULL")
        self.err("SELECT 1 < 'a'")

    def test_three_valued_logic(self):
        out = self.ok("SELECT NULL AND 0, NULL AND 1, NULL OR 1, NULL OR 0, NOT NULL, NOT 0, 2 AND 3")
        self.assertEqual(out[1], "0|NULL|1|NULL|NULL|1|1")

    def test_where_keeps_only_true(self):
        self.people()
        self.assertEqual(self.rows("SELECT id FROM people WHERE NOT (age > 30)"), ["id", "2", "5"])
        self.assertEqual(self.rows("SELECT id FROM people WHERE age > 30 OR city = 'Oslo'"), ["id", "1", "3", "4"])

    def test_text_condition_is_error(self):
        self.people()
        self.err("SELECT id FROM people WHERE name")

    def test_is_null(self):
        self.people()
        self.assertEqual(self.rows("SELECT id FROM people WHERE city IS NULL OR age IS NULL"), ["id", "3", "4"])
        self.assertEqual(self.ok("SELECT NULL IS NULL, 1 IS NULL, NULL IS NOT NULL")[1], "1|0|0")

    def test_like(self):
        self.people()
        self.assertEqual(self.rows("SELECT name FROM people WHERE name LIKE '%e'"), ["name", "Eve", "dee"])
        self.assertEqual(self.ok("SELECT 'ABC' LIKE 'a_c', 'abc' NOT LIKE 'a%', 'a%' LIKE 'a%', NULL LIKE 'x'")[1],
                         "1|0|1|NULL")
        self.err("SELECT 12 LIKE '1%'")

    def test_in(self):
        self.assertEqual(self.ok("SELECT 2 IN (1, 2), 3 IN (1, 2), 3 IN (1, NULL), NULL IN (1), 3 NOT IN (1, 2),"
                                 " 3 NOT IN (1, NULL), 1 IN (1.0)")[1], "1|0|NULL|NULL|1|NULL|1")

    def test_between(self):
        self.people()
        self.assertEqual(self.rows("SELECT id FROM people WHERE age BETWEEN 25 AND 31"), ["id", "1", "2", "5"])
        self.assertEqual(self.rows("SELECT id FROM people WHERE age NOT BETWEEN 25 AND 31"), ["id", "4"])
        self.assertEqual(self.ok("SELECT 5 BETWEEN 1 AND NULL, 0 BETWEEN 1 AND NULL")[1], "NULL|0")

    def test_case(self):
        self.people()
        out = self.ok("SELECT id, CASE WHEN age >= 30 THEN 'senior' WHEN age >= 0 THEN 'junior' END AS band,"
                      " CASE WHEN age IS NULL THEN 'n/a' ELSE 'ok' END FROM people ORDER BY id")
        self.assertEqual(out, ["id|band|expr3", "1|senior|ok", "2|junior|ok", "3|NULL|n/a", "4|senior|ok",
                               "5|junior|ok"])

    def test_functions(self):
        out = self.ok("SELECT LENGTH('héllo'), UPPER('abcé'), LOWER('ABÉ'), ABS(-3), ABS(-2.5), ROUND(2.5),"
                      " ROUND(-2.5), ROUND(1.2345, 2), ROUND(7), SUBSTR('hello', 2, 3), SUBSTR('hello', 4),"
                      " SUBSTR('hi', 5), COALESCE(NULL, NULL, 3, 4), COALESCE(NULL), LENGTH(NULL)")
        self.assertEqual(out[1], "5|ABCé|abÉ|3|2.5|3.0|-3.0|1.23|7.0|ell|lo||3|NULL|NULL")

    def test_function_errors(self):
        self.err("SELECT LENGTH(5)")
        self.err("SELECT NOSUCH(1)")
        self.err("SELECT ABS('x')")
        self.err("SELECT UPPER('a', 'b')")

    def test_unknown_and_ambiguous_columns(self):
        self.people()
        self.err("SELECT nope FROM people")
        self.ok("CREATE TABLE pets (id INTEGER, owner INTEGER)")
        self.err("SELECT id FROM people JOIN pets ON owner = people.id")
        self.err("SELECT x.id FROM people")


class SelectClauses(Base):
    def test_order_by_nulls_and_desc(self):
        self.people()
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY age, id")[1:], ["3", "2", "5", "1", "4"])
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY age DESC, id DESC")[1:], ["4", "1", "5", "2", "3"])

    def test_order_by_text_by_code_point(self):
        self.people()
        self.assertEqual(self.ok("SELECT name FROM people ORDER BY name")[1:], ["Ann", "Cid", "Eve", "bob", "dee"])

    def test_order_by_alias_position_and_expression(self):
        self.people()
        self.assertEqual(self.ok("SELECT name, score * 2 AS dbl FROM people WHERE score IS NOT NULL ORDER BY dbl DESC")
                         [1:], ["dee|182.5", "Ann|177.0", "bob|144.0", "Eve|120.0"])
        self.assertEqual(self.ok("SELECT id, name FROM people ORDER BY 2 DESC")[1:3], ["4|dee", "2|bob"])
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY LENGTH(city), id")[1:], ["4", "1", "2", "3", "5"])

    def test_mixed_type_ordering(self):
        self.ok("CREATE TABLE m (k INTEGER, v TEXT); INSERT INTO m VALUES (1, 'b'), (2, NULL), (3, 'a')")
        self.assertEqual(self.ok("SELECT v FROM m ORDER BY v")[1:], ["NULL", "a", "b"])
        out = self.ok("SELECT CASE WHEN k = 2 THEN NULL WHEN k = 1 THEN 'b' ELSE k END AS c FROM m ORDER BY c")
        self.assertEqual(out[1:], ["NULL", "3", "b"])
        out = self.ok("SELECT CASE WHEN k = 2 THEN NULL WHEN k = 1 THEN 'b' ELSE k END AS c FROM m ORDER BY c DESC")
        self.assertEqual(out[1:], ["b", "3", "NULL"])

    def test_limit_offset(self):
        self.people()
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY id LIMIT 2")[1:], ["1", "2"])
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY id LIMIT 2 OFFSET 3")[1:], ["4", "5"])
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY id LIMIT 0"), ["id"])
        self.assertEqual(self.ok("SELECT id FROM people ORDER BY id LIMIT 9 OFFSET 9"), ["id"])

    def test_distinct(self):
        self.people()
        self.assertEqual(self.rows("SELECT DISTINCT city FROM people"), ["city", "NULL", "Oslo", "Rome"])
        self.assertEqual(self.rows("SELECT DISTINCT age, city FROM people WHERE age = 25"), ["age|city", "25|Rome"])

    def test_star_and_table_star(self):
        self.ok("CREATE TABLE a (x INTEGER, y TEXT); CREATE TABLE b (x INTEGER, z TEXT);"
                "INSERT INTO a VALUES (1, 'p'); INSERT INTO b VALUES (1, 'q')")
        self.assertEqual(self.ok("SELECT * FROM a JOIN b ON a.x = b.x"), ["x|y|x|z", "1|p|1|q"])
        self.assertEqual(self.ok("SELECT b.*, a.y FROM a JOIN b ON a.x = b.x"), ["x|z|y", "1|q|p"])

    def test_table_alias(self):
        self.people()
        self.assertEqual(self.ok("SELECT p.name FROM people AS p WHERE p.id = 2"), ["name", "bob"])
        self.assertEqual(self.ok("SELECT q.name FROM people q WHERE q.id = 3"), ["name", "Cid"])


class Joins(Base):
    def setUp(self):
        super().setUp()
        self.ok("CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT);"
                "CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT, dept INTEGER, salary INTEGER);"
                "CREATE TABLE proj (id INTEGER, emp INTEGER, title TEXT);"
                "INSERT INTO dept VALUES (1, 'eng'), (2, 'ops'), (3, 'hr');"
                "INSERT INTO emp VALUES (10, 'ann', 1, 100), (11, 'bo', 1, 80), (12, 'cy', 2, 90), (13, 'di', NULL, 70);"
                "INSERT INTO proj VALUES (1, 10, 'x'), (2, 10, 'y'), (3, 12, 'z')")

    def test_inner_join(self):
        self.assertEqual(self.rows("SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept = d.id"),
                         ["name|name", "ann|eng", "bo|eng", "cy|ops"])

    def test_left_join_keeps_unmatched(self):
        self.assertEqual(self.rows("SELECT d.name, e.name FROM dept d LEFT JOIN emp e ON e.dept = d.id"),
                         ["name|name", "eng|ann", "eng|bo", "hr|NULL", "ops|cy"])

    def test_three_way_join(self):
        self.assertEqual(self.rows("SELECT d.name, p.title FROM dept d JOIN emp e ON e.dept = d.id"
                                   " JOIN proj p ON p.emp = e.id"),
                         ["name|title", "eng|x", "eng|y", "ops|z"])

    def test_left_join_with_where_on_null(self):
        self.assertEqual(self.rows("SELECT e.name FROM emp e LEFT JOIN proj p ON p.emp = e.id WHERE p.id IS NULL"),
                         ["name", "bo", "di"])

    def test_join_condition_not_equality(self):
        self.assertEqual(self.rows("SELECT a.name, b.name FROM emp a JOIN emp b ON a.salary > b.salary + 15"),
                         ["name|name", "ann|bo", "ann|di", "cy|di"])


class Grouping(Base):
    def setUp(self):
        super().setUp()
        self.ok("CREATE TABLE sales (region TEXT, rep TEXT, amount INTEGER, rate REAL);"
                "INSERT INTO sales VALUES ('north', 'a', 10, 1.5), ('north', 'b', 20, NULL), ('south', 'a', 5, 2.0),"
                "('south', 'c', NULL, 0.5), (NULL, 'd', 7, NULL), (NULL, 'e', 3, 1.0)")

    def test_group_by_with_aggregates(self):
        self.assertEqual(self.rows("SELECT region, COUNT(*), COUNT(amount), SUM(amount), AVG(amount), MIN(rep),"
                                   " MAX(rate) FROM sales GROUP BY region"),
                         ["region|expr2|expr3|expr4|expr5|expr6|expr7", "NULL|2|2|10|5.0|d|1.0",
                          "north|2|2|30|15.0|a|1.5", "south|2|1|5|5.0|a|2.0"])

    def test_aggregates_without_group(self):
        self.assertEqual(self.ok("SELECT COUNT(*), SUM(amount), SUM(rate), AVG(rate), COUNT(DISTINCT rep)"
                                 " FROM sales")[1], "6|45|5.0|1.25|5")

    def test_empty_input(self):
        self.assertEqual(self.ok("SELECT COUNT(*), SUM(amount), MAX(rep) FROM sales WHERE amount > 1000")[1],
                         "0|NULL|NULL")
        self.assertEqual(self.ok("SELECT region, COUNT(*) FROM sales WHERE amount > 1000 GROUP BY region"),
                         ["region|expr2"])

    def test_having_and_order_by_aggregate(self):
        out = self.ok("SELECT rep, SUM(amount) AS total FROM sales GROUP BY rep HAVING COUNT(amount) >= 1"
                      " ORDER BY total DESC, rep")
        self.assertEqual(out[1:], ["b|20", "a|15", "d|7", "e|3"])
        self.assertEqual(self.ok("SELECT region FROM sales GROUP BY region ORDER BY SUM(amount) DESC")[1:],
                         ["north", "NULL", "south"])

    def test_group_by_expression(self):
        self.assertEqual(self.rows("SELECT amount > 6, COUNT(*) FROM sales WHERE amount IS NOT NULL GROUP BY amount > 6"),
                         ["expr1|expr2", "0|2", "1|3"])

    def test_bare_column_is_error(self):
        self.err("SELECT region, rep FROM sales GROUP BY region")
        self.err("SELECT rep, COUNT(*) FROM sales")

    def test_aggregate_misuse(self):
        self.err("SELECT region FROM sales WHERE SUM(amount) > 1")
        self.err("SELECT SUM(COUNT(*)) FROM sales")
        self.err("SELECT SUM(rep) FROM sales")

    def test_distinct_after_grouping(self):
        self.assertEqual(self.rows("SELECT DISTINCT COUNT(*) FROM sales GROUP BY region"), ["expr1", "2"])


class ErrorsAndAtomicity(Base):
    def test_error_stops_script_and_keeps_earlier_statements(self):
        code, out, err = run(self.db, "CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);"
                                      " INSERT INTO t VALUES ('bad'); INSERT INTO t VALUES (3)")
        self.assertEqual((code, out.splitlines()), (1, ["inserted 1"]))
        self.assertTrue(err.startswith("error:"))
        self.assertEqual(self.ok("SELECT a FROM t"), ["a", "1"])

    def test_syntax_error_later_in_script(self):
        code, out, _ = run(self.db, "CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1); SELEKT 1; INSERT INTO t VALUES (2)")
        self.assertEqual((code, out.splitlines()), (1, ["inserted 1"]))
        self.assertEqual(self.ok("SELECT COUNT(*) FROM t")[1], "1")

    def test_failed_update_has_no_effect(self):
        self.ok("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y')")
        self.err("UPDATE t SET a = a + 'z'")
        self.assertEqual(self.rows("SELECT a, b FROM t"), ["a|b", "1|x", "2|y"])

    def test_unknown_table(self):
        self.err("SELECT * FROM missing")
        self.err("INSERT INTO missing VALUES (1)")

    def test_limit_needs_integer(self):
        self.ok("CREATE TABLE t (a INTEGER)")
        self.err("SELECT a FROM t LIMIT 'x'")


class Transactions(Base):
    def test_commit_and_rollback(self):
        self.ok("CREATE TABLE t (a INTEGER)")
        self.assertEqual(self.ok("BEGIN; INSERT INTO t VALUES (1); SELECT COUNT(*) FROM t; ROLLBACK;"
                                 " SELECT COUNT(*) FROM t"), ["inserted 1", "expr1", "1", "expr1", "0"])
        self.ok("BEGIN; INSERT INTO t VALUES (2); COMMIT")
        self.assertEqual(self.ok("SELECT a FROM t"), ["a", "2"])

    def test_script_end_inside_transaction_rolls_back(self):
        self.ok("CREATE TABLE t (a INTEGER); BEGIN; INSERT INTO t VALUES (1)")
        self.assertEqual(self.ok("SELECT COUNT(*) FROM t")[1], "0")

    def test_error_inside_transaction_rolls_back_all(self):
        self.ok("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)")
        self.err("BEGIN; INSERT INTO t VALUES (2); DELETE FROM t WHERE a = 1; INSERT INTO t VALUES (2); COMMIT")
        self.assertEqual(self.ok("SELECT a FROM t"), ["a", "1"])

    def test_nested_or_stray_transaction_commands(self):
        self.err("BEGIN; BEGIN")
        self.err("COMMIT")
        self.err("ROLLBACK")

    def test_ddl_inside_transaction(self):
        self.ok("BEGIN; CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1); ROLLBACK")
        self.err("SELECT * FROM t")
        self.ok("BEGIN; CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1); COMMIT")
        self.assertEqual(self.ok("SELECT * FROM t"), ["a", "1"])


class Durability(Base):
    def test_persists_across_processes(self):
        self.ok("CREATE TABLE t (a INTEGER, s TEXT); CREATE INDEX ta ON t (a)")
        for i in range(30):
            self.ok(f"INSERT INTO t VALUES ({i}, 'v{i}')")
        self.ok("DELETE FROM t WHERE a % 3 = 0; UPDATE t SET s = 'w' WHERE a = 4")
        self.assertEqual(self.ok("SELECT COUNT(*), SUM(a) FROM t")[1], "20|300")
        self.assertEqual(self.ok("SELECT s FROM t WHERE a = 4"), ["s", "w"])

    def test_kill_during_autocommit_inserts(self):
        self.ok("CREATE TABLE t (n INTEGER PRIMARY KEY)")
        script = "".join(f"INSERT INTO t VALUES ({i});\n" for i in range(1, 20001))
        p = subprocess.Popen([sys.executable, "-m", "minidb", self.db], cwd=PROJECT, stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        p.stdin.write(script)
        p.stdin.close()
        time.sleep(1.5)
        p.send_signal(signal.SIGKILL)
        p.wait()
        out = self.ok("SELECT COUNT(*), MIN(n), MAX(n) FROM t")[1].split("|")
        count = int(out[0])
        if count:
            self.assertEqual(out[1:], ["1", str(count)])
        self.assertEqual(self.ok("INSERT INTO t VALUES (99999)"), ["inserted 1"])

    def test_kill_during_transaction(self):
        self.ok("CREATE TABLE t (n INTEGER)")
        script = "BEGIN;\n" + "".join(f"INSERT INTO t VALUES ({i});\n" for i in range(4000)) + "COMMIT;\n"
        for delay in (0.3, 0.8):
            p = subprocess.Popen([sys.executable, "-m", "minidb", self.db], cwd=PROJECT, stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
            p.stdin.write(script)
            p.stdin.close()
            time.sleep(delay)
            p.send_signal(signal.SIGKILL)
            p.wait()
            count = int(self.ok("SELECT COUNT(*) FROM t")[1])
            self.assertIn(count, (0, 4000, 8000))

    def test_concurrent_writers(self):
        self.ok("CREATE TABLE t (who TEXT, n INTEGER)")
        procs = []
        for who in ("a", "b"):
            script = "".join(f"INSERT INTO t VALUES ('{who}', {i});\n" for i in range(300))
            p = subprocess.Popen([sys.executable, "-m", "minidb", self.db], cwd=PROJECT, stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            p.stdin.write(script)
            p.stdin.close()
            procs.append(p)
        for p in procs:
            self.assertEqual(p.wait(timeout=120), 0, p.stderr.read())
        self.assertEqual(self.rows("SELECT who, COUNT(*) FROM t GROUP BY who"), ["who|expr2", "a|300", "b|300"])


class Performance(Base):
    def test_many_autocommit_inserts(self):
        self.ok("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)")
        script = "".join(f"INSERT INTO t VALUES ({i}, 'row{i}');\n" for i in range(5000))
        start = time.time()
        code, _, err = run(self.db, stdin=script, timeout=120)
        self.assertEqual(code, 0, err)
        self.assertLess(time.time() - start, 20)
        self.assertEqual(self.ok("SELECT COUNT(*) FROM t")[1], "5000")

    def test_index_lookup_and_scan_on_100k_rows(self):
        self.ok("CREATE TABLE big (id INTEGER, k TEXT, v INTEGER)")
        for b in range(100):
            values = ", ".join(f"({b * 1000 + i}, 'key{b * 1000 + i}', {(b * 1000 + i) % 97})" for i in range(1000))
            code, _, err = run(self.db, f"INSERT INTO big VALUES {values}", timeout=120)
            self.assertEqual(code, 0, err)
        self.ok("CREATE INDEX bk ON big (k)")
        start = time.time()
        self.assertEqual(self.ok("SELECT id, v FROM big WHERE k = 'key77777'"), ["id|v", "77777|80"])
        self.assertLess(time.time() - start, 1.0)
        start = time.time()
        self.assertEqual(self.ok("SELECT COUNT(*) FROM big WHERE v = 5 AND id > 50000")[1], "515")
        self.assertLess(time.time() - start, 5.0)


class Delivery(unittest.TestCase):
    def test_no_forbidden_modules(self):
        bad = re.compile(r"^\s*(import|from)\s+(sqlite3|dbm|shelve)\b", re.M)
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "minidb", "__main__.py")))
        for root, _, files in os.walk(os.path.join(PROJECT, "minidb")):
            for f in files:
                if f.endswith(".py"):
                    with open(os.path.join(root, f), encoding="utf-8", errors="replace") as fh:
                        self.assertIsNone(bad.search(fh.read()), f)

    def test_own_tests(self):
        p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=PROJECT,
                           capture_output=True, text=True, timeout=600)
        m = re.search(r"Ran (\d+) tests?", p.stderr)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        self.assertTrue(m and int(m.group(1)) >= 40, p.stderr[-500:])

    def test_docs(self):
        for name in ("README.md", os.path.join("docs", "design.md")):
            path = os.path.join(PROJECT, name)
            self.assertTrue(os.path.isfile(path), name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                self.assertGreater(len(fh.read().strip()), 300, name)


if __name__ == "__main__":
    unittest.main()
