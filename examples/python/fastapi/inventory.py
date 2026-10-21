import asyncio


class OutOfStock(Exception):
    pass


class PricingTimeout(Exception):
    pass


STOCK = {"sku-1": 0, "sku-2": 3}


def reserve(sku: str, quantity: int) -> None:
    if STOCK.get(sku, 0) < quantity:
        raise OutOfStock(f"{sku}: {quantity} requested, {STOCK.get(sku, 0)} left")  # frame: reserve


def price(cart_id: int) -> int:
    raise PricingTimeout(f"pricing for cart {cart_id} timed out after 2.5s")  # frame: price


async def check_warehouse(name: str) -> None:
    await asyncio.sleep(0)
    raise ConnectionError(f"warehouse {name} unreachable")  # frame: check_warehouse
