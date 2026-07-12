"""Position detail endpoints — enriched snapshot + funding history."""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from loguru import logger

from src.adapters.hyperliquid import HyperliquidAdapter
from src.config import load_env
from src.storage import Database

router = APIRouter(prefix="/positions")


def _open_db() -> Database:
    env = load_env()
    return Database(env.monitor_db_path)


def _liq_distance_pct(
    mark: str | None,
    liq: str | None,
    side: str,
) -> str | None:
    if mark is None or liq is None:
        return None
    try:
        m, l = Decimal(mark), Decimal(liq)
        if m == 0:
            return None
        if side == "long":
            return str((m - l) / m * 100)
        if side == "short":
            return str((l - m) / m * 100)
    except Exception:
        return None
    return None


def _hf_distance_pct(hf: str | None) -> str | None:
    if hf is None:
        return None
    try:
        return str((Decimal(hf) - 1) * 100)
    except Exception:
        return None


def _enrich(row: dict[str, Any]) -> dict[str, Any]:
    side = row.get("side", "")
    liq_dist = _liq_distance_pct(row.get("mark_price"), row.get("liquidation_price"), side)
    hf_dist = _hf_distance_pct(row.get("health_factor"))

    return {
        **row,
        "distance_to_liq_pct": liq_dist if liq_dist is not None else hf_dist,
    }


@router.get("/{position_id}")
def get_position(position_id: int) -> dict[str, Any]:
    db = _open_db()
    row = db.get_position_by_id(position_id)
    db.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"position {position_id} not found")
    return _enrich(row)


@router.get("/{position_id}/funding_history")
async def get_funding_history(
    position_id: int,
    hours: int = Query(168, ge=1, le=720),
) -> list[dict[str, Any]]:
    db = _open_db()
    row = db.get_position_by_id(position_id)
    db.close()

    if row is None:
        raise HTTPException(status_code=404, detail=f"position {position_id} not found")

    if row.get("protocol") != "hyperliquid":
        raise HTTPException(
            status_code=422,
            detail="funding_history is only available for Hyperliquid positions",
        )

    coin = row.get("market_id") or row.get("asset")
    if not coin:
        raise HTTPException(status_code=422, detail="position has no market_id")

    adapter = HyperliquidAdapter()
    try:
        history = await adapter.fetch_funding_history(coin=coin, hours_back=hours)
    except Exception as exc:
        logger.error(f"funding_history fetch failed for {coin}: {exc}")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        await adapter.aclose()

    return [{"ts": ts_ms // 1000, "rate": str(rate)} for ts_ms, rate in history]
