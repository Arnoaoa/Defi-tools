import type { ApiMarket } from '@/lib/api'

const MORPHO_API = 'https://api.morpho.org/graphql'

export const SUPPORTED_CHAIN_IDS = [1, 8453]

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
          collateralAssets
          collateralAssetsUsd
          liquidityAssetsUsd
        }
      }
    }
  }
`

const POSITIONS_QUERY = `
  query GetUserPositions($chainId: Int!, $address: String!) {
    userByAddress(chainId: $chainId, address: $address) {
      marketPositions {
        state {
          supplyAssets
          supplyAssetsUsd
        }
        market {
          marketId
          chain { id }
        }
      }
    }
  }
`

async function morphoQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  revalidateSeconds?: number
): Promise<T> {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    ...(revalidateSeconds !== undefined
      ? { next: { revalidate: revalidateSeconds } }
      : { cache: 'no-store' as const }),
  })

  if (!res.ok) throw new Error(`API Morpho indisponible (${res.status})`)

  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data as T
}

export async function fetchMorphoMarkets(revalidateSeconds?: number): Promise<ApiMarket[]> {
  const data = await morphoQuery<{ markets: { items: ApiMarket[] } }>(
    MARKETS_QUERY,
    { chainIds: SUPPORTED_CHAIN_IDS },
    revalidateSeconds
  )
  return data.markets.items
}

export interface UserPosition {
  marketId: string
  chainId: number
  supplyAssets: number
  supplyAssetsUsd: number | null
}

interface PositionsData {
  userByAddress: {
    marketPositions: {
      state: { supplyAssets: number; supplyAssetsUsd: number | null } | null
      market: { marketId: string; chain: { id: number } }
    }[]
  } | null
}

export async function fetchUserPositions(address: string): Promise<UserPosition[]> {
  const results = await Promise.all(
    SUPPORTED_CHAIN_IDS.map((chainId) =>
      morphoQuery<PositionsData>(POSITIONS_QUERY, { chainId, address })
        // The API errors on addresses it has never seen — same as "no positions"
        .catch(() => ({ userByAddress: null }))
    )
  )

  return results.flatMap(
    (data) =>
      data.userByAddress?.marketPositions.flatMap((p) =>
        p.state && p.state.supplyAssets > 0
          ? [
              {
                marketId: p.market.marketId,
                chainId: p.market.chain.id,
                supplyAssets: p.state.supplyAssets,
                supplyAssetsUsd: p.state.supplyAssetsUsd,
              },
            ]
          : []
      ) ?? []
  )
}
