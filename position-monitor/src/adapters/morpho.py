"""Morpho Blue adapter — read-only via the official GraphQL API.

Endpoint: https://api.morpho.org/graphql

Morpho Blue uses isolated markets (one LLTV per market). Each market is
identified by a hex marketId. The API exposes both market positions
(supply/borrow on Blue markets) and vault positions (MetaMorpho aggregators).

Two Position objects are emitted per market: one COLLATERAL leg, one DEBT leg.
Vault positions are emitted as a single SPOT leg.

Market metadata is cached for 5 minutes to avoid re-querying on every cycle.
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

import httpx
from gql import Client, gql
from gql.transport.httpx import HTTPXAsyncTransport
from loguru import logger

from src.adapters.base import (
    AdapterError,
    AdapterNotFound,
    AdapterTimeout,
    ProtocolAdapter,
)
from src.models import MarketState, Position, PositionSide

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PRIMARY_URL = "https://api.morpho.org/graphql"

DEFAULT_TIMEOUT = 5.0
MARKET_CACHE_TTL = 300  # 5 minutes

# LLTV is expressed in WAD (1e18 = 100%)
WAD = Decimal("1000000000000000000")  # 1e18

SUPPORTED_CHAINS: dict[str, int] = {
    "ethereum": 1,
    "base": 8453,
}

# ---------------------------------------------------------------------------
# GraphQL queries
# ---------------------------------------------------------------------------

# Fetch all Morpho Blue positions for a wallet (primary API).
# Schema updated 2026-06-04: uniqueKey -> marketId, oracleAddress -> oracle{address},
# MarketPosition exposes healthFactor directly + state{collateral,borrowAssets,...}.
_POSITIONS_QUERY = gql("""
query MorphoPositions($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    marketPositions {
      healthFactor
      priceVariationToLiquidationPrice
      state {
        collateral
        collateralUsd
        borrowAssets
        borrowAssetsUsd
        borrowShares
        supplyAssets
        supplyAssetsUsd
      }
      market {
        marketId
        lltv
        oracle {
          address
        }
        loanAsset {
          address
          symbol
          decimals
        }
        collateralAsset {
          address
          symbol
          decimals
        }
        state {
          supplyApy
          borrowApy
          supplyAssets
          borrowAssets
          price
        }
      }
    }
    vaultPositions {
      state {
        assets
        assetsUsd
        shares
        pnl
        pnlUsd
        roe
      }
      vault {
        address
        symbol
        name
        asset {
          address
          symbol
          decimals
        }
      }
    }
  }
}
""")

# Fetch a single market state (primary API)
_MARKET_QUERY = gql("""
query MorphoMarket($marketId: String!, $chainId: Int!) {
  marketById(marketId: $marketId, chainId: $chainId) {
    marketId
    lltv
    oracle {
      address
    }
    loanAsset {
      address
      symbol
      decimals
    }
    collateralAsset {
      address
      symbol
      decimals
    }
    state {
      supplyApy
      borrowApy
      supplyAssets
      borrowAssets
      price
    }
  }
}
""")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _d(value: Any) -> Decimal | None:
    """Convert API value to Decimal, returning None for empty/invalid."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Market metadata cache entry
# ---------------------------------------------------------------------------


