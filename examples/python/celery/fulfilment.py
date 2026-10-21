class PrinterOffline(Exception):
    pass


class CarrierTimeout(Exception):
    pass


def print_label(order_id: int) -> None:
    raise PrinterOffline(f"label printer for order {order_id} is offline")  # frame: print_label


def book_courier(order_id: int) -> None:
    raise CarrierTimeout(f"carrier booking for order {order_id} timed out")  # frame: book_courier
