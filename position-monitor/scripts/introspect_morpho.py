"""Introspect Morpho GraphQL endpoints to find the new field names.

Probes both the primary API and the subgraph for the actual Market schema,
so we can fix the obsolete queries in src/adapters/morpho.py.
"""
from __future__ import annotations

import asyncio
import json
import os

from dotenv import load_dotenv

load_dotenv()

if os.getenv("MONITOR_SSL_VERIFY", "true").lower() == "false":
    import httpx

    _orig_async = httpx.AsyncClient.__init__
    _orig_sync = httpx.Client.__init__

    def _async_init(self, *args, **kwargs):
        kwargs.setdefault("verify", False)
        _orig_async(self, *args, **kwargs)

    def _sync_init(self, *args, **kwargs):
        kwargs.setdefault("verify", False)
        _orig_sync(self, *args, **kwargs)

    httpx.AsyncClient.__init__ = _async_init
    httpx.Client.__init__ = _sync_init

import httpx

PRIMARY_URL = "https://api.morpho.org/graphql"
SUBGRAPH_ID = "EE7m9KzByJep5hU9znbjREWgvdooKd1JWrUQJXLn6hh1"

INTROSPECT_MARKET = """
{
  __type(name: "Market") {
    name
    fields {
      name
      type { name kind ofType { name kind } }
    }
  }
}
"""


async def main():
    api_key = os.getenv("GRAPH_API_KEY", "")

    # --- Primary API ---
    print("=" * 70)
    print("PRIMARY API — api.morpho.org/graphql")
    print("=" * 70)
    async with httpx.AsyncClient(timeout=15.0) as c:
        r = await c.post(PRIMARY_URL, json={"query": INTROSPECT_MARKET})
        data = r.json()
        if data.get("data", {}).get("__type"):
            fields = data["data"]["__type"]["fields"]
            print(f"Total fields: {len(fields)}")
            for f in sorted(fields, key=lambda x: x["name"]):
                t = f["type"]
                tn = t.get("name") or (t.get("ofType") or {}).get("name") or t.get("kind")
                print(f"  {f['name']:40s} : {tn}")
        else:
            print(json.dumps(data, indent=2)[:2000])

    # --- Subgraph ---
    print()
    print("=" * 70)
    print("SUBGRAPH — Morpho Blue Ethereum")
    print("=" * 70)
    if api_key:
        url = f"https://gateway.thegraph.com/api/{api_key}/subgraphs/id/{SUBGRAPH_ID}"
    else:
        url = f"https://gateway.thegraph.com/api/subgraphs/id/{SUBGRAPH_ID}"
        print("(no GRAPH_API_KEY — likely to 401)")

    async with httpx.AsyncClient(timeout=15.0) as c:
        r = await c.post(url, json={"query": INTROSPECT_MARKET})
        data = r.json()
        if data.get("data", {}).get("__type"):
            fields = data["data"]["__type"]["fields"]
            print(f"Total fields: {len(fields)}")
            for f in sorted(fields, key=lambda x: x["name"]):
                t = f["type"]
                tn = t.get("name") or (t.get("ofType") or {}).get("name") or t.get("kind")
                print(f"  {f['name']:40s} : {tn}")
        else:
            print(json.dumps(data, indent=2)[:2000])


if __name__ == "__main__":
    asyncio.run(main())
