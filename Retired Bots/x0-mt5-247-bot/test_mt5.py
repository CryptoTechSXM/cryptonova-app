import os
import time
from dotenv import load_dotenv
import MetaTrader5 as mt5

load_dotenv()

# Your MT5 terminal path (safe to keep here)
MT5_PATH = r"C:\Program Files\MetaTrader 5\terminal64.exe"

# Load MT5 login details from .env
login_str = os.getenv("MT5_LOGIN")
password = os.getenv("MT5_PASSWORD")
server = os.getenv("MT5_SERVER")

SYMBOL = "XAUUSD.pro"

def die(msg: str):
    print(msg)
    try:
        mt5.shutdown()
    except Exception:
        pass
    raise SystemExit

def show_last_error(prefix=""):
    code, desc = mt5.last_error()
    print(f"{prefix}({code}, '{desc}')")

def wait_ready(seconds=15):
    """Wait until terminal_info() becomes available."""
    for _ in range(seconds):
        ti = mt5.terminal_info()
        if ti is not None:
            return True
        time.sleep(1)
    return False

def main():
    # Basic env validation
    if not login_str or not password or not server:
        die("❌ Missing MT5_LOGIN / MT5_PASSWORD / MT5_SERVER in .env")

    login = int(login_str)

    print("=== MT5 Connection Test ===")
    print("Step 1) Try attach to an already-open MT5 terminal...")

    # Attempt 1: attach to running terminal
    if mt5.initialize(timeout=5000):
        print("✅ initialize() attached to running terminal.")
    else:
        print("❌ initialize() could not attach.")
        show_last_error("Last error: ")

        print("\nStep 2) Try launching MT5 via path...")
        if mt5.initialize(path=MT5_PATH, timeout=5000):
            print("✅ initialize(path=...) launched/connected to terminal.")
        else:
            print("❌ initialize(path=...) failed.")
            show_last_error("Last error: ")
            die("\n🚫 Cannot connect to MT5. Next fix: kill terminal64.exe in Task Manager and ensure MT5+CMD have same permissions.")

    # Wait for terminal to be ready
    print("Waiting for terminal readiness...")
    if not wait_ready(seconds=20):
        show_last_error("Terminal not ready, last error: ")
        die("❌ MT5 terminal not ready (terminal_info() stayed None). Close MT5 popups and retry.")

    # Login
    print("Logging in...")
    if not mt5.login(login, password=password, server=server):
        print("❌ mt5.login failed.")
        show_last_error("Last error: ")
        die("Check MT5_LOGIN / MT5_PASSWORD / MT5_SERVER in .env (must match MT5 exactly).")

    acc = mt5.account_info()
    if acc is None:
        show_last_error("Account info error: ")
        die("❌ account_info() returned None after login.")

    print("✅ Logged in!")
    print(f"Account: {acc.login} | Balance: {acc.balance} | Server: {server}")

    # Symbol check
    info = mt5.symbol_info(SYMBOL)
    if info is None:
        die(f"❌ Symbol not found in MT5: {SYMBOL} (check Market Watch name)")

    if not info.visible:
        mt5.symbol_select(SYMBOL, True)
        info = mt5.symbol_info(SYMBOL)

    tick = mt5.symbol_info_tick(SYMBOL)
    print(f"✅ Symbol OK: {SYMBOL}")
    if tick:
        print(f"Bid: {tick.bid}  Ask: {tick.ask}")
    else:
        print("⚠️ No tick data yet (market closed or symbol not streaming).")

    mt5.shutdown()
    print("Done.")

if __name__ == "__main__":
    main()
