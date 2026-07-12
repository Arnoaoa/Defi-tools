"""Transaction syncer: fetches Etherscan tx history per wallet, classifies, stores."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from loguru import logger

from src.adapters.etherscan import EtherscanClient
from src.storage.db import Database

CHAINS = list(EtherscanClient.CHAIN_IDS.keys())
SOURCES = ("normal", "internal", "token")


class TransactionSyncer:
    def __init__(self, db: Database, etherscan: EtherscanClient) -> None:
        self._db = db
        self._es = etherscan

    def _classify(
        self,
        raw: dict,
        source: str,
        wallet_address: str,
        self_addresses: set[str],
    ) -> str:
        from_addr = (raw.get("from") or "").lower()
        to_addr = (raw.get("to") or "").lower()
        wallet_lower = wallet_address.lower()

        if from_addr in self_addresses and to_addr in self_addresses:
            return "internal_transfer"
        if to_addr == wallet_lower:
            return "transfer_in"
        if from_addr == wallet_lower:
            # Normal txs with non-empty input and no value going to a self wallet
            if source == "normal":
                input_data = raw.get("input", "0x")
                has_value = int(raw.get("value", "0") or "0") > 0
                if input_data and input_data != "0x" and not has_value:
                    return "contract_call"
            return "transfer_out"
        return "contract_call"

    def _normalize(
        self,
        raw: dict,
        source: str,
        wallet_id: str,
        chain: str,
        classification: str,
    ) -> dict[str, Any]:
        input_data = raw.get("input", "0x") or "0x"
        method_id = input_data[:10] if len(input_data) >= 10 and input_data != "0x" else None

        if source == "token":
            asset_symbol = raw.get("tokenSymbol") or raw.get("tokenName", "?")
            asset_address = (raw.get("contractAddress") or "").lower() or None
            try:
                asset_decimals = int(raw.get("tokenDecimal") or 18)
            except (ValueError, TypeError):
                asset_decimals = 18
            value_native = raw.get("value")
        else:
            asset_symbol = "ETH"
            asset_address = None
            asset_decimals = 18
            value_native = raw.get("value")

        from_addr = (raw.get("from") or "").lower()
        to_addr = raw.get("to") or None
        if to_addr is not None:
            to_addr = to_addr.lower() or None

        return {
            "wallet_id": wallet_id,
            "chain": chain,
            "source": source,
            "tx_hash": raw.get("hash", ""),
            "block_number": int(raw.get("blockNumber") or 0),
            "timestamp": int(raw.get("timeStamp") or 0),
            "from_addr": from_addr,
            "to_addr": to_addr,
            "value_native": str(value_native) if value_native is not None else None,
            "asset_symbol": asset_symbol,
            "asset_address": asset_address,
            "asset_decimals": asset_decimals,
            "classification": classification,
            "gas_used": str(raw.get("gasUsed")) if raw.get("gasUsed") is not None else None,
            "gas_price": str(raw.get("gasPrice")) if raw.get("gasPrice") is not None else None,
            "is_error": int(raw.get("isError") or 0),
            "method_id": method_id,
            "raw_json": json.dumps(raw, separators=(",", ":")),
        }

    async def _sync_one(
        self,
        wallet: dict,
        chain: str,
        source: str,
        self_addresses: set[str],
    ) -> dict[str, int]:
        wallet_id = wallet["id"]
        address = wallet["address"]
        stats: dict[str, int] = {"fetched": 0, "inserted": 0, "errors": 0}

        last_block = self._db.get_sync_state(wallet_id, chain, source)
        start_block = last_block + 1 if last_block > 0 else 0

        try:
            fetch_fn = {
                "normal": self._es.fetch_normal_txs,
                "internal": self._es.fetch_internal_txs,
                "token": self._es.fetch_token_txs,
            }[source]
            rows = await fetch_fn(address=address, chain=chain, start_block=start_block)
        except RuntimeError as exc:
            logger.warning(f"[{wallet_id}/{chain}/{source}] fetch failed: {exc}")
            stats["errors"] += 1
            return stats
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[{wallet_id}/{chain}/{source}] unexpected error: {exc}")
            stats["errors"] += 1
            return stats

        if not rows:
            return stats

        stats["fetched"] = len(rows)
        normalized = [
            self._normalize(
                r,
                source,
                wallet_id,
                chain,
                self._classify(r, source, address, self_addresses),
            )
            for r in rows
        ]

        inserted = self._db.insert_wallet_transactions(normalized)
        stats["inserted"] = inserted

        max_block = max(int(r.get("blockNumber") or 0) for r in rows)
        self._db.update_sync_state(wallet_id, chain, source, max_block)
        logger.debug(
            f"[{wallet_id}/{chain}/{source}] fetched={stats['fetched']} "
            f"inserted={inserted} up_to_block={max_block}"
        )
        return stats

    async def sync_wallet(self, wallet: dict) -> dict:
        """Sync all chains × sources for a single wallet."""
        self_addresses: set[str] = {
            w["address"].lower() for w in self._db.list_wallets(grp="self")
        }

        tasks = [
            self._sync_one(wallet, chain, source, self_addresses)
            for chain in CHAINS
            for source in SOURCES
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        agg: dict[str, Any] = {
            "wallet_id": wallet["id"],
            "fetched": 0,
            "inserted": 0,
            "errors": 0,
            "by_chain": {},
        }
        i = 0
        for chain in CHAINS:
            chain_inserted = 0
            for source in SOURCES:
                r = results[i]
                i += 1
                if isinstance(r, Exception):
                    logger.warning(f"[{wallet['id']}/{chain}/{source}] task exception: {r}")
                    agg["errors"] += 1
                    continue
                agg["fetched"] += r["fetched"]
                agg["inserted"] += r["inserted"]
                agg["errors"] += r["errors"]
                chain_inserted += r["inserted"]
            if chain_inserted:
                agg["by_chain"][chain] = chain_inserted

        return agg

    async def sync_all_wallets(self) -> dict:
        wallets = self._db.list_wallets()  # self + watch
        if not wallets:
            return {"wallets": 0, "total_inserted": 0, "by_chain": {}, "by_classification": {}}

        logger.info(f"Transaction sync: starting for {len(wallets)} wallet(s)")
        t0 = time.monotonic()

        wallet_stats = await asyncio.gather(
            *[self.sync_wallet(w) for w in wallets],
            return_exceptions=True,
        )

        totals: dict[str, Any] = {
            "wallets": len(wallets),
            "total_inserted": 0,
            "by_chain": {},
            "errors": 0,
        }
        for ws in wallet_stats:
            if isinstance(ws, Exception):
                logger.warning(f"Wallet sync task raised: {ws}")
                totals["errors"] += 1
                continue
            totals["total_inserted"] += ws["inserted"]
            totals["errors"] += ws["errors"]
            for chain, cnt in ws.get("by_chain", {}).items():
                totals["by_chain"][chain] = totals["by_chain"].get(chain, 0) + cnt

        # Classification breakdown from DB (cheap count query)
        cur = self._db._conn.execute(  # noqa: SLF001
            "SELECT classification, COUNT(*) FROM wallet_transactions GROUP BY classification"
        )
        totals["by_classification"] = {row[0]: row[1] for row in cur.fetchall()}

        elapsed = time.monotonic() - t0
        logger.info(
            f"Transaction sync done in {elapsed:.1f}s — "
            f"inserted={totals['total_inserted']} "
            f"errors={totals['errors']}"
        )
        return totals
