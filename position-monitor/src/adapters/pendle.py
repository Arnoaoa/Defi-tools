"""Pendle V2 adapter — read-only via public REST API + on-chain balanceOf.

API base: https://api-v2.pendle.finance/core

Endpoints used:
  - GET /v3/{chainId}/assets/all         → PT/YT/LP asset list (name, expiry, decimals)
  - GET /v2/{chainId}/markets/{addr}/data → liquidity, volume 24h, implied APY
  - GET /v1/{chainId}/markets/active      → active markets list (fallback discovery)

On-chain:
  - ERC-20 balanceOf(address) via web3.py AsyncWeb3 per PT contract

Position logic:
  - A PT (Principal Token) is a long fixed-yield position. side = LONG.
  - size_native = balance / 10^decimals
  - pt_expiry_ts = unix timestamp of maturity (from asset metadata)
  - market_id = Pendle market address (not the PT contract itself)

Chain IDs supported:
  1       = ethereum
  42161   = arbitrum
  8453    = base
  10      = optimism
  56      = bsc

RPC URLs resolved from env vars (same keys as strategies.yaml):
  ALCHEMY_ETH_URL, ALCHEMY_ARB_URL, ALCHEMY_BASE_URL,
  ALCHEMY_OPT_URL, ANKR_BSC_URL (or ALCHEMY_BSC_URL as fallback).

Discovery mode: if pt_contracts is not provided, fetches all PT assets from the
API and calls balanceOf for up to MAX_DISCOVERY_CONTRACTS to avoid RPC flooding.
"""
from __future__ import annotations

import asyncio
import os
import time
from decimal import Decimal
from typing import Any

import httpx
from loguru import logger
from web3 import AsyncWeb3, AsyncHTTPProvider

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

API_BASE = "https://api-v2.pendle.finance/core"
DEFAULT_TIMEOUT = 15.0
MARKET_CACHE_TTL = 300  # 5 minutes — market data changes slowly enough
MAX_DISCOVERY_CONTRACTS = 50  # cap balanceOf calls during auto-discovery

CHAIN_IDS: dict[str, int] = {
    "ethereum": 1,
    "arbitrum": 42161,
    "base": 8453,
    "optimism": 10,
    "bsc": 56,
}

# RPC env-var names per chain (first found wins)
CHAIN_RPC_ENV: dict[str, list[str]] = {
    "ethereum": ["ALCHEMY_ETH_URL"],
    "arbitrum": ["ALCHEMY_ARB_URL"],
    "base": ["ALCHEMY_BASE_URL"],
    "optimism": ["ALCHEMY_OPT_URL"],
    "bsc": ["ANKR_BSC_URL", "ALCHEMY_BSC_URL"],
}

