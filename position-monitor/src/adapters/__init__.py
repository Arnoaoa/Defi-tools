"""Protocol adapters. Each module implements ProtocolAdapter."""
from src.adapters.aave import AaveV3Adapter
from src.adapters.apex_omni import ApexOmniAdapter
from src.adapters.base import (
    AdapterError,
    AdapterNotFound,
    AdapterTimeout,
    AdapterUnauthorized,
    ProtocolAdapter,
)
from src.adapters.euler import EulerV2Adapter
from src.adapters.hyperliquid import HyperliquidAdapter
from src.adapters.morpho import MorphoAdapter
from src.adapters.pendle import PendleAdapter

__all__ = [
    "AaveV3Adapter",
    "AdapterError",
    "AdapterNotFound",
    "AdapterTimeout",
    "AdapterUnauthorized",
    "ApexOmniAdapter",
    "EulerV2Adapter",
    "HyperliquidAdapter",
    "MorphoAdapter",
    "PendleAdapter",
    "ProtocolAdapter",
]
