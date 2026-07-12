"""Common interface for price oracle sources."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal


@dataclass(slots=True, frozen=True)
class PriceResult:
    symbol: str
    price: Decimal
    source: str
    timestamp: int  # unix seconds when the price was published on-chain / fetched
    staleness_seconds: int  # age of the price at fetch time
    confidence: Literal["high", "medium", "low"]


class OracleError(Exception):
    """Base exception for oracle failures."""


class OracleStale(OracleError):
    """Raised when the feed's last update is older than the staleness threshold."""


class OracleNotFound(OracleError):
    """Raised when no feed is configured for the requested symbol."""


class PriceSource(ABC):
    """Abstract price oracle.  All oracles implement this single method."""

    @abstractmethod
    async def fetch(self, symbol: str, *, vs: str = "USD") -> PriceResult:
        """Return a PriceResult for *symbol* quoted in *vs*.

        Raises:
            OracleNotFound  — symbol/pair not supported by this source.
            OracleStale     — data is present but too old to be trusted.
            OracleError     — any other retrieval failure.
        """
