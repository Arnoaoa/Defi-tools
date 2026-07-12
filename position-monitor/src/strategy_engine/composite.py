"""Composite strategy engine.

Transforms a list of Position legs into a StrategySnapshot with aggregated
metrics: net delta, composite health factor, unrealized PnL, Pendle expiry, etc.
"""
from __future__ import annotations

import time
from collections import defaultdict
from decimal import Decimal
from typing import TYPE_CHECKING, Protocol

from loguru import logger

from src.config import StrategyConfig
from src.models.position import LegRole, Position, PositionSide, StrategySnapshot

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Optional DB protocol (duck-typed — no hard dependency on storage layer)
# ---------------------------------------------------------------------------


class _FundingDB(Protocol):
    def get_last_n_funding(
        self, *, protocol: str, market_id: str, n: int
    ) -> list[tuple[int, Decimal]]:
        """Return up to n (timestamp_ms, funding_rate) rows, newest first."""
        ...


# ---------------------------------------------------------------------------
# Role → delta sign mapping
# ---------------------------------------------------------------------------

# Roles that contribute a POSITIVE (long) exposure to a given asset
_LONG_ROLES: frozenset[LegRole] = frozenset(
    {
        LegRole.SPOT,
        LegRole.COLLATERAL,
        LegRole.COLLATERAL_AND_DEBT,
        LegRole.PT_LONG,
        LegRole.LONG_PERP,
    }
)

# Roles that contribute a NEGATIVE (short) exposure to a given asset
_SHORT_ROLES: frozenset[LegRole] = frozenset(
    {
        LegRole.SHORT_PERP,
        LegRole.SHORT_HEDGE,
        LegRole.DEBT,
    }
)

# Sides that, absent a LegConfig role, map to long
_LONG_SIDES: frozenset[PositionSide] = frozenset(
    {PositionSide.LONG, PositionSide.COLLATERAL, PositionSide.SPOT}
)

# Stable assets excluded from net_delta computation (they are tracked separately
# via depeg checks). A debt in USDT does NOT mean you are short USD-volatility —
# it's a stable liability whose only market risk is depeg, not direction.
# Including stables in net_delta produces false-positive delta_deviation on
# looping / carry strategies where stable debt is intentional.
_STABLE_ASSETS: frozenset[str] = frozenset(
    {
        "USDC", "USDT", "DAI", "GHO", "USDe", "sUSDe", "FRAX", "FDUSD",
        "BUSD", "TUSD", "PYUSD", "LUSD", "crvUSD", "mkUSD", "USDD",
    }
)


def _role_from_side(side: PositionSide) -> int:
    """Fallback delta sign (+1/-1) when no LegRole is available."""
    return 1 if side in _LONG_SIDES else -1


def _delta_sign(role: LegRole | None, side: PositionSide) -> int:
    """Return +1 for long exposure, -1 for short exposure."""
    if role is None:
        return _role_from_side(side)
    if role in _LONG_ROLES:
        return 1
    if role in _SHORT_ROLES:
        return -1
    # Unknown role — default to side-based sign and warn
    logger.warning("strategy_engine: unknown LegRole {!r}, falling back to side sign", role)
    return _role_from_side(side)


def _is_lending_role(role: LegRole | None, pos: Position) -> bool:
    """True if this leg participates in a lending position."""
    if role in {LegRole.COLLATERAL, LegRole.DEBT, LegRole.COLLATERAL_AND_DEBT}:
        return True
    if role is None:
        return pos.side in {PositionSide.COLLATERAL, PositionSide.DEBT}
    return False


def _is_perp_role(role: LegRole | None, pos: Position) -> bool:
    if role in {LegRole.SHORT_PERP, LegRole.LONG_PERP, LegRole.SHORT_HEDGE}:
        return True
    if role is None:
        return pos.funding_rate is not None
    return False


def _is_pt_role(role: LegRole | None) -> bool:
    return role == LegRole.PT_LONG


