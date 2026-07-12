"""Configuration: env vars + strategies.yaml validation.

Two sources:
  - .env (via python-dotenv)        — secrets, RPC URLs, paths
  - strategies.yaml (via ruamel)    — user-declared strategies and thresholds

Pydantic enforces a strict schema on strategies — a typo in the YAML fails fast.
"""
from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator
from ruamel.yaml import YAML


# ============================================================
# Pydantic models for strategies.yaml
# ============================================================


class WalletConfig(BaseModel):
    """One wallet declared in strategies.yaml.

    group = 'self'  → counts toward portfolio + drives alerts.
    group = 'watch' → read-only observation (whales / strategies to copy).
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    address: str
    chain: str = "ethereum"
    group: str = "self"  # 'self' | 'watch'
    notes: str | None = None

    @field_validator("group")
    @classmethod
    def _check_group(cls, v: str) -> str:
        if v not in ("self", "watch"):
            raise ValueError(f"group must be 'self' or 'watch', got {v!r}")
        return v


class LegConfig(BaseModel):
    """One leg of a composite strategy."""

    model_config = ConfigDict(extra="allow")  # protocol-specific extras OK

    protocol: str  # hyperliquid / morpho / pendle / aave / euler / apex_omni / spot
    role: str  # spot / short_perp / collateral / debt / pt_long / short_hedge / collateral_and_debt
    chain: str | None = None
    asset: str | None = None
    account: str | None = None  # Hyperliquid account (legacy: raw address)
    wallet: str | None = None  # EVM wallet (legacy: raw address)
    wallet_id: str | None = None  # NEW: references a WalletConfig.id
    market_id: str | None = None
    pt_contract: str | None = None
    symbol: str | None = None  # CEX-style (XAU-USDT etc.)

    # Apex Mode B fields (also used for manual_position spot entries)
    size_native: Decimal | None = None
    entry_price: Decimal | None = None
    entry_ts: str | None = None

    # Tactical strategy fields
    watch_tokens: list[dict[str, str]] | None = None

    @field_validator("size_native", "entry_price", mode="before")
    @classmethod
    def _to_decimal(cls, v: Any) -> Decimal | None:
        if v is None or v == "":
            return None
        return Decimal(str(v))


class ManualPosition(BaseModel):
    """Manually-declared position (no API fetch — user owns the values).

    Use for assets the monitor can't auto-fetch: OTC spot, LP shares that
    aren't tokenized, staked positions on protocols not yet covered, etc.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    wallet_id: str
    chain: str
    asset: str
    protocol: str = "manual"
    side: str = "spot"  # 'spot' | 'long' | 'short' | 'collateral' | 'debt'
    size_native: Decimal
    entry_price: Decimal | None = None
    entry_ts: str | None = None
    notes: str | None = None

    @field_validator("size_native", "entry_price", mode="before")
    @classmethod
    def _to_decimal(cls, v: Any) -> Decimal | None:
        if v is None or v == "":
            return None
        return Decimal(str(v))


class StrategyThresholds(BaseModel):
    """Per-strategy alert thresholds (override globals)."""

    model_config = ConfigDict(extra="forbid")

    hf_warning: Decimal | None = None
    hf_urgent: Decimal | None = None
    hf_critical: Decimal | None = None
    funding_flip_n_prints: int | None = None
    depeg_threshold_pct: Decimal | None = None
    depeg_persistence_min: int | None = None
    drawdown_24h_pct: Decimal | None = None
    pendle_expiry_warning_days: int | None = None
    pendle_expiry_urgent_days: int | None = None
    pendle_expiry_critical_days: int | None = None

    @field_validator(
        "hf_warning", "hf_urgent", "hf_critical",
        "depeg_threshold_pct", "drawdown_24h_pct",
        mode="before",
    )
    @classmethod
    def _to_decimal(cls, v: Any) -> Decimal | None:
        if v is None:
            return None
        return Decimal(str(v))


