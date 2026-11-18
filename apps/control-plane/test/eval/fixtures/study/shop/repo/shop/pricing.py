"""Line totals and the bulk discount."""
from .money import percent_of

BULK_QUANTITY = 10
BULK_RATE = "0.10"


def line_total(price_cents: int, quantity: int) -> int:
    return price_cents * quantity


def bulk_discount(price_cents: int, quantity: int) -> int:
    """10% off a line of BULK_QUANTITY or more of the same product."""
    if quantity > BULK_QUANTITY:
        return percent_of(line_total(price_cents, quantity), BULK_RATE)
    return 0
