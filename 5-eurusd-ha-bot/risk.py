from datetime import datetime, timezone
import MetaTrader5 as mt5


def is_session_active(config):
    now_utc = datetime.now(timezone.utc).hour
    active = config.SESSION_START_UTC <= now_utc < config.SESSION_END_UTC
    if not active:
        print(f"Outside trading session (UTC {now_utc:02d}:xx)")
    return active


class DailyRiskManager:

    def __init__(self, config):
        self.config       = config
        self.trade_date   = datetime.now(timezone.utc).date()
        self.trade_count  = 0
        self.daily_pnl    = 0.0
        self.open_balance = None
        self.blocked      = False

    def _reset_if_new_day(self):
        today = datetime.now(timezone.utc).date()
        if today is not self.trade_date and today > self.trade_date:
            self.trade_date   = today
            self.trade_count  = 0
            self.daily_pnl    = 0.0
            self.open_balance = None
            self.blocked      = False

    def _opening_balance(self):
        if self.open_balance is None:
            acc = mt5.account_info()
            self.open_balance = acc.balance if acc else 0.0
        return self.open_balance

    def record_entry(self):
        self._reset_if_new_day()
        self.trade_count += 1
        max_t = getattr(self.config, "MAX_DAILY_TRADES", 3)
        print(f"Daily trades: {self.trade_count}/{max_t}")
        if self.trade_count >= max_t:
            print(f"Daily trade limit reached ({self.trade_count}/{max_t})")
            self.blocked = True

    def record_trade(self, profit_usd):
        self._reset_if_new_day()
        self.daily_pnl += profit_usd
        bal     = self._opening_balance()
        pct     = (self.daily_pnl / bal * 100) if bal > 0 else 0
        max_pct = getattr(self.config, "MAX_DAILY_LOSS_PCT", 3.0)
        print(f"Daily P&L: {self.daily_pnl:+.2f} ({pct:+.1f}%) | limit: -{max_pct}%")
        if pct <= -max_pct:
            print(f"Daily loss limit hit ({pct:.1f}%)")
            self.blocked = True

    def can_trade(self):
        self._reset_if_new_day()
        if self.blocked:
            max_t = getattr(self.config, "MAX_DAILY_TRADES", 3)
            print(f"Trading blocked - trades: {self.trade_count}/{max_t}  P&L: {self.daily_pnl:+.2f}")
        return not self.blocked