class StrategyConfig(BaseModel):
    """One composite strategy declaration."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    type: str = "composite"  # passive / delta_neutral / leveraged_yield / spot / composite
    delta_target_pct: Decimal = Decimal(0)
    legs: list[LegConfig]
    thresholds: StrategyThresholds | None = None

    @field_validator("delta_target_pct", mode="before")
    @classmethod
    def _to_decimal(cls, v: Any) -> Decimal:
        return Decimal(str(v))


class RpcConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    ethereum: str | None = None
    arbitrum: str | None = None
    base: str | None = None
    avalanche: str | None = None
    optimism: str | None = None


class GlobalDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hf_warning: Decimal = Decimal("1.5")
    hf_urgent: Decimal = Decimal("1.2")
    hf_critical: Decimal = Decimal("1.05")
    funding_flip_n_prints: int = 3
    depeg_threshold_pct: Decimal = Decimal("1.0")
    depeg_persistence_min: int = 15
    drawdown_24h_pct: Decimal = Decimal("15")
    pendle_expiry_warning_days: int = 30
    pendle_expiry_urgent_days: int = 7
    pendle_expiry_critical_days: int = 1

    @field_validator(
        "hf_warning", "hf_urgent", "hf_critical",
        "depeg_threshold_pct", "drawdown_24h_pct",
        mode="before",
    )
    @classmethod
    def _to_decimal(cls, v: Any) -> Decimal:
        return Decimal(str(v))


class StrategiesFile(BaseModel):
    """Top-level strategies.yaml schema."""

    model_config = ConfigDict(extra="forbid")
    rpc: RpcConfig = Field(default_factory=RpcConfig)
    defaults: GlobalDefaults = Field(default_factory=GlobalDefaults)
    wallets: list[WalletConfig] = Field(default_factory=list)
    strategies: list[StrategyConfig]
    manual_positions: list[ManualPosition] = Field(default_factory=list)

    def get_wallet(self, wallet_id: str) -> WalletConfig | None:
        for w in self.wallets:
            if w.id == wallet_id:
                return w
        return None

    def self_wallets(self) -> list[WalletConfig]:
        return [w for w in self.wallets if w.group == "self"]

    def watch_wallets(self) -> list[WalletConfig]:
        return [w for w in self.wallets if w.group == "watch"]


# ============================================================
# Env config
# ============================================================


class EnvConfig(BaseModel):
    """Runtime env configuration (from .env)."""

    model_config = ConfigDict(extra="ignore")

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    alchemy_api_key: str = ""
    ankr_api_key: str = ""
    graph_api_key: str = ""
    coingecko_api_key: str = ""
    etherscan_api_key: str = ""  # Etherscan V2: one key for 60+ chains

    alchemy_eth_url: str = ""
    alchemy_arb_url: str = ""
    alchemy_base_url: str = ""
    alchemy_opt_url: str = ""
    ankr_avax_url: str = ""

    monitor_log_level: str = "INFO"
    monitor_db_path: str = "./data/monitor.sqlite"
    monitor_heartbeat_path: str = "./data/last_heartbeat.txt"

    api_host: str = "127.0.0.1"
    api_port: int = 8000
    dashboard_origin: str = "http://localhost:3000"


# ============================================================
# Loaders
# ============================================================


def load_env(env_path: str | Path = ".env") -> EnvConfig:
    """Load .env into EnvConfig. Missing keys default to '' (empty string)."""
    load_dotenv(env_path, override=False)
    raw = {k.lower(): v for k, v in os.environ.items() if k.isupper()}
    return EnvConfig(**raw)


def load_strategies(path: str | Path = "strategies.yaml") -> StrategiesFile:
    """Parse + validate strategies.yaml. Resolves ${ENV} placeholders in rpc URLs."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"strategies.yaml not found at {p}. "
            f"Copy strategies.example.yaml to strategies.yaml and fill it."
        )
    yaml = YAML(typ="safe")
    data = yaml.load(p.read_text(encoding="utf-8"))

    # Resolve ${ENV_VAR} in rpc section
    if "rpc" in data and isinstance(data["rpc"], dict):
        for k, v in data["rpc"].items():
            if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
                env_key = v[2:-1]
                data["rpc"][k] = os.environ.get(env_key, "")

    result = StrategiesFile.model_validate(data)

    try:
        from src.storage import Database
        env = load_env()
        db = Database(env.monitor_db_path)
        db_strats = db.list_strategies()
        db.close()
        by_id = {s.id: s for s in result.strategies}
        for row in db_strats:
            legs = [LegConfig(protocol=leg["protocol"], role=leg["role"],
                              asset=leg.get("asset"), chain=leg.get("chain"),
                              symbol=leg.get("symbol"), wallet_id=leg.get("wallet_id"))
                    for leg in row["legs"]]
            by_id[row["id"]] = StrategyConfig(
                id=row["id"],
                name=row["name"],
                type=row["type"],
                delta_target_pct=Decimal(row["delta_target_pct"]),
                legs=legs,
            )
        result.strategies = list(by_id.values())
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"DB strategy merge failed: {e}")

    return result


def load_all(
    env_path: str | Path = ".env",
    strategies_path: str | Path = "strategies.yaml",
) -> tuple[EnvConfig, StrategiesFile]:
    """Load both env + strategies in one call. Order matters (env first for placeholders)."""
    env = load_env(env_path)
    strategies = load_strategies(strategies_path)
    return env, strategies
