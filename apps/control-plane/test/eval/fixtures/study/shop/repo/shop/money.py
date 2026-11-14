"""Money is kept as integer cents; these helpers convert and round."""
from decimal import Decimal, ROUND_HALF_UP


def to_cents(amount) -> int:
    """'12.34', 12.34 or Decimal('12.34') -> 1234."""
    return int((Decimal(str(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def percent_of(cents: int, rate) -> int:
    """`rate` of `cents`, rounded half up to a whole cent (rate 0.0725 is 7.25%)."""
    return int((Decimal(cents) * Decimal(str(rate))).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def fmt(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
