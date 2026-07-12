"""Euler V2 adapter — read-only via Goldsky subgraph + on-chain Lens contracts.

Architecture:
  1. Primary data source : Goldsky public subgraph (no API key required)
     - trackingActiveAccount entity → active deposits/borrows per sub-account
     - eulerVaults entity           → vault metadata (APY, totalBorrows, etc.)
  2. On-chain fallback / enrichment : AccountLens + VaultLens (web3.py)
     - AccountLens.getAccountInfo(account, vault)
       → collateralValueLiquidation / liabilityValueLiquidation  (HF source)
     - VaultLens.getVaultInfoFull(vault)
       → LTV, interest rates, oracle price

Sub-account model (EVC):
  Each Ethereum address controls 256 virtual sub-accounts identified by a 1-byte
  selector (0–255). Sub-account addresses are derived by XOR-ing the owner address
  (as uint160) with the sub-account ID: sub_addr = owner XOR id.
  Sub-account 0 = the wallet itself.

Health Factor formula (from Euler docs, AccountLens source):
  HF = collateralValueLiquidation / liabilityValueLiquidation
  Both values are returned by AccountLens in the vault's unit-of-account (usually USD).
  HF < 1 → position is liquidatable.

LTV precision:
  liquidationLTV and borrowLTV are stored as basis points (1e4 = 100%).
  The adapter normalises to [0, 1] Decimal for the Position.liquidation_threshold field.

Deployed contract addresses (Ethereum mainnet):
  EVC             : 0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383
  AccountLens     : 0xA60c4257c809353039A71527dfe701B577e34bc7
  VaultLens       : 0x7427E9Ef64BBe73D40BBcF455D50d215E50f3177

Source references:
  Subgraph docs  : https://docs.euler.finance/developers/data-querying/subgraphs/
  Lens docs      : https://docs.euler.finance/developers/data-querying/using-lens-contracts/
  Contracts repo : https://github.com/euler-xyz/euler-interfaces

TODO (before production use):
  - TODO[1] Validate AccountLens ABI below against the live euler-interfaces repo ABI.
            Fetch: https://raw.githubusercontent.com/euler-xyz/euler-interfaces/master/abis/AccountLens.json
  - TODO[2] Validate VaultLens ABI below against the live euler-interfaces repo ABI.
            Fetch: https://raw.githubusercontent.com/euler-xyz/euler-interfaces/master/abis/VaultLens.json
  - TODO[3] Provide a funded test wallet that has Euler V2 positions (mainnet) to run
            integration tests. Example: check the Euler Finance app for active borrowers.
  - TODO[4] Add L2 chain support for EVC addresses (Base EVC: 0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989).
            Extend _CHAIN_CONFIG with per-chain EVC + Lens addresses.
  - TODO[5] The Goldsky subgraph `deposits`/`borrows` fields return concatenated strings
            ("${subAccount}${vault}" — 42+42=84 chars). If the format ever changes,
            update _parse_position_key() accordingly.
  - TODO[6] Oracle prices returned by VaultLens are denominated in the vault's
            unitOfAccount (usually USD or ETH). If unitOfAccount != USD, convert.
            Current implementation sets oracle_price = raw value from lens (no conversion).
  - TODO[7] Euler Earn vaults (yield strategies) are distinct from EVK lending vaults.
            This adapter targets EVK only; Earn positions are skipped.
"""
from __future__ import annotations

import asyncio
import time
from decimal import Decimal
from typing import Any

import httpx
from loguru import logger

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

DEFAULT_TIMEOUT = 15.0
VAULT_CACHE_TTL = 300  # 5 min — LTV and decimals are stable

# Basis points divisor — LTV stored as integers (e.g. 9000 = 90%)
_BPS = Decimal("10000")

# Subgraph APY fields are stored as decimal fractions (0.05 = 5%)
# No conversion needed.

# ---------------------------------------------------------------------------
# Chain configuration
# ---------------------------------------------------------------------------

# Goldsky public subgraph URLs — no API key required
_GOLDSKY_BASE = "https://api.goldsky.com/api/public/project_cm4iagnemt1wp01xn4gh1agft/subgraphs"

_CHAIN_CONFIG: dict[str, dict[str, str]] = {
    "ethereum": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-mainnet/latest/gn",
        "evc": "0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383",
        "account_lens": "0xA60c4257c809353039A71527dfe701B577e34bc7",
        "vault_lens": "0x7427E9Ef64BBe73D40BBcF455D50d215E50f3177",
    },
    "base": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-base/latest/gn",
        "evc": "0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989",
        "account_lens": "0xe6b05A38D6a29D2C8277fA1A8BA069F1693b780C",
        "vault_lens": "0x601F023CD063324DdbCADa69460e969fb97e98b9",
    },
    "arbitrum": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-arbitrum/latest/gn",
        # TODO[4]: Confirm EVC address for Arbitrum — check euler-interfaces/addresses/42161/
        "evc": "",
        "account_lens": "0x90a52DDcb232e7bb003DD9258fA1235c553eC956",
        "vault_lens": "0x8E0321a0f6d37411136077215ED9A539C1B16258",
    },
    "optimism": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-optimism/latest/gn",
        "evc": "",
        "account_lens": "",
        "vault_lens": "",
    },
    "avalanche": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-avalanche/latest/gn",
        "evc": "",
        "account_lens": "",
        "vault_lens": "",
    },
    "bsc": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-bsc/latest/gn",
        "evc": "",
        "account_lens": "",
        "vault_lens": "",
    },
    "sonic": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-sonic/latest/gn",
        "evc": "",
        "account_lens": "",
        "vault_lens": "",
    },
    "berachain": {
        "subgraph_url": f"{_GOLDSKY_BASE}/euler-v2-berachain/latest/gn",
        "evc": "",
        "account_lens": "",
        "vault_lens": "",
    },
}

