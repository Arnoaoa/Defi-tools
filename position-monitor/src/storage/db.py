"""SQLite storage layer.

Sync API on purpose — sqlite3 is fast enough locally and avoids the complexity
of aiosqlite for a single-process app. The main loop awaits adapter calls,
then runs DB writes synchronously between cycles.

All amounts are stored as TEXT (Decimal.__str__) to preserve precision.
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from loguru import logger

from src.models import MarketState, Position, StrategySnapshot

CURRENT_SCHEMA_VERSION = 6
SCHEMA_FILE = Path(__file__).parent / "schema.sql"

# In-Python migrations keyed by target version. Each migration runs in a single
# transaction. We don't use a migration framework — the project's surface is
# small and the user is solo.
def _migration_v2(conn: sqlite3.Connection) -> None:
    """Add wallet_id column to positions table (multi-wallet support)."""
    cur = conn.execute("PRAGMA table_info(positions)")
    cols = {row[1] for row in cur.fetchall()}
    if "wallet_id" not in cols:
        conn.execute("ALTER TABLE positions ADD COLUMN wallet_id TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_positions_wallet_ts "
            "ON positions(wallet_id, snapshot_ts DESC)"
        )


def _migration_v3(conn: sqlite3.Connection) -> None:
    """Add auto_discover flag to wallets — when 1, fetch positions across all
    configured adapters every cycle (not just strategy-referenced ones)."""
    cur = conn.execute("PRAGMA table_info(wallets)")
    cols = {row[1] for row in cur.fetchall()}
    if "auto_discover" not in cols:
        conn.execute(
            "ALTER TABLE wallets ADD COLUMN auto_discover INTEGER NOT NULL DEFAULT 1"
        )


def _migration_v4(conn: sqlite3.Connection) -> None:
    """Add wallet_transactions and etherscan_sync_state tables for on-chain tx history."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wallet_transactions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id       TEXT NOT NULL,
            chain           TEXT NOT NULL,
            source          TEXT NOT NULL,
            tx_hash         TEXT NOT NULL,
            block_number    INTEGER NOT NULL,
            timestamp       INTEGER NOT NULL,
            from_addr       TEXT NOT NULL,
            to_addr         TEXT,
            value_native    TEXT,
            asset_symbol    TEXT,
            asset_address   TEXT,
            asset_decimals  INTEGER,
            classification  TEXT NOT NULL,
            gas_used        TEXT,
            gas_price       TEXT,
            is_error        INTEGER NOT NULL DEFAULT 0,
            method_id       TEXT,
            raw_json        TEXT NOT NULL,
            UNIQUE(wallet_id, chain, source, tx_hash, from_addr, to_addr, asset_address)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_wtx_wallet_ts "
        "ON wallet_transactions(wallet_id, timestamp DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_wtx_classification "
        "ON wallet_transactions(classification, timestamp DESC)"
    )
    conn.execute("""
        CREATE TABLE IF NOT EXISTS etherscan_sync_state (
            wallet_id        TEXT NOT NULL,
            chain            TEXT NOT NULL,
            source           TEXT NOT NULL,
            last_block       INTEGER NOT NULL DEFAULT 0,
            last_sync_ts     INTEGER NOT NULL,
            PRIMARY KEY (wallet_id, chain, source)
        )
    """)


def _migration_v5(conn: sqlite3.Connection) -> None:
    """Add manual_positions table for user-entered positions (Apex Omni, OTC, etc.)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS manual_positions (
            id            TEXT PRIMARY KEY,
            wallet_id     TEXT,
            chain         TEXT NOT NULL,
            protocol      TEXT NOT NULL,
            asset         TEXT NOT NULL,
            side          TEXT NOT NULL,
            size_native   TEXT NOT NULL,
            entry_price   TEXT,
            entry_ts      INTEGER,
            notes         TEXT,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_manual_pos_wallet ON manual_positions(wallet_id)"
    )


def _migration_v6(conn: sqlite3.Connection) -> None:
    """Add db_strategies and db_strategy_legs tables for UI-built strategies."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_strategies (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            type              TEXT NOT NULL,
            delta_target_pct  TEXT NOT NULL DEFAULT '0',
            notes             TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS db_strategy_legs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id   TEXT NOT NULL,
            leg_index     INTEGER NOT NULL,
            protocol      TEXT NOT NULL,
            role          TEXT NOT NULL,
            asset         TEXT,
            chain         TEXT,
            symbol        TEXT,
            wallet_id     TEXT,
            FOREIGN KEY (strategy_id) REFERENCES db_strategies(id) ON DELETE CASCADE,
            UNIQUE(strategy_id, leg_index)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_strategy_legs ON db_strategy_legs(strategy_id)"
    )


