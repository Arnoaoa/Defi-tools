"""Dead-man's switch (watchdog) for the main monitor process.

Designed to run as a SEPARATE process (separate Task Scheduler entry).
A crash of the main monitor does not affect this watchdog.

One check per invocation — Task Scheduler triggers every 15 minutes.
"""
from __future__ import annotations

import time
from typing import TypedDict

from loguru import logger

from src.notifications.telegram import TelegramNotifier
from src.storage.db import Database

# How long to wait before re-sending the same alert type (seconds)
_DEDUP_WINDOW_SECONDS = 3600  # 1 hour


class CheckResult(TypedDict):
    status: str          # 'healthy' | 'silent' | 'no_heartbeat'
    silence_minutes: float
    alerted: bool


class DeadManSwitch:
    """Watchdog: checks the main monitor's heartbeat and alerts if stale.

    Run check() once per invocation. Deduplication is handled via the alerts
    table so that at most one alert is sent per hour per condition type.
    """

    def __init__(
        self,
        db: Database,
        telegram: TelegramNotifier,
        *,
        max_silence_minutes: int = 30,
    ) -> None:
        self._db = db
        self._telegram = telegram
        self._max_silence_seconds = max_silence_minutes * 60

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def check(self) -> CheckResult:
        """Run one watchdog check.

        Returns a dict with keys: status, silence_minutes, alerted.
        """
        now = int(time.time())
        hb = self._db.get_heartbeat()

        if hb is None:
            return await self._handle_no_heartbeat(now)

        silence_seconds = now - hb["last_cycle_ts"]
        silence_minutes = silence_seconds / 60

        if silence_seconds > self._max_silence_seconds:
            return await self._handle_silent(now, hb, silence_minutes)

        logger.info(
            f"Dead-man check: healthy — dernier heartbeat il y a "
            f"{silence_minutes:.1f} min"
        )
        return CheckResult(status="healthy", silence_minutes=silence_minutes, alerted=False)

    # ------------------------------------------------------------------
    # Internal handlers
    # ------------------------------------------------------------------

    async def _should_send_alert(self) -> bool:
        """Return True if no monitor_health alert was sent in the last hour."""
        last = self._db.get_last_alert(strategy_id=None, type_="monitor_health")
        if last is None:
            return True
        elapsed = int(time.time()) - last["snapshot_ts"]
        return elapsed >= _DEDUP_WINDOW_SECONDS

    async def _record_and_send(self, now: int, message: str) -> bool:
        """Insert alert in DB then attempt Telegram delivery. Returns alerted=True."""
        alert_id = self._db.insert_alert(
            snapshot_ts=now,
            strategy_id=None,
            level="critical",
            type_="monitor_health",
            message=message,
            asset=None,
            payload=None,
        )

        sent = await self._telegram.send_message(message)

        if sent:
            self._db.mark_alert_sent(alert_id)
        else:
            self._db.mark_alert_sent(alert_id, error="Telegram delivery failed")

        return True

    async def _handle_no_heartbeat(self, now: int) -> CheckResult:
        logger.warning("Dead-man check: aucun heartbeat en base — monitor jamais demarré ?")

        alerted = False
        if await self._should_send_alert():
            message = (
                "[MONITOR HEALTH] CRITICAL\n"
                "Le monitor n'a jamais démarré — aucun cycle enregistré en base.\n"
                "Vérifiez l'installation et que le Task Scheduler est actif."
            )
            alerted = await self._record_and_send(now, message)
            logger.critical("Alerte envoyée : monitor jamais démarré")
        else:
            logger.info("Dead-man check: alerte no_heartbeat déjà envoyée récemment — skip")

        return CheckResult(status="no_heartbeat", silence_minutes=0.0, alerted=alerted)

    async def _handle_silent(
        self, now: int, hb: dict, silence_minutes: float
    ) -> CheckResult:
        last_cycle_time = time.strftime(
            "%H:%M", time.localtime(hb["last_cycle_ts"])
        )
        logger.warning(
            f"Dead-man check: SILENT — pas de heartbeat depuis "
            f"{silence_minutes:.0f} min (dernier cycle à {last_cycle_time})"
        )

        alerted = False
        if await self._should_send_alert():
            message = (
                f"[MONITOR HEALTH] CRITICAL\n"
                f"Le monitor est silencieux depuis {silence_minutes:.0f} minutes.\n"
                f"Dernier cycle enregistré à {last_cycle_time}.\n"
                f"Vérifiez que le process tourne (Task Scheduler, logs)."
            )
            alerted = await self._record_and_send(now, message)
            logger.critical(
                f"Alerte envoyée : monitor silencieux depuis {silence_minutes:.0f} min"
            )
        else:
            logger.info("Dead-man check: alerte silent déjà envoyée récemment — skip")

        return CheckResult(
            status="silent", silence_minutes=silence_minutes, alerted=alerted
        )
