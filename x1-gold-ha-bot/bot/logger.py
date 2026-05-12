import os
import csv
from datetime import datetime


LOG_DIR = "logs"
RUNTIME_LOG = os.path.join(LOG_DIR, "runtime.log")
TRADE_LOG = os.path.join(LOG_DIR, "trades.csv")


def ensure_log_dir():
    if not os.path.exists(LOG_DIR):
        os.makedirs(LOG_DIR)


def log(message: str):
    try:
        ensure_log_dir()

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        formatted = f"[{timestamp}] {message}"

        print(formatted)

        with open(RUNTIME_LOG, "a", encoding="utf-8") as f:
            f.write(formatted + "\n")

    except Exception as e:
        print(f"[LOGGER ERROR] {e}")


def log_trade(data: dict):
    try:
        ensure_log_dir()

        file_exists = os.path.isfile(TRADE_LOG)

        with open(TRADE_LOG, "a", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=data.keys())

            if not file_exists:
                writer.writeheader()

            writer.writerow(data)

    except Exception as e:
        log(f"Trade log error: {e}")