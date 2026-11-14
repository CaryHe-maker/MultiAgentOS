"""Checkout turns a cart into an order and takes its items out of the stock."""
import itertools
from dataclasses import dataclass, field

from .cart import Cart
from .tax import tax_cents

_numbers = itertools.count(1)


@dataclass
class Order:
    number: int
    region: str
    subtotal: int
    discount: int
    tax: int
    total: int
    lines: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "number": self.number,
            "region": self.region,
            "subtotal": self.subtotal,
            "discount": self.discount,
            "tax": self.tax,
            "total": self.total,
            "lines": self.lines,
        }


class EmptyCart(Exception):
    pass


def checkout(cart: Cart, region: str) -> Order:
    lines = cart.lines()
    if not lines:
        raise EmptyCart()
    subtotal = cart.subtotal()
    discount = cart.discount()
    taxable = subtotal - discount
    tax = tax_cents(taxable, region)
    order = Order(
        number=next(_numbers),
        region=region.upper(),
        subtotal=subtotal,
        discount=discount,
        tax=tax,
        total=taxable + tax,
        lines=[{"sku": p.sku, "quantity": q, "price": p.price_cents} for p, q in lines],
    )
    for product, quantity in lines:
        cart.inventory.commit(product.sku, quantity)
    cart.clear()
    return order
