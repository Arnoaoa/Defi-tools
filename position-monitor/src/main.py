"""Position Monitor — main orchestrator (one cycle per invocation).

Designed to be run by Windows Task Scheduler every 15 min. Each invocation:
  1. Loads config + strategies.yaml
  2. Inits adapters, oracles, DB
  3. For each strategy:
     a. Fetches all leg positions in parallel (with per-leg error isolation)
     b. Fetches prices for all unique assets
     c. Aggregates → StrategySnapshot via StrategyEngine
     d. Runs ThresholdChecker → list of Alert
     e. Filters through AlertDeduper → queues in DB
     f. Persists snapshot
  4. Processes Telegram queue (sends pending alerts)
  5. Updates heartbeat

Error isolation:
  - One protocol down → that leg is skipped, strategy still snapshotted partially
  - One strategy crashes → other strategies still run
  - Telegram send failure → alert stays queued for next cycle
  - Catastrophic failure → exception logged + heartbeat NOT updated (dead-man's switch triggers)
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from decimal import Decimal
from typing import Any

# Load .env early so MONITOR_SSL_VERIFY (and any other startup-time flags) are
# visible before module-level patches run.
from dotenv import load_dotenv

load_dotenv()

# Optional dev escape hatch: disable SSL verify when a local AV / proxy
# intercepts HTTPS connections with its own self-signed certs. Never enable
# in production — set MONITOR_SSL_VERIFY=true (default) on the prod machine.
if os.getenv("MONITOR_SSL_VERIFY", "true").lower() == "false":
    import httpx

    _orig_async_init = httpx.AsyncClient.__init__
    _orig_sync_init = httpx.Client.__init__

    def _async_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("verify", False)
        _orig_async_init(self, *args, **kwargs)

    def _sync_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("verify", False)
        _orig_sync_init(self, *args, **kwargs)

    httpx.AsyncClient.__init__ = _async_init  # type: ignore[method-assign]
    httpx.Client.__init__ = _sync_init  # type: ignore[method-assign]

from loguru import logger  # noqa: E402

from src.adapters import (
    AaveV3Adapter,
    AdapterError,
    ApexOmniAdapter,
    EulerV2Adapter,
    HyperliquidAdapter,
    MorphoAdapter,
    PendleAdapter,
    ProtocolAdapter,
)
from src.alerts import AlertDeduper, ThresholdChecker
from src.alerts.models import Alert, AlertLevel
from src.config import (
    EnvConfig,
    LegConfig,
    ManualPosition,
    StrategiesFile,
    StrategyConfig,
    load_all,
)
from src.models import Position, PositionSide
from src.notifications import TelegramNotifier
from src.oracles import ChainlinkOracle, CoinGeckoOracle, OracleError
from src.portfolio import PortfolioAggregator
from src.storage import Database
from src.strategy_engine import StrategyEngine
from src.adapters.etherscan import EtherscanClient
from src.sync.transactions import TransactionSyncer

CYCLE_TIMEOUT_SEC = 240  # hard ceiling per cycle


# ---------------------------------------------------------------------------
# Adapter factory
# ---------------------------------------------------------------------------


def _build_adapters(
    env: EnvConfig,
    strategies: StrategiesFile,
    *,
    include_all: bool = False,
) -> dict[str, ProtocolAdapter]:
    """Instantiate adapters.

    By default only the protocols referenced in strategies are instantiated.
    When include_all=True (auto-discovery mode), every supported adapter is
    instantiated so any self-wallet can be scanned across the full surface.
    """
    if include_all:
        protocols_used: set[str] = {
            "hyperliquid", "apex_omni", "morpho", "pendle", "aave", "euler",
        }
    else:
        protocols_used = {
            leg.protocol for strategy in strategies.strategies for leg in strategy.legs
        }
    logger.info(f"Adapters needed: {sorted(protocols_used)}")

    factory: dict[str, ProtocolAdapter] = {}

    if "hyperliquid" in protocols_used:
        factory["hyperliquid"] = HyperliquidAdapter()
    if "apex_omni" in protocols_used:
        factory["apex_omni"] = ApexOmniAdapter()
    if "morpho" in protocols_used:
        factory["morpho"] = MorphoAdapter(config={"graph_api_key": env.graph_api_key})
    if "pendle" in protocols_used:
        # Pendle needs RPC URLs per chain
        rpc_map: dict[str, str] = {}
        if strategies.rpc.ethereum:
            rpc_map["ethereum"] = strategies.rpc.ethereum
        if strategies.rpc.arbitrum:
            rpc_map["arbitrum"] = strategies.rpc.arbitrum
        if strategies.rpc.base:
            rpc_map["base"] = strategies.rpc.base
        if strategies.rpc.optimism:
            rpc_map["optimism"] = strategies.rpc.optimism
        factory["pendle"] = PendleAdapter(config={"rpc_urls": rpc_map})
    if "aave" in protocols_used:
        factory["aave"] = AaveV3Adapter(config={"graph_api_key": env.graph_api_key})
    if "euler" in protocols_used:
        # Euler V2 uses Goldsky subgraph (no key required) + optional on-chain
        # lens fallback. Pass the Ethereum RPC URL so the adapter can fall
        # back to AccountLens / VaultLens reads when the subgraph is degraded.
        factory["euler"] = EulerV2Adapter(config={
            "rpc_url_ethereum": strategies.rpc.ethereum,
        })

    return factory


# ---------------------------------------------------------------------------
# Per-strategy position fetching
# ---------------------------------------------------------------------------


def _resolve_leg_address(
    leg: LegConfig, strategies: StrategiesFile
) -> str | None:
    """Resolve a leg's address from wallet_id (new) or wallet/account (legacy)."""
    if leg.wallet_id:
        w = strategies.get_wallet(leg.wallet_id)
        if w is None:
            logger.warning(
                f"leg references unknown wallet_id {leg.wallet_id!r} — skipping"
            )
            return None
        return w.address
    return leg.account or leg.wallet


