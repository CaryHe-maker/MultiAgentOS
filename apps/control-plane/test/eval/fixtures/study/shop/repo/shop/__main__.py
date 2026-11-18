"""python3 -m shop quote --catalog catalog.json --cart cart.json --region CA"""
import argparse
import json
import sys

from .cart import Cart
from .catalog import Catalog
from .inventory import Inventory
from .orders import checkout


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="shop")
    commands = parser.add_subparsers(dest="command", required=True)
    quote = commands.add_parser("quote", help="price a cart without keeping the order")
    quote.add_argument("--catalog", required=True)
    quote.add_argument("--cart", required=True, help='JSON {"SKU": quantity, ...}')
    quote.add_argument("--region", required=True)
    args = parser.parse_args(argv)

    catalog = Catalog.load(args.catalog)
    with open(args.cart, encoding="utf8") as handle:
        wanted = json.load(handle)
    # A quote is not limited by stock.
    inventory = Inventory(dict(wanted))
    cart = Cart(catalog, inventory)
    for sku, quantity in wanted.items():
        cart.add(sku, quantity)
    order = checkout(cart, args.region)
    json.dump(order.as_dict(), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
