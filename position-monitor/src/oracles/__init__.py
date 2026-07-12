"""Price oracles — Chainlink (primary, on-chain) + CoinGecko (confirmation, REST)."""
from src.oracles.base import PriceSource, PriceResult, OracleError
from src.oracles.chainlink import ChainlinkOracle
from src.oracles.coingecko import CoinGeckoOracle

__all__ = [
    "ChainlinkOracle",
    "CoinGeckoOracle",
    "PriceSource",
    "PriceResult",
    "OracleError",
]
