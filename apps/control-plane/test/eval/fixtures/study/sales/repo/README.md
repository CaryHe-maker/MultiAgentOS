# sales

The monthly sales report from the order export (`order_id,date,region,amount`).

    python3 -m sales report data/export-2026.csv
    python3 -m sales report data/export-2026.csv --json

Tests: `python3 -m unittest discover -s tests -t .`
