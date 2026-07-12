"""Portfolio aggregator — classify and group positions across wallets.

The aggregator produces a PortfolioSnapshot per group ('self' / 'watch')
broken down by (chain, category, asset). This feeds the dashboard's
/portfolio view and the historical trend chart.

Categories are intentionally coarse-grained — the breakdown UI splits
deeper by asset within each cell.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any

from loguru import logger

from src.models import LegRole, Position, PositionSide

# Stable assets — these go in their own category, regardless of side.
# Kept in sync with strategy_engine._STABLE_ASSETS.
_STABLE_ASSETS: frozenset[str] = frozenset(
    {
        "USDC", "USDT", "DAI", "GHO", "USDe", "sUSDe", "FRAX", "FDUSD",
        "BUSD", "TUSD", "PYUSD", "LUSD", "crvUSD", "mkUSD", "USDD",
    }
)


class Category(str, Enum):
    SPOT_VOLATILE = "spot_volatile"        # BTC, ETH, etc. held outright
    SPOT_STABLE = "spot_stable"            # USDC, USDT, etc. held outright
    LENDING_COLLAT = "lending_collat"      # supplied / posted as collateral
    LENDING_DEBT = "lending_debt"          # borrowed (negative value)
    PERP_LONG = "perp_long"
    PERP_SHORT = "perp_short"              # negative directional exposure
    PT = "pt"                              # Pendle Principal Tokens
    LP = "lp"                              # liquidity provider positions
    OTHER = "other"


@dataclass
class PortfolioBreakdownRow:
    """A single cell of the portfolio breakdown — sums all positions of one
    category on one chain for one group."""

    group: str
    chain: str
    category: Category
    value_usd: Decimal
    position_count: int
    # Per-asset detail: { 'WBTC': {value_usd, size_native, count} }
    assets: dict[str, dict[str, Any]] = field(default_factory=dict)


def _classify(pos: Position, role_hint: LegRole | None = None) -> Category:
    """Map a Position to a portfolio Category.

    Uses both LegRole (if available from strategy mapping) and PositionSide
    as fallback. Stables are split into their own bucket.
    """
    asset_upper = (pos.asset or "").upper()
    is_stable = asset_upper in _STABLE_ASSETS

    # Pendle PT detection — adapter tags PT positions with side=LONG and
    # pt_expiry_ts set.
    if pos.pt_expiry_ts is not None or role_hint == LegRole.PT_LONG:
        return Category.PT

    # Lending positions: protocols Morpho / Aave / Euler return side=COLLATERAL or DEBT
    if pos.side == PositionSide.COLLATERAL or role_hint == LegRole.COLLATERAL:
        return Category.LENDING_COLLAT
    if pos.side == PositionSide.DEBT or role_hint == LegRole.DEBT:
        return Category.LENDING_DEBT

    # Perp positions: protocols Hyperliquid / Apex Omni return side=LONG/SHORT with funding_rate set
    if pos.funding_rate is not None:
        if pos.side == PositionSide.SHORT or role_hint in (
            LegRole.SHORT_PERP,
            LegRole.SHORT_HEDGE,
        ):
            return Category.PERP_SHORT
        if pos.side == PositionSide.LONG or role_hint == LegRole.LONG_PERP:
            return Category.PERP_LONG

    # LP positions — Pendle LP, Curve LP, etc. (none mapped yet but reserve)
    # Heuristic: asset name contains 'LP' or starts with known LP prefixes.
    if "-LP" in asset_upper or asset_upper.endswith("LP"):
        return Category.LP

    # Spot fallback
    if is_stable:
        return Category.SPOT_STABLE
    return Category.SPOT_VOLATILE


@dataclass
class PortfolioAggregator:
    """Build a portfolio breakdown from per-wallet positions.

    Usage:
        agg = PortfolioAggregator(snapshot_ts=now)
        agg.add_wallet_positions(wallet_id='arnaud_main', group='self',
                                 chain='ethereum', positions=[...])
        breakdown = agg.build_breakdown(group='self')
    """

    snapshot_ts: int
    _by_cell: dict[tuple[str, str, Category], PortfolioBreakdownRow] = field(
        default_factory=dict
    )

    def add_wallet_positions(
        self,
        *,
        group: str,
        chain: str,
        positions: list[Position],
        role_hints: dict[int, LegRole] | None = None,
    ) -> None:
        """Add positions from one wallet. role_hints maps position index → LegRole."""
        role_hints = role_hints or {}

        for idx, pos in enumerate(positions):
            category = _classify(pos, role_hints.get(idx))
            cell_key = (group, chain, category)

            cell = self._by_cell.get(cell_key)
            if cell is None:
                cell = PortfolioBreakdownRow(
                    group=group,
                    chain=chain,
                    category=category,
                    value_usd=Decimal(0),
                    position_count=0,
                )
                self._by_cell[cell_key] = cell

            # Value contribution
            #   Debt categories are stored as POSITIVE absolute value here;
            #   the dashboard renders them with a minus sign and color.
            size_usd = pos.size_usd or Decimal(0)
            value = abs(size_usd)

            cell.value_usd += value
            cell.position_count += 1

            # Per-asset detail
            asset_key = pos.asset or "UNKNOWN"
            slot = cell.assets.setdefault(
                asset_key,
                {"value_usd": Decimal(0), "size_native": Decimal(0), "count": 0},
            )
            slot["value_usd"] += value
            slot["size_native"] += pos.size_native or Decimal(0)
            slot["count"] += 1

    def build_breakdown(self, *, group: str) -> list[PortfolioBreakdownRow]:
        """Return the breakdown rows for the given group, sorted by value desc."""
        rows = [
            cell for (g, _chain, _cat), cell in self._by_cell.items() if g == group
        ]
        rows.sort(key=lambda r: r.value_usd, reverse=True)
        return rows

    def total_value_usd(self, *, group: str) -> Decimal:
        return sum(
            (
                cell.value_usd if cell.category != Category.LENDING_DEBT else -cell.value_usd
                for cell in self.build_breakdown(group=group)
            ),
            Decimal(0),
        )

    def as_storage_rows(self, *, group: str) -> list[dict[str, Any]]:
        """Serialize as rows ready for Database.insert_portfolio_snapshots."""
        out = []
        for cell in self.build_breakdown(group=group):
            # Convert per-asset assets dict to JSON-safe form
            assets_serialised = {
                k: {
                    "value_usd": str(v["value_usd"]),
                    "size_native": str(v["size_native"]),
                    "count": v["count"],
                }
                for k, v in cell.assets.items()
            }
            out.append({
                "snapshot_ts": self.snapshot_ts,
                "grp": cell.group,
                "chain": cell.chain,
                "category": cell.category.value,
                "value_usd": cell.value_usd,
                "position_count": cell.position_count,
                "metrics": {"assets": assets_serialised},
            })
        return out


def log_summary(agg: PortfolioAggregator) -> None:
    """Convenience: log a 1-line breakdown summary per group."""
    for grp in ("self", "watch"):
        rows = agg.build_breakdown(group=grp)
        if not rows:
            continue
        total = agg.total_value_usd(group=grp)
        cats = ", ".join(
            f"{r.category.value}={r.value_usd:.0f}" for r in rows[:5]
        )
        logger.info(
            f"Portfolio [{grp}]: total=${total:.0f} across {len(rows)} cells — top: {cats}"
        )
