import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest

from shop.cart import Cart
from shop.catalog import Catalog, Product
from shop.inventory import Inventory, OutOfStock
from shop.orders import checkout
from shop.pricing import bulk_discount
from shop.tax import tax_cents


def make(stock=100):
    catalog = Catalog([Product("PEN", "Pen", 150), Product("MUG", "Mug", 1200)])
    inventory = Inventory({"PEN": stock, "MUG": stock})
    return inventory, Cart(catalog, inventory)


class HiddenFixesTest(unittest.TestCase):
    def test_reservations_add_up(self):
        inventory = Inventory({"A": 5})
        inventory.reserve("A", 3)
        inventory.reserve("A", 2)
        with self.assertRaises(OutOfStock):
            inventory.reserve("A", 1)
        self.assertEqual(inventory.available("A"), 0)

    def test_bulk_boundary(self):
        self.assertEqual(bulk_discount(1000, 9), 0)
        self.assertEqual(bulk_discount(1000, 10), 1000)

    def test_zero_rate_regions(self):
        self.assertEqual(tax_cents(5000, "OR"), 0)
        self.assertEqual(tax_cents(5000, "mt"), 0)
        self.assertEqual(tax_cents(5000, "ZZ"), 250)


class HiddenCouponTest(unittest.TestCase):
    def setUp(self):
        from shop.coupons import Coupon, CouponError

        self.Coupon = Coupon
        self.CouponError = CouponError
        self.today = datetime.date(2026, 5, 1)

    def test_percent_after_bulk_before_tax(self):
        _, cart = make()
        cart.add("PEN", 10)  # 1500, bulk 150 -> 1350
        order = checkout(cart, "CA", coupon=self.Coupon("TEN", "percent", 10), today=self.today)
        self.assertEqual(order.subtotal, 1500)
        self.assertEqual(order.discount, 150)
        self.assertEqual(order.coupon, 135)
        self.assertEqual(order.tax, tax_cents(1215, "CA"))
        self.assertEqual(order.total, 1215 + tax_cents(1215, "CA"))
        self.assertEqual(order.as_dict()["coupon"], 135)
        self.assertEqual(order.as_dict()["coupon_code"], "TEN")

    def test_fixed_never_below_zero(self):
        _, cart = make()
        cart.add("PEN", 1)
        order = checkout(cart, "NY", coupon=self.Coupon("BIG", "fixed", 5000), today=self.today)
        self.assertEqual(order.coupon, 150)
        self.assertEqual(order.tax, 0)
        self.assertEqual(order.total, 0)

    def test_no_coupon(self):
        _, cart = make()
        cart.add("MUG", 1)
        order = checkout(cart, "TX")
        self.assertEqual(order.coupon, 0)
        self.assertIsNone(order.coupon_code)

    def test_minimum_and_expiry_refuse_without_selling(self):
        inventory, cart = make()
        cart.add("MUG", 1)
        with self.assertRaises(self.CouponError):
            checkout(cart, "CA", coupon=self.Coupon("MIN", "fixed", 100, min_subtotal=5000), today=self.today)
        with self.assertRaises(self.CouponError):
            checkout(
                cart,
                "CA",
                coupon=self.Coupon("OLD", "percent", 5, expires=datetime.date(2026, 4, 30)),
                today=self.today,
            )
        self.assertEqual(inventory.stock("MUG"), 100)
        self.assertEqual(inventory.reserved("MUG"), 1)
        order = checkout(
            cart, "CA", coupon=self.Coupon("LAST", "percent", 5, expires=self.today), today=self.today
        )
        self.assertEqual(order.coupon, 60)
        self.assertEqual(inventory.stock("MUG"), 99)

    def test_load_coupons(self):
        from shop.coupons import load_coupons

        path = os.path.join(tempfile.mkdtemp(), "coupons.json")
        with open(path, "w", encoding="utf8") as handle:
            json.dump(
                [
                    {"code": "A", "kind": "percent", "value": 20},
                    {"code": "B", "kind": "fixed", "value": 300, "min_subtotal": 1000, "expires": "2026-12-31"},
                ],
                handle,
            )
        coupons = load_coupons(path)
        self.assertEqual(sorted(coupons), ["A", "B"])
        self.assertEqual(coupons["B"].expires, datetime.date(2026, 12, 31))
        self.assertEqual(coupons["B"].min_subtotal, 1000)


class HiddenCliTest(unittest.TestCase):
    def files(self):
        folder = tempfile.mkdtemp()
        paths = {name: os.path.join(folder, f"{name}.json") for name in ("catalog", "cart", "coupons")}
        with open(paths["catalog"], "w", encoding="utf8") as handle:
            json.dump([{"sku": "PEN", "name": "Pen", "price": "1.50"}], handle)
        with open(paths["cart"], "w", encoding="utf8") as handle:
            json.dump({"PEN": 4}, handle)
        with open(paths["coupons"], "w", encoding="utf8") as handle:
            json.dump([{"code": "HALF", "kind": "percent", "value": 50}], handle)
        return paths

    def quote(self, *extra):
        paths = self.files()
        return subprocess.run(
            [sys.executable, "-m", "shop", "quote", "--catalog", paths["catalog"], "--cart", paths["cart"],
             "--region", "OR", "--coupons", paths["coupons"], *extra],
            capture_output=True,
            text=True,
        )

    def test_quote_with_coupon(self):
        done = self.quote("--coupon", "HALF")
        self.assertEqual(done.returncode, 0, done.stderr)
        order = json.loads(done.stdout)
        self.assertEqual(order["coupon"], 300)
        self.assertEqual(order["total"], 300)

    def test_unknown_coupon(self):
        done = self.quote("--coupon", "NOPE")
        self.assertEqual(done.returncode, 2)
        self.assertTrue(done.stderr.strip())


if __name__ == "__main__":
    unittest.main()
