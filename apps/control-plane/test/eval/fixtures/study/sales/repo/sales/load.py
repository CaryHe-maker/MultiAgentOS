"""Reading the order export: order_id,date,region,amount (amount in units, "12.50")."""
import csv
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Row:
    order_id: str
    date: str  # YYYY-MM-DD
    region: str
    amount: Decimal


def read_rows(path: str):
    with open(path, newline="", encoding="utf8") as handle:
        reader = csv.DictReader(handle)
        missing = {"order_id", "date", "region", "amount"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"missing columns: {', '.join(sorted(missing))}")
        return [
            Row(line["order_id"].strip(), line["date"].strip(), line["region"].strip().upper(), Decimal(line["amount"]))
            for line in reader
        ]
