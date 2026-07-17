import { NextResponse } from 'next/server'
import { fetchMorphoVaults, morphoVaultUrl } from '@/lib/morpho-api'
import type { YieldPool } from '@/lib/yields'

const LLAMA_YIELDS_API = 'https://yields.llama.fi/pools'

// Morpho comes from the Morpho API directly (DefiLlama misses non-curated vaults)
const LLAMA_PROJECTS = new Set(['aave-v3', 'aave-v4', 'euler-v2'])
const CHAIN_IDS: Record<string, number> = { Ethereum: 1, Base: 8453 }
const CHAIN_NAMES = Object.fromEntries(Object.entries(CHAIN_IDS).map(([name, id]) => [id, name]))

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

async function fetchLlamaPools(): Promise<YieldPool[]> {
  const res = await fetch(LLAMA_YIELDS_API, { next: { revalidate: 3600 } })
  if (!res.ok) throw new Error(`DefiLlama API error: ${res.status}`)
  const json: { data: LlamaPool[] } = await res.json()

  return json.data
    .filter((p) => LLAMA_PROJECTS.has(p.project) && p.chain in CHAIN_IDS)
    .map((p) => ({
      pool: p.pool,
      project: p.project as YieldPool['project'],
      chain: p.chain,
      chainId: CHAIN_IDS[p.chain],
      symbol: p.symbol,
      apy: p.apy ?? 0,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      tvlUsd: p.tvlUsd,
      underlyingToken: p.underlyingTokens?.[0] ?? null,
      poolMeta: p.poolMeta,
      url: `https://defillama.com/yields/pool/${p.pool}`,
      listed: null,
    }))
}

async function fetchVaultPools(): Promise<YieldPool[]> {
  const vaults = await fetchMorphoVaults(3600)
  return vaults
    .filter((v) => v.state)
    .map((v) => ({
      pool: `${v.chain.id}-${v.address}`,
      project: 'morpho-vault' as const,
      chain: CHAIN_NAMES[v.chain.id] ?? v.chain.network,
      chainId: v.chain.id,
      symbol: v.asset.symbol,
      apy: v.state!.netApy * 100,
      apyBase: v.state!.apy * 100,
      apyReward: Math.max(0, v.state!.netApy - v.state!.apy) * 100,
      tvlUsd: v.state!.totalAssetsUsd,
      underlyingToken: v.asset.address,
      poolMeta: v.name,
      url: morphoVaultUrl(v),
      listed: v.listed,
    }))
}

export async function GET() {
  try {
    const [llamaPools, vaultPools] = await Promise.all([fetchLlamaPools(), fetchVaultPools()])
    return NextResponse.json({ pools: [...vaultPools, ...llamaPools] })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Yields upstream error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
