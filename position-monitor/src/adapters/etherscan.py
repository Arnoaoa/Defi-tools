"""Etherscan V2 unified API client.

One API key covers all chains via the chainid query param.
Paginates automatically when a page returns exactly 10 000 results.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from loguru import logger


class EtherscanClient:
    BASE_URL = "https://api.etherscan.io/v2/api"
    CHAIN_IDS: dict[str, int] = {
        "ethereum": 1,
        "arbitrum": 42161,
        "base": 8453,
        "optimism": 10,
    }
    PAGE_SIZE = 10_000

    def __init__(
        self,
        api_key: str,
        *,
        rate_limit_per_sec: int = 5,
        timeout: float = 15.0,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout
        self._sem = asyncio.Semaphore(rate_limit_per_sec)
        self._client = httpx.AsyncClient(timeout=timeout)
        # Token-bucket: track last request timestamps in a deque-like way via
        # a simple window approach — semaphore handles concurrency, the 0.2s
        # sleep per page keeps us under 5 req/s for multi-page fetches.
        self._last_req_ts: float = 0.0

    async def _get(self, params: dict[str, Any]) -> list[dict]:
        params["apikey"] = self._api_key
        async with self._sem:
            # Ensure ≥ 0.2s between requests under the semaphore
            gap = time.monotonic() - self._last_req_ts
            if gap < 0.2:
                await asyncio.sleep(0.2 - gap)

            try:
                resp = await self._client.get(self.BASE_URL, params=params)
                self._last_req_ts = time.monotonic()
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise RuntimeError(f"Etherscan HTTP error: {exc}") from exc

        data = resp.json()

        # Rate limit hit → single retry
        if isinstance(data.get("result"), str) and "rate limit" in data["result"].lower():
            logger.warning("Etherscan rate limit hit — retrying after 1s")
            await asyncio.sleep(1.0)
            return await self._get(params)

        if data.get("status") == "0":
            msg = data.get("message", "")
            result = data.get("result", "")
            # "No transactions found" is a normal empty-page response
            if "no transactions" in str(result).lower() or "no transactions" in msg.lower():
                return []
            # Any other status=0 is a real error
            raise RuntimeError(f"Etherscan error: {msg} — {result}")

        result = data.get("result", [])
        return result if isinstance(result, list) else []

    async def _fetch_paginated(
        self,
        *,
        action: str,
        address: str,
        chain: str,
        start_block: int,
        end_block: int = 99_999_999,
    ) -> list[dict]:
        chain_id = self.CHAIN_IDS[chain]
        base_params = {
            "chainid": chain_id,
            "module": "account",
            "action": action,
            "address": address,
            "endblock": end_block,
            "sort": "asc",
            "offset": self.PAGE_SIZE,
            "page": 1,
        }
        all_rows: list[dict] = []
        current_start = start_block

        while True:
            params = {**base_params, "startblock": current_start}
            page = await self._get(params)
            all_rows.extend(page)

            if len(page) < self.PAGE_SIZE:
                # Last page — done
                break

            # Hit the limit — advance to the block after the last one seen
            max_block = max(int(r["blockNumber"]) for r in page)
            logger.debug(
                f"Etherscan page full ({len(page)} rows), advancing to block {max_block + 1}"
            )
            await asyncio.sleep(0.2)
            current_start = max_block + 1

        return all_rows

    async def fetch_normal_txs(
        self,
        *,
        address: str,
        chain: str,
        start_block: int = 0,
        end_block: int = 99_999_999,
    ) -> list[dict]:
        return await self._fetch_paginated(
            action="txlist",
            address=address,
            chain=chain,
            start_block=start_block,
            end_block=end_block,
        )

    async def fetch_internal_txs(
        self,
        *,
        address: str,
        chain: str,
        start_block: int = 0,
        end_block: int = 99_999_999,
    ) -> list[dict]:
        return await self._fetch_paginated(
            action="txlistinternal",
            address=address,
            chain=chain,
            start_block=start_block,
            end_block=end_block,
        )

    async def fetch_token_txs(
        self,
        *,
        address: str,
        chain: str,
        start_block: int = 0,
        end_block: int = 99_999_999,
    ) -> list[dict]:
        return await self._fetch_paginated(
            action="tokentx",
            address=address,
            chain=chain,
            start_block=start_block,
            end_block=end_block,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