class _MarketMeta:
    """Cached market metadata for a single market."""

    __slots__ = ("data", "cached_at")

    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.cached_at = int(time.time())

    def is_fresh(self, ttl: int = MARKET_CACHE_TTL) -> bool:
        return (int(time.time()) - self.cached_at) < ttl


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class MorphoAdapter(ProtocolAdapter):
    """Adapter for Morpho Blue isolated lending markets."""

    name = "morpho"
    supports_lending = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._timeout = self.config.get("timeout", DEFAULT_TIMEOUT)
        self._client: Client | None = None
        self._market_cache: dict[str, _MarketMeta] = {}

    def _get_client(self) -> Client:
        if self._client is None:
            transport = HTTPXAsyncTransport(url=_PRIMARY_URL, timeout=self._timeout)
            self._client = Client(transport=transport, fetch_schema_from_transport=False)
        return self._client

    async def _query(self, document: Any, variables: dict[str, Any]) -> dict[str, Any]:
        client = self._get_client()
        try:
            async with client as session:
                result = await session.execute(document, variable_values=variables)
            return result  # type: ignore[return-value]
        except httpx.TimeoutException as e:
            raise AdapterTimeout("Morpho API timeout") from e
        except Exception as e:
            raise AdapterError(f"Morpho API error: {e}") from e

    # ------------------------------------------------------------------
    # Market metadata cache
    # ------------------------------------------------------------------

    def _cache_market(self, market_id: str, data: dict[str, Any]) -> None:
        self._market_cache[market_id.lower()] = _MarketMeta(data)

    def _get_cached_market(self, market_id: str) -> dict[str, Any] | None:
        entry = self._market_cache.get(market_id.lower())
        if entry and entry.is_fresh():
            return entry.data
        return None

    # ------------------------------------------------------------------
    # Position parsing helpers
    # ------------------------------------------------------------------

    def _positions_from_primary(
        self, data: dict[str, Any], address: str, chain: str, ts: int
    ) -> list[Position]:
        user = data.get("userByAddress")
        if not user:
            return []

        positions: list[Position] = []

        # --- Market positions (Morpho Blue lending markets) ---
        for mp in user.get("marketPositions", []) or []:
            market = mp.get("market") or {}
            pos_state = mp.get("state") or {}
            market_id = market.get("marketId", "")

            collateral_raw = _d(pos_state.get("collateral")) or Decimal(0)
            borrow_assets = _d(pos_state.get("borrowAssets")) or Decimal(0)
            collateral_usd = _d(pos_state.get("collateralUsd"))
            borrow_usd = _d(pos_state.get("borrowAssetsUsd"))

            # Skip fully closed positions
            if collateral_raw == 0 and borrow_assets == 0:
                continue

            lltv_raw = _d(market.get("lltv")) or Decimal(0)
            market_state = market.get("state") or {}
            oracle_price = _d(market_state.get("price"))

            # HF is now provided directly by the API (no need to recompute)
            hf = _d(mp.get("healthFactor"))

            # Cache market metadata for future cycles
            self._cache_market(market_id, market)

            collateral_asset = market.get("collateralAsset") or {}
            loan_asset = market.get("loanAsset") or {}
            collateral_symbol = collateral_asset.get("symbol", "UNKNOWN")
            loan_symbol = loan_asset.get("symbol", "UNKNOWN")

            legs = _build_position_legs(
                protocol=self.name,
                chain=chain,
                unique_key=market_id,
                collateral_raw=collateral_raw,
                borrow_assets=borrow_assets,
                collateral_symbol=collateral_symbol,
                loan_symbol=loan_symbol,
                lltv_raw=lltv_raw,
                oracle_price=oracle_price,
                hf=hf,
                address=address,
                ts=ts,
                raw_market=market,
                raw_position=mp,
                collateral_usd=collateral_usd,
                borrow_usd=borrow_usd,
            )
            positions.extend(legs)

        # --- Vault positions (MetaMorpho / Centora-style aggregators) ---
        for vp in user.get("vaultPositions", []) or []:
            vault = vp.get("vault") or {}
            vp_state = vp.get("state") or {}

            shares = _d(vp_state.get("shares")) or Decimal(0)
            assets_raw = _d(vp_state.get("assets")) or Decimal(0)
            assets_usd = _d(vp_state.get("assetsUsd"))

            if shares == 0 and assets_raw == 0:
                continue

            asset = vault.get("asset") or {}
            asset_symbol = asset.get("symbol") or vault.get("symbol") or "UNKNOWN"
            vault_address = vault.get("address", "")

            positions.append(
                Position(
                    protocol=self.name,
                    chain=chain,
                    asset=asset_symbol,
                    side=PositionSide.SPOT,
                    size_native=assets_raw,
                    size_usd=assets_usd,
                    entry_price=None,
                    mark_price=None,
                    oracle_price=None,
                    health_factor=None,
                    liquidation_threshold=None,
                    market_id=f"vault:{vault_address}",
                    funding_rate=None,
                    funding_period_hours=None,
                    unrealized_pnl_usd=_d(vp_state.get("pnlUsd")),
                    liquidation_price=None,
                    pt_expiry_ts=None,
                    market_liquidity_usd=None,
                    implied_apy=None,
                    snapshot_ts=ts,
                    wallet=address,
                    raw={"vault": vault, "position": vp, "kind": "morpho_vault"},
                )
            )

        return positions

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def fetch_positions(
        self, *, address: str, chain: str = "ethereum", **kwargs: Any
    ) -> list[Position]:
        """Fetch all open Morpho positions (markets + vaults) for a wallet."""
        if chain not in SUPPORTED_CHAINS:
            raise AdapterError(f"Morpho: unsupported chain '{chain}'")

        ts = int(time.time())
        data = await self._query(
            _POSITIONS_QUERY,
            {"address": address.lower(), "chainId": SUPPORTED_CHAINS[chain]},
        )
        positions = self._positions_from_primary(data, address, chain, ts)

        logger.debug(
            f"Morpho: {len(positions)} position legs for "
            f"{address[:8]}...{address[-4:]} on {chain}"
        )
        return positions

    async def fetch_market_state(
        self, *, market_id: str, chain: str = "ethereum", **kwargs: Any
    ) -> MarketState:
        """Fetch live state for a single Morpho Blue market by its marketId."""
        ts = int(time.time())
        cached = self._get_cached_market(market_id)
        if cached:
            return _market_state_from_raw(cached, market_id, ts, self.name)

        data = await self._query(
            _MARKET_QUERY,
            {"marketId": market_id, "chainId": SUPPORTED_CHAINS.get(chain, 1)},
        )
        raw = data.get("marketById")
        if not raw:
            raise AdapterNotFound(f"Morpho: market '{market_id}' not found")

        self._cache_market(market_id, raw)
        return _market_state_from_raw(raw, market_id, ts, self.name)

    async def healthcheck(self) -> bool:
        try:
            await self._query(gql("{ __typename }"), {})
            return True
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        # gql Client does not hold a persistent connection in async-with pattern
        pass


