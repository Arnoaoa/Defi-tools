"""Alert deduplication — prevents spam for repeated alerts within a time window."""
from __future__ import annotations

import time

from loguru import logger

from src.alerts.models import Alert, AlertLevel
from src.storage.db import Database

LEVEL_ORDER: dict[AlertLevel, int] = {
    AlertLevel.INFO: 0,
    AlertLevel.WARNING: 1,
    AlertLevel.URGENT: 2,
    AlertLevel.CRITICAL: 3,
}


def _is_upgrade(new_level: AlertLevel, last_level_str: str) -> bool:
    """Return True if new_level is strictly higher than the previously stored level."""
    try:
        last_level = AlertLevel(last_level_str)
    except ValueError:
        return True  # unknown stored level → let it through
    return LEVEL_ORDER[new_level] > LEVEL_ORDER[last_level]


class AlertDeduper:
    """Avoid spam: same (strategy_id, type) within window minutes = skip.

    Exception: if level UPGRADES (warning → urgent or urgent → critical),
    let it through regardless of the window.
    """

    def __init__(self, db: Database, *, window_minutes: int = 30) -> None:
        self._db = db
        self._window_sec = window_minutes * 60

    def filter(self, alerts: list[Alert]) -> list[Alert]:
        """Return only alerts that should actually be delivered."""
        now = int(time.time())
        result: list[Alert] = []

        for alert in alerts:
            last = self._db.get_last_alert(
                strategy_id=alert.strategy_id,
                type_=alert.type.value,
            )

            if last is None:
                # Never fired before → always deliver
                result.append(alert)
                continue

            last_sent_at: int | None = last.get("sent_at")
            last_level: str = last.get("level", "")

            # Level upgrade → always deliver, regardless of window
            if _is_upgrade(alert.level, last_level):
                logger.info(
                    f"[dedup] Upgrade de niveau ({last_level} → {alert.level.value}) "
                    f"pour {alert.type.value} / strategy={alert.strategy_id} — transmis"
                )
                result.append(alert)
                continue

            # Never sent (only inserted, not delivered)
            if last_sent_at is None:
                # Already pending in DB — skip to avoid duplicate sends
                logger.debug(
                    f"[dedup] Alerte {alert.type.value} déjà en attente "
                    f"(strategy={alert.strategy_id}) — ignorée"
                )
                continue

            # Within cooldown window → skip
            if now - last_sent_at < self._window_sec:
                age_min = (now - last_sent_at) // 60
                logger.debug(
                    f"[dedup] Alerte {alert.type.value} supprimée "
                    f"(strategy={alert.strategy_id}, dernière envoyée il y a {age_min} min)"
                )
                continue

            # Window expired → deliver
            result.append(alert)

        return result
