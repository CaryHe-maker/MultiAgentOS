"""python3 -m shop quote --catalog catalog.json --cart cart.json --region CA"""
import argparse
import json
import sys

from .cart import Cart
from .catalog import Catalog
from .inventory import Inventory
from .coupons import CouponError, load_coupons
from .orders import checkout


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="shop")
    commands = parser.add_subparsers(dest="command", required=True)
    quote = commands.add_parser("quote", help="price a cart without keeping the order")
    quote.add_argument("--catalog", required=True)
    quote.add_argument("--cart", required=True, help='JSON {"SKU": quantity, ...}')
    quote.add_argument("--region", required=True)
    quote.add_argument("--coupons")
    quote.add_argument("--coupon")
    args = parser.parse_args(argv)

    catalog = Catalog.load(args.catalog)
    with open(args.cart, encoding="utf8") as handle:
        wanted = json.load(handle)
    # A quote is not limited by stock.
    inventory = Inventory(dict(wanted))
    cart = Cart(catalog, inventory)
    for sku, quantity in wanted.items():
        cart.add(sku, quantity)
    coupon = None
    if args.coupon:
        coupon = load_coupons(args.coupons).get(args.coupon) if args.coupons else None
        if coupon is None:
            print(f"unknown coupon {args.coupon}", file=sys.stderr)
            return 2
    try:
        order = checkout(cart, args.region, coupon=coupon)
    except CouponError as error:
        print(error, file=sys.stderr)
        return 2
    json.dump(order.as_dict(), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
