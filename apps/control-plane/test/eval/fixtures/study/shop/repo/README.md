# shop

A small order-pricing library: a catalog, stock with reservations, carts, bulk discounts and
sales tax by region. Amounts are integer cents everywhere.

Run the tests with `python3 -m unittest discover -s tests -t .`.

    python3 -m shop quote --catalog catalog.json --cart cart.json --region CA

prints the order as JSON.
