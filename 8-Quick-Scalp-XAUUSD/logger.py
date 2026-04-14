import csv
import os
from datetime import datetime

FILE_NAME = "trade_log.csv"


def init_log():
    if not os.path.exists(FILE_NAME):
        with open(FILE_NAME, mode='w', newline='') as file:
            writer = csv.writer(file)
            writer.writerow([
                "Time",
                "Type",
                "Entry Price",
                "Stop Loss",
                "Close Price",
                "Profit"
            ])


def log_trade(trade_type, entry, sl, close_price, profit):
    with open(FILE_NAME, mode='a', newline='') as file:
        writer = csv.writer(file)
        writer.writerow([
            datetime.now(),
            trade_type,
            entry,
            sl,
            close_price,
            profit
        ])
