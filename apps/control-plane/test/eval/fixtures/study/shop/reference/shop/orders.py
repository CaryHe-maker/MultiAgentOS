"""Checkout turns a cart into an order and takes its items out of the stock."""
import datetime
import itertools
from dataclasses import dataclass, field

from .cart import Cart
from .coupons import Coupon
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
    coupon: int = 0
    coupon_code: object = None

    def as_dict(self) -> dict:
        return {
            "number": self.number,
            "region": self.region,
            "subtotal": self.subtotal,
            "discount": self.discount,
            "tax": self.tax,
            "total": self.total,
            "lines": self.lines,
            "coupon": self.coupon,
            "coupon_code": self.coupon_code,
        }


class EmptyCart(Exception):
    pass


def checkout(cart: Cart, region: str, coupon: Coupon = None, today=None) -> Order:
    lines = cart.lines()
    if not lines:
        raise EmptyCart()
    subtotal = cart.subtotal()
    discount = cart.discount()
    off = 0 if coupon is None else coupon.amount(subtotal, subtotal - discount, today or datetime.date.today())
    taxable = subtotal - discount - off
    tax = tax_cents(taxable, region)
    order = Order(
        number=next(_numbers),
        region=region.upper(),
        subtotal=subtotal,
        discount=discount,
        tax=tax,
        total=taxable + tax,
        lines=[{"sku": p.sku, "quantity": q, "price": p.price_cents} for p, q in lines],
        coupon=off,
        coupon_code=None if coupon is None else coupon.code,
    )
    for product, quantity in lines:
        cart.inventory.commit(product.sku, quantity)
    cart.clear()
    return order
