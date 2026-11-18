import unittest

from shop.inventory import Inventory, OutOfStock


class InventoryTest(unittest.TestCase):
    def test_reserve_and_release(self):
        inventory = Inventory({"A": 5})
        inventory.reserve("A", 3)
        self.assertEqual(inventory.available("A"), 2)
        inventory.release("A", 3)
        self.assertEqual(inventory.available("A"), 5)

    def test_reserve_more_than_stock(self):
        inventory = Inventory({"A": 2})
        with self.assertRaises(OutOfStock):
            inventory.reserve("A", 3)

    def test_reserve_counts_existing_reservations(self):
        inventory = Inventory({"A": 5})
        inventory.reserve("A", 4)
        with self.assertRaises(OutOfStock):
            inventory.reserve("A", 2)

    def test_commit_takes_stock(self):
        inventory = Inventory({"A": 5})
        inventory.reserve("A", 2)
        inventory.commit("A", 2)
        self.assertEqual(inventory.stock("A"), 3)
        self.assertEqual(inventory.reserved("A"), 0)


if __name__ == "__main__":
    unittest.main()