# ---------------------------------------------------------------------------
# Main engine
# ---------------------------------------------------------------------------


class StrategyEngine:
    """Stateless engine that aggregates a list of Position legs into a StrategySnapshot."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compute_snapshot(
        self,
        strategy: StrategyConfig,
        positions: list[Position],
        *,
        prices: dict[str, Decimal],
        db: _FundingDB | None = None,
    ) -> StrategySnapshot:
        """Build a StrategySnapshot from raw positions.

        Args:
            strategy: strategy configuration (id, delta_target_pct, legs, …)
            positions: list of Position objects — one per protocol leg
            prices: {asset_symbol: usd_price} from oracle layer
            db: optional storage handle for funding history (V2 feature)
        """
        now_ts = int(time.time())

        # Build a role lookup keyed by (protocol, asset, side) → LegRole
        # to map each Position back to its declared role in the config
        role_map = self._build_role_map(strategy)

        # 1. Resolve size_usd for every leg
        valued: list[tuple[Position, LegRole | None, Decimal | None]] = []
        legs_unpriced = 0

        for pos in positions:
            role = role_map.get(self._role_key(pos))
            size_usd = self._resolve_size_usd(pos, prices)

            if size_usd is None:
                legs_unpriced += 1
                logger.warning(
                    "strategy_engine [{}]: leg {}/{}/{} has no size_usd and no price — skipping aggregation",
                    strategy.id,
                    pos.protocol,
                    pos.asset,
                    pos.side.value,
                )
            valued.append((pos, role, size_usd))

        if legs_unpriced:
            logger.warning(
                "strategy_engine [{}]: {} leg(s) unpriced — metrics may be incomplete",
                strategy.id,
                legs_unpriced,
            )

        # 2. Net delta
        net_delta_usd = self._compute_net_delta(valued)

        # 3. Capital engaged + deviation
        capital_engaged = sum(
            abs(size_usd)
            for _, _, size_usd in valued
            if size_usd is not None
        )

        delta_target_pct = strategy.delta_target_pct
        delta_deviation_pct = self._compute_delta_deviation(
            net_delta_usd, capital_engaged, delta_target_pct
        )

        # 4. Composite health factor
        composite_hf = self._compute_composite_hf(valued)

        # 5. Unrealized PnL
        pnl_unrealized_usd = sum(
            (pos.unrealized_pnl_usd for pos, _, _ in valued if pos.unrealized_pnl_usd is not None),
            Decimal(0),
        )

        # 6. Funding PnL 24h
        pnl_funding_24h_usd = self._compute_funding_24h(strategy, valued, db)

        # 7. Flags
        has_lending_leg = any(_is_lending_role(role, pos) for pos, role, _ in valued)
        has_perp_leg = any(_is_perp_role(role, pos) for pos, role, _ in valued)
        has_pt_leg = any(_is_pt_role(role) for _, role, _ in valued)

        # 8. Pendle expiry (minimum days to expiry across all PT legs)
        days_to_pendle_expiry = self._compute_pendle_expiry(valued, now_ts)

        return StrategySnapshot(
            strategy_id=strategy.id,
            snapshot_ts=now_ts,
            net_delta_usd=net_delta_usd,
            delta_target_pct=delta_target_pct,
            delta_deviation_pct=delta_deviation_pct,
            composite_hf=composite_hf,
            pnl_unrealized_usd=pnl_unrealized_usd,
            pnl_funding_24h_usd=pnl_funding_24h_usd,
            leg_positions=list(positions),
            has_lending_leg=has_lending_leg,
            has_perp_leg=has_perp_leg,
            has_pt_leg=has_pt_leg,
            days_to_pendle_expiry=days_to_pendle_expiry,
        )

    def compute_warmup_status(self, snap: StrategySnapshot, cycle_count: int) -> bool:  # noqa: ARG002
        """Return True during warmup phase (first 3 cycles).

        During warmup, callers should prefix alerts with '[WARMUP]' and avoid
        acting on potentially incomplete baseline data.
        """
        return cycle_count < 3

    def health_summary(self, snap: StrategySnapshot) -> str:
        """Return 'healthy' / 'watch' / 'alert' based on HF and delta deviation."""
        is_alert = False
        is_watch = False

        # HF thresholds: alert < 1.1, watch < 1.3
        if snap.composite_hf is not None:
            if snap.composite_hf < Decimal("1.1"):
                is_alert = True
            elif snap.composite_hf < Decimal("1.3"):
                is_watch = True

        # Delta deviation: alert > 20%, watch > 10%
        abs_dev = abs(snap.delta_deviation_pct)
        if abs_dev > Decimal("20"):
            is_alert = True
        elif abs_dev > Decimal("10"):
            is_watch = True

        if is_alert:
            return "alert"
        if is_watch:
            return "watch"
        return "healthy"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _role_key(pos: Position) -> tuple[str, str, str]:
        """Composite key used to match a Position to a LegConfig role."""
        return (pos.protocol, pos.asset or "", pos.side.value)

    def _build_role_map(
        self, strategy: StrategyConfig
    ) -> dict[tuple[str, str, str], LegRole]:
        """Map (protocol, asset, side) → LegRole from strategy leg config.

        Best-effort: if a leg config has no asset, we skip the side component
        so it matches any asset for that protocol. First match wins.
        """
        role_map: dict[tuple[str, str, str], LegRole] = {}
        for leg in strategy.legs:
            try:
                leg_role = LegRole(leg.role)
            except ValueError:
                logger.warning(
                    "strategy_engine [{}]: unknown leg role {!r} in config — ignoring",
                    strategy.id,
                    leg.role,
                )
                continue

            # Infer the PositionSide from LegRole for the key
            side_value = self._side_from_role(leg_role)
            asset = leg.asset or ""
            key = (leg.protocol, asset, side_value)
            role_map[key] = leg_role
        return role_map

    @staticmethod
    def _side_from_role(role: LegRole) -> str:
        """Map LegRole back to a PositionSide string for key building."""
        mapping: dict[LegRole, str] = {
            LegRole.SPOT: PositionSide.SPOT.value,
            LegRole.SHORT_PERP: PositionSide.SHORT.value,
            LegRole.LONG_PERP: PositionSide.LONG.value,
            LegRole.SHORT_HEDGE: PositionSide.SHORT.value,
            LegRole.COLLATERAL: PositionSide.COLLATERAL.value,
            LegRole.DEBT: PositionSide.DEBT.value,
            LegRole.COLLATERAL_AND_DEBT: PositionSide.COLLATERAL.value,
            LegRole.PT_LONG: PositionSide.LONG.value,
        }
        return mapping.get(role, "")

    @staticmethod
    def _resolve_size_usd(pos: Position, prices: dict[str, Decimal]) -> Decimal | None:
        """Return size_usd, computing it from native size + oracle price if needed."""
        if pos.size_usd is not None:
            return pos.size_usd
        price = prices.get(pos.asset)
        if price is not None:
            return pos.size_native * price
        return None

    @staticmethod
    def _compute_net_delta(
        valued: list[tuple[Position, LegRole | None, Decimal | None]],
    ) -> Decimal:
        """Sum of (signed size_usd) per VOLATILE asset, then total across assets.

        COLLATERAL / SPOT / PT_LONG = long (+), DEBT / SHORT_PERP = short (-).

        STABLE assets are EXCLUDED from net_delta — they are tracked separately
        via depeg alerts. Including a stable debt (e.g. USDT borrowed against
        WETH collateral on Morpho) as "short USD exposure" produces false
        delta-deviation alerts on looping/carry strategies that are economically
        neutral on USD-direction.

        Legs with no size_usd are skipped (already warned upstream).
        """
        # asset → signed USD exposure
        per_asset: dict[str, Decimal] = defaultdict(Decimal)

        for pos, role, size_usd in valued:
            if size_usd is None:
                continue
            if pos.asset in _STABLE_ASSETS:
                # Stables: not a directional bet, monitored via depeg checks.
                continue
            sign = _delta_sign(role, pos.side)
            per_asset[pos.asset] += Decimal(sign) * size_usd

        return sum(per_asset.values(), Decimal(0))

    @staticmethod
    def _compute_delta_deviation(
        net_delta_usd: Decimal,
        capital_engaged: Decimal,
        delta_target_pct: Decimal,
    ) -> Decimal:
        if capital_engaged == 0:
            return Decimal(0)
        target_usd = capital_engaged * delta_target_pct / Decimal(100)
        deviation_usd = net_delta_usd - target_usd
        return (deviation_usd / capital_engaged) * Decimal(100)

    @staticmethod
    def _compute_composite_hf(
        valued: list[tuple[Position, LegRole | None, Decimal | None]],
    ) -> Decimal | None:
        """Return the minimum health factor across lending legs.

        De-duplicates by (protocol, wallet) so that a multi-position Aave/Morpho
        account doesn't double-count the same global HF.
        """
        seen_accounts: set[tuple[str, str]] = set()
        hf_values: list[Decimal] = []

        for pos, role, _ in valued:
            if not _is_lending_role(role, pos):
                continue
            if pos.health_factor is None:
                logger.debug(
                    "strategy_engine: lending leg {}/{} has no health_factor set",
                    pos.protocol,
                    pos.asset,
                )
                continue

            account_key = (pos.protocol, pos.wallet or "")
            if account_key in seen_accounts:
                # Same protocol+wallet already counted — same global HF, skip
                continue
            seen_accounts.add(account_key)
            hf_values.append(pos.health_factor)

        return min(hf_values) if hf_values else None

    @staticmethod
    def _compute_funding_24h(
        strategy: StrategyConfig,
        valued: list[tuple[Position, LegRole | None, Decimal | None]],
        db: _FundingDB | None,
    ) -> Decimal:
        """Estimate cumulative funding over the last 24 hours.

        V1 (no DB): returns 0 with a warning.
        V2 (DB provided): queries funding history per perp leg.

        For V2, the estimate is:
          sum over last 24 prints of (funding_rate × position_size_usd)
        Positive = received (short pays long on HL when rate < 0, etc. — sign
        convention depends on protocol; we store what the adapter returns and
        preserve the sign).
        """
        if db is None:
            logger.warning(
                "strategy_engine [{}]: no DB provided — pnl_funding_24h_usd set to 0 (V1 cold start)",
                strategy.id,
            )
            return Decimal(0)

        total_funding = Decimal(0)
        for pos, role, size_usd in valued:
            if not _is_perp_role(role, pos):
                continue
            if size_usd is None:
                continue

            market = pos.market_id or pos.asset
            try:
                prints = db.get_last_n_funding(
                    protocol=pos.protocol, market_id=market, n=24
                )
            except Exception:
                logger.warning(
                    "strategy_engine [{}]: failed to fetch funding history for {}/{}",
                    strategy.id,
                    pos.protocol,
                    market,
                )
                continue

            for _ts_ms, rate in prints:
                # rate is per funding period; we sum raw rates × notional
                # sign: positive rate = longs pay shorts; short position profits
                sign = _delta_sign(role, pos.side)
                # Short receives positive funding when rate > 0
                total_funding += Decimal(-sign) * rate * size_usd

        return total_funding

    @staticmethod
    def _compute_pendle_expiry(
        valued: list[tuple[Position, LegRole | None, Decimal | None]],
        now_ts: int,
    ) -> int | None:
        """Return the minimum days to PT expiry across all PT legs, or None."""
        days_list: list[int] = []
        for pos, role, _ in valued:
            if not _is_pt_role(role):
                continue
            if pos.pt_expiry_ts is None:
                continue
            days = int((pos.pt_expiry_ts - now_ts) / 86400)
            days_list.append(days)
        return min(days_list) if days_list else None
