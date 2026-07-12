"""Read-only HTTP routes exposed to the dashboard.

Design choices:
  - All Decimals serialized as strings (avoid JSON float precision loss).
  - Strategy config (id, name, type) merged with latest snapshot for the
    overview cards.
  - History endpoint exposes raw snapshots — frontend renders the chart.
"""
from __future__ import annotations

import time
from typing import Any

import re

from fastapi import APIRouter, HTTPException, Query
from loguru import logger
from pydantic import BaseModel, Field, field_validator

from src.config import load_all
from src.storage import Database

router = APIRouter()


# ---------------------------------------------------------------------------
# Lazy singletons (rebuilt on each request — DB is cheap, ensures fresh state)
# ---------------------------------------------------------------------------


def _open_db() -> Database:
    _, strategies = load_all()
    del strategies  # only used for config in other handlers
    from src.config import load_env

    env = load_env()
    return Database(env.monitor_db_path)


def _strategy_lookup() -> dict[str, dict[str, Any]]:
    _, strategies = load_all()
    return {
        s.id: {
            "id": s.id,
            "name": s.name,
            "type": s.type,
            "delta_target_pct": str(s.delta_target_pct),
            "legs": [
                {
                    "protocol": leg.protocol,
                    "role": leg.role,
                    "asset": leg.asset,
                    "chain": leg.chain,
                    "symbol": leg.symbol,
                }
                for leg in s.legs
            ],
        }
        for s in strategies.strategies
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/health")
def health() -> dict[str, Any]:
    """Monitor self-health: uptime, last cycle, errors."""
    db = _open_db()
    hb = db.get_heartbeat()
    db.close()

    if hb is None:
        return {
            "status": "no_heartbeat",
            "last_cycle_ts": None,
            "silence_seconds": None,
            "cycle_duration_ms": None,
            "cycle_errors": None,
        }

    now = int(time.time())
    silence = now - hb["last_cycle_ts"]
    status = "healthy" if silence < 30 * 60 else "silent"

    return {
        "status": status,
        "last_cycle_ts": hb["last_cycle_ts"],
        "silence_seconds": silence,
        "cycle_duration_ms": hb["cycle_duration_ms"],
        "cycle_errors": hb["cycle_errors"],
        "last_cycle_log": hb.get("last_cycle_log"),
    }


@router.get("/strategies")
def list_strategies() -> list[dict[str, Any]]:
    """All strategies declared in YAML + their latest snapshot summary."""
    db = _open_db()
    config = _strategy_lookup()

    out: list[dict[str, Any]] = []
    for sid, meta in config.items():
        snap = db.get_latest_strategy_snapshot(sid)
        out.append({**meta, "latest_snapshot": snap})

    db.close()
    return out


@router.get("/strategies/{strategy_id}")
def get_strategy(strategy_id: str) -> dict[str, Any]:
    """Full strategy detail: config + latest snapshot + current positions."""
    db = _open_db()
    config = _strategy_lookup()

    if strategy_id not in config:
        db.close()
        raise HTTPException(status_code=404, detail=f"strategy '{strategy_id}' unknown")

    snap = db.get_latest_strategy_snapshot(strategy_id)
    if snap is None:
        positions: list[dict[str, Any]] = []
    else:
        snap_ts = snap["snapshot_ts"]
        cur = db._conn.execute(  # noqa: SLF001 — internal use, fine here
            """
            SELECT * FROM positions
            WHERE strategy_id = ? AND snapshot_ts = ?
            ORDER BY protocol, asset
            """,
            (strategy_id, snap_ts),
        )
        positions = [dict(row) for row in cur.fetchall()]

    db.close()
    return {
        **config[strategy_id],
        "latest_snapshot": snap,
        "positions": positions,
    }


@router.get("/strategies/{strategy_id}/history")
def get_strategy_history(
    strategy_id: str, days: int = Query(7, ge=1, le=90)
) -> list[dict[str, Any]]:
    """Snapshots for the last N days (used by the trend chart)."""
    db = _open_db()
    config = _strategy_lookup()

    if strategy_id not in config:
        db.close()
        raise HTTPException(status_code=404, detail=f"strategy '{strategy_id}' unknown")

    since_ts = int(time.time()) - days * 86400
    snapshots = db.get_recent_strategy_snapshots(strategy_id, since_ts=since_ts)
    db.close()
    return snapshots


@router.get("/alerts")
def list_alerts(
    limit: int = Query(100, ge=1, le=500),
    level: str | None = Query(None, description="info | warning | urgent | critical"),
    strategy_id: str | None = None,
    only_unsent: bool = False,
) -> list[dict[str, Any]]:
    """Alert log, optionally filtered by level / strategy / unsent state."""
    db = _open_db()

    sql = "SELECT * FROM alerts WHERE 1=1"
    params: list[Any] = []
    if level:
        sql += " AND level = ?"
        params.append(level)
    if strategy_id:
        sql += " AND strategy_id = ?"
        params.append(strategy_id)
    if only_unsent:
        sql += " AND sent_at IS NULL"
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    cur = db._conn.execute(sql, params)  # noqa: SLF001
    rows = [dict(row) for row in cur.fetchall()]
    db.close()
    return rows


class WalletCreatePayload(BaseModel):
    id: str = Field(..., min_length=2, max_length=64)
    label: str = Field(..., min_length=1, max_length=64)
    address: str = Field(..., min_length=1, max_length=128)
    chain: str = Field(default="ethereum", min_length=1, max_length=32)
    group: str = Field(default="self", pattern="^(self|watch)$")
    notes: str | None = Field(default=None, max_length=512)
    auto_discover: bool = True

    @field_validator("id")
    @classmethod
    def _slug(cls, v: str) -> str:
        if not re.match(r"^[a-z0-9_-]+$", v):
            raise ValueError("id must be lowercase letters, digits, _ or -")
        return v

    @field_validator("address")
    @classmethod
    def _addr(cls, v: str) -> str:
        return v.strip()


class WalletPatchPayload(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=64)
    chain: str | None = Field(default=None, min_length=1, max_length=32)
    group: str | None = Field(default=None, pattern="^(self|watch)$")
    notes: str | None = Field(default=None, max_length=512)
    auto_discover: bool | None = None


def _serialize_wallet(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "label": r["label"],
        "address": r["address"],
        "chain": r["chain"],
        "group": r["grp"],
        "notes": r.get("notes"),
        "auto_discover": bool(r.get("auto_discover", 1)),
        "created_at": r.get("created_at"),
    }


@router.get("/wallets")
def list_wallets(group: str | None = Query(None, description="self | watch")) -> list[dict[str, Any]]:
    """Declared wallets — merges DB registry with strategies.yaml entries.

    The DB is now the source of truth for wallets added at runtime via the UI.
    YAML-declared wallets are upserted into the DB at each monitor cycle.
    """
    db = _open_db()
    rows = db.list_wallets(grp=group)
    db.close()
    return [_serialize_wallet(r) for r in rows]


@router.post("/wallets", status_code=201)
def create_wallet(payload: WalletCreatePayload) -> dict[str, Any]:
    """Create or upsert a wallet by id."""
    db = _open_db()

    # Reject duplicate address on same chain (different id)
    existing = db.list_wallets()
    for w in existing:
        if (
            w["address"].lower() == payload.address.lower()
            and w["chain"] == payload.chain
            and w["id"] != payload.id
        ):
            db.close()
            raise HTTPException(
                status_code=409,
                detail=f"Address already registered as wallet '{w['id']}' on {payload.chain}",
            )

    db.upsert_wallet(
        id=payload.id,
        label=payload.label,
        address=payload.address,
        chain=payload.chain,
        grp=payload.group,
        notes=payload.notes,
        auto_discover=payload.auto_discover,
    )
    row = db.get_wallet(payload.id)
    db.close()
    logger.info(f"Wallet upserted: {payload.id} ({payload.address[:10]}…)")
    if row is None:
        raise HTTPException(status_code=500, detail="upsert failed silently")
    return _serialize_wallet(row)


@router.patch("/wallets/{wallet_id}")
def patch_wallet(wallet_id: str, payload: WalletPatchPayload) -> dict[str, Any]:
    db = _open_db()
    existing = db.get_wallet(wallet_id)
    if existing is None:
        db.close()
        raise HTTPException(status_code=404, detail=f"wallet '{wallet_id}' not found")

    db.upsert_wallet(
        id=wallet_id,
        label=payload.label or existing["label"],
        address=existing["address"],  # address is immutable via PATCH
        chain=payload.chain or existing["chain"],
        grp=payload.group or existing["grp"],
        notes=payload.notes if payload.notes is not None else existing.get("notes"),
        auto_discover=(
            payload.auto_discover
            if payload.auto_discover is not None
            else bool(existing.get("auto_discover", 1))
        ),
    )
    row = db.get_wallet(wallet_id)
    db.close()
    if row is None:
        raise HTTPException(status_code=500, detail="patch failed silently")
    return _serialize_wallet(row)


@router.delete("/wallets/{wallet_id}", status_code=204)
def delete_wallet(wallet_id: str) -> None:
    db = _open_db()
    existing = db.get_wallet(wallet_id)
    if existing is None:
        db.close()
        raise HTTPException(status_code=404, detail=f"wallet '{wallet_id}' not found")
    db.delete_wallet(wallet_id)
    db.close()
    logger.info(f"Wallet deleted: {wallet_id}")


@router.get("/portfolio")
def get_portfolio(
    group: str = Query("self", description="self | watch"),
) -> dict[str, Any]:
    """Latest portfolio breakdown for the given group.

    Returns the breakdown rows + the total value + per-chain aggregation.
    """
    db = _open_db()
    rows = db.latest_portfolio_breakdown(grp=group)
    db.close()

    # Aggregate totals
    total_assets_usd = 0.0
    total_debt_usd = 0.0
    per_chain: dict[str, float] = {}
    per_category: dict[str, float] = {}

    for r in rows:
        value = float(r["value_usd"])
        cat = r["category"]
        chain = r["chain"]

        if cat == "lending_debt":
            total_debt_usd += value
        else:
            total_assets_usd += value

        per_chain[chain] = per_chain.get(chain, 0.0) + (
            -value if cat == "lending_debt" else value
        )
        per_category[cat] = per_category.get(cat, 0.0) + value

    return {
        "group": group,
        "snapshot_ts": rows[0]["snapshot_ts"] if rows else None,
        "totals": {
            "assets_usd": str(total_assets_usd),
            "debt_usd": str(total_debt_usd),
            "net_usd": str(total_assets_usd - total_debt_usd),
        },
        "per_chain": {k: str(v) for k, v in per_chain.items()},
        "per_category": {k: str(v) for k, v in per_category.items()},
        "rows": rows,
    }


@router.get("/portfolio/history")
def get_portfolio_history(
    group: str = Query("self"),
    days: int = Query(30, ge=1, le=365),
) -> list[dict[str, Any]]:
    """Total portfolio value over time (one point per cycle, summed across categories)."""
    db = _open_db()
    since = int(time.time()) - days * 86400
    history = db.portfolio_total_history(grp=group, since_ts=since)
    db.close()
    return history


@router.get("/transactions")
def list_transactions(
    wallet_id: str | None = Query(None),
    classification: str | None = Query(None),
    since_ts: int | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> list[dict[str, Any]]:
    """On-chain transaction history, optionally filtered."""
    db = _open_db()
    rows = db.list_wallet_transactions(
        wallet_id=wallet_id,
        classification=classification,
        since_ts=since_ts,
        limit=limit,
    )
    db.close()
    return rows


@router.get("/transactions/stats")
def transactions_stats() -> dict[str, Any]:
    """Aggregate transaction counts by classification and chain."""
    db = _open_db()
    cur = db._conn.execute(  # noqa: SLF001
        "SELECT classification, COUNT(*) FROM wallet_transactions GROUP BY classification"
    )
    by_classification = {row[0]: row[1] for row in cur.fetchall()}

    cur = db._conn.execute(  # noqa: SLF001
        "SELECT chain, COUNT(*) FROM wallet_transactions GROUP BY chain"
    )
    by_chain = {row[0]: row[1] for row in cur.fetchall()}

    total = db.count_wallet_transactions()
    db.close()
    return {"total": total, "by_classification": by_classification, "by_chain": by_chain}


@router.get("/stats")
def stats() -> dict[str, Any]:
    """Aggregate stats for the overview header (total alerts, by level, ...)."""
    db = _open_db()

    cur = db._conn.execute(  # noqa: SLF001
        """
        SELECT level, COUNT(*) as count
        FROM alerts
        WHERE snapshot_ts > ?
        GROUP BY level
        """,
        (int(time.time()) - 24 * 3600,),
    )
    alerts_24h_by_level = {row[0]: row[1] for row in cur.fetchall()}

    cur = db._conn.execute(  # noqa: SLF001
        "SELECT COUNT(DISTINCT strategy_id) FROM strategy_snapshots"
    )
    strategies_count = cur.fetchone()[0]

    cur = db._conn.execute(  # noqa: SLF001
        "SELECT COUNT(*) FROM alerts WHERE sent_at IS NULL"
    )
    queued = cur.fetchone()[0]

    db.close()
    return {
        "strategies": strategies_count,
        "queued_alerts": queued,
        "alerts_24h": alerts_24h_by_level,
    }
