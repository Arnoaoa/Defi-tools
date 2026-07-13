export const YIELD_PROJECTS = {
  'morpho-blue': 'Morpho',
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
}

// Served by /api/yields — the server proxies and filters DefiLlama's full
// pool list (~20MB) down to our protocols/chains (~200KB), cached 1h.
export async function fetchYields(): Promise<YieldPool[]> {
  const res = await fetch('/api/yields')
  if (!res.ok) throw new Error(`Yields API error: ${res.status}`)
  const json: { pools: YieldPool[] } = await res.json()
  return json.pools
}

export function llamaPoolUrl(pool: YieldPool): string {
  return `https://defillama.com/yields/pool/${pool.pool}`
}