async def _fetch_leg_positions(
    adapter: ProtocolAdapter,
    leg: LegConfig,
    strategy_id: str,
    strategies: StrategiesFile,
) -> list[Position]:
    """Fetch positions for a single leg with full error isolation."""
    try:
        kwargs: dict[str, Any] = {}
        address = _resolve_leg_address(leg, strategies)
        if leg.chain:
            kwargs["chain"] = leg.chain
        if leg.market_id:
            kwargs["market_id"] = leg.market_id
        if leg.pt_contract:
            kwargs["pt_contracts"] = [leg.pt_contract]

        # Apex Omni Mode B — no positions fetch, compose from config
        if leg.protocol == "apex_omni":
            if not isinstance(adapter, ApexOmniAdapter):
                return []
            if leg.symbol is None or leg.size_native is None:
                logger.warning(
                    f"[{strategy_id}] apex_omni leg missing symbol/size_native — skipping"
                )
                return []
            pos = await adapter.compose_position(
                config={
                    "symbol": leg.symbol,
                    "size_native": leg.size_native,
                    "entry_price": leg.entry_price,
                    "entry_ts": leg.entry_ts,
                },
                wallet=address,
            )
            return [pos] if pos is not None else []

        # Spot leg — no on-chain fetch, just record a stub Position
        if leg.protocol == "spot":
            logger.debug(f"[{strategy_id}] spot leg recorded as config-only (no adapter call)")
            return []

        if address is None:
            logger.warning(
                f"[{strategy_id}] {leg.protocol} leg missing wallet/account — skipping"
            )
            return []

        positions = await adapter.fetch_positions(address=address, **kwargs)
        logger.debug(
            f"[{strategy_id}] {leg.protocol}: fetched {len(positions)} position(s)"
        )
        return positions

    except AdapterError as e:
        logger.warning(f"[{strategy_id}] adapter {leg.protocol} failed: {e}")
        return []
    except Exception as e:  # noqa: BLE001 — catch-all per-leg isolation
        logger.exception(f"[{strategy_id}] unexpected error in {leg.protocol}: {e}")
        return []


# ---------------------------------------------------------------------------
# Price fetching
# ---------------------------------------------------------------------------


_DISCOVERY_STRATEGY_ID = "_discovery"


