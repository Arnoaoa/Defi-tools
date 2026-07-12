"""Probe a single address across every adapter / chain combination and report
exactly what is found (or why nothing is found).

Usage:
    python scripts/probe_address.py 0x869A05FE6568b39b6202f6378f463e48bA2880B3
"""
from __future__ import annotations

import asyncio
import os
import sys

from dotenv import load_dotenv

# Load .env BEFORE the SSL patch check (mirrors src/main.py).
load_dotenv()

if os.getenv("MONITOR_SSL_VERIFY", "true").lower() == "false":
    import httpx

    _orig_async = httpx.AsyncClient.__init__
    _orig_sync = httpx.Client.__init__

    def _async_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("verify", False)
        _orig_async(self, *args, **kwargs)

    def _sync_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("verify", False)
        _orig_sync(self, *args, **kwargs)

    httpx.AsyncClient.__init__ = _async_init  # type: ignore[method-assign]
    httpx.Client.__init__ = _sync_init  # type: ignore[method-assign]

from src.adapters import (
    AaveV3Adapter,
    EulerV2Adapter,
    HyperliquidAdapter,
    MorphoAdapter,
    PendleAdapter,
)
from src.config import load_env, load_strategies


CHAINS_EVM = ["ethereum", "arbitrum", "base", "optimism"]


async def probe(address: str) -> None:
    env = load_env()
    strategies = load_strategies()

    rpc_map: dict[str, str] = {}
    if strategies.rpc.ethereum:
        rpc_map["ethereum"] = strategies.rpc.ethereum
    if strategies.rpc.arbitrum:
        rpc_map["arbitrum"] = strategies.rpc.arbitrum
    if strategies.rpc.base:
        rpc_map["base"] = strategies.rpc.base
    if strategies.rpc.optimism:
        rpc_map["optimism"] = strategies.rpc.optimism

    print(f"\n=== Probing {address} ===\n")

    # ---- Hyperliquid ----
    hl = HyperliquidAdapter()
    try:
        positions = await hl.fetch_positions(address=address)
        print(f"[Hyperliquid] {len(positions)} position(s)")
        for p in positions[:5]:
            print(f"  {p.asset} {p.side.value} size={p.size_native} usd={p.size_usd}")
    except Exception as e:
        print(f"[Hyperliquid] ERROR: {type(e).__name__}: {e}")
    await hl.aclose()

    # ---- Aave V3 (each chain) ----
    aave = AaveV3Adapter(config={"graph_api_key": env.graph_api_key})
    for chain in CHAINS_EVM + ["avalanche", "polygon", "bsc"]:
        try:
            positions = await aave.fetch_positions(address=address, chain=chain)
            if positions:
                print(f"[Aave V3 {chain}] {len(positions)} position(s)")
                for p in positions[:3]:
                    print(f"  {p.asset} {p.side.value} usd={p.size_usd} HF={p.health_factor}")
            else:
                print(f"[Aave V3 {chain}] no positions")
        except Exception as e:
            print(f"[Aave V3 {chain}] ERROR: {type(e).__name__}: {str(e)[:120]}")
    await aave.aclose()

    # ---- Morpho (each chain supported) ----
    morpho = MorphoAdapter()
    for chain in ["ethereum", "base"]:
        try:
            positions = await morpho.fetch_positions(address=address, chain=chain)
            if positions:
                print(f"[Morpho {chain}] {len(positions)} position(s)")
                for p in positions[:3]:
                    print(f"  {p.asset} {p.side.value} usd={p.size_usd} HF={p.health_factor}")
            else:
                print(f"[Morpho {chain}] no positions")
        except Exception as e:
            print(f"[Morpho {chain}] ERROR: {type(e).__name__}: {str(e)[:120]}")
    await morpho.aclose()

    # ---- Pendle (each chain) ----
    pendle = PendleAdapter(config={"rpc_urls": rpc_map})
    for chain in CHAINS_EVM:
        try:
            positions = await pendle.fetch_positions(address=address, chain=chain)
            if positions:
                print(f"[Pendle {chain}] {len(positions)} position(s)")
                for p in positions[:3]:
                    print(f"  {p.asset} expiry={p.pt_expiry_ts}")
            else:
                print(f"[Pendle {chain}] no positions")
        except Exception as e:
            print(f"[Pendle {chain}] ERROR: {type(e).__name__}: {str(e)[:120]}")
    await pendle.aclose()

    # ---- Euler V2 (Ethereum only for now) ----
    euler = EulerV2Adapter(config={"rpc_url_ethereum": strategies.rpc.ethereum})
    try:
        positions = await euler.fetch_positions(address=address, chain="ethereum")
        if positions:
            print(f"[Euler V2 ethereum] {len(positions)} position(s)")
            for p in positions[:3]:
                print(f"  {p.asset} {p.side.value} usd={p.size_usd} HF={p.health_factor}")
        else:
            print("[Euler V2 ethereum] no positions")
    except Exception as e:
        print(f"[Euler V2 ethereum] ERROR: {type(e).__name__}: {str(e)[:120]}")
    await euler.aclose()

    print("\n=== Done ===\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    asyncio.run(probe(sys.argv[1]))
