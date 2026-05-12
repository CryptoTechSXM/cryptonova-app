"""
config.py - Centralised Settings

All configuration is loaded from a .env file using python-dotenv.
Never hard-code credentials here - put them in your .env file instead.

Required .env keys:
    MT5_LOGIN, MT5_PASSWORD, MT5_SERVER
    TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_CHANNELS

Optional .env keys (have safe defaults):
    MT5_MAGIC_NUMBER            default 234000
    TELEGRAM_SESSION_NAME       default "cryptonite_session"
    EXECUTION_CHANNEL_ID        default ""
    REPORT_CHANNEL_ID           default ""
    BASE_RISK_PCT               default 1.0
    TIME_FILTER_ENABLED         default true
    TIME_FILTER_START_HOUR      default 7
    TIME_FILTER_END_HOUR        default 22
    MAX_DAILY_LOSS_TRADES       default 5
    MAX_CONSECUTIVE_LOSSES      default 3
    MAX_TRADES_PER_SYMBOL       default 2
    COOLDOWN_SECONDS            default 60
    PARTIAL_CLOSE_ENABLED       default true
    PARTIAL_CLOSE_PERCENT       default 50
    ADOPT_MANUAL_TRADES         default false
    BE_BUFFER_DOLLARS           default 0.0
    TRAIL_GIVEBACK_R            default 0.25
    CHANNEL_ROUTING             default ""
    CHANNEL_RISK                default ""
    DEFAULT_PARSER_MODE         default "auto"
    DAILY_REPORT_ENABLED        default true
    DAILY_REPORT_HOUR           default 21
    TELEGRAM_BOT_TOKEN          default ""
    CONTROL_CHAT_ID             default ""
    BOT_COMMANDS_ENABLED        default true
"""

import os
from dotenv import load_dotenv

load_dotenv()

VALID_PARSER_MODES = ("auto", "structured", "inline", "market_only", "strict")


def _get_int(key, default=None):
    val = os.getenv(key)
    if val is None or val.strip() == "":
        return default
    try:
        return int(val)
    except ValueError:
        raise ValueError(f"[CONFIG] {key} must be an integer, got: {val!r}")


def _get_float(key, default=None):
    val = os.getenv(key)
    if val is None or val.strip() == "":
        return default
    try:
        return float(val)
    except ValueError:
        raise ValueError(f"[CONFIG] {key} must be a float, got: {val!r}")


def _get_bool(key, default=False):
    val = os.getenv(key)
    if val is None or val.strip() == "":
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _get_channel_list(key):
    val = os.getenv(key, "")
    if not val.strip():
        return []
    return [ch.strip() for ch in val.split(",") if ch.strip()]


def _get_int_list(key, default=None):
    val = os.getenv(key, "")
    if not val.strip():
        return default or []
    result = []
    for x in val.split(","):
        x = x.strip()
        if x.lstrip("-").isdigit():
            result.append(int(x))
    return result


def _parse_channel_routing(val):
    result = {}
    if not val:
        return result
    for part in val.split(","):
        part = part.strip()
        if ":" not in part:
            continue
        ch_id, mode = part.split(":", 1)
        ch_id = ch_id.strip()
        mode  = mode.strip().lower()
        if mode in VALID_PARSER_MODES:
            result[ch_id] = mode
    return result


def _parse_channel_risk(val):
    result = {}
    if not val:
        return result
    for part in val.split(","):
        part = part.strip()
        if ":" not in part:
            continue
        ch_id, mult = part.split(":", 1)
        try:
            result[ch_id.strip()] = float(mult.strip())
        except ValueError:
            pass
    return result


