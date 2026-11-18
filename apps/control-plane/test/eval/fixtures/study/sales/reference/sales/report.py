"""The monthly report: total and number of orders per region and month."""
from decimal import Decimal

from .clean import dedupe, valid


def month_of(date: str) -> str:
    return date[:7]


def monthly(rows):
    """{(region, month): {"orders": n, "total": Decimal}} over cleaned rows."""
    rows = valid(dedupe(rows))
    report = {}
    for row in rows:
        cell = report.setdefault((row.region, month_of(row.date)), {"orders": 0, "total": Decimal("0")})
        cell["orders"] += 1
        cell["total"] += row.amount
    return report


def render(report) -> str:
    lines = [f"{'region':<8}{'month':<9}{'orders':>8}{'total':>14}"]
    for (region, month), cell in sorted(report.items()):
        lines.append(f"{region:<8}{month:<9}{cell['orders']:>8}{cell['total']:>14.2f}")
    grand = sum((cell["total"] for cell in report.values()), Decimal("0"))
    lines.append(f"{'all':<17}{sum(c['orders'] for c in report.values()):>8}{grand:>14.2f}")
    return "\n".join(lines)


def as_json(report):
    return [
        {"region": region, "month": month, "orders": cell["orders"], "total": f"{cell['total']:.2f}"}
        for (region, month), cell in sorted(report.items())
    ]
