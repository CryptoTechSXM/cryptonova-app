"""
telegram_control.py
====================
Lightweight Telegram command interface for the CNFS Executor bot.
Uses Bot API polling — no Telethon / API_ID needed, just a BOT_TOKEN.

Commands (sent to the bot in Telegram):
  /help       — list all commands
  /status     — bot state, position summary, paused/active
  /pause      — stop accepting new signals (open trades unaffected)
  /resume     — re-enable signal processing
  /positions  — list all open positions with floating P&L and trail status
  /stats      — today's W/L/BE, P&L, balance, equity
  /daily      — today's closed trade breakdown
  /weekly     — last 7 days performance
  /monthly    — month-to-date performance

Reports are sent to REPORT_CHAT_ID automatically on:
  - Bot online / offline
  - Trade opened
  - Trail SL moved
  - Position closed (by SL/TP/trail)

SECURITY: only messages from CONTROL_CHAT_ID are acted on.
"""

import threading
import time
import json
import ssl
import urllib.request
import urllib.parse
from datetime import datetime, date, timezone, timedelta

# Bypass SSL verification — fixes self-signed certificate errors on some networks
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode    = ssl.CERT_NONE


class TelegramControl:
    def __init__(self, bot_token, control_chat_id, report_chat_id,
                 get_state_fn, pause_fn, resume_fn):
        self._token      = bot_token
        self._control_id = str(control_chat_id)
        self._report_id  = str(report_chat_id)
        self._get_state  = get_state_fn
        self._pause      = pause_fn
        self._resume     = resume_fn
        self._offset     = 0
        self._running    = False

    # ----------------------------------------------------------
    # API helpers
    # ----------------------------------------------------------
    def _api(self, method, params=None):
        url  = "https://api.telegram.org/bot{}/{}".format(self._token, method)
        data = json.dumps(params or {}).encode()
        req  = urllib.request.Request(url, data=data,
                                      headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15, context=_SSL_CTX) as r:
                return json.loads(r.read())
        except Exception as e:
            err = str(e).lower()
            if "timed out" in err or "time out" in err:
                return None  # normal long-polling timeout — suppress
            print("[CTRL] API error {}: {}".format(method, e))
            return None

    def _send(self, chat_id, text):
        self._api("sendMessage", {
            "chat_id":    str(chat_id),
            "text":       text,
            "parse_mode": "HTML",
        })

    def send_report(self, text):
        """Send a message to the report channel."""
        self._send(self._report_id, text)

    # ----------------------------------------------------------
    # Command handlers
    # ----------------------------------------------------------
    def _cmd_help(self):
        return (
            "\U0001f916 <b>CNFS Executor Commands</b>\n\n"
            "/status     — Bot state &amp; open positions\n"
            "/positions  — Open positions with P&amp;L &amp; trail info\n"
            "/stats      — Today's W/L/BE, P&amp;L, balance\n"
            "/daily      — Today's closed trades breakdown\n"
            "/weekly     — Last 7 days performance\n"
            "/monthly    — Month-to-date performance\n"
            "/pause      — Stop accepting new signals\n"
            "/resume     — Re-enable signal processing\n"
            "/help       — This message"
        )

    def _cmd_status(self):
        state = self._get_state()
        paused    = state.get("paused", False)
        total     = state.get("total_positions", 0)
        at_risk   = state.get("at_risk", 0)
        be_locked = state.get("be_locked", 0)
        balance   = state.get("balance", 0)
        equity    = state.get("equity", 0)
        symbol    = state.get("symbol", "XAUUSD")

        status_icon = "\u23f8" if paused else "\u2705"
        status_txt  = "PAUSED" if paused else "ACTIVE"

        lines = [
            "\U0001f916 <b>CNFS Executor — Status</b>",
            "",
            "{} Trading: <b>{}</b>".format(status_icon, status_txt),
            "\U0001f4ca Symbol: {}".format(symbol),
            "",
            "\U0001f4c2 Open positions: {}".format(total),
            "  \u26a0\ufe0f  At risk (original SL): {}".format(at_risk),
            "  \U0001f512 Breakeven locked: {}".format(be_locked),
            "",
            "\U0001f4b0 Balance: ${:,.2f}".format(balance),
            "\U0001f4c8 Equity:  ${:,.2f}".format(equity),
            "",
            "\U0001f550 {}".format(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")),
        ]
        return "\n".join(lines)

    def _cmd_positions(self):
        state = self._get_state()
        positions = state.get("positions_detail", [])
        if not positions:
            return "\U0001f4c2 No open positions"
        lines = ["\U0001f4c2 <b>Open Positions</b>\n"]
        for p in positions:
            trail_icon = "\U0001f512" if p["be_done"] else "\u26a0\ufe0f"
            lines.append(
                "{} <b>{} {}</b>\n"
                "   Entry: {:.2f}  SL: {:.2f}  TP: {:.2f}\n"
                "   Float: {:+.1f} pips  ({:+.2f}$)\n"
                "   Trail: {}".format(
                    trail_icon,
                    p["direction"], p["ticket"],
                    p["entry"], p["current_sl"], p["tp"],
                    p["float_pips"], p["float_usd"],
                    "Locked @ {:.1f}p".format(p["locked_pips"]) if p["be_done"]
                    else "Not yet locked"
                )
            )
        return "\n".join(lines)

    def _cmd_pause(self):
        self._pause()
        return (
            "\u23f8 <b>Trading PAUSED</b>\n\n"
            "No new signals will be executed.\n"
            "Open trades and trailing stops are unaffected.\n\n"
            "Send /resume to re-enable."
        )

    def _cmd_resume(self):
        self._resume()
        return (
            "\u25b6\ufe0f <b>Trading RESUMED</b>\n\n"
            "Bot is now accepting signals again."
        )

    def _deal_stats(self, start_dt, end_dt):
        """Fetch closed deal stats between two datetimes. Returns (wins,losses,be,total_pnl)."""
        try:
            import MetaTrader5 as mt5
            import config
            deals = mt5.history_deals_get(start_dt, end_dt) or []
            wins = losses = be = 0
            total_pnl = 0.0
            for d in deals:
                if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL): continue
                if d.entry != mt5.DEAL_ENTRY_OUT: continue
                if getattr(d, "magic", 0) != config.MAGIC_NUMBER: continue
                pnl = d.profit
                total_pnl += pnl
                if pnl > 0.05:    wins += 1
                elif pnl < -0.05: losses += 1
                else:             be += 1
            return wins, losses, be, total_pnl
        except Exception:
            return 0, 0, 0, 0.0

    def _cmd_stats(self):
        try:
            import MetaTrader5 as mt5
            today    = date.today()
            start_dt = datetime.combine(today, datetime.min.time()).replace(tzinfo=timezone.utc)
            wins, losses, be, total_pnl = self._deal_stats(start_dt, datetime.now(timezone.utc))
            total = wins + losses + be
            wr    = round(wins / total * 100) if total > 0 else 0
            state = self._get_state()
            balance = state.get("balance", 0)
            equity  = state.get("equity", 0)
            open_p  = state.get("total_positions", 0)
            pnl_e   = "\U0001f4c8" if total_pnl >= 0 else "\U0001f4c9"
            pnl_s   = "+" if total_pnl >= 0 else ""
            closed_label = "{} closed".format(total) if total else "no trades yet"
            return (
                "\U0001f4ca <b>Today's Stats</b>\n\n"
                "Results:  \u2705 {} W  |  \u274c {} L  |  \u27a1\ufe0f {} BE  ({})\n"
                "Win rate: {}%\n\n"
                "P&L:     {} {}{}\n"
                "Balance: ${:,.2f}\n"
                "Equity:  ${:,.2f}\n"
                "Open:    {} position(s)"
            ).format(wins, losses, be, closed_label, wr,
                     pnl_e, pnl_s, "{:.2f}".format(total_pnl), balance, equity, open_p)
        except Exception as e:
            return "\u274c Stats error: {}".format(e)

    def _cmd_daily(self):
        try:
            import MetaTrader5 as mt5
            import config
            today    = date.today()
            start_dt = datetime.combine(today, datetime.min.time()).replace(tzinfo=timezone.utc)
            end_dt   = datetime.now(timezone.utc)
            deals    = mt5.history_deals_get(start_dt, end_dt) or []
            wins = losses = be = 0
            total_pnl = 0.0
            lines = []
            for d in deals:
                if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL): continue
                if d.entry != mt5.DEAL_ENTRY_OUT: continue
                if getattr(d, "magic", 0) != config.MAGIC_NUMBER: continue
                pnl = d.profit
                total_pnl += pnl
                icon = "\u2705" if pnl > 0.05 else ("\u274c" if pnl < -0.05 else "\u27a1\ufe0f")
                if pnl > 0.05: wins += 1
                elif pnl < -0.05: losses += 1
                else: be += 1
                t = datetime.fromtimestamp(d.time, tz=timezone.utc).strftime("%H:%M")
                lines.append("{} {} {:+.2f}".format(icon, t, pnl))
            pnl_e = "\U0001f4c8" if total_pnl >= 0 else "\U0001f4c9"
            pnl_s = "+" if total_pnl >= 0 else ""
            header = "\U0001f4c5 <b>Daily — {}</b>\n\n".format(today.isoformat())
            if not lines:
                return header + "No closed trades today."
            return (header + "\n".join(lines) +
                    "\n\n\u2705 {} W  \u274c {} L  \u27a1\ufe0f {} BE\n{} {}{}".format(
                        wins, losses, be, pnl_e, pnl_s, "{:.2f}".format(total_pnl)))
        except Exception as e:
            return "\u274c Daily error: {}".format(e)

    def _cmd_weekly(self):
        try:
            import MetaTrader5 as mt5
            today    = date.today()
            start_dt = datetime.combine(today - timedelta(days=6), datetime.min.time()).replace(tzinfo=timezone.utc)
            wins, losses, be, total_pnl = self._deal_stats(start_dt, datetime.now(timezone.utc))
            total = wins + losses + be
            wr    = round(wins / total * 100) if total > 0 else 0
            acc   = mt5.account_info()
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0
            pnl_e = "\U0001f4c8" if total_pnl >= 0 else "\U0001f4c9"
            pnl_s = "+" if total_pnl >= 0 else ""
            dr = "{} to {}".format((today - timedelta(days=6)).isoformat(), today.isoformat())
            closed_label = "{} closed".format(total) if total else "no trades"
            return (
                "\U0001f4c5 <b>Weekly Summary</b>\n{}\n\n"
                "Results:  \u2705 {} W  |  \u274c {} L  |  \u27a1\ufe0f {} BE  ({})\n"
                "Win rate: {}%\n\n"
                "P&L:     {} {}{}\n"
                "Balance: ${:,.2f}\n"
                "Equity:  ${:,.2f}"
            ).format(dr, wins, losses, be, closed_label, wr,
                     pnl_e, pnl_s, "{:.2f}".format(total_pnl), balance, equity)
        except Exception as e:
            return "\u274c Weekly error: {}".format(e)

    def _cmd_monthly(self):
        try:
            import MetaTrader5 as mt5
            today    = date.today()
            start_dt = datetime(today.year, today.month, 1, tzinfo=timezone.utc)
            wins, losses, be, total_pnl = self._deal_stats(start_dt, datetime.now(timezone.utc))
            total = wins + losses + be
            wr    = round(wins / total * 100) if total > 0 else 0
            acc   = mt5.account_info()
            balance = acc.balance if acc else 0.0
            equity  = acc.equity  if acc else 0.0
            pnl_e   = "\U0001f4c8" if total_pnl >= 0 else "\U0001f4c9"
            pnl_s   = "+" if total_pnl >= 0 else ""
            month_label  = today.strftime("%B %Y")
            closed_label = "{} closed".format(total) if total else "no trades"
            return (
                "\U0001f4c6 <b>Monthly Summary — {}</b>\n\n"
                "Results:  \u2705 {} W  |  \u274c {} L  |  \u27a1\ufe0f {} BE  ({})\n"
                "Win rate: {}%\n\n"
                "P&L:     {} {}{}\n"
                "Balance: ${:,.2f}\n"
                "Equity:  ${:,.2f}"
            ).format(month_label, wins, losses, be, closed_label, wr,
                     pnl_e, pnl_s, "{:.2f}".format(total_pnl), balance, equity)
        except Exception as e:
            return "\u274c Monthly error: {}".format(e)

    # ----------------------------------------------------------
    # Polling loop
    # ----------------------------------------------------------
    def _process_update(self, update):
        msg = (update.get("message") or update.get("edited_message")
               or update.get("channel_post") or update.get("edited_channel_post"))
        if not msg:
            return
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text    = (msg.get("text") or "").strip()

        if chat_id != self._control_id:
            print("[CTRL] Ignored message from unauthorized chat {}".format(chat_id))
            return

        if not text.startswith("/"):
            return

        cmd = text.split()[0].lower().lstrip("/").split("@")[0]
        print("[CTRL] Command: /{}".format(cmd))

        if cmd == "help":
            reply = self._cmd_help()
        elif cmd == "status":
            reply = self._cmd_status()
        elif cmd == "positions":
            reply = self._cmd_positions()
        elif cmd == "stats":
            reply = self._cmd_stats()
        elif cmd == "daily":
            reply = self._cmd_daily()
        elif cmd == "weekly":
            reply = self._cmd_weekly()
        elif cmd == "monthly":
            reply = self._cmd_monthly()
        elif cmd == "pause":
            reply = self._cmd_pause()
        elif cmd == "resume":
            reply = self._cmd_resume()
        else:
            reply = "\u2753 Unknown command. Send /help for the list."

        self._send(chat_id, reply)

    def _poll(self):
        print("[CTRL] Polling started (control_chat={})".format(self._control_id))
        while self._running:
            try:
                resp = self._api("getUpdates", {
                    "offset":          self._offset,
                    "timeout":         20,
                    "allowed_updates": ["message", "channel_post"],
                })
                if resp and resp.get("ok"):
                    for update in resp.get("result", []):
                        self._offset = update["update_id"] + 1
                        self._process_update(update)
            except Exception as e:
                err = str(e).lower()
                if "timed out" in err or "time out" in err:
                    pass
                else:
                    print("[CTRL] Poll error: {}".format(e))
                    time.sleep(5)

    def start(self):
        self._running = True
        t = threading.Thread(target=self._poll, daemon=True)
        t.start()
        return t

    def stop(self):
        self._running = False
