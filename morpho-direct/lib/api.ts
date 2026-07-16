export interface ApiMarket {
  marketId: string
  lltv: string
  irmAddress: string
  chain: {
    id: number
    network: string
  }
  loanAsset: {
    address: string
    symbol: string
    decimals: number
    name: string
  }
  collateralAsset: {
    address: string
    symbol: string
    decimals: number
    name: string
  } | null
  oracle: { address: string; type: string | null } | null
  state: {
    supplyApy: number
    weeklySupplyApy: number | null
    monthlySupplyApy: number | null
    borrowApy: number
    supplyAssets: string
    supplyAssetsUsd: number | null
    utilization: number
  } | null
}

export function morphoAppUrl(market: ApiMarket): string {
  const slug = `${market.collateralAsset?.symbol ?? ''}-${market.loanAsset.symbol}`.toLowerCase()
  return `https://app.morpho.org/${market.chain.network.toLowerCase()}/market/${market.marketId}/${slug}`
}

// Served by /api/markets — server-side proxy of the Morpho GraphQL API with a
// 5-minute cache that keeps serving the last good payload during outages.
// Returns both chains; the UI filters by selected chain client-side.
export async function fetchMarkets(): Promise<ApiMarket[]> {
  const res = await fetch('/api/markets')
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `Markets API error: ${res.status}`)

  return (json.markets as ApiMarket[]).filter((m) => m.collateralAsset && m.oracle)
}
