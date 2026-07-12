"""Threshold checker — evaluates alert conditions for a strategy snapshot."""
from __future__ import annotations

import time
from decimal import Decimal
from typing import TYPE_CHECKING

from loguru import logger

from src.alerts.models import Alert, AlertLevel, AlertType
from src.models.position import LegRole, Position, PositionSide

if TYPE_CHECKING:
    from src.config import GlobalDefaults, StrategyConfig
    from src.models.position import StrategySnapshot

# ---------------------------------------------------------------------------
# Depeg reference table
# ---------------------------------------------------------------------------

# Assets whose price is expected to track 1 USD
_STABLE_USD_PEG: dict[str, Decimal] = {
    "USDC": Decimal(1),
    "USDT": Decimal(1),
    "GHO": Decimal(1),
    "USDe": Decimal(1),
    "DAI": Decimal(1),
    "FRAX": Decimal(1),
}

# Assets whose price tracks XAU/USD (gold) — need XAU reference price from prices_history
_GOLD_PEGGED: frozenset[str] = frozenset({"PAXG", "XAUt"})

# Per-asset depeg soft/hard thresholds (pct deviation, as Decimal "0.3" = 0.3%)
# Fallback to GlobalDefaults.depeg_threshold_pct for assets not listed here
_ASSET_DEPEG_SOFT: dict[str, Decimal] = {
    "USDC": Decimal("0.3"),
    "GHO": Decimal("0.3"),
    "USDT": Decimal("0.5"),
    "USDe": Decimal("1.0"),
    "DAI": Decimal("0.3"),
    "FRAX": Decimal("0.5"),
}
_ASSET_DEPEG_CONFIRMED: dict[str, Decimal] = {
    "USDC": Decimal("1.0"),
    "GHO": Decimal("1.0"),
    "USDT": Decimal("1.0"),
    "USDe": Decimal("2.0"),
    "DAI": Decimal("1.0"),
    "FRAX": Decimal("1.0"),
}


def _pct_deviation(price: Decimal, peg: Decimal) -> Decimal:
    """Absolute percentage deviation from peg (always positive)."""
    return abs(price - peg) / peg * Decimal(100)


def _is_funding_unfavorable(rate: Decimal, side: PositionSide) -> bool:
    """Return True if the funding rate is unfavorable (= cost) for this position.

    On perpetuals:
    - LONG pays when rate > 0 (longs subsidise shorts)
    - SHORT pays when rate < 0 (shorts subsidise longs)
    """
    if side == PositionSide.LONG:
        return rate > Decimal(0)
    if side == PositionSide.SHORT:
        return rate < Decimal(0)
    return False


def _annualise_funding(rate_per_period: Decimal, period_hours: float) -> Decimal:
    """Convert a per-period funding rate to annualised percentage."""
    periods_per_year = Decimal(str(8760 / period_hours))
    return abs(rate_per_period) * periods_per_year * Decimal(100)


