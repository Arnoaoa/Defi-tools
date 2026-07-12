"""Alert domain models."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class AlertLevel(str, Enum):
    INFO = "info"
    WARNING = "warning"
    URGENT = "urgent"
    CRITICAL = "critical"


class AlertType(str, Enum):
    HF_WARNING = "hf_warning"
    HF_URGENT = "hf_urgent"
    HF_CRITICAL = "hf_critical"
    FUNDING_FLIP_SOFT = "funding_flip_soft"          # 1 print défavorable, log only
    FUNDING_FLIP_CONFIRMED = "funding_flip_confirmed"  # N prints consécutifs, warning
    FUNDING_FLIP_MATERIAL = "funding_flip_material"   # N+1 prints + coût élevé, urgent
    DEPEG_WATCH = "depeg_watch"
    DEPEG_CONFIRMED = "depeg_confirmed"
    PENDLE_EXPIRY_T30 = "pendle_expiry_t30"
    PENDLE_EXPIRY_T7 = "pendle_expiry_t7"
    PENDLE_EXPIRY_T1 = "pendle_expiry_t1"
    DRAWDOWN_24H = "drawdown_24h"
    DELTA_DEVIATION = "delta_deviation"
    FETCH_FAILED = "fetch_failed"
    DEGRADED_MODE = "degraded_mode"
    MONITOR_HEALTH = "monitor_health"  # dead-man switch


@dataclass(frozen=True, slots=True)
class Alert:
    strategy_id: str | None
    level: AlertLevel
    type: AlertType
    asset: str | None
    message: str
    payload: dict
    snapshot_ts: int
