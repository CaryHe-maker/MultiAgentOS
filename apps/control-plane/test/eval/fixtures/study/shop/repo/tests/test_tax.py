import unittest

from shop.tax import rate_for, tax_cents


class TaxTest(unittest.TestCase):
    def test_known_region(self):
        self.assertEqual(tax_cents(10000, "CA"), 725)
        self.assertEqual(tax_cents(10000, "ny"), 400)

    def test_unknown_region_uses_default(self):
        self.assertEqual(rate_for("ZZ"), "0.05")

    def test_oregon_has_no_sales_tax(self):
        self.assertEqual(tax_cents(10000, "OR"), 0)


if __name__ == "__main__":
    unittest.main()
