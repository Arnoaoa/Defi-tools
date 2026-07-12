"""Apex Omni adapter — read-only via public REST API (Mode B, no API key).

API base: https://omni.apex.exchange/api/

Endpoints used (all unauthenticated):
  - GET /v3/system-time          → healthcheck
  - GET /v3/all-config-data      → list of markets (cached 5 min)
  - GET /v3/ticker-data          → mark price, 24h volume, current funding rate
  - GET /v3/funding-rate-history → historical funding rates for a symbol
  - GET /v3/market-depth         → order book depth for liquidity estimate

Mode B limitation: Apex has no public endpoint for positions by address.
fetch_positions() always returns [] — use compose_position() instead, which
builds a synthetic Position from a static config (entry data from strategies.yaml)
combined with live market data.

Rate limits: 600 requests / 60 seconds per IP.
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

import httpx
from loguru import logger

from src.adapters.base import (
    AdapterError,
    AdapterTimeout,
    ProtocolAdapter,
)
from src.models import MarketState, Position, PositionSide

BASE_URL = "https://omni.apex.exchange/api"
DEFAULT_TIMEOUT = 10.0
HOUR_SECONDS = 3_600
CONFIG_CACHE_TTL = 300  # 5 minutes


def _d(value: Any) -> Decimal | None:
    """Convert API string/number to Decimal, returning None for empty/invalid."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


