"""Aave V3 adapter — read-only via The Graph subgraphs + official Aave API.

Data sources:
  - User positions  : The Graph decentralized network (per-chain subgraphs)
  - Market state    : The Graph decentralized network
  - Fallback pricing: Aave official API (https://api.v3.aave.com/graphql)

Subgraph IDs (The Graph decentralized network, source: aave/protocol-subgraphs):
  Ethereum : Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g
  Arbitrum : DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B
  Base     : GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF
  Optimism : DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb
  Avalanche: 2h9woxy8RTjHu1HJsCEnmzpPHFArU33avmUh4f71JpVn
  Polygon  : Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211
  BSC      : 7Jk85XgkV1MQ7u56hD8rr65rfASbayJXopugWkUoBMnZ

The Graph decentralized network requires an API key.
Set GRAPH_API_KEY in your environment (or pass via config["graph_api_key"]).
Without it, requests will be rejected. Get a key at https://thegraph.com/studio/.

Health Factor formula (pool-level, NOT isolation mode):
  HF = Σ(collateral_i * LT_i * price_i) / Σ(debt_i * price_i)
  where LT_i = reserveLiquidationThreshold / 10_000 (basis points)

eMode / Isolation mode caveats:
  - eMode: when a user is in an efficiency mode category, the effective LT is
    the *eMode* LT (not per-asset LT). This adapter reads the per-asset LT from
    the subgraph (reserveLiquidationThreshold), which matches Aave UI in standard
    mode. If the user has eModeCategoryId != 0, the displayed HF may differ
    slightly from Aave's on-chain value. TODO: fetch eMode LT from User entity.
  - Isolation mode: assets with debtCeiling > 0 can only be used as sole
    collateral, with borrowing restricted to stablecoins. This adapter computes
    HF identically — the constraint is enforced by Aave's contracts, not here.
  - Stable debt: deprecated in Aave V3.2+. currentTotalDebt already aggregates
    variable + stable. currentStableDebt included for completeness but stable
    borrow rate is irrelevant for HF.

Rate limits (The Graph gateway): no documented hard limit; stay under 100 req/min.
"""
from __future__ import annotations

import os
import time
from decimal import Decimal
from typing import Any

import httpx
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

DEFAULT_TIMEOUT = 15.0
ASSET_CACHE_TTL = 300  # 5 min — LT and decimals are stable between governance votes

# The Graph gateway base — requires API key in the path
_GRAPH_GATEWAY = "https://gateway.thegraph.com/api/{api_key}/subgraphs/id/{subgraph_id}"

# Subgraph IDs per chain (The Graph decentralized network)
_SUBGRAPH_IDS: dict[str, str] = {
    "ethereum": "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g",
    "arbitrum": "DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B",
    # NOTE: base subgraph ID below appears truncated (44 chars vs 46 elsewhere)
    # and returns "subgraph not found". TODO: locate the correct ID via
    # https://thegraph.com/explorer (Aave V3 Base subgraph) and re-enable.
    # "base": "GQFbb95cE6d8mV989mL5figjaGaKCAQB3xqYrr1bRyXqF",
    "optimism": "DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb",
    "avalanche": "2h9woxy8RTjHu1HJsCEnmzpPHFArU33avmUh4f71JpVn",
    "polygon": "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211",
    "bsc": "7Jk85XgkV1MQ7u56hD8rr65rfASbayJXopugWkUoBMnZ",
}

SUPPORTED_CHAINS = set(_SUBGRAPH_IDS.keys())

# Ray = 1e27 — Aave stores rates as rays (liquidityRate, variableBorrowRate)
_RAY = Decimal("1e27")
# Basis points divisor — LT stored as integers (e.g. 8250 = 82.5%)
_BPS = Decimal("10000")

# ---------------------------------------------------------------------------
# GraphQL queries
# ---------------------------------------------------------------------------

_QUERY_USER_RESERVES = """
query UserReserves($user: String!) {
  userReserves(
    where: { user: $user, currentATokenBalance_gt: "0" }
    first: 100
  ) {
    usageAsCollateralEnabledOnUser
    currentATokenBalance
    currentVariableDebt
    currentStableDebt
    currentTotalDebt
    reserve {
      id
      symbol
      decimals
      reserveLiquidationThreshold
      baseLTVasCollateral
      usageAsCollateralEnabled
      liquidityRate
      variableBorrowRate
      totalLiquidity
      totalCurrentVariableDebt
      totalPrincipalStableDebt
      price {
        priceInEth
      }
    }
  }
  _meta {
    block {
      number
    }
  }
}
"""

