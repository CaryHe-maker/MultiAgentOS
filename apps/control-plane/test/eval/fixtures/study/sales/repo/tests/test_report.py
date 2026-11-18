import os
import tempfile
import unittest
from decimal import Decimal

from sales.load import Row, read_rows
from sales.report import as_json, monthly, render


def row(order_id, date, region, amount):
    return Row(order_id, date, region, Decimal(amount))


class ReportTest(unittest.TestCase):
    def test_groups_by_region_and_month(self):
        report = monthly(
            [
                row("1", "2026-01-05", "N", "10.00"),
                row("2", "2026-01-20", "N", "5.50"),
                row("3", "2026-02-01", "N", "1.00"),
                row("4", "2026-01-09", "S", "2.25"),
            ]
        )
        self.assertEqual(report[("N", "2026-01")], {"orders": 2, "total": Decimal("15.50")})
        self.assertEqual(report[("S", "2026-01")]["orders"], 1)
        self.assertEqual(len(report), 3)

    def test_months_of_different_years_apart(self):
        report = monthly([row("1", "2025-03-01", "N", "1.00"), row("2", "2026-03-01", "N", "2.00")])
        self.assertEqual(report[("N", "2025-03")]["total"], Decimal("1.00"))
        self.assertEqual(report[("N", "2026-03")]["total"], Decimal("2.00"))

    def test_corrections_replace_earlier_rows(self):
        report = monthly([row("7", "2026-04-02", "E", "99.00"), row("7", "2026-04-02", "E", "9.90")])
        self.assertEqual(report[("E", "2026-04")], {"orders": 1, "total": Decimal("9.90")})

    def test_invalid_rows_dropped(self):
        report = monthly([row("1", "2026-04-02", "", "1.00"), row("2", "bad", "E", "1.00")])
        self.assertEqual(report, {})

    def test_render_and_json(self):
        report = monthly([row("1", "2026-05-01", "W", "1234.5")])
        self.assertIn("1234.50", render(report))
        self.assertEqual(as_json(report)[0]["total"], "1234.50")

    def test_read_rows(self):
        path = os.path.join(tempfile.mkdtemp(), "export.csv")
        with open(path, "w", encoding="utf8") as handle:
            handle.write("order_id,date,region,amount\n1,2026-01-01,n,3.10\n")
        self.assertEqual(read_rows(path), [row("1", "2026-01-01", "N", "3.10")])


if __name__ == "__main__":
    unittest.main()
