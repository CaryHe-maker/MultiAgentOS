"""Stock on hand and the part of it reserved by carts."""


class OutOfStock(Exception):
    def __init__(self, sku: str, wanted: int, available: int):
        super().__init__(f"{sku}: wanted {wanted}, available {available}")
        self.sku = sku
        self.wanted = wanted
        self.available = available


class Inventory:
    def __init__(self, stock=None):
        self._stock = dict(stock or {})
        self._reserved = {}

    def stock(self, sku: str) -> int:
        return self._stock.get(sku, 0)

    def reserved(self, sku: str) -> int:
        return self._reserved.get(sku, 0)

    def available(self, sku: str) -> int:
        return self.stock(sku) - self.reserved(sku)

    def receive(self, sku: str, quantity: int) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._stock[sku] = self.stock(sku) + quantity

    def reserve(self, sku: str, quantity: int) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if quantity > self.stock(sku):
            raise OutOfStock(sku, quantity, self.available(sku))
        self._reserved[sku] = self.reserved(sku) + quantity

    def release(self, sku: str, quantity: int) -> None:
        self._reserved[sku] = max(0, self.reserved(sku) - quantity)

    def commit(self, sku: str, quantity: int) -> None:
        """A reservation was sold: it leaves the stock."""
        if quantity > self.reserved(sku):
            raise ValueError(f"{sku}: committing more than reserved")
        self._reserved[sku] -= quantity
        self._stock[sku] -= quantity
