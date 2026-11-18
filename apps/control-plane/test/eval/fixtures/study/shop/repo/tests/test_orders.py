import unittest

from shop.orders import EmptyCart, checkout
from tests.helpers import shop


class OrdersTest(unittest.TestCase):
    def test_checkout_totals(self):
        _, inventory, cart = shop()
        cart.add("PEN", 2)
        cart.add("MUG", 1)
        order = checkout(cart, "CA")
        self.assertEqual(order.subtotal, 1500)
        self.assertEqual(order.discount, 0)
        self.assertEqual(order.tax, 109)
        self.assertEqual(order.total, 1609)
        self.assertEqual(inventory.stock("PEN"), 98)

    def test_empty_cart(self):
        _, _, cart = shop()
        with self.assertRaises(EmptyCart):
            checkout(cart, "CA")

    def test_remove(self):
        _, inventory, cart = shop()
        cart.add("PAD", 3)
        cart.remove("PAD", 1)
        self.assertEqual(cart.subtotal(), 998)
        self.assertEqual(inventory.reserved("PAD"), 2)


if __name__ == "__main__":
    unittest.main()
