import csv
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import unittest
from decimal import Decimal

from sales.load import Row, read_rows
from sales.report import monthly


def export(count, seed=7):
    """`count` rows over two years, with corrections; and the report a plain reading expects."""
    rand = random.Random(seed)
    rows = []
    for index in range(count):
        if rows and rand.random() < 0.15:
            earlier = rand.choice(rows)
            rows.append((earlier[0], earlier[1], earlier[2], f"{rand.randint(1, 50000) / 100:.2f}"))
            continue
        year = rand.choice((2025, 2026))
        date = f"{year}-{rand.randint(1, 12):02d}-{rand.randint(1, 28):02d}"
        rows.append((f"o{index}", date, rand.choice("NSEW"), f"{rand.randint(1, 50000) / 100:.2f}"))
    last = {}
    for order_id, date, region, amount in rows:
        last[order_id] = (date, region, Decimal(amount))
    expected = {}
    for date, region, amount in last.values():
        cell = expected.setdefault((region, date[:7]), {"orders": 0, "total": Decimal("0")})
        cell["orders"] += 1
        cell["total"] += amount
    return rows, expected


def write(rows):
    path = os.path.join(tempfile.mkdtemp(), "export.csv")
    with open(path, "w", newline="", encoding="utf8") as handle:
        out = csv.writer(handle)
        out.writerow(["order_id", "date", "region", "amount"])
        out.writerows(rows)
    return path


class HiddenSalesTest(unittest.TestCase):
    def test_matches_a_plain_reading(self):
        rows, expected = export(3000)
        got = monthly(read_rows(write(rows)))
        self.assertEqual(got, expected)

    def test_last_correction_wins_even_when_three(self):
        report = monthly(
            [
                Row("9", "2026-06-01", "N", Decimal("5.00")),
                Row("8", "2026-06-02", "N", Decimal("1.00")),
                Row("9", "2026-06-01", "N", Decimal("6.00")),
                Row("9", "2026-06-01", "N", Decimal("7.00")),
            ]
        )
        self.assertEqual(report[("N", "2026-06")], {"orders": 2, "total": Decimal("8.00")})

    def test_fast_enough(self):
        rows, expected = export(60000, seed=11)
        loaded = read_rows(write(rows))
        started = time.perf_counter()
        got = monthly(loaded)
        took = time.perf_counter() - started
        self.assertEqual(got, expected)
        self.assertLess(took, 3.0, f"monthly() took {took:.1f}s for 60000 rows")

    def test_cli_json(self):
        rows, expected = export(500, seed=3)
        done = subprocess.run(
            [sys.executable, "-m", "sales", "report", write(rows), "--json"], capture_output=True, text=True
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        cells = {(cell["region"], cell["month"]): cell for cell in json.loads(done.stdout)}
        self.assertEqual(set(cells), set(expected))
        for key, cell in expected.items():
            self.assertEqual(cells[key]["orders"], cell["orders"])
            self.assertEqual(cells[key]["total"], f"{cell['total']:.2f}")


if __name__ == "__main__":
    unittest.main()