# ---------------------------------------------------------------------------
# Module-level helpers (keep adapter class clean)
# ---------------------------------------------------------------------------


def _build_position_legs(
    *,
    protocol: str,
    chain: str,
    unique_key: str,
    collateral_raw: Decimal,
    borrow_assets: Decimal,
    collateral_symbol: str,
    loan_symbol: str,
    lltv_raw: Decimal,
    oracle_price: Decimal | None,
    hf: Decimal | None,
    address: str,
    ts: int,
    raw_market: dict[str, Any],
    raw_position: dict[str, Any],
    collateral_usd: Decimal | None = None,
    borrow_usd: Decimal | None = None,
) -> list[Position]:
    """Emit up to two Position objects (COLLATERAL + DEBT) for a market."""
    lltv_normalised = lltv_raw / WAD if lltv_raw else None
    legs: list[Position] = []

    if collateral_raw > 0:
        legs.append(
            Position(
                protocol=protocol,
                chain=chain,
                asset=collateral_symbol,
                side=PositionSide.COLLATERAL,
                size_native=collateral_raw,
                size_usd=collateral_usd,
                entry_price=None,
                mark_price=None,
                oracle_price=oracle_price,
                health_factor=hf,
                liquidation_threshold=lltv_normalised,
                market_id=unique_key,
                funding_rate=None,
                funding_period_hours=None,
                unrealized_pnl_usd=None,
                liquidation_price=None,
                pt_expiry_ts=None,
                market_liquidity_usd=None,
                implied_apy=None,
                snapshot_ts=ts,
                wallet=address,
                raw={"market": raw_market, "position": raw_position},
            )
        )

    if borrow_assets > 0:
        legs.append(
            Position(
                protocol=protocol,
                chain=chain,
                asset=loan_symbol,
                side=PositionSide.DEBT,
                size_native=borrow_assets,
                size_usd=borrow_usd,
                entry_price=None,
                mark_price=None,
                oracle_price=oracle_price,
                health_factor=hf,
                liquidation_threshold=lltv_normalised,
                market_id=unique_key,
                funding_rate=None,
                funding_period_hours=None,
                unrealized_pnl_usd=None,
                liquidation_price=None,
                pt_expiry_ts=None,
                market_liquidity_usd=None,
                implied_apy=None,
                snapshot_ts=ts,
                wallet=address,
                raw={"market": raw_market, "position": raw_position},
            )
        )

    return legs


def _market_state_from_raw(
    raw: dict[str, Any], market_id: str, ts: int, protocol: str
) -> MarketState:
    """Convert a raw market dict (primary or subgraph) to MarketState."""
    state = raw.get("state") or {}
    borrow_apy = _d(state.get("borrowApy"))
    # New API: supplyAssets / borrowAssets (was totalSupplyAssets / totalBorrowAssets)
    total_supply = _d(state.get("supplyAssets")) or _d(state.get("totalSupplyAssets"))
    total_borrow = _d(state.get("borrowAssets")) or _d(state.get("totalBorrowAssets"))
    oracle_price = _d(state.get("price"))

    # Use borrow APY as the "funding rate" analogue for lending protocols
    return MarketState(
        protocol=protocol,
        market_id=market_id,
        mark_price=None,
        oracle_price=oracle_price,
        funding_rate=borrow_apy,
        open_interest_usd=total_borrow,
        liquidity_usd=total_supply,
        snapshot_ts=ts,
        raw=raw,
    )