SUPPORTED_CHAINS = set(_CHAIN_CONFIG.keys())

# ---------------------------------------------------------------------------
# Minimal ABIs for on-chain calls
# TODO[1] and TODO[2]: replace with full ABIs from euler-interfaces repo
# ---------------------------------------------------------------------------

# AccountLens ABI — minimal subset for getAccountInfo
_ACCOUNT_LENS_ABI = [
    {
        "name": "getAccountInfo",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "vault", "type": "address"},
        ],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    # EVCAccountInfo (ignored here — we care about vaultAccountInfo)
                    {
                        "name": "evcAccountInfo",
                        "type": "tuple",
                        "components": [
                            {"name": "evc", "type": "address"},
                            {"name": "account", "type": "address"},
                            {"name": "addressPrefix", "type": "bytes19"},
                            {"name": "owner", "type": "address"},
                            {"name": "isLockdownMode", "type": "bool"},
                            {"name": "isPermitDisabledMode", "type": "bool"},
                            {"name": "lastAccountStatusCheckTimestamp", "type": "uint256"},
                            {"name": "enabledControllers", "type": "address[]"},
                            {"name": "enabledCollaterals", "type": "address[]"},
                        ],
                    },
                    # VaultAccountInfo
                    {
                        "name": "vaultAccountInfo",
                        "type": "tuple",
                        "components": [
                            {"name": "account", "type": "address"},
                            {"name": "vault", "type": "address"},
                            {"name": "asset", "type": "address"},
                            {"name": "shares", "type": "uint256"},
                            {"name": "assets", "type": "uint256"},
                            {"name": "borrowed", "type": "uint256"},
                            {"name": "assetAllowanceVault", "type": "uint256"},
                            {"name": "assetAllowanceVaultPermit2", "type": "uint256"},
                            {"name": "assetAllowanceExpiryVaultPermit2", "type": "uint256"},
                            {"name": "assetAllowancePermit2", "type": "uint256"},
                            {"name": "balanceForwarderEnabled", "type": "bool"},
                            {"name": "isController", "type": "bool"},
                            {"name": "isCollateral", "type": "bool"},
                            {
                                "name": "liquidityInfo",
                                "type": "tuple",
                                "components": [
                                    {"name": "timeToLiquidation", "type": "int256"},
                                    {"name": "liabilityValueBorrowing", "type": "uint256"},
                                    {"name": "liabilityValueLiquidation", "type": "uint256"},
                                    {"name": "collateralValueBorrowing", "type": "uint256"},
                                    {"name": "collateralValueLiquidation", "type": "uint256"},
                                    {"name": "collateralValueRaw", "type": "uint256"},
                                    {
                                        "name": "collateralLiquidityBorrowingInfo",
                                        "type": "tuple[]",
                                        "components": [
                                            {"name": "collateral", "type": "address"},
                                            {"name": "collateralValueBorrowing", "type": "uint256"},
                                            {"name": "collateralValueLiquidation", "type": "uint256"},
                                            {"name": "collateralValueRaw", "type": "uint256"},
                                        ],
                                    },
                                    {"name": "queryFailure", "type": "bool"},
                                    {"name": "queryFailureReason", "type": "bytes"},
                                ],
                            },
                        ],
                    },
                    # AccountRewardInfo (ignored)
                    {"name": "accountRewardInfo", "type": "tuple", "components": []},
                ],
            }
        ],
    }
]

# VaultLens ABI — minimal subset for getVaultInfoFull
_VAULT_LENS_ABI = [
    {
        "name": "getVaultInfoFull",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "vault", "type": "address"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    # Static fields
                    {"name": "vault", "type": "address"},
                    {"name": "vaultName", "type": "string"},
                    {"name": "vaultSymbol", "type": "string"},
                    {"name": "vaultDecimals", "type": "uint8"},
                    {"name": "asset", "type": "address"},
                    {"name": "assetName", "type": "string"},
                    {"name": "assetSymbol", "type": "string"},
                    {"name": "assetDecimals", "type": "uint8"},
                    {"name": "unitOfAccount", "type": "address"},
                    # Dynamic fields
                    {"name": "totalShares", "type": "uint256"},
                    {"name": "totalCash", "type": "uint256"},
                    {"name": "totalBorrowed", "type": "uint256"},
                    {"name": "totalAssets", "type": "uint256"},
                    {"name": "accumulatedFeesShares", "type": "uint256"},
                    {"name": "accumulatedFeesAssets", "type": "uint256"},
                    {"name": "governorFeeShare", "type": "uint256"},
                    {"name": "protocolFeeShare", "type": "uint256"},
                    {"name": "protocolFeeReceiver", "type": "address"},
                    {"name": "supplyCap", "type": "uint256"},
                    {"name": "borrowCap", "type": "uint256"},
                    {"name": "maxLiquidationDiscount", "type": "uint256"},
                    {"name": "liquidationCoolOffTime", "type": "uint256"},
                    {"name": "hookedOperations", "type": "uint32"},
                    {"name": "configFlags", "type": "uint32"},
                    {"name": "isFrozen", "type": "bool"},
                    {"name": "isOperationPaused", "type": "bool"},
                    # IRM info
                    {
                        "name": "irmInfo",
                        "type": "tuple",
                        "components": [
                            {"name": "vault", "type": "address"},
                            {"name": "interestRateModel", "type": "address"},
                            {"name": "interestFee", "type": "uint256"},
                            {"name": "borrowSPY", "type": "uint256"},
                            {"name": "borrowAPY", "type": "uint256"},
                            {"name": "supplyAPY", "type": "uint256"},
                            {"name": "cash", "type": "uint256"},
                            {"name": "borrows", "type": "uint256"},
                        ],
                    },
                    # Collateral LTV info
                    {
                        "name": "collateralLTVInfo",
                        "type": "tuple[]",
                        "components": [
                            {"name": "collateral", "type": "address"},
                            {"name": "borrowLTV", "type": "uint16"},
                            {"name": "liquidationLTV", "type": "uint16"},
                            {"name": "initialLiquidationLTV", "type": "uint16"},
                            {"name": "targetTimestamp", "type": "uint48"},
                            {"name": "rampDuration", "type": "uint32"},
                        ],
                    },
                    # Oracle info (liability)
                    {
                        "name": "liabilityPriceInfo",
                        "type": "tuple",
                        "components": [
                            {"name": "oracle", "type": "address"},
                            {"name": "asset", "type": "address"},
                            {"name": "unitOfAccount", "type": "address"},
                            {"name": "amountIn", "type": "uint256"},
                            {"name": "amountOutMid", "type": "uint256"},
                            {"name": "amountOutBid", "type": "uint256"},
                            {"name": "amountOutAsk", "type": "uint256"},
                            {"name": "queryFailure", "type": "bool"},
                            {"name": "queryFailureReason", "type": "bytes"},
                        ],
                    },
                ],
            }
        ],
    }
]

