"""Chainlink Data Feed oracle — reads latestRoundData() on-chain via web3.py.

Feeds are Ethereum mainnet aggregator proxies (EACAggregatorProxy).
Staleness threshold: 30 minutes.  Confidence: "high".
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Any

from loguru import logger
from web3 import AsyncWeb3
from web3.providers import AsyncHTTPProvider

from src.oracles.base import OracleError, OracleNotFound, OracleStale, PriceResult, PriceSource

# Minimal ABI — only what we need.
_AGGREGATOR_ABI: list[dict[str, Any]] = [
    {
        "name": "latestRoundData",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [
            {"name": "roundId", "type": "uint80"},
            {"name": "answer", "type": "int256"},
            {"name": "startedAt", "type": "uint256"},
            {"name": "updatedAt", "type": "uint256"},
            {"name": "answeredInRound", "type": "uint80"},
        ],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
]

# Ethereum mainnet Chainlink aggregator proxy addresses (checksummed).
# Sources: https://docs.chain.link/data-feeds/price-feeds/addresses
# All verified as of 2026-06.
_FEEDS_ETHEREUM: dict[str, str] = {
    "BTC/USD":  "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88",
    "ETH/USD":  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "USDC/USD": "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    "USDT/USD": "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    "PAXG/USD": "0x54614f4f1D7a8b4C0C800D4c4e3b87f50D5Abf94",
    "XAU/USD":  "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
}

# Map normalised lookup key → canonical feed key and chain feeds dict.
_CHAIN_FEEDS: dict[str, dict[str, str]] = {
    "ethereum": _FEEDS_ETHEREUM,
}

# How old a price may be before we consider it stale (seconds).
STALENESS_THRESHOLD = 30 * 60  # 30 min

# Canonical alias normalization: symbol or "SYMBOL/USD" → feed key.
_ALIASES: dict[str, str] = {
    "btc":      "BTC/USD",
    "bitcoin":  "BTC/USD",
    "eth":      "ETH/USD",
    "ether":    "ETH/USD",
    "ethereum": "ETH/USD",
    "usdc":     "USDC/USD",
    "usdt":     "USDT/USD",
    "tether":   "USDT/USD",
    "paxg":     "PAXG/USD",
    "xau":      "XAU/USD",
    "gold":     "XAU/USD",
}


def _resolve_feed_key(symbol: str, vs: str, feeds: dict[str, str]) -> str:
    """Return the canonical feed key (e.g. 'BTC/USD') or raise OracleNotFound."""
    # Try "SYMBOL/VS" directly (case-insensitive)
    candidate = f"{symbol.upper()}/{vs.upper()}"
    for key in feeds:
        if key.lower() == candidate.lower():
            return key

    # Try alias map
    alias_key = _ALIASES.get(symbol.lower())
    if alias_key and alias_key.lower().endswith(f"/{vs.lower()}"):
        if alias_key in feeds:
            return alias_key

    raise OracleNotFound(
        f"No Chainlink feed for {symbol}/{vs} on this chain. "
        f"Available: {sorted(feeds)}"
    )


class ChainlinkOracle(PriceSource):
    """Reads Chainlink Data Feed aggregators directly on-chain."""

    def __init__(self, rpc_url: str, *, chain: str = "ethereum") -> None:
        if chain not in _CHAIN_FEEDS:
            raise ValueError(
                f"Unsupported chain '{chain}'. Available: {sorted(_CHAIN_FEEDS)}"
            )
        self._w3 = AsyncWeb3(AsyncHTTPProvider(rpc_url))
        self._chain = chain
        self._feeds = _CHAIN_FEEDS[chain]
        # Cache: feed_key → (decimals, timestamp_cached)
        self._decimals_cache: dict[str, int] = {}

    async def _get_decimals(self, address: str, contract: Any) -> int:
        """Fetch decimals once and cache them (they never change)."""
        addr_lower = address.lower()
        if addr_lower not in self._decimals_cache:
            self._decimals_cache[addr_lower] = await contract.functions.decimals().call()
        return self._decimals_cache[addr_lower]

    async def fetch(self, symbol: str, *, vs: str = "USD") -> PriceResult:
        """Fetch the latest price from the appropriate Chainlink aggregator.

        Raises:
            OracleNotFound  — feed not configured for this symbol/vs pair.
            OracleStale     — updatedAt is older than STALENESS_THRESHOLD.
            OracleError     — RPC call failed.
        """
        feed_key = _resolve_feed_key(symbol, vs, self._feeds)
        address = self._feeds[feed_key]

        contract = self._w3.eth.contract(
            address=AsyncWeb3.to_checksum_address(address),
            abi=_AGGREGATOR_ABI,
        )

        try:
            _round_id, answer, _started_at, updated_at, _answered_in = (
                await contract.functions.latestRoundData().call()
            )
            decimals = await self._get_decimals(address, contract)
        except Exception as exc:
            raise OracleError(
                f"Chainlink RPC call failed for {feed_key}: {exc}"
            ) from exc

        now = int(time.time())
        staleness = now - updated_at

        if staleness > STALENESS_THRESHOLD:
            raise OracleStale(
                f"Chainlink {feed_key} is {staleness}s old "
                f"(threshold {STALENESS_THRESHOLD}s, updatedAt={updated_at})"
            )

        price = Decimal(answer) / Decimal(10**decimals)

        logger.debug(
            f"Chainlink {feed_key}: {price} (staleness={staleness}s, "
            f"chain={self._chain})"
        )

        return PriceResult(
            symbol=feed_key.split("/")[0],
            price=price,
            source=f"chainlink:{self._chain}",
            timestamp=updated_at,
            staleness_seconds=staleness,
            confidence="high",
        )