class Settings:
    def __init__(self):
        self.mt5_login        = _get_int("MT5_LOGIN")
        self.mt5_password     = os.getenv("MT5_PASSWORD", "")
        self.mt5_server       = os.getenv("MT5_SERVER", "")
        self.mt5_magic_number = _get_int("MT5_MAGIC_NUMBER", 234000)

        self.telegram_api_id       = _get_int("TELEGRAM_API_ID")
        self.telegram_api_hash     = os.getenv("TELEGRAM_API_HASH", "")
        self.telegram_channels     = os.getenv("TELEGRAM_CHANNELS", "")
        self.telegram_session_name = os.getenv("TELEGRAM_SESSION_NAME", "cryptonite_session")

        self.execution_channel_id = os.getenv("EXECUTION_CHANNEL_ID", "")
        self.report_channel_id    = os.getenv("REPORT_CHANNEL_ID", "")

        self.base_risk_pct = _get_float("BASE_RISK_PCT", 1.0)

        self.time_filter_enabled    = _get_bool("TIME_FILTER_ENABLED", True)
        self.time_filter_start_hour = _get_int("TIME_FILTER_START_HOUR", 7)
        self.time_filter_end_hour   = _get_int("TIME_FILTER_END_HOUR", 22)
        self.blocked_hours          = _get_int_list("BLOCKED_HOURS", [])

        self.max_daily_loss_trades  = _get_int("MAX_DAILY_LOSS_TRADES", 5)
        self.max_consecutive_losses = _get_int("MAX_CONSECUTIVE_LOSSES", 3)
        self.max_trades_per_symbol  = _get_int("MAX_TRADES_PER_SYMBOL", 2)
        self.cooldown_seconds       = _get_int("COOLDOWN_SECONDS", 60)

        self.partial_close_enabled  = _get_bool("PARTIAL_CLOSE_ENABLED", True)
        self.partial_close_percent  = _get_float("PARTIAL_CLOSE_PERCENT", 50.0)

        self.adopt_manual_trades = _get_bool("ADOPT_MANUAL_TRADES", False)

        self.be_buffer_dollars = _get_float("BE_BUFFER_DOLLARS", 0.0)
        self.trail_giveback_r  = _get_float("TRAIL_GIVEBACK_R", 0.25)
        self.trail_trigger_r   = _get_float("TRAIL_TRIGGER_R", 0.50)
        self.trail_fixed_pips  = _get_float("TRAIL_FIXED_PIPS", 0.0)

        # ATR-based trailing stop (replaces R-based when ATR_TRAIL_ENABLED=true)
        self.atr_trail_enabled  = _get_bool("ATR_TRAIL_ENABLED",  True)
        self.atr_period         = _get_int("ATR_PERIOD",           14)
        self.atr_be_trigger_pct = _get_float("ATR_BE_TRIGGER_PCT", 0.25)  # 25% of ATR
        self.atr_trail_dist_pct = _get_float("ATR_TRAIL_DIST_PCT", 0.20)  # 20% of ATR
        self.min_be_pips        = _get_float("MIN_BE_PIPS",        10.0)  # floor pips
        self.min_trail_pips     = _get_float("MIN_TRAIL_PIPS",     8.0)   # floor pips

        self.news_filter_enabled    = _get_bool("NEWS_FILTER_ENABLED", False)
        self.news_filter_countries  = [c.strip().upper() for c in os.getenv("NEWS_FILTER_COUNTRIES", "US,EU,GB").split(",") if c.strip()]
        self.news_filter_importance = [v.strip().upper() for v in os.getenv("NEWS_FILTER_IMPORTANCE", "RED,ORANGE").split(",") if v.strip()]
        self.news_filter_before_min = int(os.getenv("NEWS_FILTER_BEFORE_MIN", "30"))
        self.news_filter_after_min  = int(os.getenv("NEWS_FILTER_AFTER_MIN",  "30"))
        self.news_close_before_min  = int(os.getenv("NEWS_CLOSE_BEFORE_MIN",  "10"))

        self.sell_lot_multiplier             = _get_float("SELL_LOT_MULTIPLIER", 1.0)
        self.close_opposite_on_signal        = _get_bool("CLOSE_OPPOSITE_ON_SIGNAL",        False)
        self.close_opposite_same_source_only = _get_bool("CLOSE_OPPOSITE_SAME_SOURCE_ONLY", True)

        self.channel_routing     = _parse_channel_routing(os.getenv("CHANNEL_ROUTING", ""))
        self.channel_risk        = _parse_channel_risk(os.getenv("CHANNEL_RISK", ""))
        self.default_parser_mode = os.getenv("DEFAULT_PARSER_MODE", "auto").lower()

        self.daily_report_enabled    = _get_bool("DAILY_REPORT_ENABLED", True)
        self.daily_report_hour       = _get_int("DAILY_REPORT_HOUR", 21)
        self.drawdown_alert_pct      = _get_float("DRAWDOWN_ALERT_PCT", 3.0)
        self.daily_profit_target_pct = _get_float("DAILY_PROFIT_TARGET_PCT", 2.0)
        self.order_timeout_minutes   = _get_int("ORDER_TIMEOUT_MINUTES", 60)

        self.telegram_bot_token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self.control_chat_id      = _get_int("CONTROL_CHAT_ID")
        self.bot_commands_enabled = _get_bool("BOT_COMMANDS_ENABLED", True)

    def validate(self):
        """Raise EnvironmentError if any required .env key is missing."""
        missing = []
        if not self.mt5_login:
            missing.append("MT5_LOGIN")
        if not self.mt5_password:
            missing.append("MT5_PASSWORD")
        if not self.mt5_server:
            missing.append("MT5_SERVER")
        if not self.telegram_api_id:
            missing.append("TELEGRAM_API_ID")
        if not self.telegram_api_hash:
            missing.append("TELEGRAM_API_HASH")
        if not self.telegram_channels:
            missing.append("TELEGRAM_CHANNELS")
        if missing:
            raise EnvironmentError(
                f"[CONFIG] Missing required .env keys: {', '.join(missing)}"
            )

    def get_channel_ids(self):
        """Return list of channel ID strings from TELEGRAM_CHANNELS."""
        return _get_channel_list("TELEGRAM_CHANNELS")

    def get_parser_mode(self, chat_id):
        """Return parser mode for a channel. Falls back to default_parser_mode."""
        mode = self.channel_routing.get(str(chat_id), self.default_parser_mode)
        if mode not in VALID_PARSER_MODES:
            return "auto"
        return mode

    def get_channel_risk(self, chat_id):
        """Return risk multiplier for a channel. Defaults to 1.0."""
        return self.channel_risk.get(str(chat_id), 1.0)


settings = Settings()