# ---------------------------------------------------------------------------
# GraphQL queries
# ---------------------------------------------------------------------------

_QUERY_ACTIVE_ACCOUNT = """
query ActiveAccount($id: ID!) {
  trackingActiveAccount(id: $id) {
    mainAddress
    deposits
    borrows
  }
}
"""

_QUERY_VAULT = """
query Vault($id: ID!) {
  eulerVaults(where: {id: $id}) {
    id
    name
    symbol
    asset
    decimals
    oracle
    interestRateModel
    unitOfAccount
    state {
      totalShares
      totalBorrows
      cash
      supplyApy
      borrowApy
      interestRate
      timestamp
    }
  }
}
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _d(value: Any) -> Decimal | None:
    """Convert any value to Decimal, returning None on failure."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _sub_account_address(owner: str, sub_id: int) -> str:
    """Derive the EVC sub-account address for a given owner and sub-account ID.

    EVC encoding: sub_account_address = uint160(owner) XOR uint160(sub_id)
    sub_id is in [0, 255]; sub_id=0 returns the owner address itself.
    """
    owner_int = int(owner, 16)
    return "0x{:040x}".format(owner_int ^ sub_id)


def _parse_position_key(key: str) -> tuple[str, str] | None:
    """Parse a Goldsky position key of the form ${subAccount}${vault}.

    Both addresses are 42 chars (0x + 40 hex). Total = 84 chars.
    Returns (sub_account_address, vault_address) or None if malformed.
    """
    key = key.strip()
    if len(key) != 84:
        logger.warning(f"EulerV2: unexpected position key length {len(key)}: {key!r}")
        return None
    sub_account = key[:42]
    vault = key[42:]
    if not sub_account.startswith("0x") or not vault.startswith("0x"):
        logger.warning(f"EulerV2: position key missing 0x prefix: {key!r}")
        return None
    return sub_account.lower(), vault.lower()


def _compute_hf(
    collateral_value_liq: int,
    liability_value_liq: int,
) -> Decimal | None:
    """HF = collateralValueLiquidation / liabilityValueLiquidation.

    Returns None if liability is 0 (no debt, no liquidation risk).
    Both values from AccountLens are in the vault's unitOfAccount (typically USD).
    """
    if liability_value_liq <= 0:
        return None
    return Decimal(collateral_value_liq) / Decimal(liability_value_liq)


def _wad_to_apy(wad_rate: int) -> Decimal:
    """Convert a per-second borrow rate in WAD (1e18) to approximate APY.

    APY = (1 + rate_per_second)^31536000 - 1
    """
    if wad_rate == 0:
        return Decimal(0)
    rate_per_second = float(Decimal(wad_rate) / Decimal("1e18"))
    try:
        return Decimal(str((1 + rate_per_second) ** 31_536_000 - 1))
    except (OverflowError, ValueError):
        return Decimal(wad_rate) / Decimal("1e18")


# ---------------------------------------------------------------------------
# Vault metadata cache
# ---------------------------------------------------------------------------


