"""Cleaning the export before it is counted.

The export system writes a correction as a new row with the same order_id; the row written
last is the one that holds.
"""


def dedupe(rows):
    kept = []
    for row in rows:
        if row.order_id in [each.order_id for each in kept]:
            continue
        kept.append(row)
    return kept


def valid(rows):
    """Rows with a region and a date; the rest are dropped."""
    return [row for row in rows if row.region and len(row.date) == 10]
