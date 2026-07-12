"""Canonical position / market models.

All adapters convert their protocol-specific data into these dataclasses.
The strategy engine consumes only these — no protocol leakage.

Decimals are used (not float) to avoid precision errors on crypto amounts.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any


class PositionSide(str, Enum):
    LONG = "long"
    SHORT = "short"
    COLLATERAL = "collateral"
    DEBT = "debt"
    SPOT = "spot"


class LegRole(str, Enum):
    """Functional role of a leg within a composite strategy."""

    SPOT = "spot"
    SHORT_PERP = "short_perp"
    LONG_PERP = "long_perp"
    COLLATERAL = "collateral"
    DEBT = "debt"
    COLLATERAL_AND_DEBT = "collateral_and_debt"  # single lending position
    PT_LONG = "pt_long"
    SHORT_HEDGE = "short_hedge"


@dataclass(slots=True, frozen=True)
class Position:
    """A single position fetched from a protocol.

    Each adapter returns a list of these. A composite strategy may aggregate
    multiple Position objects (one per leg).
    """

    # Identity
    protocol: str
    chain: str
    asset: str
    side: PositionSide

    # Size + value
    size_native: Decimal  # in the asset's native units
    size_usd: Decimal | None  # USD valuation at snapshot_ts (None if unknown)

    # Pricing snapshot
    entry_price: Decimal | None
    mark_price: Decimal | None
    oracle_price: Decimal | None  # on-chain oracle if available

    # Lending-specific (None if not lending)
    health_factor: Decimal | None
    liquidation_threshold: Decimal | None  # LT / LLTV
    market_id: str | None

    # Perp-specific (None if not perp)
    funding_rate: Decimal | None  # current rate (per funding period)
    funding_period_hours: float | None  # 1 for Hyperliquid, etc.
    unrealized_pnl_usd: Decimal | None
    liquidation_price: Decimal | None

    # Pendle-specific (None if not Pendle)
    pt_expiry_ts: int | None  # unix timestamp of PT maturity
    market_liquidity_usd: Decimal | None
    implied_apy: Decimal | None

    # Metadata
    snapshot_ts: int  # unix ts when this snapshot was taken
    wallet: str | None  # the wallet address this position belongs to
    raw: dict[str, Any] = field(default_factory=dict)  # raw payload for audit


@dataclass(slots=True, frozen=True)
class MarketState:
    """Live market data not tied to a specific user position.

    Used to track funding rate history, mark prices, depth, etc.
    """

    protocol: str
    market_id: str  # e.g. "BTC-USD" or "0xMorphoMarket..."
    mark_price: Decimal | None
    oracle_price: Decimal | None
    funding_rate: Decimal | None  # current
    open_interest_usd: Decimal | None
    liquidity_usd: Decimal | None
    snapshot_ts: int
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class StrategySnapshot:
    """Aggregated view of a composite strategy at a given timestamp.

    Computed by the strategy_engine from a set of Position objects.
    """

    strategy_id: str
    snapshot_ts: int

    # Aggregated metrics
    net_delta_usd: Decimal  # sum(long_usd) - sum(short_usd) per asset, then summed
    delta_target_pct: Decimal  # configured target (e.g. 0 for delta-neutral)
    delta_deviation_pct: Decimal  # actual deviation from target

    composite_hf: Decimal | None  # min(HF) across lending legs (None if no lending)
    pnl_unrealized_usd: Decimal  # sum across legs
    pnl_funding_24h_usd: Decimal  # cumulative funding paid/received over last 24h

    # Per-leg details (kept for traceability)
    leg_positions: list[Position] = field(default_factory=list)

    # Health flags
    has_lending_leg: bool = False
    has_perp_leg: bool = False
    has_pt_leg: bool = False
    days_to_pendle_expiry: int | None = None
