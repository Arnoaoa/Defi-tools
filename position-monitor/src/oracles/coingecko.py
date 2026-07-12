"""CoinGecko REST oracle — free tier, no key required for moderate use.

Endpoint: GET /simple/price?ids={ids}&vs_currencies=usd
Confidence: "medium" (secondary source, off-chain).
Cache TTL: 60 seconds.  Timeout: 8 seconds.
Rate limit: ~30 calls/min on free tier — the cache keeps us well below that.
"""
from __future__ import annotations

import time
from decimal import Decimal

import httpx
from loguru import logger

from src.oracles.base import OracleError, OracleNotFound, PriceResult, PriceSource

COINGECKO_BASE = "https://api.coingecko.com/api/v3"
REQUEST_TIMEOUT = 8.0
CACHE_TTL = 60  # seconds

# symbol (upper) → coingecko platform id
_SYMBOL_TO_CG_ID: dict[str, str] = {
    "BTC":   "bitcoin",
    "ETH":   "ethereum",
    "USDC":  "usd-coin",
    "USDT":  "tether",
    "PAXG":  "pax-gold",
    "XAUt":  "tether-gold",
    "XAU":   "pax-gold",   # gold spot — map to PAXG as closest free proxy
    "DAI":   "dai",
    "WBTC":  "wrapped-bitcoin",
    "WETH":  "weth",
    "SOL":   "solana",
    "BNB":   "binancecoin",
    "MATIC": "matic-network",
    "ARB":   "arbitrum",
    "OP":    "optimism",
    "LINK":  "chainlink",
    "UNI":   "uniswap",
    "AAVE":  "aave",
    "MKR":   "maker",
    "SNX":   "havven",
    "CRV":   "curve-dao-token",
}


def _resolve_cg_id(symbol: str) -> str:
    """Return the CoinGecko id for a symbol or raise OracleNotFound."""
    cg_id = _SYMBOL_TO_CG_ID.get(symbol.upper())
    if cg_id is None:
        raise OracleNotFound(
            f"No CoinGecko mapping for symbol '{symbol}'. "
            f"Available: {sorted(_SYMBOL_TO_CG_ID)}"
        )
    return cg_id


class CoinGeckoOracle(PriceSource):
    """Fetches prices from the CoinGecko /simple/price endpoint."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        timeout: float = REQUEST_TIMEOUT,
        cache_ttl: int = CACHE_TTL,
    ) -> None:
        headers: dict[str, str] = {"Accept": "application/json"}
        if api_key:
            headers["x-cg-demo-api-key"] = api_key

        self._client = httpx.AsyncClient(
            base_url=COINGECKO_BASE,
            timeout=timeout,
            headers=headers,
        )
        self._cache_ttl = cache_ttl
        # cache: cg_id → (price_decimal, fetched_ts)
        self._cache: dict[str, tuple[Decimal, int]] = {}

    def _cached(self, cg_id: str) -> Decimal | None:
        entry = self._cache.get(cg_id)
        if entry is None:
            return None
        price, fetched_at = entry
        if int(time.time()) - fetched_at < self._cache_ttl:
            return price
        return None

    async def _fetch_from_api(self, cg_id: str, vs: str) -> Decimal:
        """Hit the CoinGecko API and update the cache."""
        vs_lower = vs.lower()
        params = {"ids": cg_id, "vs_currencies": vs_lower}
        try:
            resp = await self._client.get("/simple/price", params=params)
            resp.raise_for_status()
        except httpx.TimeoutException as exc:
            raise OracleError(f"CoinGecko timeout for {cg_id}") from exc
        except httpx.HTTPStatusError as exc:
            raise OracleError(
                f"CoinGecko HTTP {exc.response.status_code} for {cg_id}"
            ) from exc
        except httpx.HTTPError as exc:
            raise OracleError(f"CoinGecko request error for {cg_id}: {exc}") from exc

        data = resp.json()
        coin_data = data.get(cg_id)
        if coin_data is None:
            raise OracleError(
                f"CoinGecko returned no data for id '{cg_id}'. "
                f"Full response: {data}"
            )

        raw_price = coin_data.get(vs_lower)
        if raw_price is None:
            raise OracleError(
                f"CoinGecko: vs_currency '{vs_lower}' not in response for {cg_id}"
            )

        price = Decimal(str(raw_price))
        self._cache[cg_id] = (price, int(time.time()))
        return price

    async def fetch(self, symbol: str, *, vs: str = "USD") -> PriceResult:
        """Return a PriceResult for symbol/vs from CoinGecko.

        Results are cached for cache_ttl seconds to stay within free-tier rate limits.

        Raises:
            OracleNotFound  — symbol not in the mapping table.
            OracleError     — network / API error.
        """
        cg_id = _resolve_cg_id(symbol)

        cached_price = self._cached(cg_id)
        if cached_price is not None:
            fetched_at = self._cache[cg_id][1]
            staleness = int(time.time()) - fetched_at
            logger.debug(f"CoinGecko cache hit: {symbol} = {cached_price} (age={staleness}s)")
            return PriceResult(
                symbol=symbol.upper(),
                price=cached_price,
                source="coingecko",
                timestamp=fetched_at,
                staleness_seconds=staleness,
                confidence="medium",
            )

        now = int(time.time())
        price = await self._fetch_from_api(cg_id, vs)

        logger.debug(f"CoinGecko fetch: {symbol} ({cg_id}) = {price} {vs.upper()}")

        return PriceResult(
            symbol=symbol.upper(),
            price=price,
            source="coingecko",
            timestamp=now,
            staleness_seconds=0,
            confidence="medium",
        )

    async def aclose(self) -> None:
        await self._client.aclose()
