"""ProtocolAdapter — abstract interface that every protocol module implements.

Each adapter is async and stateless beyond its constructor config.
Errors are surfaced via exceptions; callers (main loop) handle retry/skip.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from src.models import MarketState, Position


class AdapterError(Exception):
    """Base exception for adapter failures."""


class AdapterTimeout(AdapterError):
    """Raised when an upstream API doesn't respond in time."""


class AdapterUnauthorized(AdapterError):
    """Raised when an API key is missing or invalid."""


class AdapterNotFound(AdapterError):
    """Raised when a requested resource (position, market) is not found."""


class ProtocolAdapter(ABC):
    """Abstract adapter. Each protocol implements this contract.

    Implementations must be:
      - Read-only (never sign / send transactions).
      - Idempotent (safe to call repeatedly).
      - Free of side effects (no DB writes; main loop persists results).
    """

    name: str  # short identifier (e.g. "hyperliquid", "morpho")
    supports_perps: bool = False
    supports_lending: bool = False
    supports_pt: bool = False

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}

    @abstractmethod
    async def fetch_positions(
        self, *, address: str, **kwargs: Any
    ) -> list[Position]:
        """Return all open positions for a given address.

        kwargs allow protocol-specific filters (e.g. market_id for Morpho,
        chain for multi-chain protocols, pt_contract for Pendle).
        """

    @abstractmethod
    async def fetch_market_state(
        self, *, market_id: str, **kwargs: Any
    ) -> MarketState:
        """Return live market data for a specific market / symbol."""

    async def healthcheck(self) -> bool:
        """Return True if the upstream API is reachable.

        Default: subclasses can override. Used by main loop to skip dead protocols.
        """
        return True

    async def aclose(self) -> None:
        """Close any internal HTTP / WS clients. Default no-op."""
        return
