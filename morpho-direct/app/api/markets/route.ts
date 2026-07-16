import { NextResponse } from 'next/server'

const MORPHO_API = 'https://api.morpho.org/graphql'

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

// Server-side proxy with Next's data cache: on upstream failure (e.g. the
// Morpho API 504 outage of 2026-07-16), the thrown error preserves the last
// successful cached payload, so the app keeps serving slightly stale markets.
export const revalidate = 300

export async function GET() {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MARKETS_QUERY, variables: { chainIds: [1, 8453] } }),
    next: { revalidate: 300 },
  })

  if (!res.ok) {
    return NextResponse.json(
      { error: `API Morpho indisponible (${res.status})` },
      { status: 502 }
    )
  }

  const json = await res.json()
  if (json.errors?.length) {
    return NextResponse.json({ error: json.errors[0].message }, { status: 502 })
  }

  return NextResponse.json({ markets: json.data.markets.items })
}
