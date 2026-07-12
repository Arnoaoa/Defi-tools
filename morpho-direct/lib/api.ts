const MORPHO_API = 'https://api.morpho.org/graphql'

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

interface ApiResponse {
  data: {
    markets: {
      items: ApiMarket[]
    }
  }
  errors?: Array<{ message: string }>
}

const MARKETS_QUERY = `
  query GetMarkets($chainIds: [Int!]) {
    markets(
      where: { chainId_in: $chainIds, listed: true }
      orderBy: TotalLiquidityUsd
      orderDirection: Desc
      first: 1000
    ) {
      items {
        marketId
        lltv
        irmAddress
        chain { id network }
        loanAsset {
          address
          symbol
          decimals
          name
        }
        collateralAsset {
          address
          symbol
          decimals
          name
        }
        oracle {
          address
          type
        }
        state {
          supplyApy
          weeklySupplyApy
          monthlySupplyApy
          borrowApy
          supplyAssets
          supplyAssetsUsd
          utilization
        }
      }
    }
  }
`

export function morphoAppUrl(market: ApiMarket): string {
  const slug = `${market.collateralAsset?.symbol ?? ''}-${market.loanAsset.symbol}`.toLowerCase()
  return `https://app.morpho.org/${market.chain.network.toLowerCase()}/market/${market.marketId}/${slug}`
}

export async function fetchMarkets(chainIds: number[]): Promise<ApiMarket[]> {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MARKETS_QUERY, variables: { chainIds } }),
  })

  if (!res.ok) throw new Error(`Morpho API error: ${res.status}`)

  const json: ApiResponse = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)

  return json.data.markets.items.filter(
    (m) => m.collateralAsset && m.oracle
  )
}