async def _run_auto_discovery(
    db: Database,
    strategies: StrategiesFile,
    adapters: dict[str, ProtocolAdapter],
    oracles: dict[str, Any],
    portfolio: PortfolioAggregator,
    snapshot_ts: int,
    *,
    already_covered: set[tuple[str, str]],
) -> dict[str, int]:
    """Fetch positions across all configured adapters for every self wallet
    that has auto_discover=true.

    Skips (wallet_id, protocol) pairs already covered by an explicit strategy
    to avoid double counting in the portfolio aggregator.
    """
    stats = {"wallets_scanned": 0, "positions_discovered": 0, "skipped_strategy": 0}

    db_wallets = db.list_wallets(grp="self")
    auto_wallets = [w for w in db_wallets if w.get("auto_discover", 1)]
    if not auto_wallets:
        return stats

    logger.info(
        f"Auto-discovery: scanning {len(auto_wallets)} self wallets across "
        f"{len(adapters)} adapters"
    )

    for w in auto_wallets:
        wallet_id = w["id"]
        address = w["address"]
        wallet_chain = w["chain"]
        stats["wallets_scanned"] += 1

        # Per-adapter scan plan: (protocol_name, list of (chain, extra_kwargs)).
        # Hyperliquid is always tried — same EVM address can be a HL account.
        # Apex Omni Mode B does not query by address, so skip.
        # EVM lending / Pendle: scan every supported chain since the same
        # address is valid across all EVM chains.
        for protocol_name, adapter in adapters.items():
            if (wallet_id, protocol_name) in already_covered:
                stats["skipped_strategy"] += 1
                continue
            if protocol_name == "apex_omni":
                continue

            # Build the list of (chain, output_chain) to scan for this adapter.
            scan_plan: list[tuple[str | None, str]] = []
            if protocol_name == "hyperliquid":
                # No chain kwarg — adapter returns positions tagged chain="hyperliquid"
                scan_plan.append((None, "hyperliquid"))
            elif protocol_name in ("morpho", "aave", "euler", "pendle"):
                chains_to_scan = ["ethereum", "arbitrum", "base", "optimism"]
                if protocol_name == "aave":
                    chains_to_scan += ["avalanche", "polygon", "bsc"]
                for c in chains_to_scan:
                    scan_plan.append((c, c))
            else:
                # Unknown adapter: try with no chain kwarg
                scan_plan.append((None, wallet_chain))

            for chain_kw, output_chain in scan_plan:
                kwargs: dict[str, Any] = {}
                if chain_kw is not None:
                    kwargs["chain"] = chain_kw
                try:
                    positions = await adapter.fetch_positions(address=address, **kwargs)
                except AdapterError as e:
                    logger.debug(
                        f"Auto-discovery {wallet_id}/{protocol_name}/{chain_kw or 'native'}: {e}"
                    )
                    continue
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        f"Auto-discovery {wallet_id}/{protocol_name}/{chain_kw or 'native'} crashed: {e}"
                    )
                    continue

                if not positions:
                    continue

                stats["positions_discovered"] += len(positions)
                logger.info(
                    f"Auto-discovery: {wallet_id} found {len(positions)} position(s) "
                    f"via {protocol_name}/{output_chain}"
                )

                # Persist positions (with a discovery sentinel strategy_id)
                address_lower = address.lower()
                db.insert_positions(
                    _DISCOVERY_STRATEGY_ID,
                    positions,
                    wallet_id_resolver=lambda p: wallet_id  # noqa: B023
                    if (p.wallet or "").lower() == address_lower
                    else None,
                )
                _persist_market_states(db, positions, snapshot_ts)

                # Contribute to portfolio under the discovery output chain
                portfolio.add_wallet_positions(
                    group="self",
                    chain=output_chain,
                    positions=positions,
                )

    if stats["positions_discovered"] > 0:
        logger.info(
            f"Auto-discovery: found {stats['positions_discovered']} positions "
            f"across {stats['wallets_scanned']} wallets "
            f"({stats['skipped_strategy']} skipped — already in strategies)"
        )

    return stats


