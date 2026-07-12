"""Hyperliquid adapter — read-only via the public Info API.

API base: https://api.hyperliquid.xyz/info  (POST JSON)

Endpoints used:
  - "clearinghouseState"   → perp positions for an address
  - "metaAndAssetCtxs"     → funding rates + mark prices for all perps
  - "allMids"              → mid prices for all assets (perp + spot)
  - "fundingHistory"       → historical funding rate per coin

No authentication is required for any of these. No SDK dependency — we hit
REST directly via httpx, which keeps the adapter small and dependency-light.

Rate limits (2026):
  - IP global: 1200 weight/min (REST)
  - clearinghouseState / allMids: weight 2
  - metaAndAssetCtxs: weight 20
  - fundingHistory: weight 20 + (n_items / 20)
At a 15-min polling cadence with ~10 calls/cycle, we stay well below the cap.
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

INFO_URL = "https://api.hyperliquid.xyz/info"
DEFAULT_TIMEOUT = 10.0
HOUR_SECONDS = 3600


def _d(value: Any) -> Decimal | None:
    """Convert API string/number to Decimal, returning None for empty/invalid."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


class HyperliquidAdapter(ProtocolAdapter):
    name = "hyperliquid"
    supports_perps = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        timeout = self.config.get("timeout", DEFAULT_TIMEOUT)
        # Don't pass /info via base_url — httpx may rewrite trailing slash.
        # Use full URL on each call instead.
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"Content-Type": "application/json"},
        )
        self._meta_cache: dict[str, Any] | None = None
        self._meta_cache_ts: int = 0
        self._meta_cache_ttl: int = 60  # seconds

    async def _post(self, payload: dict[str, Any]) -> Any:
        try:
            resp = await self._client.post(INFO_URL, json=payload)
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutException as e:
            raise AdapterTimeout(f"Hyperliquid timeout on {payload['type']}") from e
        except httpx.HTTPError as e:
            raise AdapterError(f"Hyperliquid HTTP error: {e}") from e

    async def _meta_and_ctxs(self) -> dict[str, Any]:
        """Cached fetch of metaAndAssetCtxs (refreshed every 60s)."""
        now = int(time.time())
        if self._meta_cache and (now - self._meta_cache_ts) < self._meta_cache_ttl:
            return self._meta_cache
        data = await self._post({"type": "metaAndAssetCtxs"})
        # Response is [meta, contexts] — zip them by index for easy lookup
        meta, contexts = data[0], data[1]
        universe = meta.get("universe", [])
        merged = {
            coin_meta["name"]: {"meta": coin_meta, "ctx": ctx}
            for coin_meta, ctx in zip(universe, contexts, strict=False)
        }
        self._meta_cache = merged
        self._meta_cache_ts = now
        return merged

    async def fetch_positions(
        self, *, address: str, **kwargs: Any
    ) -> list[Position]:
        """Fetch all open perp positions for a Hyperliquid account.

        address: 0x-prefixed EVM address (the Hyperliquid account).
        """
        ts = int(time.time())
        state = await self._post(
            {"type": "clearinghouseState", "user": address}
        )
        asset_positions = state.get("assetPositions", [])
        if not asset_positions:
            return []

        meta = await self._meta_and_ctxs()
        positions: list[Position] = []

        for ap in asset_positions:
            pos = ap.get("position", {})
            coin = pos.get("coin")
            if not coin:
                continue

            size_native = _d(pos.get("szi")) or Decimal(0)
            if size_native == 0:
                continue  # closed position

            entry = _d(pos.get("entryPx"))
            unrealized = _d(pos.get("unrealizedPnl"))
            liq_px = _d(pos.get("liquidationPx"))
            position_value = _d(pos.get("positionValue"))

            # Side: szi > 0 = long, szi < 0 = short
            side = PositionSide.LONG if size_native > 0 else PositionSide.SHORT

            # Market context
            market_ctx = meta.get(coin, {}).get("ctx", {})
            mark = _d(market_ctx.get("markPx"))
            funding = _d(market_ctx.get("funding"))
            oracle = _d(market_ctx.get("oraclePx"))

            positions.append(
                Position(
                    protocol=self.name,
                    chain="hyperliquid",
                    asset=coin,
                    side=side,
                    size_native=abs(size_native),
                    size_usd=position_value,
                    entry_price=entry,
                    mark_price=mark,
                    oracle_price=oracle,
                    health_factor=None,
                    liquidation_threshold=None,
                    market_id=coin,
                    funding_rate=funding,
                    funding_period_hours=1.0,
                    unrealized_pnl_usd=unrealized,
                    liquidation_price=liq_px,
                    pt_expiry_ts=None,
                    market_liquidity_usd=None,
                    implied_apy=None,
                    snapshot_ts=ts,
                    wallet=address,
                    raw=ap,
                )
            )

        logger.debug(
            f"Hyperliquid: {len(positions)} positions for {address[:8]}...{address[-4:]}"
        )
        return positions

    async def fetch_market_state(
        self, *, market_id: str, **kwargs: Any
    ) -> MarketState:
        """Fetch funding + mark for a single coin (e.g. 'BTC', 'ETH', 'KAITO')."""
        ts = int(time.time())
        meta = await self._meta_and_ctxs()
        entry = meta.get(market_id)
        if not entry:
            raise AdapterError(f"Hyperliquid: unknown market {market_id}")
        ctx = entry["ctx"]
        return MarketState(
            protocol=self.name,
            market_id=market_id,
            mark_price=_d(ctx.get("markPx")),
            oracle_price=_d(ctx.get("oraclePx")),
            funding_rate=_d(ctx.get("funding")),
            open_interest_usd=_d(ctx.get("openInterest")),
            liquidity_usd=_d(ctx.get("dayNtlVlm")),
            snapshot_ts=ts,
            raw=ctx,
        )

    async def fetch_funding_history(
        self, *, coin: str, hours_back: int = 24
    ) -> list[tuple[int, Decimal]]:
        """Return list of (timestamp_ms, funding_rate) for the last N hours."""
        now_ms = int(time.time() * 1000)
        start_ms = now_ms - hours_back * HOUR_SECONDS * 1000
        data = await self._post(
            {"type": "fundingHistory", "coin": coin, "startTime": start_ms}
        )
        result: list[tuple[int, Decimal]] = []
        for entry in data:
            ts_ms = entry.get("time")
            rate = _d(entry.get("fundingRate"))
            if ts_ms is not None and rate is not None:
                result.append((ts_ms, rate))
        return result

    async def healthcheck(self) -> bool:
        try:
            await self._post({"type": "allMids"})
            return True
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