# Minimal ERC-20 ABI — only what we need
ERC20_ABI: list[dict[str, Any]] = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "symbol",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "string"}],
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _d(value: Any) -> Decimal | None:
    """Convert API value to Decimal, returning None on failure."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _rpc_url(chain: str) -> str:
    """Resolve RPC URL for chain from environment variables."""
    env_vars = CHAIN_RPC_ENV.get(chain, [])
    for var in env_vars:
        url = os.environ.get(var)
        if url:
            return url
    raise AdapterError(
        f"Pendle: no RPC URL configured for chain '{chain}'. "
        f"Set one of: {env_vars}"
    )


def _days_to_expiry(expiry_ts: int) -> float:
    """Return signed days until expiry. Negative = already expired."""
    return (expiry_ts - time.time()) / 86_400


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class PendleAdapter(ProtocolAdapter):
    name = "pendle"
    supports_pt = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        timeout = self.config.get("timeout", DEFAULT_TIMEOUT)
        self._client = httpx.AsyncClient(
            base_url=API_BASE,
            timeout=timeout,
            headers={"Accept": "application/json"},
        )
        # market metadata cache: (chain, market_addr) -> {data, ts}
        self._market_cache: dict[tuple[str, str], dict[str, Any]] = {}
        # asset list cache: chain -> {assets_by_pt_address, ts}
        self._asset_cache: dict[str, dict[str, Any]] = {}

    # -----------------------------------------------------------------------
    # HTTP helpers
    # -----------------------------------------------------------------------

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        try:
            resp = await self._client.get(path, params=params)
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutException as e:
            raise AdapterTimeout(f"Pendle timeout on {path}") from e
        except httpx.HTTPStatusError as e:
            raise AdapterError(
                f"Pendle HTTP {e.response.status_code} on {path}"
            ) from e
        except httpx.HTTPError as e:
            raise AdapterError(f"Pendle HTTP error on {path}: {e}") from e

    # -----------------------------------------------------------------------
    # Asset metadata (PT list per chain) — cached 5 min
    # -----------------------------------------------------------------------

    async def _fetch_assets(self, chain: str) -> dict[str, Any]:
        """Return mapping {pt_address_lower -> asset_dict} for all PT on chain.

        Response from /v3/{chainId}/assets/all contains objects with:
          address, name, symbol, type ("PT"|"YT"|"LP"|"SY"), expiry (ISO str),
          decimals, proMarketAddress (the Pendle market address)
        """
        now = int(time.time())
        cached = self._asset_cache.get(chain)
        if cached and (now - cached["ts"]) < MARKET_CACHE_TTL:
            return cached["data"]

        chain_id = CHAIN_IDS.get(chain)
        if chain_id is None:
            raise AdapterError(f"Pendle: unsupported chain '{chain}'")

        data = await self._get(f"/v3/{chain_id}/assets/all")
        # The response is either a list or {"assets": [...]}
        assets_raw: list[dict[str, Any]] = (
            data if isinstance(data, list) else data.get("assets", [])
        )

        pt_map: dict[str, Any] = {}
        for asset in assets_raw:
            if asset.get("type", "").upper() != "PT":
                continue
            addr = (asset.get("address") or "").lower()
            if addr:
                pt_map[addr] = asset

        self._asset_cache[chain] = {"data": pt_map, "ts": now}
        logger.debug(f"Pendle: loaded {len(pt_map)} PT assets on {chain}")
        return pt_map

    # -----------------------------------------------------------------------
    # Market data — cached 5 min
    # -----------------------------------------------------------------------

    async def _fetch_market_data(
        self, chain: str, market_address: str
    ) -> dict[str, Any]:
        """Return live market data from /v2/{chainId}/markets/{addr}/data.

        Cached per (chain, market_address) with 5-min TTL.

        Response includes: liquidity (USD), volume24h, impliedApy, underlyingApy,
        swapFeeApy, fixedRoi, tradingVolume, pt / yt / lp objects.
        """
        key = (chain, market_address.lower())
        now = int(time.time())
        cached = self._market_cache.get(key)
        if cached and (now - cached["ts"]) < MARKET_CACHE_TTL:
            return cached["data"]

        chain_id = CHAIN_IDS[chain]
        data = await self._get(f"/v2/{chain_id}/markets/{market_address}/data")
        market_data: dict[str, Any] = (
            data if isinstance(data, dict) else data.get("data", {})
        )

        self._market_cache[key] = {"data": market_data, "ts": now}
        return market_data

    # -----------------------------------------------------------------------
    # On-chain balanceOf
    # -----------------------------------------------------------------------

    async def _balance_of(
        self,
        w3: AsyncWeb3,
        pt_address: str,
        wallet: str,
        decimals: int,
    ) -> Decimal:
        """Call ERC-20 balanceOf on-chain. Returns Decimal in native units."""
        checksum_pt = AsyncWeb3.to_checksum_address(pt_address)
        checksum_wallet = AsyncWeb3.to_checksum_address(wallet)
        contract = w3.eth.contract(address=checksum_pt, abi=ERC20_ABI)
        try:
            raw_balance: int = await contract.functions.balanceOf(
                checksum_wallet
            ).call()
        except Exception as e:
            raise AdapterError(
                f"Pendle: balanceOf failed for {pt_address}: {e}"
            ) from e
        return Decimal(raw_balance) / Decimal(10**decimals)

    # -----------------------------------------------------------------------
    # Expiry parsing
    # -----------------------------------------------------------------------

    @staticmethod
    def _parse_expiry(asset: dict[str, Any]) -> int | None:
        """Extract unix timestamp from asset expiry field.

        Pendle API returns expiry as ISO 8601 string or unix int.
        """
        raw = asset.get("expiry")
        if raw is None:
            return None
        if isinstance(raw, (int, float)):
            return int(raw)
        # ISO string: "2025-12-26T00:00:00.000Z"
        try:
            from datetime import datetime, timezone

            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return int(dt.timestamp())
        except Exception:
            logger.warning(f"Pendle: could not parse expiry '{raw}'")
            return None

    # -----------------------------------------------------------------------
    # Build a Position from PT asset + market data + balance
    # -----------------------------------------------------------------------

    def _build_position(
        self,
        asset: dict[str, Any],
        balance: Decimal,
        market_data: dict[str, Any],
        chain: str,
        wallet: str,
        snapshot_ts: int,
    ) -> Position:
        expiry_ts = self._parse_expiry(asset)
        market_address: str | None = (
            asset.get("proMarketAddress")
            or asset.get("marketAddress")
            or market_data.get("address")
        )

        # Liquidity: API field varies across versions
        liquidity_raw = (
            market_data.get("liquidity")
            or market_data.get("totalValueLocked")
            or market_data.get("tvl")
        )
        liquidity_usd = _d(
            liquidity_raw.get("usd") if isinstance(liquidity_raw, dict)
            else liquidity_raw
        )

        # Implied APY: "impliedApy" or "impliedAPY" (decimal fraction, e.g. 0.12 = 12%)
        implied_apy = _d(
            market_data.get("impliedApy")
            or market_data.get("impliedAPY")
            or market_data.get("ptDiscount")
        )

        # Asset name: prefer full name, fall back to symbol
        asset_name = asset.get("name") or asset.get("symbol") or "PT-Unknown"

        # Mark price from market data if available (PT price in underlying terms)
        mark_price = _d(
            (market_data.get("pt") or {}).get("price")
            or market_data.get("ptPrice")
        )

        return Position(
            protocol=self.name,
            chain=chain,
            asset=asset_name,
            side=PositionSide.LONG,
            size_native=balance,
            size_usd=None,  # USD value requires oracle; not available without extra call
            entry_price=None,
            mark_price=mark_price,
            oracle_price=None,
            health_factor=None,
            liquidation_threshold=None,
            market_id=market_address,
            funding_rate=None,
            funding_period_hours=None,
            unrealized_pnl_usd=None,
            liquidation_price=None,
            pt_expiry_ts=expiry_ts,
            market_liquidity_usd=liquidity_usd,
            implied_apy=implied_apy,
            snapshot_ts=snapshot_ts,
            wallet=wallet,
            raw={
                "asset": asset,
                "market_data": market_data,
                "days_to_expiry": (
                    round(_days_to_expiry(expiry_ts), 2) if expiry_ts else None
                ),
            },
        )

    # -----------------------------------------------------------------------
    # fetch_positions — main public method
    # -----------------------------------------------------------------------

    async def fetch_positions(
        self, *, address: str, **kwargs: Any
    ) -> list[Position]:
        """Fetch Pendle PT positions for a wallet.

        kwargs:
          chain          : str                  — default "ethereum"
          pt_contracts   : list[str] | None     — explicit PT contract addresses.
                           If omitted, auto-discovery up to MAX_DISCOVERY_CONTRACTS.
        """
        chain: str = kwargs.get("chain", "ethereum")
        pt_contracts: list[str] | None = kwargs.get("pt_contracts")

        chain_id = CHAIN_IDS.get(chain)
        if chain_id is None:
            raise AdapterError(f"Pendle: unsupported chain '{chain}'")

        rpc_url = _rpc_url(chain)
        w3 = AsyncWeb3(AsyncHTTPProvider(rpc_url))

        snapshot_ts = int(time.time())

        # Build PT address → asset metadata map
        all_pt_assets = await self._fetch_assets(chain)

        if pt_contracts:
            # Targeted mode: only check the contracts the user declared
            target_pts = {addr.lower(): all_pt_assets.get(addr.lower()) for addr in pt_contracts}
            # For contracts not found in API metadata, we'll query chain directly
        else:
            # Discovery mode: use API list, capped at MAX_DISCOVERY_CONTRACTS
            target_pts = dict(list(all_pt_assets.items())[:MAX_DISCOVERY_CONTRACTS])
            if len(all_pt_assets) > MAX_DISCOVERY_CONTRACTS:
                logger.warning(
                    f"Pendle discovery on {chain}: {len(all_pt_assets)} PTs found, "
                    f"checking only the first {MAX_DISCOVERY_CONTRACTS}. "
                    "Pass pt_contracts explicitly to target specific positions."
                )

        # Call balanceOf concurrently for all target PT contracts
        async def _check_one(pt_addr: str, asset: dict[str, Any] | None) -> tuple[str, Decimal, dict[str, Any] | None]:
            decimals = 18  # ERC-20 PT default
            if asset and asset.get("decimals") is not None:
                decimals = int(asset["decimals"])
            else:
                # Fallback: query decimals on-chain (only for explicit contracts
                # not in API metadata)
                try:
                    checksum = AsyncWeb3.to_checksum_address(pt_addr)
                    contract = w3.eth.contract(address=checksum, abi=ERC20_ABI)
                    decimals = await contract.functions.decimals().call()
                except Exception as e:
                    logger.debug(
                        f"Pendle: could not fetch decimals for {pt_addr}, defaulting to 18: {e}"
                    )
            balance = await self._balance_of(w3, pt_addr, address, decimals)
            return pt_addr, balance, asset

        results = await asyncio.gather(
            *[_check_one(addr, meta) for addr, meta in target_pts.items()],
            return_exceptions=True,
        )

        positions: list[Position] = []

        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Pendle: balanceOf error (skipping): {result}")
                continue

            pt_addr, balance, asset = result

            if balance <= Decimal(0):
                continue  # no position in this PT

            if asset is None:
                # Contract was explicitly passed but not found in API — log and skip
                logger.warning(
                    f"Pendle: PT contract {pt_addr} not found in API metadata on {chain}. "
                    "Position detected on-chain but market data unavailable."
                )
                continue

            expiry_ts = self._parse_expiry(asset)
            if expiry_ts and expiry_ts < snapshot_ts:
                logger.debug(
                    f"Pendle: PT {asset.get('name')} is expired "
                    f"({round(_days_to_expiry(expiry_ts), 1)} days ago). "
                    "Included in output with negative days_to_expiry."
                )

            # Fetch live market data for this PT
            market_address = (
                asset.get("proMarketAddress") or asset.get("marketAddress")
            )
            market_data: dict[str, Any] = {}
            if market_address:
                try:
                    market_data = await self._fetch_market_data(chain, market_address)
                except (AdapterError, AdapterTimeout) as e:
                    logger.warning(
                        f"Pendle: market data unavailable for {market_address}: {e}. "
                        "Position will have null liquidity/APY fields."
                    )
            else:
                logger.warning(
                    f"Pendle: no market address for PT {asset.get('name')}. "
                    "market_liquidity_usd and implied_apy will be null."
                )

            positions.append(
                self._build_position(
                    asset=asset,
                    balance=balance,
                    market_data=market_data,
                    chain=chain,
                    wallet=address,
                    snapshot_ts=snapshot_ts,
                )
            )

        logger.debug(
            f"Pendle: {len(positions)} PT positions on {chain} "
            f"for {address[:8]}...{address[-4:]}"
        )
        return positions

    # -----------------------------------------------------------------------
    # fetch_market_state
    # -----------------------------------------------------------------------

    async def fetch_market_state(
        self, *, market_id: str, **kwargs: Any
    ) -> MarketState:
        """Fetch live Pendle market data for a market address.

        kwargs:
          chain : str — default "ethereum"
        """
        chain: str = kwargs.get("chain", "ethereum")

        if CHAIN_IDS.get(chain) is None:
            raise AdapterError(f"Pendle: unsupported chain '{chain}'")

        snapshot_ts = int(time.time())
        try:
            market_data = await self._fetch_market_data(chain, market_id)
        except AdapterError as e:
            raise AdapterNotFound(
                f"Pendle: market {market_id} on {chain} not found or unreachable"
            ) from e

        liquidity_raw = (
            market_data.get("liquidity")
            or market_data.get("totalValueLocked")
            or market_data.get("tvl")
        )
        liquidity_usd = _d(
            liquidity_raw.get("usd") if isinstance(liquidity_raw, dict)
            else liquidity_raw
        )

        implied_apy = _d(
            market_data.get("impliedApy")
            or market_data.get("impliedAPY")
        )

        volume_24h = _d(
            (market_data.get("tradingVolume") or {}).get("usd")
            or market_data.get("volume24h")
            or market_data.get("tradingVolume")
        )

        return MarketState(
            protocol=self.name,
            market_id=market_id,
            mark_price=_d(
                (market_data.get("pt") or {}).get("price")
                or market_data.get("ptPrice")
            ),
            oracle_price=_d(
                market_data.get("underlyingPrice")
                or market_data.get("oraclePrice")
            ),
            funding_rate=implied_apy,  # repurposed: APY instead of funding for PT markets
            open_interest_usd=_d(market_data.get("openInterest")),
            liquidity_usd=liquidity_usd,
            snapshot_ts=snapshot_ts,
            raw=market_data,
        )

    # -----------------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------------

    async def healthcheck(self) -> bool:
        try:
            await self._get("/v1/1/markets/active", params={"limit": 1})
            return True
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