class ThresholdChecker:
    def __init__(self, defaults: GlobalDefaults) -> None:
        self._defaults = defaults

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def check_strategy(
        self,
        strategy: StrategyConfig,
        snapshot: StrategySnapshot,
        positions: list[Position],
        *,
        funding_history: dict[tuple[str, str], list[tuple[int, Decimal]]] | None = None,
        prices_history: dict[str, list[tuple[int, Decimal]]] | None = None,
        snapshot_ts: int,
    ) -> list[Alert]:
        """Run all checks for one strategy. Returns list of triggered alerts."""
        alerts: list[Alert] = []
        thresholds = strategy.thresholds

        alerts.extend(self._check_health_factor(strategy, snapshot, snapshot_ts))
        alerts.extend(
            self._check_funding_flips(
                strategy, positions, funding_history or {}, snapshot_ts
            )
        )
        alerts.extend(
            self._check_depeg(
                strategy, positions, prices_history or {}, snapshot_ts
            )
        )
        alerts.extend(self._check_pendle_expiry(strategy, snapshot, snapshot_ts))
        alerts.extend(self._check_drawdown_24h(snapshot, prices_history or {}, snapshot_ts))
        alerts.extend(self._check_delta_deviation(strategy, snapshot, snapshot_ts))

        return alerts

    # ------------------------------------------------------------------
    # Individual checks
    # ------------------------------------------------------------------

    def _check_health_factor(
        self,
        strategy: StrategyConfig,
        snapshot: StrategySnapshot,
        snapshot_ts: int,
    ) -> list[Alert]:
        if not snapshot.has_lending_leg or snapshot.composite_hf is None:
            return []

        thresholds = strategy.thresholds
        hf = snapshot.composite_hf

        def _t(attr: str) -> Decimal:
            """Resolve threshold: strategy override → global default."""
            return (
                getattr(thresholds, attr)
                if thresholds and getattr(thresholds, attr) is not None
                else getattr(self._defaults, attr)
            )

        hf_critical = _t("hf_critical")
        hf_urgent = _t("hf_urgent")
        hf_warning = _t("hf_warning")

        # Find which lending leg(s) for context in message
        lending_labels = [
            f"{p.protocol} {p.market_id or p.asset}"
            for p in snapshot.leg_positions
            if p.health_factor is not None
        ]
        context = lending_labels[0] if lending_labels else strategy.name

        if hf < hf_critical:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.CRITICAL,
                type=AlertType.HF_CRITICAL,
                asset=None,
                message=(
                    f"HF {hf:.3f} (< {hf_critical}) — LIQUIDATION IMMINENTE {context}"
                ),
                payload={"hf": str(hf), "threshold": str(hf_critical)},
                snapshot_ts=snapshot_ts,
            )]

        if hf < hf_urgent:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.URGENT,
                type=AlertType.HF_URGENT,
                asset=None,
                message=(
                    f"HF {hf:.3f} (< {hf_urgent}) — risque liquidation élevé {context}"
                ),
                payload={"hf": str(hf), "threshold": str(hf_urgent)},
                snapshot_ts=snapshot_ts,
            )]

        if hf < hf_warning:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.WARNING,
                type=AlertType.HF_WARNING,
                asset=None,
                message=(
                    f"HF {hf:.3f} (< {hf_warning}) — surveiller {context}"
                ),
                payload={"hf": str(hf), "threshold": str(hf_warning)},
                snapshot_ts=snapshot_ts,
            )]

        return []

    def _check_funding_flips(
        self,
        strategy: StrategyConfig,
        positions: list[Position],
        funding_history: dict[tuple[str, str], list[tuple[int, Decimal]]],
        snapshot_ts: int,
    ) -> list[Alert]:
        thresholds = strategy.thresholds
        n_prints = (
            thresholds.funding_flip_n_prints
            if thresholds and thresholds.funding_flip_n_prints is not None
            else self._defaults.funding_flip_n_prints
        )
        alerts: list[Alert] = []

        perp_positions = [
            p for p in positions
            if p.funding_rate is not None and p.side in (PositionSide.LONG, PositionSide.SHORT)
        ]

        for pos in perp_positions:
            key = (pos.protocol, pos.market_id or pos.asset)
            history = funding_history.get(key, [])

            # Build list of recent rates (most recent first), fallback to current rate
            recent_rates: list[Decimal] = [r for _, r in history]
            if not recent_rates and pos.funding_rate is not None:
                recent_rates = [pos.funding_rate]

            if not recent_rates:
                continue

            # Count consecutive unfavorable prints from the most recent
            consecutive_bad = 0
            for rate in recent_rates:
                if _is_funding_unfavorable(rate, pos.side):
                    consecutive_bad += 1
                else:
                    break

            if consecutive_bad == 0:
                continue

            current_rate = recent_rates[0]
            period_h = pos.funding_period_hours or 1.0
            annualised_pct = _annualise_funding(current_rate, period_h)
            asset_label = pos.asset
            side_label = "long" if pos.side == PositionSide.LONG else "short"

            if consecutive_bad >= n_prints + 1:
                # Material: N+1 prints AND annualised cost meaningful (>5% APR)
                if annualised_pct > Decimal(5):
                    alerts.append(Alert(
                        strategy_id=strategy.id,
                        level=AlertLevel.URGENT,
                        type=AlertType.FUNDING_FLIP_MATERIAL,
                        asset=asset_label,
                        message=(
                            f"Funding défavorable ({consecutive_bad} prints consécutifs) "
                            f"sur {asset_label} {side_label} — coût annualisé ~{annualised_pct:.1f}% "
                            f"({pos.protocol})"
                        ),
                        payload={
                            "consecutive_bad_prints": consecutive_bad,
                            "current_rate": str(current_rate),
                            "annualised_pct": str(annualised_pct),
                            "protocol": pos.protocol,
                            "market_id": pos.market_id,
                        },
                        snapshot_ts=snapshot_ts,
                    ))
                    continue

            if consecutive_bad >= n_prints:
                alerts.append(Alert(
                    strategy_id=strategy.id,
                    level=AlertLevel.WARNING,
                    type=AlertType.FUNDING_FLIP_CONFIRMED,
                    asset=asset_label,
                    message=(
                        f"Funding flip confirmé ({consecutive_bad} prints) "
                        f"sur {asset_label} {side_label} ({pos.protocol})"
                    ),
                    payload={
                        "consecutive_bad_prints": consecutive_bad,
                        "current_rate": str(current_rate),
                        "annualised_pct": str(annualised_pct),
                        "protocol": pos.protocol,
                        "market_id": pos.market_id,
                    },
                    snapshot_ts=snapshot_ts,
                ))
                continue

            # Soft: exactly 1 unfavorable print
            logger.info(
                f"[{strategy.id}] Funding soft flip — {asset_label} {side_label} "
                f"rate={current_rate} ({pos.protocol})"
            )
            alerts.append(Alert(
                strategy_id=strategy.id,
                level=AlertLevel.INFO,
                type=AlertType.FUNDING_FLIP_SOFT,
                asset=asset_label,
                message=(
                    f"Funding légèrement défavorable sur {asset_label} {side_label} "
                    f"(1 print, rate={current_rate:.6f}, {pos.protocol})"
                ),
                payload={
                    "consecutive_bad_prints": consecutive_bad,
                    "current_rate": str(current_rate),
                    "annualised_pct": str(annualised_pct),
                    "protocol": pos.protocol,
                    "market_id": pos.market_id,
                },
                snapshot_ts=snapshot_ts,
            ))

        return alerts

    def _check_depeg(
        self,
        strategy: StrategyConfig,
        positions: list[Position],
        prices_history: dict[str, list[tuple[int, Decimal]]],
        snapshot_ts: int,
    ) -> list[Alert]:
        thresholds = strategy.thresholds
        alerts: list[Alert] = []

        persistence_min = (
            thresholds.depeg_persistence_min
            if thresholds and thresholds.depeg_persistence_min is not None
            else self._defaults.depeg_persistence_min
        )
        persistence_sec = persistence_min * 60

        for pos in positions:
            asset = pos.asset
            price = pos.oracle_price or pos.mark_price
            if price is None:
                continue

            # Determine peg value
            if asset in _STABLE_USD_PEG:
                peg = _STABLE_USD_PEG[asset]
                soft_threshold = _ASSET_DEPEG_SOFT.get(asset, Decimal("0.3"))
                hard_threshold = _ASSET_DEPEG_CONFIRMED.get(asset, Decimal("1.0"))
            elif asset in _GOLD_PEGGED:
                # Need XAU/USD reference from prices_history["XAU"]
                xau_history = prices_history.get("XAU") or prices_history.get("XAU/USD")
                if not xau_history:
                    logger.info(
                        f"[{strategy.id}] Pas de prix XAU disponible pour vérifier le peg de {asset}"
                    )
                    continue
                peg = xau_history[-1][1]  # latest XAU/USD price
                soft_threshold = Decimal("0.5")   # gold-pegged tokens tolerate more drift
                hard_threshold = Decimal("1.5")
            else:
                continue  # not a pegged asset

            deviation_pct = _pct_deviation(price, peg)

            # Check confirmed depeg: deviation > hard threshold AND persistent
            if deviation_pct > hard_threshold:
                # Verify persistence via price history — pass the actual peg
                # (1 USD for stables, XAU spot for gold-pegged tokens) so the
                # persistence check uses the correct reference.
                confirmed = self._is_depeg_persistent(
                    asset, peg, hard_threshold, prices_history, snapshot_ts, persistence_sec
                )
                if confirmed:
                    alerts.append(Alert(
                        strategy_id=strategy.id,
                        level=AlertLevel.URGENT,
                        type=AlertType.DEPEG_CONFIRMED,
                        asset=asset,
                        message=(
                            f"DEPEG CONFIRMÉ {asset} — déviation {deviation_pct:.2f}% "
                            f"(> {hard_threshold}%) depuis >{persistence_min} min "
                            f"(prix: {price:.4f}, peg: {peg:.4f})"
                        ),
                        payload={
                            "price": str(price),
                            "peg": str(peg),
                            "deviation_pct": str(deviation_pct),
                            "threshold_pct": str(hard_threshold),
                        },
                        snapshot_ts=snapshot_ts,
                    ))
                    continue  # skip watch alert if already confirmed

            # Check watch depeg: deviation > soft threshold
            if deviation_pct > soft_threshold:
                alerts.append(Alert(
                    strategy_id=strategy.id,
                    level=AlertLevel.WARNING,
                    type=AlertType.DEPEG_WATCH,
                    asset=asset,
                    message=(
                        f"Dépeg à surveiller {asset} — déviation {deviation_pct:.2f}% "
                        f"(seuil: {soft_threshold}%) — prix: {price:.4f}"
                    ),
                    payload={
                        "price": str(price),
                        "peg": str(peg),
                        "deviation_pct": str(deviation_pct),
                        "threshold_pct": str(soft_threshold),
                    },
                    snapshot_ts=snapshot_ts,
                ))

        return alerts

    def _is_depeg_persistent(
        self,
        asset: str,
        peg: Decimal,
        threshold_pct: Decimal,
        prices_history: dict[str, list[tuple[int, Decimal]]],
        now_ts: int,
        persistence_sec: int,
    ) -> bool:
        """Return True if price has stayed above threshold for the persistence window.

        The `peg` arg is passed explicitly so gold-pegged tokens (PAXG, XAUt)
        compare against the live XAU/USD reference, not against 1 USD.
        """
        history = prices_history.get(asset)
        if not history:
            # No history → can't confirm persistence, treat as unconfirmed
            return False

        cutoff_ts = now_ts - persistence_sec

        relevant = [(ts, p) for ts, p in history if ts >= cutoff_ts]
        if not relevant:
            return False

        return all(_pct_deviation(p, peg) > threshold_pct for _, p in relevant)

    def _check_pendle_expiry(
        self,
        strategy: StrategyConfig,
        snapshot: StrategySnapshot,
        snapshot_ts: int,
    ) -> list[Alert]:
        if not snapshot.has_pt_leg or snapshot.days_to_pendle_expiry is None:
            return []

        thresholds = strategy.thresholds
        days = snapshot.days_to_pendle_expiry

        def _t(attr: str) -> int:
            return (
                getattr(thresholds, attr)
                if thresholds and getattr(thresholds, attr) is not None
                else getattr(self._defaults, attr)
            )

        t_critical = _t("pendle_expiry_critical_days")
        t_urgent = _t("pendle_expiry_urgent_days")
        t_warning = _t("pendle_expiry_warning_days")

        if days < t_critical:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.CRITICAL,
                type=AlertType.PENDLE_EXPIRY_T1,
                asset=None,
                message=(
                    f"PT Pendle expire dans {days}j — rebalancement urgent requis"
                ),
                payload={"days_to_expiry": days},
                snapshot_ts=snapshot_ts,
            )]

        if days < t_urgent:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.URGENT,
                type=AlertType.PENDLE_EXPIRY_T7,
                asset=None,
                message=(
                    f"PT Pendle expire dans {days}j — planifier la sortie"
                ),
                payload={"days_to_expiry": days},
                snapshot_ts=snapshot_ts,
            )]

        if days < t_warning:
            return [Alert(
                strategy_id=strategy.id,
                level=AlertLevel.WARNING,
                type=AlertType.PENDLE_EXPIRY_T30,
                asset=None,
                message=(
                    f"PT Pendle expire dans {days}j — anticiper la rotation"
                ),
                payload={"days_to_expiry": days},
                snapshot_ts=snapshot_ts,
            )]

        return []

    def _check_drawdown_24h(
        self,
        snapshot: StrategySnapshot,
        prices_history: dict[str, list[tuple[int, Decimal]]],
        snapshot_ts: int,
    ) -> list[Alert]:
        """V1: skip if no 24h price history available."""
        if not prices_history:
            logger.info(
                f"[{snapshot.strategy_id}] Pas d'historique prix 24h — "
                "vérification drawdown ignorée"
            )
        return []

    def _check_delta_deviation(
        self,
        strategy: StrategyConfig,
        snapshot: StrategySnapshot,
        snapshot_ts: int,
    ) -> list[Alert]:
        if strategy.type != "delta_neutral":
            return []

        deviation = abs(snapshot.delta_deviation_pct)
        threshold = Decimal("5")  # 5% hardcoded for V1

        if deviation <= threshold:
            return []

        direction = "long" if snapshot.delta_deviation_pct > 0 else "short"
        return [Alert(
            strategy_id=strategy.id,
            level=AlertLevel.WARNING,
            type=AlertType.DELTA_DEVIATION,
            asset=None,
            message=(
                f"Delta déviation {deviation:.2f}% ({direction}) "
                f"— rééquilibrage recommandé (seuil: {threshold}%)"
            ),
            payload={
                "delta_deviation_pct": str(snapshot.delta_deviation_pct),
                "threshold_pct": str(threshold),
                "direction": direction,
            },
            snapshot_ts=snapshot_ts,
        )]