def _process_manual_positions(
    strategies: StrategiesFile,
    portfolio: PortfolioAggregator,
    oracles: dict[str, Any],
    snapshot_ts: int,
    db: Database | None = None,
) -> None:
    """Build synthetic Position objects for manual_positions, value them via oracles,
    and contribute to the portfolio aggregator (no DB persistence for now).

    DB rows take priority over YAML on ID collision — lets the UI override config.
    """
    from decimal import Decimal as _D

    by_id = {mp.id: mp for mp in strategies.manual_positions}

    if db is not None:
        for row in db.list_manual_positions():
            by_id[row["id"]] = ManualPosition(
                id=row["id"],
                wallet_id=row.get("wallet_id") or "",
                chain=row["chain"],
                protocol=row["protocol"],
                asset=row["asset"],
                side=row["side"],
                size_native=_D(row["size_native"]),
                entry_price=_D(row["entry_price"]) if row.get("entry_price") else None,
                entry_ts=str(row["entry_ts"]) if row.get("entry_ts") is not None else None,
                notes=row.get("notes"),
            )

    for mp in by_id.values():
        w = strategies.get_wallet(mp.wallet_id)
        if w is None:
            logger.warning(
                f"manual_position {mp.id!r} references unknown wallet_id {mp.wallet_id!r}"
            )
            continue

        # Try to value via Chainlink → CoinGecko fallback
        mark = None
        for src in ("chainlink", "coingecko"):
            oracle = oracles.get(src)
            if oracle is None:
                continue
            try:
                import asyncio as _asyncio
                result = _asyncio.get_event_loop().run_until_complete(
                    oracle.fetch(mp.asset)
                )
                mark = result.price
                break
            except Exception:
                continue

        size_usd = (mp.size_native * mark) if mark else None
        try:
            side_enum = PositionSide(mp.side)
        except ValueError:
            side_enum = PositionSide.SPOT

        pos = Position(
            protocol=mp.protocol,
            chain=mp.chain,
            asset=mp.asset,
            side=side_enum,
            size_native=mp.size_native,
            size_usd=size_usd,
            entry_price=mp.entry_price,
            mark_price=mark,
            oracle_price=None,
            health_factor=None,
            liquidation_threshold=None,
            market_id=None,
            funding_rate=None,
            funding_period_hours=None,
            unrealized_pnl_usd=(
                (mark - mp.entry_price) * mp.size_native
                if mark is not None and mp.entry_price is not None
                else None
            ),
            liquidation_price=None,
            pt_expiry_ts=None,
            market_liquidity_usd=None,
            implied_apy=None,
            snapshot_ts=snapshot_ts,
            wallet=w.address,
            raw={"manual": True, "id": mp.id},
        )

        if w.group == "self":
            portfolio.add_wallet_positions(
                group="self", chain=mp.chain, positions=[pos]
            )


def _persist_market_states(
    db: Database, positions: list[Position], snapshot_ts: int
) -> None:
    """Snapshot market state from each perp position into market_states table.

    Required for the funding flip checker to read historical funding rates.
    We derive a MarketState synthetically from each position with a funding_rate set.
    """
    from src.models import MarketState

    seen: set[tuple[str, str]] = set()
    for pos in positions:
        if pos.funding_rate is None or not pos.market_id:
            continue
        key = (pos.protocol, pos.market_id)
        if key in seen:
            continue
        seen.add(key)
        state = MarketState(
            protocol=pos.protocol,
            market_id=pos.market_id,
            mark_price=pos.mark_price,
            oracle_price=pos.oracle_price,
            funding_rate=pos.funding_rate,
            open_interest_usd=None,
            liquidity_usd=pos.market_liquidity_usd,
            snapshot_ts=snapshot_ts,
            raw={},
        )
        db.insert_market_state(state)


async def _fetch_prices_for_assets(
    assets: set[str],
    oracles: dict[str, Any],
) -> dict[str, Decimal]:
    """Fetch USD prices for a set of asset symbols.

    Tries Chainlink first (high confidence, on-chain), falls back to CoinGecko.
    Returns a dict {symbol: usd_price} — missing prices are simply absent.
    """
    if not assets:
        return {}

    prices: dict[str, Decimal] = {}
    chainlink = oracles.get("chainlink")
    coingecko = oracles.get("coingecko")

    for asset in assets:
        # Try Chainlink first
        if chainlink is not None:
            try:
                result = await chainlink.fetch(asset)
                prices[asset] = result.price
                continue
            except OracleError:
                pass

        # Fallback CoinGecko
        if coingecko is not None:
            try:
                result = await coingecko.fetch(asset)
                prices[asset] = result.price
            except OracleError:
                logger.debug(f"No price source for {asset}")

    return prices


