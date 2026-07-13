import { NextResponse } from 'next/server'

const LLAMA_YIELDS_API = 'https://yields.llama.fi/pools'

const PROJECTS = new Set(['morpho-blue', 'aave-v3', 'aave-v4', 'euler-v2'])
const CHAIN_IDS: Record<string, number> = { Ethereum: 1, Base: 8453 }

interface LlamaPool {
  pool: string
  project: string
  chain: string
  symbol: string
  apy: number | null
  apyBase: number | null
  apyReward: number | null
  tvlUsd: number
  underlyingTokens: string[] | null
  poolMeta: string | null
}

// DefiLlama refreshes roughly hourly — cache the filtered payload server-side
export const revalidate = 3600

export async function GET() {
  const res = await fetch(LLAMA_YIELDS_API, { next: { revalidate: 3600 } })
  if (!res.ok) {
    return NextResponse.json({ error: `DefiLlama API error: ${res.status}` }, { status: 502 })
  }
  const json: { data: LlamaPool[] } = await res.json()

  const pools = json.data
    .filter((p) => PROJECTS.has(p.project) && p.chain in CHAIN_IDS)
    .map((p) => ({
      pool: p.pool,
      project: p.project,
      chain: p.chain,
      chainId: CHAIN_IDS[p.chain],
      symbol: p.symbol,
      apy: p.apy ?? 0,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd,
      underlyingToken: p.underlyingTokens?.[0] ?? null,
      poolMeta: p.poolMeta,
    }))

  return NextResponse.json({ pools })
}
