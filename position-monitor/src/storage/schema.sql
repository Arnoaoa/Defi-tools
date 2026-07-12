-- Position Monitor SQLite schema
-- Applied idempotently at Database init via CREATE TABLE IF NOT EXISTS.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- Schema version (manual bump on migrations)
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

-- ============================================================
-- positions: raw position snapshots from adapters
-- ============================================================
CREATE TABLE IF NOT EXISTS positions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ts   INTEGER NOT NULL,
    strategy_id   TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    chain         TEXT NOT NULL,
    asset         TEXT NOT NULL,
    side          TEXT NOT NULL,         -- long / short / collateral / debt / spot
    size_native   TEXT NOT NULL,         -- Decimal stored as string
    size_usd      TEXT,
    entry_price   TEXT,
    mark_price    TEXT,
    oracle_price  TEXT,
    health_factor TEXT,
    liquidation_threshold TEXT,
    market_id     TEXT,
    funding_rate  TEXT,
    funding_period_hours REAL,
    unrealized_pnl_usd TEXT,
    liquidation_price TEXT,
    pt_expiry_ts  INTEGER,
    market_liquidity_usd TEXT,
    implied_apy   TEXT,
    wallet        TEXT,
    raw_json      TEXT NOT NULL          -- audit payload
);

CREATE INDEX IF NOT EXISTS idx_positions_strategy_ts
    ON positions(strategy_id, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_protocol_market_ts
    ON positions(protocol, market_id, snapshot_ts DESC);

-- ============================================================
-- market_states: live market data (funding, mark, depth)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_states (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ts  INTEGER NOT NULL,
    protocol     TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    mark_price   TEXT,
    oracle_price TEXT,
    funding_rate TEXT,
    open_interest_usd TEXT,
    liquidity_usd TEXT,
    raw_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_states_protocol_market_ts
    ON market_states(protocol, market_id, snapshot_ts DESC);

-- ============================================================
-- strategy_snapshots: aggregated composite metrics per strategy
-- ============================================================
CREATE TABLE IF NOT EXISTS strategy_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ts    INTEGER NOT NULL,
    strategy_id    TEXT NOT NULL,
    net_delta_usd  TEXT,
    delta_target_pct TEXT,
    delta_deviation_pct TEXT,
    composite_hf   TEXT,
    pnl_unrealized_usd TEXT,
    pnl_funding_24h_usd TEXT,
    has_lending_leg BOOLEAN NOT NULL DEFAULT 0,
    has_perp_leg   BOOLEAN NOT NULL DEFAULT 0,
    has_pt_leg     BOOLEAN NOT NULL DEFAULT 0,
    days_to_pendle_expiry INTEGER,
    metrics_json   TEXT,                  -- extended metrics
    UNIQUE(strategy_id, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_strategy_ts
    ON strategy_snapshots(strategy_id, snapshot_ts DESC);

-- ============================================================
-- alerts: triggered + sent alerts (dedup + history)
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ts  INTEGER NOT NULL,
    strategy_id  TEXT,
    level        TEXT NOT NULL,           -- info / warning / urgent / critical
    type         TEXT NOT NULL,           -- hf_low / funding_flip / depeg / ...
    asset        TEXT,                    -- optional asset context
    message      TEXT NOT NULL,
    payload_json TEXT,                    -- structured trigger data
    sent_at      INTEGER,                 -- NULL = not sent yet (queued)
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_strategy_type_ts
    ON alerts(strategy_id, type, snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unsent
    ON alerts(sent_at) WHERE sent_at IS NULL;

-- ============================================================
-- heartbeat: dead-man's switch reference
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeat (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_cycle_ts INTEGER NOT NULL,
    cycle_duration_ms INTEGER,
    cycle_errors INTEGER DEFAULT 0,
    last_cycle_log TEXT
);

-- ============================================================
-- wallets: addresses tracked by the monitor.
--   group = 'self'  → positions count toward the user's portfolio,
--                     drive alerts, can back strategies.
--   group = 'watch' → read-only observation (whales / strategies to copy),
--                     no alerts, no portfolio aggregation.
-- ============================================================
CREATE TABLE IF NOT EXISTS wallets (
    id          TEXT PRIMARY KEY,           -- short slug, e.g. 'arnaud_main'
    label       TEXT NOT NULL,
    address     TEXT NOT NULL,              -- 0x... or chain-specific format
    chain       TEXT NOT NULL DEFAULT 'ethereum',
    grp         TEXT NOT NULL DEFAULT 'self', -- 'self' | 'watch'
    notes       TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(address, chain)
);

CREATE INDEX IF NOT EXISTS idx_wallets_grp ON wallets(grp);

-- ============================================================
-- portfolio_snapshots: aggregated portfolio at a given timestamp,
--   per (group, chain, category). One row per cell of the breakdown.
--   Multiple snapshots over time → trend chart.
-- ============================================================
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ts  INTEGER NOT NULL,
    grp          TEXT NOT NULL,             -- 'self' | 'watch'
    chain        TEXT NOT NULL,
    category     TEXT NOT NULL,             -- spot_volatile / spot_stable /
                                            -- lending_collat / lending_debt /
                                            -- perp_long / perp_short / pt / lp
    value_usd    TEXT NOT NULL,             -- sum of size_usd across positions
    position_count INTEGER NOT NULL,
    metrics_json TEXT                       -- per-asset breakdown
);

CREATE INDEX IF NOT EXISTS idx_portfolio_ts ON portfolio_snapshots(snapshot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_grp_ts ON portfolio_snapshots(grp, snapshot_ts DESC);

-- Add wallet_id FK on positions (NULL allowed for backward-compat / manual entries)
-- Note: SQLite ALTER TABLE ADD COLUMN does not support FK constraint addition,
-- but the column is added when missing. Application logic enforces wallet_id presence.
-- Migration handled at app level (CURRENT_SCHEMA_VERSION bumped).

-- ============================================================
-- wallet_transactions: on-chain tx history per wallet (Etherscan)
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id       TEXT NOT NULL,
    chain           TEXT NOT NULL,
    source          TEXT NOT NULL,        -- 'normal' | 'internal' | 'token'
    tx_hash         TEXT NOT NULL,
    block_number    INTEGER NOT NULL,
    timestamp       INTEGER NOT NULL,
    from_addr       TEXT NOT NULL,
    to_addr         TEXT,                 -- can be NULL for contract creation
    value_native    TEXT,                 -- string Decimal, native units (wei or token raw)
    asset_symbol    TEXT,                 -- 'ETH' for normal/internal, token symbol for ERC-20
    asset_address   TEXT,                 -- token contract for ERC-20, NULL for native
    asset_decimals  INTEGER,              -- nullable
    classification  TEXT NOT NULL,        -- internal_transfer / transfer_in / transfer_out / contract_call
    gas_used        TEXT,
    gas_price       TEXT,
    is_error        INTEGER NOT NULL DEFAULT 0,
    method_id       TEXT,                 -- first 4 bytes of input data (function selector)
    raw_json        TEXT NOT NULL,
    UNIQUE(wallet_id, chain, source, tx_hash, from_addr, to_addr, asset_address)
);

CREATE INDEX IF NOT EXISTS idx_wtx_wallet_ts ON wallet_transactions(wallet_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wtx_classification ON wallet_transactions(classification, timestamp DESC);

-- ============================================================
-- etherscan_sync_state: last block synced per wallet/chain/source
-- ============================================================
CREATE TABLE IF NOT EXISTS etherscan_sync_state (
    wallet_id        TEXT NOT NULL,
    chain            TEXT NOT NULL,
    source           TEXT NOT NULL,       -- 'normal' | 'internal' | 'token'
    last_block       INTEGER NOT NULL DEFAULT 0,
    last_sync_ts     INTEGER NOT NULL,
    PRIMARY KEY (wallet_id, chain, source)
);

-- ============================================================
-- manual_positions: entries the user types in via the UI
-- (Apex Omni, OTC trades, anything adapter-less)
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_positions (
    id            TEXT PRIMARY KEY,         -- slug, e.g. 'apex_btc_short'
    wallet_id     TEXT,                     -- nullable: positions can be account-less (Apex)
    chain         TEXT NOT NULL,            -- e.g. 'apex' / 'ethereum' / 'arbitrum'
    protocol      TEXT NOT NULL,            -- e.g. 'apex_omni' / 'manual'
    asset         TEXT NOT NULL,
    side          TEXT NOT NULL,            -- long / short / collateral / debt / spot
    size_native   TEXT NOT NULL,            -- string Decimal
    entry_price   TEXT,                     -- string Decimal
    entry_ts      INTEGER,                  -- unix sec
    notes         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_pos_wallet ON manual_positions(wallet_id);

-- ============================================================
-- db_strategies: strategies declared via the dashboard UI
-- (overrides strategies.yaml on ID collision)
-- ============================================================
CREATE TABLE IF NOT EXISTS db_strategies (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    type              TEXT NOT NULL,
    delta_target_pct  TEXT NOT NULL DEFAULT '0',
    notes             TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

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
);

CREATE INDEX IF NOT EXISTS idx_strategy_legs ON db_strategy_legs(strategy_id);