# ---------------------------------------------------------------------------
# Per-strategy processing
# ---------------------------------------------------------------------------


async def _process_strategy(
    strategy: StrategyConfig,
    strategies_file: StrategiesFile,
    adapters: dict[str, ProtocolAdapter],
    oracles: dict[str, Any],
    engine: StrategyEngine,
    checker: ThresholdChecker,
    deduper: AlertDeduper,
    db: Database,
    snapshot_ts: int,
    portfolio: PortfolioAggregator,
) -> dict[str, int]:
    """Process one strategy end-to-end. Returns stats {fetched, alerts_raised, alerts_kept}."""
    stats = {"fetched": 0, "alerts_raised": 0, "alerts_kept": 0}

    # 1. Fetch positions for every leg in parallel
    leg_tasks = [
        _fetch_leg_positions(adapters[leg.protocol], leg, strategy.id, strategies_file)
        for leg in strategy.legs
        if leg.protocol in adapters
    ]
    if not leg_tasks:
        logger.warning(f"[{strategy.id}] no adapter available — skipping")
        return stats

    leg_results = await asyncio.gather(*leg_tasks, return_exceptions=False)
    all_positions: list[Position] = [p for legs in leg_results for p in legs]
    stats["fetched"] = len(all_positions)

    # 2. Determine assets needing prices (legs without size_usd)
    assets_needing_prices = {
        p.asset for p in all_positions if p.size_usd is None and p.asset
    }
    prices = await _fetch_prices_for_assets(assets_needing_prices, oracles)

    # 3. Compute composite snapshot
    snapshot = engine.compute_snapshot(strategy, all_positions, prices=prices, db=db)

    # 4. Persist positions + market_states (needed for funding history) + snapshot.
    # Resolve wallet_id by matching position.wallet to strategies_file wallets.
    address_to_wallet_id: dict[str, str] = {
        w.address.lower(): w.id for w in strategies_file.wallets
    }

    def _resolve_wallet_id(p: Position) -> str | None:
        if p.wallet:
            return address_to_wallet_id.get(p.wallet.lower())
        return None

    db.insert_positions(
        strategy.id, all_positions, wallet_id_resolver=_resolve_wallet_id
    )
    _persist_market_states(db, all_positions, snapshot_ts)
    db.insert_strategy_snapshot(snapshot)

    # 4b. Contribute leg positions to the portfolio aggregator. Only 'self'
    # wallets count. We group by chain since the aggregator key is (group, chain, category).
    for pos in all_positions:
        if not pos.wallet:
            continue
        wid = address_to_wallet_id.get(pos.wallet.lower())
        if wid is None:
            continue
        w = strategies_file.get_wallet(wid)
        if w is None or w.group != "self":
            continue
        portfolio.add_wallet_positions(
            group=w.group,
            chain=pos.chain,
            positions=[pos],
        )

    # 5. Build funding history map for threshold checks (last 5 prints per perp)
    funding_history: dict[tuple[str, str], list[tuple[int, Decimal]]] = {}
    for pos in all_positions:
        if pos.funding_rate is not None and pos.market_id:
            key = (pos.protocol, pos.market_id)
            funding_history[key] = db.get_last_n_funding(
                protocol=pos.protocol, market_id=pos.market_id, n=5
            )

    # 6. Run threshold checks
    raw_alerts = checker.check_strategy(
        strategy,
        snapshot,
        all_positions,
        funding_history=funding_history,
        prices_history=None,  # V1 cold start: no history yet
        snapshot_ts=snapshot_ts,
    )
    stats["alerts_raised"] = len(raw_alerts)

    # 7. Dedup
    kept_alerts = deduper.filter(raw_alerts)
    stats["alerts_kept"] = len(kept_alerts)

    # 8. Persist kept alerts in queue (sent_at = NULL)
    for alert in kept_alerts:
        db.insert_alert(
            snapshot_ts=alert.snapshot_ts,
            strategy_id=alert.strategy_id,
            level=alert.level.value,
            type_=alert.type.value,
            message=alert.message,
            asset=alert.asset,
            payload=alert.payload,
        )

    if stats["alerts_kept"] > 0:
        logger.info(
            f"[{strategy.id}] {stats['fetched']} positions, "
            f"{stats['alerts_raised']} raw alerts → {stats['alerts_kept']} queued"
        )

    return stats