class ApexOmniAdapter(ProtocolAdapter):
    name = "apex_omni"
    supports_perps = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        timeout = self.config.get("timeout", DEFAULT_TIMEOUT)
        self._client = httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=timeout,
        )
        self._config_cache: dict[str, Any] | None = None
        self._config_cache_ts: int = 0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """Perform a GET request and return parsed JSON."""
        try:
            resp = await self._client.get(path, params=params)
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutException as e:
            raise AdapterTimeout(f"Apex Omni timeout on {path}") from e
        except httpx.HTTPStatusError as e:
            raise AdapterError(
                f"Apex Omni HTTP {e.response.status_code} on {path}"
            ) from e
        except httpx.HTTPError as e:
            raise AdapterError(f"Apex Omni HTTP error on {path}: {e}") from e

    async def _all_config(self) -> dict[str, Any]:
        """Cached fetch of /v3/all-config-data (refreshed every 5 min).

        Returns a dict keyed by symbol (e.g. "BTC-USDT") for O(1) lookup.
        """
        now = int(time.time())
        if self._config_cache and (now - self._config_cache_ts) < CONFIG_CACHE_TTL:
            return self._config_cache

        data = await self._get("/v3/all-config-data")
        # Response structure: {"data": {"perpetualContract": [...], ...}, ...}
        contracts = (
            data.get("data", {}).get("perpetualContract", [])
            or data.get("data", {}).get("contracts", [])
            or []
        )
        merged: dict[str, Any] = {c["symbol"]: c for c in contracts if "symbol" in c}
        self._config_cache = merged
        self._config_cache_ts = now
        return merged

    async def _ticker(self, symbol: str) -> dict[str, Any]:
        """Fetch ticker data for a symbol (mark price, volume, funding rate)."""
        data = await self._get("/v3/ticker-data", params={"symbol": symbol})
        tickers = data.get("data", {})
        # Response is either a dict keyed by symbol or a list
        if isinstance(tickers, dict):
            ticker = tickers.get(symbol, {})
        elif isinstance(tickers, list):
            ticker = next((t for t in tickers if t.get("symbol") == symbol), {})
        else:
            ticker = {}
        if not ticker:
            raise AdapterError(f"Apex Omni: no ticker data for {symbol}")
        return ticker

    async def _funding_history(
        self, symbol: str, start_ts: int
    ) -> list[tuple[int, Decimal]]:
        """Fetch funding rate history for a symbol since start_ts (unix seconds).

        Returns list of (timestamp_ms, funding_rate) tuples, oldest first.
        """
        data = await self._get(
            "/v3/funding-rate-history",
            params={"symbol": symbol, "startTime": start_ts * 1000},
        )
        entries = data.get("data", {}).get("fundingRateData", []) or []
        result: list[tuple[int, Decimal]] = []
        for entry in entries:
            ts_ms = entry.get("fundingTime") or entry.get("time")
            rate = _d(entry.get("fundingRate") or entry.get("rate"))
            if ts_ms is not None and rate is not None:
                result.append((int(ts_ms), rate))
        return result

    async def _depth_liquidity(self, symbol: str) -> Decimal | None:
        """Estimate liquidity from top-of-book order depth."""
        data = await self._get("/v3/market-depth", params={"symbol": symbol})
        depth = data.get("data", {})
        bids = depth.get("b", []) or depth.get("bids", [])
        asks = depth.get("a", []) or depth.get("asks", [])
        # Sum notional across top 10 levels
        total = Decimal(0)
        for level in (bids[:10] + asks[:10]):
            price = _d(level[0] if isinstance(level, list) else level.get("price"))
            qty = _d(level[1] if isinstance(level, list) else level.get("size"))
            if price and qty:
                total += price * qty
        return total if total > 0 else None

    # ------------------------------------------------------------------
    # ProtocolAdapter interface
    # ------------------------------------------------------------------

    async def fetch_positions(self, *, address: str, **kwargs: Any) -> list[Position]:
        """Always returns [] — Apex has no public endpoint for positions by address.

        Use compose_position() with a static config from strategies.yaml instead.
        """
        logger.warning(
            "ApexOmniAdapter.fetch_positions() called but Apex has no public "
            "positions endpoint. Returning []. Use compose_position() for Mode B."
        )
        return []

    async def fetch_market_state(
        self, *, market_id: str, **kwargs: Any
    ) -> MarketState:
        """Fetch live market data for a symbol (e.g. 'BTC-USDT').

        Combines ticker data (mark, funding) with order book depth.
        """
        ts = int(time.time())
        ticker = await self._ticker(market_id)

        # Fetch liquidity separately; non-fatal if it fails
        liquidity: Decimal | None = None
        try:
            liquidity = await self._depth_liquidity(market_id)
        except (AdapterError, AdapterTimeout) as exc:
            logger.debug(f"Apex Omni: depth fetch skipped for {market_id}: {exc}")

        return MarketState(
            protocol=self.name,
            market_id=market_id,
            mark_price=_d(ticker.get("lastPrice") or ticker.get("markPrice")),
            oracle_price=_d(ticker.get("oraclePrice") or ticker.get("indexPrice")),
            funding_rate=_d(
                ticker.get("fundingRate") or ticker.get("nextFundingRate")
            ),
            open_interest_usd=_d(
                ticker.get("openInterest") or ticker.get("openInterestValue")
            ),
            liquidity_usd=liquidity,
            snapshot_ts=ts,
            raw=ticker,
        )

    # ------------------------------------------------------------------
    # Mode B specific: synthetic position from static config + live data
    # ------------------------------------------------------------------

    async def compose_position(
        self,
        config: dict[str, Any],
        *,
        wallet: str | None = None,
    ) -> Position:
        """Build a synthetic Position by merging static entry data with live market data.

        config keys (from strategies.yaml):
          symbol       : str   — e.g. "XAU-USDT"
          size_native  : str   — position size in base asset units
          entry_price  : str   — average entry price in USD
          entry_ts     : int   — unix timestamp when position was opened

        Fetches live ticker (mark price, funding rate) and computes cumulative
        funding paid since entry_ts. Result is stored in raw["funding_cumulative_24h_usd"]
        (the Position model has no first-class field for this).
        """
        symbol: str = config["symbol"]
        size_native = _d(config["size_native"]) or Decimal(0)
        entry_price = _d(config["entry_price"])
        entry_ts: int = int(config["entry_ts"])
        ts = int(time.time())

        ticker = await self._ticker(symbol)
        mark_price = _d(ticker.get("lastPrice") or ticker.get("markPrice"))
        current_funding = _d(
            ticker.get("fundingRate") or ticker.get("nextFundingRate")
        )

        # Compute unrealized PnL (short: profit when price falls)
        unrealized_pnl: Decimal | None = None
        if mark_price is not None and entry_price is not None and size_native:
            price_delta = entry_price - mark_price  # positive = profitable for short
            unrealized_pnl = price_delta * size_native

        # Cumulative funding collected since entry (short receives positive funding)
        funding_cumulative: Decimal = Decimal(0)
        funding_periods: int = 0
        try:
            history = await self._funding_history(symbol, start_ts=entry_ts)
            funding_periods = len(history)
            for _ts_ms, rate in history:
                # Each payment: rate * notional (simplified: size * entry_price)
                notional = size_native * (entry_price or Decimal(0))
                funding_cumulative += rate * notional
        except (AdapterError, AdapterTimeout) as exc:
            logger.warning(
                f"Apex Omni: funding history unavailable for {symbol}: {exc}. "
                "funding_cumulative_usd will be 0."
            )

        size_usd = size_native * mark_price if mark_price else None

        return Position(
            protocol=self.name,
            chain="apex_omni",
            asset=symbol,
            side=PositionSide.SHORT,
            size_native=size_native,
            size_usd=size_usd,
            entry_price=entry_price,
            mark_price=mark_price,
            oracle_price=_d(ticker.get("oraclePrice") or ticker.get("indexPrice")),
            health_factor=None,
            liquidation_threshold=None,
            market_id=symbol,
            funding_rate=current_funding,
            funding_period_hours=8.0,  # Apex uses 8h funding periods
            unrealized_pnl_usd=unrealized_pnl,
            liquidation_price=None,  # not available without auth
            pt_expiry_ts=None,
            market_liquidity_usd=None,
            implied_apy=None,
            snapshot_ts=ts,
            wallet=wallet,
            raw={
                "ticker": ticker,
                "entry_ts": entry_ts,
                "funding_cumulative_usd": str(funding_cumulative),
                "funding_periods_counted": funding_periods,
            },
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def healthcheck(self) -> bool:
        try:
            await self._get("/v3/system-time")
            return True
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
