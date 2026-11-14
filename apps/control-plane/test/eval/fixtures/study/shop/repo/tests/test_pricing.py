import unittest

from shop.pricing import bulk_discount, line_total


class PricingTest(unittest.TestCase):
    def test_line_total(self):
        self.assertEqual(line_total(150, 4), 600)

    def test_no_discount_below_bulk(self):
        self.assertEqual(bulk_discount(150, 9), 0)

    def test_bulk_discount_from_ten(self):
        self.assertEqual(bulk_discount(150, 10), 150)
        self.assertEqual(bulk_discount(499, 12), 599)


if __name__ == "__main__":
    unittest.main()