# ---------------------------------------------------------------------------
# Cycle orchestration
# ---------------------------------------------------------------------------


async def _run_transaction_sync(
    syncer: TransactionSyncer,
    etherscan_client: EtherscanClient,
) -> dict:
    """Run transaction sync and close the Etherscan client when done."""
    try:
        return await syncer.sync_all_wallets()
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"Transaction sync failed: {exc}")
        return {}
    finally:
        await etherscan_client.aclose()


async def run_cycle(env: EnvConfig, strategies: StrategiesFile) -> dict[str, Any]:
    """Run one complete monitor cycle."""
    cycle_start = time.monotonic()
    snapshot_ts = int(time.time())
    errors_count = 0

    logger.info(f"=== Cycle start ts={snapshot_ts} ===")

    # Init DB
    db = Database(env.monitor_db_path)

    # Init adapters. When any self wallet has auto_discover=true we instantiate
    # the full adapter surface so the discovery loop can scan everything.
    db_pre = Database(env.monitor_db_path)
    has_auto_discover_wallet = any(
        bool(w.get("auto_discover", 1))
        for w in db_pre.list_wallets(grp="self")
    )
    db_pre.close()
    adapters = _build_adapters(env, strategies, include_all=has_auto_discover_wallet)

    # Init oracles
    oracles: dict[str, Any] = {}
    if strategies.rpc.ethereum:
        oracles["chainlink"] = ChainlinkOracle(rpc_url=strategies.rpc.ethereum)
    oracles["coingecko"] = CoinGeckoOracle(api_key=env.coingecko_api_key or None)

    # Init engine + checker + deduper
    engine = StrategyEngine()
    checker = ThresholdChecker(strategies.defaults)
    deduper = AlertDeduper(db, window_minutes=30)

    # Init Telegram
    telegram = TelegramNotifier(
        token=env.telegram_bot_token, chat_id=env.telegram_chat_id
    )

    cycle_stats = {
        "strategies": 0,
        "positions_fetched": 0,
        "alerts_raised": 0,
        "alerts_kept": 0,
        "telegram": {"sent": 0, "failed": 0, "skipped": 0},
        "portfolio_cells": 0,
        "discovery_positions": 0,
    }

    # Sync wallets from YAML to the DB registry (preserves auto_discover from DB
    # if the wallet is already there — YAML doesn't override the runtime flag).
    for w in strategies.wallets:
        existing = db.get_wallet(w.id)
        auto = bool(existing.get("auto_discover", 1)) if existing else True
        db.upsert_wallet(
            id=w.id,
            label=w.label,
            address=w.address,
            chain=w.chain,
            grp=w.group,
            notes=w.notes,
            auto_discover=auto,
        )

    # Portfolio aggregator built up as strategies are processed.
    portfolio = PortfolioAggregator(snapshot_ts=snapshot_ts)

    # Track (wallet_id, protocol) pairs explicitly handled by strategies, so the
    # discovery loop skips them.
    strategy_covered: set[tuple[str, str]] = set()
    for strat in strategies.strategies:
        for leg in strat.legs:
            if leg.wallet_id and leg.protocol:
                strategy_covered.add((leg.wallet_id, leg.protocol))

    # Process each strategy with isolation
    for strategy in strategies.strategies:
        try:
            stats = await _process_strategy(
                strategy, strategies, adapters, oracles, engine, checker,
                deduper, db, snapshot_ts, portfolio,
            )
            cycle_stats["strategies"] += 1
            cycle_stats["positions_fetched"] += stats["fetched"]
            cycle_stats["alerts_raised"] += stats["alerts_raised"]
            cycle_stats["alerts_kept"] += stats["alerts_kept"]
        except Exception as e:  # noqa: BLE001
            errors_count += 1
            logger.exception(f"Strategy {strategy.id} crashed: {e}")

    # Auto-discovery loop: fetch positions for self wallets via every adapter
    # not already covered by an explicit strategy.
    try:
        discovery_stats = await _run_auto_discovery(
            db, strategies, adapters, oracles, portfolio, snapshot_ts,
            already_covered=strategy_covered,
        )
        cycle_stats["discovery_positions"] = discovery_stats["positions_discovered"]
    except Exception as e:  # noqa: BLE001
        logger.exception(f"Auto-discovery failed: {e}")
        errors_count += 1

    # Process manual_positions — YAML + DB merged (DB wins on ID collision)
    _process_manual_positions(strategies, portfolio, oracles, snapshot_ts, db)

    # Persist portfolio snapshot
    try:
        rows = portfolio.as_storage_rows(group="self")
        db.insert_portfolio_snapshots(rows)
        cycle_stats["portfolio_cells"] = len(rows)
        from src.portfolio.aggregator import log_summary
        log_summary(portfolio)
    except Exception as e:  # noqa: BLE001
        logger.exception(f"Portfolio snapshot failed: {e}")
        errors_count += 1

    # Process Telegram queue (or stub-mark as sent)
    try:
        tg_stats = await telegram.process_queue(db, max_per_cycle=20)
        cycle_stats["telegram"] = tg_stats
    except Exception as e:  # noqa: BLE001
        errors_count += 1
        logger.exception(f"Telegram queue processing failed: {e}")

    # Transaction sync (incremental on repeated cycles, full history on first run).
    # Launched as a background task so it doesn't block the cycle on initial sync.
    tx_sync_task: asyncio.Task | None = None
    if env.etherscan_api_key:
        etherscan_client = EtherscanClient(api_key=env.etherscan_api_key)
        syncer = TransactionSyncer(db, etherscan_client)
        tx_sync_task = asyncio.create_task(_run_transaction_sync(syncer, etherscan_client))
    else:
        logger.debug("ETHERSCAN_API_KEY not set — skipping transaction sync")

    # Close adapters
    for adapter in adapters.values():
        try:
            await adapter.aclose()
        except Exception:  # noqa: BLE001
            pass

    # If the tx sync finished already (incremental run), collect stats; otherwise let it run.
    if tx_sync_task is not None and tx_sync_task.done():
        try:
            tx_stats = tx_sync_task.result()
            cycle_stats["tx_inserted"] = tx_stats.get("total_inserted", 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Transaction sync task failed: {exc}")

    # Update heartbeat
    duration_ms = int((time.monotonic() - cycle_start) * 1000)
    db.update_heartbeat(
        last_cycle_ts=snapshot_ts,
        cycle_duration_ms=duration_ms,
        cycle_errors=errors_count,
        last_cycle_log=(
            f"strategies={cycle_stats['strategies']} "
            f"positions={cycle_stats['positions_fetched']} "
            f"alerts_kept={cycle_stats['alerts_kept']} "
            f"tg_sent={cycle_stats['telegram'].get('sent', 0)}"
        ),
    )

    db.close()

    logger.info(
        f"=== Cycle done in {duration_ms}ms — strategies={cycle_stats['strategies']}, "
        f"positions={cycle_stats['positions_fetched']}, "
        f"discovery={cycle_stats['discovery_positions']}, "
        f"alerts_kept={cycle_stats['alerts_kept']}, "
        f"tg_sent={cycle_stats['telegram'].get('sent', 0)}, "
        f"errors={errors_count} ==="
    )

    return cycle_stats


def _setup_logging(level: str = "INFO") -> None:
    """Configure loguru: stdout + rotating file."""
    logger.remove()
    logger.add(
        sys.stderr,
        level=level,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | {message}",
    )
    logger.add(
        "data/monitor.log",
        rotation="10 MB",
        retention="7 days",
        level=level,
        encoding="utf-8",
    )


async def _main_async() -> int:
    try:
        env, strategies = load_all()
    except FileNotFoundError as e:
        logger.error(str(e))
        return 2
    except Exception as e:  # noqa: BLE001
        logger.exception(f"Config load failed: {e}")
        return 2

    _setup_logging(env.monitor_log_level)

    try:
        await asyncio.wait_for(run_cycle(env, strategies), timeout=CYCLE_TIMEOUT_SEC)
        return 0
    except asyncio.TimeoutError:
        logger.error(f"Cycle exceeded {CYCLE_TIMEOUT_SEC}s timeout — aborting")
        return 3
    except Exception as e:  # noqa: BLE001
        logger.exception(f"Cycle failed catastrophically: {e}")
        return 1


def main() -> int:
    return asyncio.run(_main_async())


if __name__ == "__main__":
    sys.exit(main())