_MIGRATIONS = {
    2: _migration_v2,
    3: _migration_v3,
    4: _migration_v4,
    5: _migration_v5,
    6: _migration_v6,
}


def _d_str(value: Decimal | None) -> str | None:
    """Decimal → string for storage. Preserves precision."""
    return str(value) if value is not None else None


def _str_d(value: str | None) -> Decimal | None:
    """String → Decimal for retrieval."""
    return Decimal(value) if value is not None else None


def _to_json(value: Any) -> str:
    """JSON serialize with Decimal support."""

    def default(o: Any) -> Any:
        if isinstance(o, Decimal):
            return str(o)
        if hasattr(o, "value"):  # Enum
            return o.value
        raise TypeError(f"Unserializable: {type(o)}")

    return json.dumps(value, default=default, separators=(",", ":"))


class Database:
    """SQLite wrapper. One instance per process. Thread-unsafe by design."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self.path),
            isolation_level=None,  # autocommit off via explicit BEGIN/COMMIT
            check_same_thread=True,
        )
        self._conn.row_factory = sqlite3.Row
        self._apply_schema()

    def _apply_schema(self) -> None:
        sql = SCHEMA_FILE.read_text(encoding="utf-8")
        self._conn.executescript(sql)
        # Determine current applied version
        cur = self._conn.execute(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
        )
        row = cur.fetchone()
        current = row[0] if row else 0

        # Apply pending migrations one by one
        for v in sorted(_MIGRATIONS):
            if v > current:
                logger.info(f"Applying schema migration v{v}")
                _MIGRATIONS[v](self._conn)
                self._conn.execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                    (v, int(time.time())),
                )
                current = v

        if current == 0:
            # Fresh DB, record initial version
            self._conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (CURRENT_SCHEMA_VERSION, int(time.time())),
            )
        logger.debug(f"Database ready at {self.path} (schema v{CURRENT_SCHEMA_VERSION})")

    # --------------------------------------------------------------
    # Inserts
    # --------------------------------------------------------------

    def insert_positions(
        self,
        strategy_id: str,
        positions: Iterable[Position],
        *,
        wallet_id_resolver: callable | None = None,
    ) -> int:
        """Insert a batch of positions.

        wallet_id_resolver: optional callable (Position → wallet_id) used to
        populate the new wallet_id column. If None, wallet_id is left NULL.
        """
        rows = []
        for p in positions:
            wid = wallet_id_resolver(p) if wallet_id_resolver else None
            rows.append((
                p.snapshot_ts,
                strategy_id,
                p.protocol,
                p.chain,
                p.asset,
                p.side.value,
                _d_str(p.size_native),
                _d_str(p.size_usd),
                _d_str(p.entry_price),
                _d_str(p.mark_price),
                _d_str(p.oracle_price),
                _d_str(p.health_factor),
                _d_str(p.liquidation_threshold),
                p.market_id,
                _d_str(p.funding_rate),
                p.funding_period_hours,
                _d_str(p.unrealized_pnl_usd),
                _d_str(p.liquidation_price),
                p.pt_expiry_ts,
                _d_str(p.market_liquidity_usd),
                _d_str(p.implied_apy),
                p.wallet,
                _to_json(p.raw),
                wid,
            ))
        if not rows:
            return 0
        with self._conn:
            self._conn.executemany(
                """
                INSERT INTO positions (
                    snapshot_ts, strategy_id, protocol, chain, asset, side,
                    size_native, size_usd, entry_price, mark_price, oracle_price,
                    health_factor, liquidation_threshold, market_id,
                    funding_rate, funding_period_hours, unrealized_pnl_usd,
                    liquidation_price, pt_expiry_ts, market_liquidity_usd,
                    implied_apy, wallet, raw_json, wallet_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        return len(rows)

    # --------------------------------------------------------------
    # Wallets registry
    # --------------------------------------------------------------

    def upsert_wallet(
        self,
        *,
        id: str,
        label: str,
        address: str,
        chain: str = "ethereum",
        grp: str = "self",
        notes: str | None = None,
        auto_discover: bool = True,
    ) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO wallets (id, label, address, chain, grp, notes, created_at, auto_discover)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    label = excluded.label,
                    address = excluded.address,
                    chain = excluded.chain,
                    grp = excluded.grp,
                    notes = excluded.notes,
                    auto_discover = excluded.auto_discover
                """,
                (
                    id, label, address.lower(), chain, grp, notes,
                    int(time.time()), 1 if auto_discover else 0,
                ),
            )

    def list_wallets(self, *, grp: str | None = None) -> list[dict[str, Any]]:
        if grp:
            cur = self._conn.execute(
                "SELECT * FROM wallets WHERE grp = ? ORDER BY label",
                (grp,),
            )
        else:
            cur = self._conn.execute("SELECT * FROM wallets ORDER BY grp, label")
        return [dict(row) for row in cur.fetchall()]

    def get_wallet(self, wallet_id: str) -> dict[str, Any] | None:
        cur = self._conn.execute("SELECT * FROM wallets WHERE id = ?", (wallet_id,))
        row = cur.fetchone()
        return dict(row) if row else None

    def delete_wallet(self, wallet_id: str) -> None:
        with self._conn:
            self._conn.execute("DELETE FROM wallets WHERE id = ?", (wallet_id,))

    # --------------------------------------------------------------
    # Portfolio snapshots
    # --------------------------------------------------------------

    def insert_portfolio_snapshots(
        self, rows: Iterable[dict[str, Any]]
    ) -> int:
        batch = [
            (
                r["snapshot_ts"],
                r["grp"],
                r["chain"],
                r["category"],
                _d_str(r["value_usd"]),
                r["position_count"],
                _to_json(r.get("metrics", {})),
            )
            for r in rows
        ]
        if not batch:
            return 0
        with self._conn:
            self._conn.executemany(
                """
                INSERT INTO portfolio_snapshots
                  (snapshot_ts, grp, chain, category, value_usd, position_count, metrics_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                batch,
            )
        return len(batch)

    def latest_portfolio_breakdown(self, grp: str = "self") -> list[dict[str, Any]]:
        """Return the most recent breakdown rows for the given group."""
        cur = self._conn.execute(
            """
            SELECT ps.* FROM portfolio_snapshots ps
            INNER JOIN (
                SELECT MAX(snapshot_ts) AS max_ts FROM portfolio_snapshots
                WHERE grp = ?
            ) latest ON ps.snapshot_ts = latest.max_ts
            WHERE ps.grp = ?
            ORDER BY ps.chain, ps.category
            """,
            (grp, grp),
        )
        return [dict(row) for row in cur.fetchall()]

    def portfolio_total_history(
        self, *, grp: str = "self", since_ts: int | None = None
    ) -> list[dict[str, Any]]:
        """Total portfolio value over time (summed across categories)."""
        params: list[Any] = [grp]
        sql = """
            SELECT snapshot_ts, SUM(CAST(value_usd AS REAL)) AS total_usd
            FROM portfolio_snapshots
            WHERE grp = ?
        """
        if since_ts is not None:
            sql += " AND snapshot_ts >= ?"
            params.append(since_ts)
        sql += " GROUP BY snapshot_ts ORDER BY snapshot_ts ASC"
        cur = self._conn.execute(sql, params)
        return [{"snapshot_ts": r[0], "total_usd": str(r[1])} for r in cur.fetchall()]

    def insert_market_state(self, state: MarketState) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO market_states (
                    snapshot_ts, protocol, market_id, mark_price, oracle_price,
                    funding_rate, open_interest_usd, liquidity_usd, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    state.snapshot_ts,
                    state.protocol,
                    state.market_id,
                    _d_str(state.mark_price),
                    _d_str(state.oracle_price),
                    _d_str(state.funding_rate),
                    _d_str(state.open_interest_usd),
                    _d_str(state.liquidity_usd),
                    _to_json(state.raw),
                ),
            )

    def insert_strategy_snapshot(self, snap: StrategySnapshot) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO strategy_snapshots (
                    snapshot_ts, strategy_id,
                    net_delta_usd, delta_target_pct, delta_deviation_pct,
                    composite_hf, pnl_unrealized_usd, pnl_funding_24h_usd,
                    has_lending_leg, has_perp_leg, has_pt_leg,
                    days_to_pendle_expiry, metrics_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snap.snapshot_ts,
                    snap.strategy_id,
                    _d_str(snap.net_delta_usd),
                    _d_str(snap.delta_target_pct),
                    _d_str(snap.delta_deviation_pct),
                    _d_str(snap.composite_hf),
                    _d_str(snap.pnl_unrealized_usd),
                    _d_str(snap.pnl_funding_24h_usd),
                    snap.has_lending_leg,
                    snap.has_perp_leg,
                    snap.has_pt_leg,
                    snap.days_to_pendle_expiry,
                    _to_json({"leg_count": len(snap.leg_positions)}),
                ),
            )

    def insert_alert(
        self,
        *,
        snapshot_ts: int,
        strategy_id: str | None,
        level: str,
        type_: str,
        message: str,
        asset: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> int:
        with self._conn:
            cur = self._conn.execute(
                """
                INSERT INTO alerts (
                    snapshot_ts, strategy_id, level, type, asset, message, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_ts,
                    strategy_id,
                    level,
                    type_,
                    asset,
                    message,
                    _to_json(payload) if payload else None,
                ),
            )
            return cur.lastrowid or 0

    def mark_alert_sent(self, alert_id: int, *, error: str | None = None) -> None:
        with self._conn:
            self._conn.execute(
                """
                UPDATE alerts
                SET sent_at = ?, delivery_attempts = delivery_attempts + 1, last_error = ?
                WHERE id = ?
                """,
                (int(time.time()) if error is None else None, error, alert_id),
            )

    # --------------------------------------------------------------
    # Queries
    # --------------------------------------------------------------

    def get_position_by_id(self, position_id: int) -> dict[str, Any] | None:
        cur = self._conn.execute(
            "SELECT * FROM positions WHERE id = ?", (position_id,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

    def get_last_n_funding(
        self, *, protocol: str, market_id: str, n: int
    ) -> list[tuple[int, Decimal]]:
        cur = self._conn.execute(
            """
            SELECT snapshot_ts, funding_rate FROM market_states
            WHERE protocol = ? AND market_id = ? AND funding_rate IS NOT NULL
            ORDER BY snapshot_ts DESC LIMIT ?
            """,
            (protocol, market_id, n),
        )
        return [(row[0], Decimal(row[1])) for row in cur.fetchall()]

    def get_last_alert(
        self, *, strategy_id: str | None, type_: str
    ) -> dict[str, Any] | None:
        cur = self._conn.execute(
            """
            SELECT * FROM alerts
            WHERE (strategy_id = ? OR (? IS NULL AND strategy_id IS NULL))
              AND type = ?
            ORDER BY snapshot_ts DESC LIMIT 1
            """,
            (strategy_id, strategy_id, type_),
        )
        row = cur.fetchone()
        return dict(row) if row else None

    def get_unsent_alerts(self, limit: int = 100, *, max_attempts: int = 3) -> list[dict[str, Any]]:
        """Return unsent alerts with delivery_attempts < max_attempts.

        After max_attempts failures the alert is considered "given up on" and
        won't be retried automatically — the dashboard can still surface it.
        """
        cur = self._conn.execute(
            """
            SELECT * FROM alerts
            WHERE sent_at IS NULL AND delivery_attempts < ?
            ORDER BY id LIMIT ?
            """,
            (max_attempts, limit),
        )
        return [dict(row) for row in cur.fetchall()]

    def get_latest_strategy_snapshot(self, strategy_id: str) -> dict[str, Any] | None:
        cur = self._conn.execute(
            """
            SELECT * FROM strategy_snapshots
            WHERE strategy_id = ?
            ORDER BY snapshot_ts DESC LIMIT 1
            """,
            (strategy_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else None

    def get_recent_strategy_snapshots(
        self, strategy_id: str, *, since_ts: int
    ) -> list[dict[str, Any]]:
        cur = self._conn.execute(
            """
            SELECT * FROM strategy_snapshots
            WHERE strategy_id = ? AND snapshot_ts >= ?
            ORDER BY snapshot_ts ASC
            """,
            (strategy_id, since_ts),
        )
        return [dict(row) for row in cur.fetchall()]

    # --------------------------------------------------------------
    # Heartbeat
    # --------------------------------------------------------------

    def update_heartbeat(
        self,
        *,
        last_cycle_ts: int,
        cycle_duration_ms: int,
        cycle_errors: int = 0,
        last_cycle_log: str | None = None,
    ) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO heartbeat (id, last_cycle_ts, cycle_duration_ms, cycle_errors, last_cycle_log)
                VALUES (1, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    last_cycle_ts = excluded.last_cycle_ts,
                    cycle_duration_ms = excluded.cycle_duration_ms,
                    cycle_errors = excluded.cycle_errors,
                    last_cycle_log = excluded.last_cycle_log
                """,
                (last_cycle_ts, cycle_duration_ms, cycle_errors, last_cycle_log),
            )

    def get_heartbeat(self) -> dict[str, Any] | None:
        row = self._conn.execute("SELECT * FROM heartbeat WHERE id = 1").fetchone()
        return dict(row) if row else None

    # --------------------------------------------------------------
    # Transaction history (Etherscan)
    # --------------------------------------------------------------

    def insert_wallet_transactions(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0
        batch = [
            (
                r["wallet_id"],
                r["chain"],
                r["source"],
                r["tx_hash"],
                r["block_number"],
                r["timestamp"],
                r["from_addr"],
                r.get("to_addr"),
                r.get("value_native"),
                r.get("asset_symbol"),
                r.get("asset_address"),
                r.get("asset_decimals"),
                r["classification"],
                r.get("gas_used"),
                r.get("gas_price"),
                r.get("is_error", 0),
                r.get("method_id"),
                r["raw_json"],
            )
            for r in rows
        ]
        with self._conn:
            self._conn.executemany(
                """
                INSERT OR IGNORE INTO wallet_transactions (
                    wallet_id, chain, source, tx_hash, block_number, timestamp,
                    from_addr, to_addr, value_native, asset_symbol, asset_address,
                    asset_decimals, classification, gas_used, gas_price,
                    is_error, method_id, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                batch,
            )
        return len(batch)

    def get_sync_state(self, wallet_id: str, chain: str, source: str) -> int:
        cur = self._conn.execute(
            "SELECT last_block FROM etherscan_sync_state WHERE wallet_id=? AND chain=? AND source=?",
            (wallet_id, chain, source),
        )
        row = cur.fetchone()
        return row[0] if row else 0

    def update_sync_state(self, wallet_id: str, chain: str, source: str, last_block: int) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO etherscan_sync_state (wallet_id, chain, source, last_block, last_sync_ts)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(wallet_id, chain, source) DO UPDATE SET
                    last_block = excluded.last_block,
                    last_sync_ts = excluded.last_sync_ts
                """,
                (wallet_id, chain, source, last_block, int(time.time())),
            )

    def list_wallet_transactions(
        self,
        *,
        wallet_id: str | None = None,
        classification: str | None = None,
        since_ts: int | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM wallet_transactions WHERE 1=1"
        params: list[Any] = []
        if wallet_id:
            sql += " AND wallet_id = ?"
            params.append(wallet_id)
        if classification:
            sql += " AND classification = ?"
            params.append(classification)
        if since_ts is not None:
            sql += " AND timestamp >= ?"
            params.append(since_ts)
        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(min(limit, 500))
        cur = self._conn.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]

    def count_wallet_transactions(self, *, wallet_id: str | None = None) -> int:
        if wallet_id:
            cur = self._conn.execute(
                "SELECT COUNT(*) FROM wallet_transactions WHERE wallet_id = ?",
                (wallet_id,),
            )
        else:
            cur = self._conn.execute("SELECT COUNT(*) FROM wallet_transactions")
        return cur.fetchone()[0]

    # --------------------------------------------------------------
    # Manual positions CRUD
    # --------------------------------------------------------------

    def upsert_manual_position(
        self,
        *,
        id: str,
        wallet_id: str | None,
        chain: str,
        protocol: str,
        asset: str,
        side: str,
        size_native: str,
        entry_price: str | None = None,
        entry_ts: int | None = None,
        notes: str | None = None,
    ) -> None:
        now = int(time.time())
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO manual_positions
                    (id, wallet_id, chain, protocol, asset, side, size_native,
                     entry_price, entry_ts, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    wallet_id   = excluded.wallet_id,
                    chain       = excluded.chain,
                    protocol    = excluded.protocol,
                    asset       = excluded.asset,
                    side        = excluded.side,
                    size_native = excluded.size_native,
                    entry_price = excluded.entry_price,
                    entry_ts    = excluded.entry_ts,
                    notes       = excluded.notes,
                    updated_at  = excluded.updated_at
                """,
                (id, wallet_id, chain, protocol, asset, side, size_native,
                 entry_price, entry_ts, notes, now, now),
            )

    def list_manual_positions(self, *, wallet_id: str | None = None) -> list[dict[str, Any]]:
        if wallet_id is not None:
            cur = self._conn.execute(
                "SELECT * FROM manual_positions WHERE wallet_id = ? ORDER BY created_at DESC",
                (wallet_id,),
            )
        else:
            cur = self._conn.execute(
                "SELECT * FROM manual_positions ORDER BY created_at DESC"
            )
        return [dict(row) for row in cur.fetchall()]

    def get_manual_position(self, id: str) -> dict[str, Any] | None:
        cur = self._conn.execute(
            "SELECT * FROM manual_positions WHERE id = ?", (id,)
        )
        row = cur.fetchone()
        return dict(row) if row else None

    def delete_manual_position(self, id: str) -> None:
        with self._conn:
            self._conn.execute(
                "DELETE FROM manual_positions WHERE id = ?", (id,)
            )

    # --------------------------------------------------------------
    # DB strategies (UI-built, override YAML on ID collision)
    # --------------------------------------------------------------

    def upsert_strategy(
        self,
        *,
        id: str,
        name: str,
        type_: str,
        delta_target_pct: str,
        notes: str | None,
        legs: list[dict[str, Any]],
    ) -> None:
        now = int(time.time())
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO db_strategies (id, name, type, delta_target_pct, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    type = excluded.type,
                    delta_target_pct = excluded.delta_target_pct,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at
                """,
                (id, name, type_, delta_target_pct, notes, now, now),
            )
            self._conn.execute(
                "DELETE FROM db_strategy_legs WHERE strategy_id = ?", (id,)
            )
            self._conn.executemany(
                """
                INSERT INTO db_strategy_legs
                  (strategy_id, leg_index, protocol, role, asset, chain, symbol, wallet_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        id,
                        i,
                        leg["protocol"],
                        leg["role"],
                        leg.get("asset"),
                        leg.get("chain"),
                        leg.get("symbol"),
                        leg.get("wallet_id"),
                    )
                    for i, leg in enumerate(legs)
                ],
            )

    def list_strategies(self) -> list[dict[str, Any]]:
        strats = [
            dict(row)
            for row in self._conn.execute(
                "SELECT * FROM db_strategies ORDER BY created_at ASC"
            ).fetchall()
        ]
        for s in strats:
            s["legs"] = self._fetch_legs(s["id"])
        return strats

    def get_strategy(self, id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM db_strategies WHERE id = ?", (id,)
        ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["legs"] = self._fetch_legs(id)
        return result

    def delete_strategy(self, id: str) -> None:
        with self._conn:
            self._conn.execute("DELETE FROM db_strategies WHERE id = ?", (id,))

    def _fetch_legs(self, strategy_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT protocol, role, asset, chain, symbol, wallet_id "
            "FROM db_strategy_legs WHERE strategy_id = ? ORDER BY leg_index ASC",
            (strategy_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def close(self) -> None:
        self._conn.close()
