"""Products by SKU."""
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int
    category: str = "general"


class UnknownProduct(KeyError):
    pass


class Catalog:
    def __init__(self, products=()):
        self._products = {}
        for product in products:
            self.add(product)

    def add(self, product: Product) -> None:
        if product.price_cents < 0:
            raise ValueError(f"negative price for {product.sku}")
        self._products[product.sku] = product

    def get(self, sku: str) -> Product:
        try:
            return self._products[sku]
        except KeyError:
            raise UnknownProduct(sku) from None

    def __contains__(self, sku: str) -> bool:
        return sku in self._products

    @classmethod
    def load(cls, path: str) -> "Catalog":
        """A JSON list of {sku, name, price, category?}; price in units ("4.99")."""
        from .money import to_cents

        with open(path, encoding="utf8") as handle:
            rows = json.load(handle)
        return cls(
            Product(row["sku"], row["name"], to_cents(row["price"]), row.get("category", "general"))
            for row in rows
        )