# Separate query for users who only have debt (no aToken balance above 0)
# We also fetch debt-only positions via a dedicated query.
_QUERY_USER_DEBT = """
query UserDebt($user: String!) {
  userReserves(
    where: { user: $user, currentTotalDebt_gt: "0" }
    first: 100
  ) {
    usageAsCollateralEnabledOnUser
    currentATokenBalance
    currentVariableDebt
    currentStableDebt
    currentTotalDebt
    reserve {
      id
      symbol
      decimals
      reserveLiquidationThreshold
      baseLTVasCollateral
      usageAsCollateralEnabled
      liquidityRate
      variableBorrowRate
      totalLiquidity
      totalCurrentVariableDebt
      totalPrincipalStableDebt
      price {
        priceInEth
      }
    }
  }
}
"""

_QUERY_ETH_USD_PRICE = """
query EthPrice {
  priceOracle(id: "1") {
    usdPriceEth
  }
}
"""

_QUERY_RESERVE = """
query Reserve($id: String!) {
  reserve(id: $id) {
    id
    symbol
    decimals
    reserveLiquidationThreshold
    baseLTVasCollateral
    usageAsCollateralEnabled
    liquidityRate
    variableBorrowRate
    totalLiquidity
    totalCurrentVariableDebt
    totalPrincipalStableDebt
    price {
      priceInEth
    }
  }
}
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _d(value: Any) -> Decimal | None:
    """Convert any value to Decimal, returning None on failure."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _ray_to_apy(ray_rate: Decimal) -> Decimal:
    """Convert Aave ray rate to approximate APY.

    Aave stores rates as per-second in ray (1e27).
    APY = (1 + rate/ray)^(seconds_per_year) - 1
    Approximation: APY ≈ rate / ray  (valid for small rates, <0.5% error at 20% APY)
    """
    if ray_rate == 0:
        return Decimal(0)
    # More accurate: (1 + rate/ray)^31536000 - 1
    # Using float for the exponentiation — acceptable for display purposes
    rate_per_second = float(ray_rate / _RAY)
    try:
        apy = Decimal(str((1 + rate_per_second) ** 31_536_000 - 1))
    except (OverflowError, ValueError):
        apy = ray_rate / _RAY  # fallback to linear approximation
    return apy


def _to_human(raw_amount: Decimal, decimals: int) -> Decimal:
    """Convert raw token amount (integer, no decimals) to human-readable."""
    return raw_amount / Decimal(10**decimals)


def _eth_to_usd(amount_eth: Decimal, eth_usd_price: Decimal) -> Decimal:
    """Convert an ETH-denominated amount to USD."""
    return amount_eth * eth_usd_price


class _AssetParams:
    """Cached per-asset parameters fetched from the subgraph."""

    __slots__ = ("symbol", "decimals", "lt_bps", "fetched_at")

    def __init__(self, symbol: str, decimals: int, lt_bps: int) -> None:
        self.symbol = symbol
        self.decimals = decimals
        self.lt_bps = lt_bps  # e.g. 8250 for 82.5%
        self.fetched_at = int(time.time())

    def is_stale(self) -> bool:
        return int(time.time()) - self.fetched_at > ASSET_CACHE_TTL


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------

