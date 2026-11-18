"""Coupons taken off after the bulk discount and before tax."""
import datetime
import json
from dataclasses import dataclass
from typing import Optional

from .money import percent_of


class CouponError(Exception):
    pass


@dataclass(frozen=True)
class Coupon:
    code: str
    kind: str
    value: int
    min_subtotal: int = 0
    expires: Optional[datetime.date] = None

    def amount(self, subtotal: int, discounted: int, today: datetime.date) -> int:
        if subtotal < self.min_subtotal:
            raise CouponError(f"{self.code}: needs a subtotal of {self.min_subtotal}")
        if self.expires is not None and today > self.expires:
            raise CouponError(f"{self.code}: expired on {self.expires}")
        if self.kind == "percent":
            off = percent_of(discounted, f"{self.value / 100}")
        elif self.kind == "fixed":
            off = self.value
        else:
            raise CouponError(f"{self.code}: unknown kind {self.kind}")
        return max(0, min(off, discounted))


def load_coupons(path: str) -> dict:
    with open(path, encoding="utf8") as handle:
        rows = json.load(handle)
    return {
        row["code"]: Coupon(
            row["code"],
            row["kind"],
            int(row["value"]),
            int(row.get("min_subtotal", 0)),
            datetime.date.fromisoformat(row["expires"]) if row.get("expires") else None,
        )
        for row in rows
    }
