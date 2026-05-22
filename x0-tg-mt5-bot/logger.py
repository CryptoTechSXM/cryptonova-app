from datetime import datetime
import os

LOG_FILE = "trade_log.txt"


def log(message, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] [{level}] {message}"

    # Console
    print(formatted)

    # File
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(formatted + "\n")
    except Exception as e:
        print(f"[LOGGER ERROR] {e}")


# =========================
# TRADE JOURNAL ENTRY
# =========================
def log_trade(symbol, side, entry, sl, tp, result=None, profit=None):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    line = (
        f"{timestamp} | {symbol} | {side} | "
        f"Entry={entry} | SL={sl} | TP={tp}"
    )

    if result:
        line += f" | Result={result}"

    if profit is not None:
        line += f" | Profit={round(profit, 2)}"

    try:
        with open("journal.txt", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        print(f"[JOURNAL ERROR] {e}")