class AaveV3Adapter(ProtocolAdapter):
    """Aave V3 multi-chain lending adapter.

    Fetches user collateral + debt positions from The Graph subgraphs.
    Computes the account-level health factor (HF) using per-asset LT.

    config keys:
      graph_api_key (str)  : The Graph API key (or set GRAPH_API_KEY env var)
      timeout (float)      : HTTP timeout in seconds (default 15)
    """

    name = "aave_v3"
    supports_lending = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._api_key: str = (
            self.config.get("graph_api_key")
            or os.environ.get("GRAPH_API_KEY")
            or ""
        )
        if not self._api_key:
            logger.warning(
                "AaveV3Adapter: no GRAPH_API_KEY set — subgraph queries will fail. "
                "Get a key at https://thegraph.com/studio/"
            )

        timeout = self.config.get("timeout", DEFAULT_TIMEOUT)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"Content-Type": "application/json"},
        )

        # Cache: chain → { reserve_id → _AssetParams }
        self._asset_cache: dict[str, dict[str, _AssetParams]] = {}

    # ------------------------------------------------------------------
    # Internal: subgraph URL + query execution
    # ------------------------------------------------------------------

    def _subgraph_url(self, chain: str) -> str:
        chain = chain.lower()
        if chain not in _SUBGRAPH_IDS:
            raise AdapterError(
                f"AaveV3: unsupported chain '{chain}'. "
                f"Supported: {sorted(SUPPORTED_CHAINS)}"
            )
        subgraph_id = _SUBGRAPH_IDS[chain]
        return _GRAPH_GATEWAY.format(
            api_key=self._api_key, subgraph_id=subgraph_id
        )

    async def _query(
        self,
        chain: str,
        query: str,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = self._subgraph_url(chain)
        payload: dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables

        try:
            resp = await self._client.post(url, json=payload)
            resp.raise_for_status()
        except httpx.TimeoutException as exc:
            raise AdapterTimeout(
                f"AaveV3 subgraph timeout ({chain})"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise AdapterError(
                f"AaveV3 subgraph HTTP {exc.response.status_code} ({chain}): "
                f"{exc.response.text[:200]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise AdapterError(
                f"AaveV3 subgraph error ({chain}): {exc}"
            ) from exc

        data = resp.json()
        if "errors" in data:
            raise AdapterError(
                f"AaveV3 GraphQL error ({chain}): {data['errors']}"
            )
        return data.get("data", {})

    # ------------------------------------------------------------------
    # ETH/USD price
    # ------------------------------------------------------------------

    async def _fetch_eth_usd(self, chain: str) -> Decimal:
        """Fetch ETH price in USD from the subgraph's PriceOracle entity.

        The priceOracle entity (id="1") stores usdPriceEth as a ray-like value.
        Specifically: usdPriceEth = 1e18 / eth_price_in_usd  (Wei per USD).
        So: eth_usd = 1e18 / usdPriceEth.
        """
        try:
            data = await self._query(chain, _QUERY_ETH_USD_PRICE)
            oracle = data.get("priceOracle") or {}
            usd_price_eth_raw = _d(oracle.get("usdPriceEth"))
            if usd_price_eth_raw and usd_price_eth_raw > 0:
                return Decimal("1e18") / usd_price_eth_raw
        except AdapterError:
            logger.warning(
                f"AaveV3: could not fetch ETH/USD price on {chain}, defaulting to 0"
            )
        return Decimal(0)

    # ------------------------------------------------------------------
    # fetch_positions
    # ------------------------------------------------------------------

    async def fetch_positions(
        self, *, address: str, chain: str = "ethereum", **kwargs: Any
    ) -> list[Position]:
        """Fetch all Aave V3 supply + borrow positions for an address.

        Returns one Position per asset per side (COLLATERAL or DEBT).
        health_factor is set identically on all returned positions —
        it is the account-level HF, not per-position.

        Args:
            address: 0x-prefixed EVM wallet address (lowercased for subgraph).
            chain:   one of SUPPORTED_CHAINS (default: "ethereum").
        """
        ts = int(time.time())
        user = address.lower()

        # Fetch all userReserves where the user has supply OR debt
        collateral_data, debt_data, eth_usd = await _parallel_fetch(
            self._query(chain, _QUERY_USER_RESERVES, {"user": user}),
            self._query(chain, _QUERY_USER_DEBT, {"user": user}),
            self._fetch_eth_usd(chain),
        )

        # Merge both result sets by reserve id — avoid duplicates
        reserves_by_id: dict[str, dict[str, Any]] = {}
        for ur in collateral_data.get("userReserves", []):
            rid = ur["reserve"]["id"]
            reserves_by_id[rid] = ur
        for ur in debt_data.get("userReserves", []):
            rid = ur["reserve"]["id"]
            if rid not in reserves_by_id:
                reserves_by_id[rid] = ur
            else:
                # Already present — make sure debt fields are not zero'd out
                existing = reserves_by_id[rid]
                if _d(existing.get("currentTotalDebt", "0")) == 0:
                    reserves_by_id[rid] = ur

        if not reserves_by_id:
            logger.debug(f"AaveV3 ({chain}): no positions for {address[:8]}...")
            return []

        if eth_usd <= 0:
            logger.warning(
                f"AaveV3 ({chain}): ETH/USD price is 0 — USD values will be 0"
            )

        # ------------------------------------------------------------------
        # Compute account-level health factor
        # ------------------------------------------------------------------
        # HF = Σ(collateral_usd_i * LT_i) / Σ(debt_usd_i)
        # All amounts converted to USD via priceInEth * eth_usd
        # ------------------------------------------------------------------

        weighted_collateral = Decimal(0)  # Σ(collateral_usd * LT)
        total_debt_usd = Decimal(0)

        # First pass: accumulate HF numerator and denominator
        parsed_reserves: list[dict[str, Any]] = []

        for ur in reserves_by_id.values():
            reserve = ur["reserve"]
            decimals = int(reserve.get("decimals", 18))
            lt_bps = _d(reserve.get("reserveLiquidationThreshold", "0")) or Decimal(0)
            lt = lt_bps / _BPS  # e.g. 0.825

            price_in_eth_raw = _d(
                (reserve.get("price") or {}).get("priceInEth", "0")
            ) or Decimal(0)
            # priceInEth is stored with 18 decimals in Aave subgraph
            price_in_eth = price_in_eth_raw / Decimal("1e18")
            price_usd = price_in_eth * eth_usd

            # Supply (aToken balance)
            supply_raw = _d(ur.get("currentATokenBalance", "0")) or Decimal(0)
            supply_native = _to_human(supply_raw, decimals)
            supply_usd = supply_native * price_usd

            # Debt (variable + stable)
            debt_raw = _d(ur.get("currentTotalDebt", "0")) or Decimal(0)
            debt_native = _to_human(debt_raw, decimals)
            debt_usd = debt_native * price_usd

            is_collateral = ur.get("usageAsCollateralEnabledOnUser", False)

            if is_collateral and supply_native > 0:
                weighted_collateral += supply_usd * lt

            if debt_native > 0:
                total_debt_usd += debt_usd

            parsed_reserves.append({
                "ur": ur,
                "reserve": reserve,
                "decimals": decimals,
                "lt": lt,
                "price_usd": price_usd,
                "price_in_eth": price_in_eth,
                "supply_native": supply_native,
                "supply_usd": supply_usd,
                "debt_native": debt_native,
                "debt_usd": debt_usd,
                "is_collateral": is_collateral,
            })

        # HF = Decimal("inf") when no debt (no liquidation risk)
        if total_debt_usd > 0:
            health_factor = weighted_collateral / total_debt_usd
        else:
            health_factor = None  # no debt → HF undefined / infinite

        # ------------------------------------------------------------------
        # Second pass: build Position objects
        # ------------------------------------------------------------------
        positions: list[Position] = []

        for p in parsed_reserves:
            ur = p["ur"]
            reserve = p["reserve"]
            asset = reserve.get("symbol", reserve["id"])
            reserve_id = reserve["id"]

            # Supply side (COLLATERAL)
            if p["supply_native"] > 0:
                positions.append(
                    Position(
                        protocol=self.name,
                        chain=chain,
                        asset=asset,
                        side=PositionSide.COLLATERAL,
                        size_native=p["supply_native"],
                        size_usd=p["supply_usd"] if p["supply_usd"] > 0 else None,
                        entry_price=None,  # Aave doesn't track entry price
                        mark_price=p["price_usd"] if p["price_usd"] > 0 else None,
                        oracle_price=p["price_usd"] if p["price_usd"] > 0 else None,
                        health_factor=health_factor,
                        liquidation_threshold=p["lt"],
                        market_id=reserve_id,
                        funding_rate=None,
                        funding_period_hours=None,
                        unrealized_pnl_usd=None,
                        liquidation_price=None,
                        pt_expiry_ts=None,
                        market_liquidity_usd=None,
                        implied_apy=None,
                        snapshot_ts=ts,
                        wallet=address,
                        raw={
                            "userReserve": ur,
                            "is_collateral_enabled": p["is_collateral"],
                        },
                    )
                )

            # Debt side (DEBT)
            if p["debt_native"] > 0:
                positions.append(
                    Position(
                        protocol=self.name,
                        chain=chain,
                        asset=asset,
                        side=PositionSide.DEBT,
                        size_native=p["debt_native"],
                        size_usd=p["debt_usd"] if p["debt_usd"] > 0 else None,
                        entry_price=None,
                        mark_price=p["price_usd"] if p["price_usd"] > 0 else None,
                        oracle_price=p["price_usd"] if p["price_usd"] > 0 else None,
                        health_factor=health_factor,
                        liquidation_threshold=p["lt"],
                        market_id=reserve_id,
                        funding_rate=None,
                        funding_period_hours=None,
                        unrealized_pnl_usd=None,
                        liquidation_price=None,
                        pt_expiry_ts=None,
                        market_liquidity_usd=None,
                        implied_apy=None,
                        snapshot_ts=ts,
                        wallet=address,
                        raw={"userReserve": ur},
                    )
                )

        logger.debug(
            f"AaveV3 ({chain}): {len(positions)} positions for "
            f"{address[:8]}...{address[-4:]} | "
            f"HF={health_factor:.4f if health_factor else 'N/A (no debt)'}"
        )
        return positions

    # ------------------------------------------------------------------
    # fetch_market_state
    # ------------------------------------------------------------------

    async def fetch_market_state(
        self, *, market_id: str, chain: str = "ethereum", **kwargs: Any
    ) -> MarketState:
        """Fetch Aave V3 market data for a single reserve.

        Args:
            market_id: underlying token address (e.g. WETH = 0xC02aaa...).
                       Lowercased for subgraph lookup.
            chain:     one of SUPPORTED_CHAINS.
        """
        ts = int(time.time())
        reserve_id = market_id.lower()

        data = await self._query(
            chain, _QUERY_RESERVE, {"id": reserve_id}
        )
        reserve = data.get("reserve")
        if not reserve:
            raise AdapterNotFound(
                f"AaveV3: reserve not found for {market_id} on {chain}"
            )

        eth_usd = await self._fetch_eth_usd(chain)

        decimals = int(reserve.get("decimals", 18))
        price_in_eth_raw = _d(
            (reserve.get("price") or {}).get("priceInEth", "0")
        ) or Decimal(0)
        price_in_eth = price_in_eth_raw / Decimal("1e18")
        price_usd = price_in_eth * eth_usd if eth_usd > 0 else None

        liquidity_rate = _d(reserve.get("liquidityRate", "0")) or Decimal(0)
        variable_borrow_rate = _d(reserve.get("variableBorrowRate", "0")) or Decimal(0)
        supply_apy = _ray_to_apy(liquidity_rate)
        borrow_apy = _ray_to_apy(variable_borrow_rate)

        total_liquidity_raw = _d(reserve.get("totalLiquidity", "0")) or Decimal(0)
        total_debt_raw = (
            _d(reserve.get("totalCurrentVariableDebt", "0")) or Decimal(0)
        ) + (
            _d(reserve.get("totalPrincipalStableDebt", "0")) or Decimal(0)
        )
        total_liquidity_native = _to_human(total_liquidity_raw, decimals)
        total_debt_native = _to_human(total_debt_raw, decimals)

        total_liquidity_usd = (
            total_liquidity_native * price_usd if price_usd else None
        )
        total_debt_usd = total_debt_native * price_usd if price_usd else None

        return MarketState(
            protocol=self.name,
            market_id=market_id,
            mark_price=price_usd,
            oracle_price=price_usd,
            funding_rate=None,  # lending protocol — no funding rate
            open_interest_usd=total_debt_usd,
            liquidity_usd=total_liquidity_usd,
            snapshot_ts=ts,
            raw={
                "reserve": reserve,
                "supply_apy": str(supply_apy),
                "borrow_apy": str(borrow_apy),
                "total_supply_native": str(total_liquidity_native),
                "total_borrow_native": str(total_debt_native),
                "chain": chain,
            },
        )

    # ------------------------------------------------------------------
    # Healthcheck
    # ------------------------------------------------------------------

    async def healthcheck(self) -> bool:
        """Ping the Ethereum subgraph with a lightweight meta query."""
        try:
            data = await self._query(
                "ethereum",
                "{ _meta { block { number } } }",
            )
            return "_meta" in data
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        await self._client.aclose()


# ---------------------------------------------------------------------------
# Parallel fetch helper (avoids asyncio import at module level for clarity)
# ---------------------------------------------------------------------------

async def _parallel_fetch(*coros: Any) -> tuple[Any, ...]:
    """Await multiple coroutines concurrently, return results as a tuple."""
    import asyncio
    return tuple(await asyncio.gather(*coros))
