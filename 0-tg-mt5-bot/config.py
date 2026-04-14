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
    EXECUTION_CHANNEL_ID        default "" (no execution alerts)
    REPORT_CHANNEL_ID           default "" (no report alerts)
    BASE_RISK_PCT               default 1.0
    TIME_FILTER_ENABLED         default true
    TIME_FILTER_START_HOUR      default 7
    TIME_FILTER_END_HOUR        default 22
    MAX_DAILY_LOSS_TRADES       default 5
    MAX_TRADES_PER_SYMBOL       default 2
    COOLDOWN_SECONDS            default 60
    PARTIAL_CLOSE_ENABLED       default true
    PARTIAL_CLOSE_PERCENT       default 50
    CHANNEL_ROUTING             default "" (all channels use auto mode)
    CHANNEL_RISK                default "" (all channels use x1.0 risk)
    DEFAULT_PARSER_MODE         default "auto"
    DAILY_REPORT_ENABLED        default true
    DAILY_REPORT_HOUR           default 21
    TELEGRAM_BOT_TOKEN          default "" (bot commands disabled)
    CONTROL_CHAT_ID             default "" (bot commands disabled)
    BOT_COMMANDS_ENABLED        default true
"""

import os
from dotenv import load_dotenv

load_dotenv()

VALID_PARSER_MODES = ("auto", "structured", "inline", "market_only", "strict")


# =========================
# HELPERS
# =========================

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
    """Parse a comma-separated list of channel IDs."""
    val = os.getenv(key, "")
    if not val.strip():
        return []
    return [ch.strip() for ch in val.split(",") if ch.strip()]


def _parse_channel_routing(val: str) -> dict:
    """
    Parse CHANNEL_ROUTING="-100123:structured,-100456:inline"
    Returns {"-100123": "structured", "-100456": "inline"}
    """
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


def _parse_channel_risk(val: str) -> dict:
    """
    Parse CHANNEL_RISK="-100123:1.5,-100456:0.5"
    Returns {"-100123": 1.5, "-100456": 0.5}
    """
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


# =========================
# SETTINGS OBJECT
# =========================

class Settings:
    def __init__(self):
        # --- MT5 ---
        self.mt5_login      = _get_int("MT5_LOGIN")
        self.mt5_password   = os.getenv("MT5_PASSWORD", "")
        self.mt5_server     = os.getenv("MT5_SERVER", "")
        self.mt5_magic_number = _get_int("MT5_MAGIC_NUMBER", 234000)

        # --- Telegram user client ---
        self.telegram_api_id    = _get_int("TELEGRAM_API_ID")
        self.telegram_api_hash  = os.getenv("TELEGRAM_API_HASH", "")
        self.telegram_channels  = os.getenv("TELEGRAM_CHANNELS", "")
        self.telegram_session_name = os.getenv("TELEGRAM_SESSION_NAME", "cryptonite_session")

        # --- Notification targets ---
        self.execution_channel_id = os.getenv("EXECUTION_CHANNEL_ID", "")
        self.report_channel_id    = os.getenv("REPORT_CHANNEL_ID", "")

        # --- Risk ---
        self.base_risk_pct = _get_float("BASE_RISK_PCT", 1.0)

        # --- Time filter ---
        self.time_filter_enabled    = _get_bool("TIME_FILTER_ENABLED", True)
        self.time_filter_start_hour = _get_int("TIME_FILTER_START_HOUR", 7)
        self.time_filter_end_hour   = _get_int("TIME_FILTER_END_HOUR", 22)

        # --- Trade limits ---
        self.max_daily_loss_trades  = _get_int("MAX_DAILY_LOSS_TRADES", 5)
        self.max_trades_per_symbol  = _get_int("MAX_TRADES_PER_SYMBOL", 2)
        self.cooldown_seconds       = _get_int("COOLDOWN_SECONDS", 60)

        # --- Partial close ---
        self.partial_close_enabled = _get_bool("PARTIAL_CLOSE_ENABLED", True)
        self.partial_close_percent = _get_float("PARTIAL_CLOSE_PERCENT", 50.0)

        # --- Per-channel routing ---
        self.channel_routing     = _parse_channel_routing(os.getenv("CHANNEL_ROUTING", ""))
        self.channel_risk        = _parse_channel_risk(os.getenv("CHANNEL_RISK", ""))
        self.default_parser_mode = os.getenv("DEFAULT_PARSER_MODE", "auto").lower()

        # --- Daily report ---
        self.daily_report_enabled = _get_bool("DAILY_REPORT_ENABLED", True)
        self.daily_report_hour    = _get_int("DAILY_REPORT_HOUR", 21)

        # --- Bot commands ---
        self.telegram_bot_token  = os.getenv("TELEGRAM_BOT_TOKEN", "")
        self.control_chat_id     = _get_int("CONTROL_CHAT_ID")
        self.bot_commands_enabled = _get_bool("BOT_COMMANDS_ENABLED", True)

    def get_channel_ids(self) -> list:
        """Return list of channel ID strings from TELEGRAM_CHANNELS."""
        return _get_channel_list("TELEGRAM_CHANNELS")

    def get_parser_mode(self, chat_id: str) -> str:
        """
        Return the parser mode for a given channel ID.
        Falls back to default_parser_mode if not explicitly mapped.
        """
        mode = self.channel_routing.get(str(chat_id), self.default_parser_mode)
        if mode not in VALID_PARSER_MODES:
            return "auto"
        return mode

    def get_channel_risk(self, chat_id: str) -> float:
        """
        Return the risk multiplier for a given channel ID.
        Defaults to 1.0 if not explicitly set.
        """
        return self.channel_risk.get(str(chat_id), 1.0)

    def validate(self):
        """
        Check that all required fields are present.
        Raises EnvironmentError with a descriptive message if anything is missing.
        """
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


settings = Settings()
