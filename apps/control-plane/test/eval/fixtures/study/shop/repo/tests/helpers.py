from shop.cart import Cart
from shop.catalog import Catalog, Product
from shop.inventory import Inventory


def shop(stock=100):
    catalog = Catalog(
        [
            Product("PEN", "Pen", 150, "office"),
            Product("PAD", "Notepad", 499, "office"),
            Product("MUG", "Mug", 1200, "kitchen"),
        ]
    )
    inventory = Inventory({"PEN": stock, "PAD": stock, "MUG": stock})
    return catalog, inventory, Cart(catalog, inventory)
