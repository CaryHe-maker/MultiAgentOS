"""Cleaning the export before it is counted.

The export system writes a correction as a new row with the same order_id; the row written
last is the one that holds.
"""


def dedupe(rows):
    last = {}
    for row in rows:
        last.pop(row.order_id, None)
        last[row.order_id] = row
    return list(last.values())


def valid(rows):
    """Rows with a region and a date; the rest are dropped."""
    return [row for row in rows if row.region and len(row.date) == 10]
