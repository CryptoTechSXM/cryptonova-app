from datetime import datetime, timezone
import MetaTrader5 as mt5


def is_session_active(config):
    now_utc = datetime.now(timezone.utc).hour
    active = config.SESSION_OPEN_HOUR <= now_utc < config.SESSION_CLOSE_HOUR
    if not active:
        print("Outside trading session (UTC {:02d}:xx)".format(now_utc))
    return active


class DailyRiskManager:

    def __init__(self, config):
        self.config        = config
        self.trade_date    = datetime.now(timezone.utc).date()
        self.trade_count   = 0
        self.daily_pnl     = 0.0
        self.open_balance  = None
        self.blocked       = False
        self.consec_losses = 0
        self.max_consec    = getattr(config, "MAX_CONSECUTIVE_LOSSES", 3)

    def _reset_if_new_day(self):
        today = datetime.now(timezone.utc).date()
        if today is not self.trade_date and today > self.trade_date:
            self.trade_date    = today
            self.trade_count   = 0
            self.daily_pnl     = 0.0
            self.open_balance  = None
            self.blocked       = False
            self.consec_losses = 0

    def _opening_balance(self):
        if self.open_balance is None:
            acc = mt5.account_info()
            self.open_balance = acc.balance if acc else 0.0
        return self.open_balance

    def record_entry(self):
        self._reset_if_new_day()
        self.trade_count += 1
        max_t = getattr(self.config, "MAX_DAILY_TRADES", 2)
        print("Daily trades: {}/{}".format(self.trade_count, max_t))
        if self.trade_count >= max_t:
            print("Daily trade limit reached ({}/{})".format(self.trade_count, max_t))
            self.blocked = True

    def record_trade(self, profit_usd):
        self._reset_if_new_day()
        self.daily_pnl += profit_usd
        bal     = self._opening_balance()
        pct     = (self.daily_pnl / bal * 100) if bal > 0 else 0
        max_pct = getattr(self.config, "MAX_DAILY_LOSS_PCT", 3.0)
        print("Daily P&L: {:+.2f} ({:+.1f}%) | limit: -{:.1f}%".format(
            self.daily_pnl, pct, max_pct))
        if profit_usd >= 0:
            self.consec_losses = 0
        else:
            self.consec_losses += 1
            print("Consecutive losses: {}/{}".format(self.consec_losses, self.max_consec))
            if self.consec_losses >= self.max_consec:
                print("[KILL SWITCH] {} consecutive losses -- trading PAUSED for today".format(
                    self.consec_losses))
                self.blocked = True
        if pct <= -max_pct:
            print("Daily loss limit hit ({:.1f}%)".format(pct))
            self.blocked = True

    def can_trade(self):
        self._reset_if_new_day()
        if self.blocked:
            max_t = getattr(self.config, "MAX_DAILY_TRADES", 2)
            print("Trading blocked - trades: {}/{}  P&L: {:+.2f}".format(
                self.trade_count, max_t, self.daily_pnl))
        return not self.blocked
