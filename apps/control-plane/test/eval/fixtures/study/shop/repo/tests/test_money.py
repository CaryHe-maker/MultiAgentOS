import unittest

from shop.money import fmt, percent_of, to_cents


class MoneyTest(unittest.TestCase):
    def test_to_cents(self):
        self.assertEqual(to_cents("12.34"), 1234)
        self.assertEqual(to_cents(0.1), 10)
        self.assertEqual(to_cents("1.005"), 101)

    def test_percent_rounds_half_up(self):
        self.assertEqual(percent_of(1000, "0.0725"), 73)
        self.assertEqual(percent_of(150, "0.10"), 15)

    def test_fmt(self):
        self.assertEqual(fmt(1234), "12.34")
        self.assertEqual(fmt(5), "0.05")
        self.assertEqual(fmt(-250), "-2.50")


if __name__ == "__main__":
    unittest.main()