class _VaultMeta:
    """Cached vault metadata (LTV, decimals, symbol)."""

    __slots__ = (
        "vault_address",
        "asset_symbol",
        "asset_address",
        "asset_decimals",
        "vault_decimals",
        "liquidation_ltv",  # normalised [0, 1] Decimal — max across collaterals
        "supply_apy",
        "borrow_apy",
        "total_supply",
        "total_borrow",
        "oracle_price_raw",  # amountOutMid from liabilityPriceInfo (unit-of-account per amountIn)
        "cached_at",
    )

    def __init__(
        self,
        *,
        vault_address: str,
        asset_symbol: str,
        asset_address: str,
        asset_decimals: int,
        vault_decimals: int,
        liquidation_ltv: Decimal | None,
        supply_apy: Decimal | None,
        borrow_apy: Decimal | None,
        total_supply: Decimal | None,
        total_borrow: Decimal | None,
        oracle_price_raw: Decimal | None,
    ) -> None:
        self.vault_address = vault_address
        self.asset_symbol = asset_symbol
        self.asset_address = asset_address
        self.asset_decimals = asset_decimals
        self.vault_decimals = vault_decimals
        self.liquidation_ltv = liquidation_ltv
        self.supply_apy = supply_apy
        self.borrow_apy = borrow_apy
        self.total_supply = total_supply
        self.total_borrow = total_borrow
        self.oracle_price_raw = oracle_price_raw
        self.cached_at = int(time.time())

    def is_fresh(self) -> bool:
        return (int(time.time()) - self.cached_at) < VAULT_CACHE_TTL


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class EulerV2Adapter(ProtocolAdapter):
    """Euler V2 multi-chain lending adapter.

    Fetches user positions across EVC sub-accounts from:
      1. Goldsky public subgraph (primary — no API key required)
      2. On-chain AccountLens + VaultLens (fallback / enrichment via web3.py)

    Health factor is computed per-position (per controller vault) using the
    AccountLens formula: HF = collateralValueLiquidation / liabilityValueLiquidation.

    config keys:
      rpc_url (str)     : Ethereum RPC URL for on-chain calls (required for lens fallback)
                          Falls back to EULER_RPC_URL env var, then public Cloudflare endpoint.
      timeout (float)   : HTTP timeout in seconds (default 15)
      use_onchain (bool): Force on-chain lens calls even when subgraph is available (default False)
    """

    name = "euler_v2"
    supports_lending = True

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        import os

        timeout = float(self.config.get("timeout", DEFAULT_TIMEOUT))
        self._http = httpx.AsyncClient(
            timeout=timeout,
            headers={"Content-Type": "application/json"},
        )

        # RPC URL for on-chain calls (AccountLens / VaultLens)
        self._rpc_url: str = (
            self.config.get("rpc_url")
            or os.environ.get("EULER_RPC_URL")
            or os.environ.get("ETH_RPC_URL")
            or "https://cloudflare-eth.com"
        )
        self._use_onchain: bool = bool(self.config.get("use_onchain", False))

        # vault_address (lower) → _VaultMeta
        self._vault_cache: dict[str, _VaultMeta] = {}

        # Lazy web3 instance (initialised on first on-chain call)
        self._web3: Any | None = None

    # ------------------------------------------------------------------
    # Internal: subgraph query
    # ------------------------------------------------------------------

    def _subgraph_url(self, chain: str) -> str:
        cfg = _CHAIN_CONFIG.get(chain.lower())
        if not cfg:
            raise AdapterError(
                f"EulerV2: unsupported chain '{chain}'. "
                f"Supported: {sorted(SUPPORTED_CHAINS)}"
            )
        return cfg["subgraph_url"]

    async def _subgraph_query(
        self,
        chain: str,
        query: str,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = self._subgraph_url(chain)
        payload: dict[str, Any] = {"query": query}
        if variables:
            payload["variables"] = variables

        try:
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
        except httpx.TimeoutException as exc:
            raise AdapterTimeout(f"EulerV2 subgraph timeout ({chain})") from exc
        except httpx.HTTPStatusError as exc:
            raise AdapterError(
                f"EulerV2 subgraph HTTP {exc.response.status_code} ({chain}): "
                f"{exc.response.text[:200]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise AdapterError(f"EulerV2 subgraph error ({chain}): {exc}") from exc

        data = resp.json()
        if "errors" in data:
            raise AdapterError(
                f"EulerV2 GraphQL error ({chain}): {data['errors']}"
            )
        return data.get("data", {})

    # ------------------------------------------------------------------
    # Internal: on-chain calls via web3.py
    # ------------------------------------------------------------------

    def _get_web3(self, rpc_url: str | None = None) -> Any:
        """Return a Web3 instance, initialising lazily."""
        if self._web3 is None:
            try:
                from web3 import Web3  # type: ignore[import]
            except ImportError as exc:
                raise AdapterError(
                    "EulerV2: web3.py is required for on-chain calls. "
                    "Install it with: pip install web3"
                ) from exc
            url = rpc_url or self._rpc_url
            self._web3 = Web3(Web3.HTTPProvider(url))
        return self._web3

    async def _call_account_lens(
        self,
        chain: str,
        account: str,
        vault: str,
    ) -> dict[str, Any] | None:
        """Call AccountLens.getAccountInfo(account, vault) on-chain.

        Returns the raw struct as a dict, or None on failure.
        """
        cfg = _CHAIN_CONFIG.get(chain.lower(), {})
        lens_addr = cfg.get("account_lens", "")
        if not lens_addr:
            logger.warning(f"EulerV2: no AccountLens address for chain '{chain}'")
            return None

        try:
            w3 = self._get_web3()
            contract = w3.eth.contract(
                address=w3.to_checksum_address(lens_addr),
                abi=_ACCOUNT_LENS_ABI,
            )
            # Run blocking call in executor to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: contract.functions.getAccountInfo(
                    w3.to_checksum_address(account),
                    w3.to_checksum_address(vault),
                ).call(),
            )
            return result
        except Exception as exc:
            logger.warning(f"EulerV2: AccountLens call failed ({account}, {vault}): {exc}")
            return None

    async def _call_vault_lens(
        self,
        chain: str,
        vault: str,
    ) -> dict[str, Any] | None:
        """Call VaultLens.getVaultInfoFull(vault) on-chain.

        Returns the raw struct, or None on failure.
        """
        cfg = _CHAIN_CONFIG.get(chain.lower(), {})
        lens_addr = cfg.get("vault_lens", "")
        if not lens_addr:
            logger.warning(f"EulerV2: no VaultLens address for chain '{chain}'")
            return None

        try:
            w3 = self._get_web3()
            contract = w3.eth.contract(
                address=w3.to_checksum_address(lens_addr),
                abi=_VAULT_LENS_ABI,
            )
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: contract.functions.getVaultInfoFull(
                    w3.to_checksum_address(vault)
                ).call(),
            )
            return result
        except Exception as exc:
            logger.warning(f"EulerV2: VaultLens call failed ({vault}): {exc}")
            return None

    # ------------------------------------------------------------------
    # Vault metadata (subgraph + optional lens enrichment, cached)
    # ------------------------------------------------------------------

    async def _fetch_vault_meta(self, chain: str, vault: str) -> _VaultMeta:
        """Return cached vault metadata, fetching from subgraph / lens if stale."""
        key = vault.lower()
        cached = self._vault_cache.get(key)
        if cached and cached.is_fresh():
            return cached

        # Try subgraph first
        meta = await self._vault_meta_from_subgraph(chain, vault)

        # Optionally enrich with on-chain VaultLens (LTV, precise APY, oracle price)
        if meta is None or self._use_onchain:
            lens_meta = await self._vault_meta_from_lens(chain, vault)
            if lens_meta is not None:
                meta = lens_meta

        if meta is None:
            # Minimal fallback to avoid crashing — no useful data
            meta = _VaultMeta(
                vault_address=key,
                asset_symbol="UNKNOWN",
                asset_address="",
                asset_decimals=18,
                vault_decimals=18,
                liquidation_ltv=None,
                supply_apy=None,
                borrow_apy=None,
                total_supply=None,
                total_borrow=None,
                oracle_price_raw=None,
            )

        self._vault_cache[key] = meta
        return meta

    async def _vault_meta_from_subgraph(
        self, chain: str, vault: str
    ) -> _VaultMeta | None:
        try:
            data = await self._subgraph_query(
                chain, _QUERY_VAULT, {"id": vault.lower()}
            )
        except AdapterError:
            return None

        vaults = data.get("eulerVaults", [])
        if not vaults:
            return None

        v = vaults[0]
        state = v.get("state") or {}

        supply_apy = _d(state.get("supplyApy"))
        borrow_apy = _d(state.get("borrowApy"))
        total_supply_raw = _d(state.get("totalShares"))  # shares, not assets
        total_borrow_raw = _d(state.get("totalBorrows"))
        decimals = int(v.get("decimals", 18))

        # Subgraph does not expose LTV — will be filled by lens call if needed
        return _VaultMeta(
            vault_address=vault.lower(),
            asset_symbol=v.get("symbol", "UNKNOWN"),
            asset_address=(v.get("asset") or "").lower(),
            asset_decimals=decimals,
            vault_decimals=decimals,
            liquidation_ltv=None,  # not available in subgraph schema
            supply_apy=supply_apy,
            borrow_apy=borrow_apy,
            total_supply=total_supply_raw,
            total_borrow=total_borrow_raw,
            oracle_price_raw=None,
        )

    async def _vault_meta_from_lens(
        self, chain: str, vault: str
    ) -> _VaultMeta | None:
        raw = await self._call_vault_lens(chain, vault)
        if raw is None:
            return None

        # VaultInfoFull is returned as a tuple — index by position (see ABI above)
        try:
            # Positional indices matching _VAULT_LENS_ABI outputs[0].components
            vault_addr = raw[0]
            vault_name = raw[1]  # noqa: F841 — unused but present
            asset_symbol = raw[7]   # assetSymbol
            asset_decimals = int(raw[8])
            total_shares = int(raw[9])   # totalShares
            total_borrowed = int(raw[12])  # totalBorrowed
            irm_info = raw[26]           # irmInfo tuple
            ltv_info_list = raw[27]      # collateralLTVInfo[]
            liability_price = raw[28]    # liabilityPriceInfo

            supply_apy: Decimal | None = None
            borrow_apy: Decimal | None = None
            if irm_info:
                # borrowAPY and supplyAPY are stored as WAD (1e18 = 100%)
                # but some versions store them already as scaled fractions
                # Treat as WAD and normalise to [0, 1]
                borrow_apy_raw = int(irm_info[4]) if len(irm_info) > 4 else 0
                supply_apy_raw = int(irm_info[5]) if len(irm_info) > 5 else 0
                borrow_apy = Decimal(borrow_apy_raw) / Decimal("1e18")
                supply_apy = Decimal(supply_apy_raw) / Decimal("1e18")

            # Max liquidation LTV across all recognised collaterals
            max_liq_ltv: Decimal | None = None
            for ltv_entry in ltv_info_list or []:
                liq_ltv_bps = int(ltv_entry[2]) if len(ltv_entry) > 2 else 0
                liq_ltv = Decimal(liq_ltv_bps) / _BPS
                if max_liq_ltv is None or liq_ltv > max_liq_ltv:
                    max_liq_ltv = liq_ltv

            # Oracle price: amount of unitOfAccount tokens per `amountIn` of asset
            oracle_price_raw: Decimal | None = None
            if liability_price and not liability_price[-2]:  # queryFailure == False
                amount_in = int(liability_price[3])
                amount_out_mid = int(liability_price[4])
                if amount_in > 0:
                    oracle_price_raw = Decimal(amount_out_mid) / Decimal(amount_in)

            return _VaultMeta(
                vault_address=str(vault_addr).lower(),
                asset_symbol=str(asset_symbol),
                asset_address="",  # not directly returned; use asset field from static
                asset_decimals=asset_decimals,
                vault_decimals=asset_decimals,
                liquidation_ltv=max_liq_ltv,
                supply_apy=supply_apy,
                borrow_apy=borrow_apy,
                total_supply=Decimal(total_shares),
                total_borrow=Decimal(total_borrowed),
                oracle_price_raw=oracle_price_raw,
            )
        except (IndexError, TypeError, ValueError) as exc:
            logger.warning(
                f"EulerV2: could not parse VaultLens result for {vault}: {exc}"
            )
            return None

    # ------------------------------------------------------------------
    # Sub-account discovery
    # ------------------------------------------------------------------

    async def _discover_active_sub_accounts(
        self,
        chain: str,
        owner: str,
    ) -> dict[int, dict[str, list[str]]]:
        """Discover sub-accounts with active positions via subgraph.

        Returns a mapping: { sub_account_id → { "deposits": [...vault], "borrows": [...vault] } }
        Only sub-accounts with at least one deposit or borrow are returned.
        Sub-account 0 is always queried even if not in subgraph results.
        """
        owner_lower = owner.lower()
        result: dict[int, dict[str, list[str]]] = {}

        try:
            # The subgraph trackingActiveAccount uses the sub-account address as ID
            # We query sub-accounts 0..255 lazily: first check sub-account 0,
            # then discover others via subgraph wildcard pattern.
            # The subgraph doesn't support prefix-match — we check sub-account 0 always,
            # plus scan the subgraph for any account sharing the same 19-byte prefix.

            # Query sub-account 0 (= owner address itself)
            sub0_data = await self._subgraph_query(
                chain,
                _QUERY_ACTIVE_ACCOUNT,
                {"id": owner_lower},
            )
            sub0 = sub0_data.get("trackingActiveAccount")
            if sub0:
                deposits = [
                    _parse_position_key(k)
                    for k in (sub0.get("deposits") or [])
                ]
                borrows = [
                    _parse_position_key(k)
                    for k in (sub0.get("borrows") or [])
                ]
                deposit_vaults = [p[1] for p in deposits if p]
                borrow_vaults = [p[1] for p in borrows if p]
                if deposit_vaults or borrow_vaults:
                    result[0] = {
                        "deposits": deposit_vaults,
                        "borrows": borrow_vaults,
                    }

            # Scan sub-accounts 1..255 for activity
            # Each sub-account address = owner XOR sub_id
            # We batch these to avoid 255 sequential queries — send all concurrently.
            sub_ids = list(range(1, 256))
            sub_addresses = [
                (_sub_account_address(owner_lower, sid), sid) for sid in sub_ids
            ]

            coros = [
                self._subgraph_query(
                    chain,
                    _QUERY_ACTIVE_ACCOUNT,
                    {"id": addr},
                )
                for addr, _ in sub_addresses
            ]

            responses = await asyncio.gather(*coros, return_exceptions=True)

            for (addr, sid), resp in zip(sub_addresses, responses):
                if isinstance(resp, Exception):
                    continue  # silently skip failed sub-account lookups
                account_data = resp.get("trackingActiveAccount")
                if not account_data:
                    continue
                deposits = [
                    _parse_position_key(k)
                    for k in (account_data.get("deposits") or [])
                ]
                borrows = [
                    _parse_position_key(k)
                    for k in (account_data.get("borrows") or [])
                ]
                deposit_vaults = [p[1] for p in deposits if p]
                borrow_vaults = [p[1] for p in borrows if p]
                if deposit_vaults or borrow_vaults:
                    result[sid] = {
                        "deposits": deposit_vaults,
                        "borrows": borrow_vaults,
                    }

        except AdapterError as exc:
            logger.warning(
                f"EulerV2: subgraph discovery failed for {owner_lower} on {chain}: {exc}. "
                "Falling back to sub-account 0 only."
            )
            if 0 not in result:
                result[0] = {"deposits": [], "borrows": []}

        return result

    # ------------------------------------------------------------------
    # Position building
    # ------------------------------------------------------------------

    async def _build_positions_for_sub_account(
        self,
        *,
        chain: str,
        owner: str,
        sub_id: int,
        sub_address: str,
        deposit_vaults: list[str],
        borrow_vaults: list[str],
        ts: int,
    ) -> list[Position]:
        """Build Position objects for one sub-account.

        For each vault in deposit_vaults:  emit COLLATERAL position.
        For each vault in borrow_vaults:   emit DEBT position (with HF).
        HF is computed by querying AccountLens on the controller vault (borrow vault).
        """
        positions: list[Position] = []

        # Deduplicate vaults across deposits and borrows for metadata batch fetch
        all_vaults = list({*deposit_vaults, *borrow_vaults})
        vault_meta_tasks = [
            self._fetch_vault_meta(chain, v) for v in all_vaults
        ]
        vault_metas_list = await asyncio.gather(*vault_meta_tasks, return_exceptions=True)
        vault_metas: dict[str, _VaultMeta] = {}
        for vault, meta in zip(all_vaults, vault_metas_list):
            if not isinstance(meta, Exception):
                vault_metas[vault.lower()] = meta  # type: ignore[assignment]

        # Fetch AccountLens data for borrow vaults (controller vaults)
        # HF must be fetched from the controller vault — the one you borrowed from.
        account_info_tasks = {
            v: self._call_account_lens(chain, sub_address, v)
            for v in borrow_vaults
        }
        account_info_results: dict[str, Any] = {}
        if account_info_tasks:
            keys = list(account_info_tasks)
            results = await asyncio.gather(*account_info_tasks.values(), return_exceptions=True)
            for k, r in zip(keys, results):
                if not isinstance(r, Exception) and r is not None:
                    account_info_results[k.lower()] = r

        # Also fetch AccountLens for deposit-only vaults (to get shares→assets conversion)
        deposit_only = [v for v in deposit_vaults if v not in borrow_vaults]
        deposit_info_tasks = {
            v: self._call_account_lens(chain, sub_address, v)
            for v in deposit_only
        }
        if deposit_info_tasks:
            keys2 = list(deposit_info_tasks)
            results2 = await asyncio.gather(*deposit_info_tasks.values(), return_exceptions=True)
            for k, r in zip(keys2, results2):
                if not isinstance(r, Exception) and r is not None:
                    account_info_results[k.lower()] = r

        # ------------------------------------------------------------------
        # COLLATERAL positions (deposits)
        # ------------------------------------------------------------------
        for vault_addr in deposit_vaults:
            meta = vault_metas.get(vault_addr.lower())
            asset_symbol = meta.asset_symbol if meta else "UNKNOWN"
            liq_ltv = meta.liquidation_ltv if meta else None
            oracle_price = meta.oracle_price_raw if meta else None

            # Extract share/asset balance from AccountLens result
            size_native: Decimal = Decimal(0)
            size_usd: Decimal | None = None

            raw_info = account_info_results.get(vault_addr.lower())
            if raw_info is not None:
                try:
                    # raw_info is a tuple: (evcAccountInfo, vaultAccountInfo, accountRewardInfo)
                    vai = raw_info[1]  # VaultAccountInfo
                    assets = int(vai[4])  # assets field (shares converted to assets)
                    decimals = meta.asset_decimals if meta else 18
                    size_native = Decimal(assets) / Decimal(10**decimals)
                    if oracle_price and oracle_price > 0:
                        size_usd = size_native * oracle_price
                except (IndexError, TypeError, ValueError) as exc:
                    logger.debug(f"EulerV2: could not parse deposit assets for {vault_addr}: {exc}")

            # HF from controller vault if this account also borrows
            # (a collateral position shares the HF of the sub-account's controller)
            # We use the first borrow vault's HF as the account-level HF
            account_hf: Decimal | None = None
            for bv in borrow_vaults:
                bv_info = account_info_results.get(bv.lower())
                if bv_info is not None:
                    try:
                        vai_b = bv_info[1]
                        liq_info = vai_b[13]  # liquidityInfo
                        collateral_val_liq = int(liq_info[4])
                        liability_val_liq = int(liq_info[2])
                        account_hf = _compute_hf(collateral_val_liq, liability_val_liq)
                        break
                    except (IndexError, TypeError, ValueError):
                        pass

            positions.append(
                Position(
                    protocol=self.name,
                    chain=chain,
                    asset=asset_symbol,
                    side=PositionSide.COLLATERAL,
                    size_native=size_native,
                    size_usd=size_usd,
                    entry_price=None,
                    mark_price=oracle_price,
                    oracle_price=oracle_price,
                    health_factor=account_hf,
                    liquidation_threshold=liq_ltv,
                    market_id=vault_addr.lower(),
                    funding_rate=None,
                    funding_period_hours=None,
                    unrealized_pnl_usd=None,
                    liquidation_price=None,
                    pt_expiry_ts=None,
                    market_liquidity_usd=None,
                    implied_apy=None,
                    snapshot_ts=ts,
                    wallet=owner,
                    raw={
                        "sub_account_id": sub_id,
                        "sub_account_address": sub_address,
                        "vault": vault_addr,
                    },
                )
            )

        # ------------------------------------------------------------------
        # DEBT positions (borrows)
        # ------------------------------------------------------------------
        for vault_addr in borrow_vaults:
            meta = vault_metas.get(vault_addr.lower())
            asset_symbol = meta.asset_symbol if meta else "UNKNOWN"
            liq_ltv = meta.liquidation_ltv if meta else None
            oracle_price = meta.oracle_price_raw if meta else None

            size_native = Decimal(0)
            size_usd: Decimal | None = None
            hf: Decimal | None = None

            raw_info = account_info_results.get(vault_addr.lower())
            if raw_info is not None:
                try:
                    vai = raw_info[1]  # VaultAccountInfo
                    borrowed = int(vai[5])  # borrowed field
                    decimals = meta.asset_decimals if meta else 18
                    size_native = Decimal(borrowed) / Decimal(10**decimals)
                    if oracle_price and oracle_price > 0:
                        size_usd = size_native * oracle_price

                    liq_info = vai[13]  # liquidityInfo
                    collateral_val_liq = int(liq_info[4])
                    liability_val_liq = int(liq_info[2])
                    hf = _compute_hf(collateral_val_liq, liability_val_liq)
                except (IndexError, TypeError, ValueError) as exc:
                    logger.debug(f"EulerV2: could not parse borrow data for {vault_addr}: {exc}")

            positions.append(
                Position(
                    protocol=self.name,
                    chain=chain,
                    asset=asset_symbol,
                    side=PositionSide.DEBT,
                    size_native=size_native,
                    size_usd=size_usd,
                    entry_price=None,
                    mark_price=oracle_price,
                    oracle_price=oracle_price,
                    health_factor=hf,
                    liquidation_threshold=liq_ltv,
                    market_id=vault_addr.lower(),
                    funding_rate=None,
                    funding_period_hours=None,
                    unrealized_pnl_usd=None,
                    liquidation_price=None,
                    pt_expiry_ts=None,
                    market_liquidity_usd=None,
                    implied_apy=None,
                    snapshot_ts=ts,
                    wallet=owner,
                    raw={
                        "sub_account_id": sub_id,
                        "sub_account_address": sub_address,
                        "vault": vault_addr,
                    },
                )
            )

        return positions

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def fetch_positions(
        self,
        *,
        address: str,
        chain: str = "ethereum",
        sub_account_ids: list[int] | None = None,
        **kwargs: Any,
    ) -> list[Position]:
        """Fetch all Euler V2 positions for an address.

        Args:
            address:         EVM wallet address (owner of sub-accounts).
            chain:           One of SUPPORTED_CHAINS (default: "ethereum").
            sub_account_ids: If provided, only query these sub-account IDs (0–255).
                             If None, discover active sub-accounts via subgraph (0–255 scan).

        Returns:
            List of Position objects (COLLATERAL or DEBT) across all active sub-accounts.
            Each position has market_id = eVault address, health_factor set on DEBT positions
            (and mirrored on COLLATERAL positions belonging to the same sub-account).
        """
        chain = chain.lower()
        if chain not in _CHAIN_CONFIG:
            raise AdapterError(
                f"EulerV2: unsupported chain '{chain}'. "
                f"Supported: {sorted(SUPPORTED_CHAINS)}"
            )

        ts = int(time.time())
        owner = address.lower()

        if sub_account_ids is not None:
            # Explicit sub-account list — query only those
            active: dict[int, dict[str, list[str]]] = {}
            sub_queries = [
                self._subgraph_query(
                    chain,
                    _QUERY_ACTIVE_ACCOUNT,
                    {"id": _sub_account_address(owner, sid)},
                )
                for sid in sub_account_ids
            ]
            results = await asyncio.gather(*sub_queries, return_exceptions=True)
            for sid, resp in zip(sub_account_ids, results):
                if isinstance(resp, Exception):
                    logger.warning(
                        f"EulerV2: sub-account {sid} query failed for {owner}: {resp}"
                    )
                    continue
                account_data = resp.get("trackingActiveAccount")
                deposits: list[str] = []
                borrows: list[str] = []
                if account_data:
                    deposits = [
                        p[1]
                        for raw in (account_data.get("deposits") or [])
                        if (p := _parse_position_key(raw)) is not None
                    ]
                    borrows = [
                        p[1]
                        for raw in (account_data.get("borrows") or [])
                        if (p := _parse_position_key(raw)) is not None
                    ]
                active[sid] = {"deposits": deposits, "borrows": borrows}
        else:
            active = await self._discover_active_sub_accounts(chain, owner)

        if not active:
            logger.debug(f"EulerV2 ({chain}): no active positions for {owner[:8]}...")
            return []

        # Build positions for each active sub-account concurrently
        build_tasks = [
            self._build_positions_for_sub_account(
                chain=chain,
                owner=owner,
                sub_id=sid,
                sub_address=_sub_account_address(owner, sid),
                deposit_vaults=data["deposits"],
                borrow_vaults=data["borrows"],
                ts=ts,
            )
            for sid, data in active.items()
            if data["deposits"] or data["borrows"]
        ]

        if not build_tasks:
            return []

        position_groups = await asyncio.gather(*build_tasks, return_exceptions=True)
        positions: list[Position] = []
        for group in position_groups:
            if isinstance(group, Exception):
                logger.warning(f"EulerV2: error building sub-account positions: {group}")
            else:
                positions.extend(group)  # type: ignore[arg-type]

        logger.debug(
            f"EulerV2 ({chain}): {len(positions)} positions for "
            f"{owner[:8]}...{owner[-4:]} "
            f"across {len(active)} active sub-account(s)"
        )
        return positions

    async def fetch_market_state(
        self,
        *,
        market_id: str,
        chain: str = "ethereum",
        **kwargs: Any,
    ) -> MarketState:
        """Fetch live market data for a single eVault.

        Args:
            market_id: eVault contract address (0x-prefixed).
            chain:     One of SUPPORTED_CHAINS.

        Returns:
            MarketState with supply/borrow APY, total supply, total borrow, oracle price.
            open_interest_usd = total borrows in USD (if oracle available).
            liquidity_usd     = total supply in USD (if oracle available).
        """
        chain = chain.lower()
        ts = int(time.time())
        vault = market_id.lower()

        meta = await self._fetch_vault_meta(chain, vault)

        decimals = meta.asset_decimals
        oracle_price = meta.oracle_price_raw

        total_supply_usd: Decimal | None = None
        total_borrow_usd: Decimal | None = None

        if meta.total_supply is not None and oracle_price and oracle_price > 0:
            total_supply_native = meta.total_supply / Decimal(10**decimals)
            total_supply_usd = total_supply_native * oracle_price

        if meta.total_borrow is not None and oracle_price and oracle_price > 0:
            total_borrow_native = meta.total_borrow / Decimal(10**decimals)
            total_borrow_usd = total_borrow_native * oracle_price

        return MarketState(
            protocol=self.name,
            market_id=vault,
            mark_price=oracle_price,
            oracle_price=oracle_price,
            funding_rate=meta.borrow_apy,  # borrow APY as "cost of capital" analogue
            open_interest_usd=total_borrow_usd,
            liquidity_usd=total_supply_usd,
            snapshot_ts=ts,
            raw={
                "chain": chain,
                "asset_symbol": meta.asset_symbol,
                "supply_apy": str(meta.supply_apy) if meta.supply_apy is not None else None,
                "borrow_apy": str(meta.borrow_apy) if meta.borrow_apy is not None else None,
                "liquidation_ltv": str(meta.liquidation_ltv) if meta.liquidation_ltv else None,
            },
        )

    # ------------------------------------------------------------------
    # Healthcheck
    # ------------------------------------------------------------------

    async def healthcheck(self) -> bool:
        """Ping the Ethereum subgraph with a lightweight meta query."""
        try:
            data = await self._subgraph_query(
                "ethereum",
                "{ eulerVaults(first: 1) { id } }",
            )
            return "eulerVaults" in data
        except (AdapterError, AdapterTimeout):
            return False

    async def aclose(self) -> None:
        await self._http.aclose()
