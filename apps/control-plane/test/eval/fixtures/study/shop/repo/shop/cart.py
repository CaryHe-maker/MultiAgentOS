"""A cart reserves stock as items are added."""
from .catalog import Catalog
from .inventory import Inventory
from .pricing import bulk_discount, line_total


class Cart:
    def __init__(self, catalog: Catalog, inventory: Inventory):
        self.catalog = catalog
        self.inventory = inventory
        self._lines = {}

    def add(self, sku: str, quantity: int = 1) -> None:
        self.catalog.get(sku)
        self.inventory.reserve(sku, quantity)
        self._lines[sku] = self._lines.get(sku, 0) + quantity

    def remove(self, sku: str, quantity: int = None) -> None:
        held = self._lines.get(sku, 0)
        quantity = held if quantity is None else min(quantity, held)
        if quantity <= 0:
            return
        self.inventory.release(sku, quantity)
        if held == quantity:
            del self._lines[sku]
        else:
            self._lines[sku] = held - quantity

    def lines(self):
        """(product, quantity) in the order the products were first added."""
        return [(self.catalog.get(sku), quantity) for sku, quantity in self._lines.items()]

    def subtotal(self) -> int:
        return sum(line_total(p.price_cents, q) for p, q in self.lines())

    def discount(self) -> int:
        return sum(bulk_discount(p.price_cents, q) for p, q in self.lines())

    def clear(self) -> None:
        """Forget the lines without releasing them (they were sold)."""
        self._lines.clear()

    def empty(self) -> None:
        for sku in list(self._lines):
            self.remove(sku)
