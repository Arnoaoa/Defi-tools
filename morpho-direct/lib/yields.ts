export const YIELD_PROJECTS = {
  'morpho-vault': 'Morpho',
  'aave-v3': 'Aave v3',
  'aave-v4': 'Aave v4',
  'euler-v2': 'Euler v2',
} as const

export type YieldProject = keyof typeof YIELD_PROJECTS

export interface YieldPool {
  pool: string
  project: YieldProject
  chain: string
  chainId: number
  symbol: string
  apy: number
  apyBase: number | null
  apyReward: number | null
  tvlUsd: number
  underlyingToken: string | null
  poolMeta: string | null
  url: string
  listed: boolean | null // false = Morpho vault not curated by Morpho; null = non-Morpho
}

// Served by /api/yields — Morpho vaults come straight from the Morpho API
// (includes non-curated vaults DefiLlama doesn't track); Aave/Euler pools are
// filtered out of DefiLlama's full pool list (~20MB → ~200KB), cached 1h.
export async function fetchYields(): Promise<YieldPool[]> {
  const res = await fetch('/api/yields')
  if (!res.ok) throw new Error(`Yields API error: ${res.status}`)
  const json: { pools: YieldPool[] } = await res.json()
  return json.pools
}
