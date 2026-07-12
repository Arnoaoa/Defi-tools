"""Telegram notification channel — send + queue worker.

Stub-safe: if token or chat_id is empty, logs messages instead of sending.
HTTP via httpx directly (lighter than the full python-telegram-bot lib for
our minimal needs: send_message + Markdown).
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import TYPE_CHECKING, Any

import httpx
from loguru import logger

from src.alerts.models import AlertLevel

if TYPE_CHECKING:
    from src.storage.db import Database


_BASE_URL = "https://api.telegram.org/bot{token}/sendMessage"
_TIMEOUT_SEC = 10.0
_RETRY_BACKOFFS = (1.0, 2.0, 4.0)  # 3 retries with exponential backoff

# Level → emoji prefix (only used in formatted alerts, never in raw send)
_LEVEL_EMOJI = {
    AlertLevel.INFO: "ℹ️",
    AlertLevel.WARNING: "⚠️",
    AlertLevel.URGENT: "🔴",
    AlertLevel.CRITICAL: "🚨",
}

# Telegram legacy Markdown reserved chars that must be escaped when in literal text
_MD_ESCAPE_RE = re.compile(r"([_*\[\]`])")


def _escape_md(text: str) -> str:
    """Escape Telegram legacy Markdown special chars in arbitrary text."""
    return _MD_ESCAPE_RE.sub(r"\\\1", text)


class TelegramNotifier:
    """Send messages to a Telegram chat via Bot API. Stub mode if unconfigured.

    Compatible with two call sites:
      - dead_man.py: simple `await tg.send_message(text)`
      - main.py: `await tg.process_queue(db, max_per_cycle=20)` dequeue+send loop
    """

    def __init__(self, *, token: str = "", chat_id: str = "") -> None:
        self.token = token
        self.chat_id = chat_id
        self._stub = not (token and chat_id)
        if self._stub:
            logger.warning(
                "TelegramNotifier in STUB mode (token or chat_id empty). "
                "Alerts will be marked sent without delivery."
            )

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    @property
    def is_enabled(self) -> bool:
        """True if both token + chat_id are configured."""
        return not self._stub

    @property
    def is_stub(self) -> bool:
        """Legacy alias for is_enabled inverse — kept for dead_man.py compat."""
        return self._stub

    # ------------------------------------------------------------------
    # Low-level send
    # ------------------------------------------------------------------

    async def send_message(self, text: str, *, parse_mode: str = "Markdown") -> bool:
        """Send one message. Returns True on success (or stub), False on definitive failure."""
        if self._stub:
            logger.info(f"[Telegram stub] Would send: {text!r}")
            return True

        url = _BASE_URL.format(token=self.token)
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True,
        }

        last_error: str | None = None
        for attempt, backoff in enumerate(_RETRY_BACKOFFS):
            try:
                async with httpx.AsyncClient(timeout=_TIMEOUT_SEC) as client:
                    resp = await client.post(url, json=payload)
                    if resp.status_code == 200:
                        logger.debug(f"Telegram sent ({len(text)} chars)")
                        return True

                    # 4xx errors are not worth retrying (auth, bad chat, bad markdown)
                    if 400 <= resp.status_code < 500:
                        logger.error(
                            f"Telegram HTTP {resp.status_code}: {resp.text[:200]} "
                            f"— giving up (no retry)"
                        )
                        return False

                    last_error = f"HTTP {resp.status_code}: {resp.text[:100]}"
            except httpx.TimeoutException as e:
                last_error = f"timeout: {e}"
            except httpx.RequestError as e:
                last_error = f"network: {e}"

            if attempt < len(_RETRY_BACKOFFS) - 1:
                logger.warning(
                    f"Telegram send failed ({last_error}) — retry in {backoff}s"
                )
                await asyncio.sleep(backoff)

        logger.error(f"Telegram send definitively failed: {last_error}")
        return False

    # ------------------------------------------------------------------
    # Queue worker
    # ------------------------------------------------------------------

    async def process_queue(
        self, db: Database, *, max_per_cycle: int = 20
    ) -> dict[str, int]:
        """Dequeue unsent alerts from DB and send them.

        INFO-level alerts are marked sent without Telegram delivery (log-only).
        Returns stats dict.
        """
        unsent = db.get_unsent_alerts(limit=max_per_cycle)
        stats = {"sent": 0, "failed": 0, "skipped_info": 0, "would_send": 0}

        if not unsent:
            return stats

        for row in unsent:
            alert_id: int = row["id"]
            level_str: str = row.get("level", "")

            # INFO alerts: never sent to Telegram (log-only), but mark as sent
            if level_str == AlertLevel.INFO.value:
                db.mark_alert_sent(alert_id)
                stats["skipped_info"] += 1
                continue

            text = self.format_alert(row)

            if self._stub:
                logger.info(f"[Telegram stub] {text}")
                db.mark_alert_sent(alert_id)
                stats["would_send"] += 1
                continue

            ok = await self.send_message(text)
            if ok:
                db.mark_alert_sent(alert_id)
                stats["sent"] += 1
            else:
                db.mark_alert_sent(alert_id, error="telegram_send_failed")
                stats["failed"] += 1

        logger.info(
            f"Telegram queue: sent={stats['sent']} failed={stats['failed']} "
            f"skipped_info={stats['skipped_info']} would_send={stats['would_send']}"
        )
        return stats

    # ------------------------------------------------------------------
    # Formatting
    # ------------------------------------------------------------------

    @staticmethod
    def format_alert(alert_row: dict[str, Any]) -> str:
        """Format a DB alert row into a Telegram Markdown message."""
        level_str = alert_row.get("level", "info")
        try:
            level = AlertLevel(level_str)
        except ValueError:
            level = AlertLevel.INFO
        emoji = _LEVEL_EMOJI.get(level, "")

        strategy_id = alert_row.get("strategy_id") or "monitor"
        message = alert_row.get("message", "")
        snapshot_ts = alert_row.get("snapshot_ts")

        # Escape user-provided text to avoid breaking Markdown parsing
        safe_strategy = _escape_md(str(strategy_id))
        safe_message = _escape_md(message)

        ts_line = ""
        if snapshot_ts:
            ts_str = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(snapshot_ts))
            ts_line = f"\n\n_{ts_str}_"

        return (
            f"{emoji} *{level.value.upper()} — {safe_strategy}*\n"
            f"{safe_message}{ts_line}"
        )
