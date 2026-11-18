"""Sales tax by region."""
from .money import percent_of

RATES = {
    "CA": "0.0725",
    "NY": "0.04",
    "TX": "0.0625",
    "OR": "0.0",
    "MT": "0.0",
}
DEFAULT_RATE = "0.05"


def rate_for(region: str):
    return RATES.get(region.upper(), DEFAULT_RATE)


def tax_cents(taxable_cents: int, region: str) -> int:
    return percent_of(taxable_cents, rate_for(region))
