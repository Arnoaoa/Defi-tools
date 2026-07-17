import type { ApiMarket } from '@/lib/api'

const MORPHO_API = 'https://api.morpho.org/graphql'

export const SUPPORTED_CHAIN_IDS = [1, 8453]

const MARKET_FRAGMENT = `
  fragment MarketFields on Market {
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
`

const MARKETS_QUERY = `
  ${MARKET_FRAGMENT}
  query GetMarkets($chainIds: [Int!]) {
    markets(
      where: { chainId_in: $chainIds, listed: true }
      orderBy: TotalLiquidityUsd
      orderDirection: Desc
      first: 1000
    ) {
      items {
        ...MarketFields
      }
    }
  }
`

const POSITIONS_QUERY = `
  query GetUserPositions($chainId: Int!, $address: String!) {
    userByAddress(chainId: $chainId, address: $address) {
      marketPositions {
        healthFactor
        priceVariationToLiquidationPrice
        state {
          supplyAssets
          supplyAssetsUsd
          borrowAssets
          borrowAssetsUsd
        }
        market {
          marketId
          chain { id }
        }
      }
      vaultPositions {
        state { assetsUsd }
        vault {
          address
          name
          chain { id network }
          asset { symbol }
          state { netApy }
        }
      }
    }
  }
`

// MetaMorpho vaults, including non-curated ones (listed: false) — the Morpho
// app hides those but they can hold the best opportunities (e.g. Jarvis USDC)
const VAULTS_QUERY = `
  query GetVaults($chainIds: [Int!], $minTvlUsd: Float!) {
    vaults(
      where: { chainId_in: $chainIds, totalAssetsUsd_gte: $minTvlUsd }
      orderBy: TotalAssetsUsd
      orderDirection: Desc
      first: 1000
    ) {
      items {
        address
        name
        listed
        chain { id network }
        asset { address symbol decimals }
        state {
          apy
          netApy
          totalAssetsUsd
        }
      }
    }
  }
`

const VAULT_ALLOCATION_QUERY = `
  ${MARKET_FRAGMENT}
  query GetVaultAllocation($address: String!, $chainId: Int!) {
    vaultByAddress(address: $address, chainId: $chainId) {
      state {
        allocation {
          supplyAssetsUsd
          market {
            ...MarketFields
          }
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
  borrowAssets: number
  borrowAssetsUsd: number | null
  healthFactor: number | null
  priceVariationToLiquidationPrice: number | null
}

export interface ApiVault {
  address: string
  name: string
  listed: boolean
  chain: { id: number; network: string }
  asset: { address: string; symbol: string; decimals: number }
  state: {
    apy: number
    netApy: number
    totalAssetsUsd: number
  } | null
}

export interface UserVaultPosition {
  vault: ApiVault
  assetsUsd: number
}

export interface UserPositions {
  markets: UserPosition[]
  vaults: UserVaultPosition[]
}

interface PositionsData {
  userByAddress: {
    marketPositions: {
      healthFactor: number | null
      priceVariationToLiquidationPrice: number | null
      state: {
        supplyAssets: number
        supplyAssetsUsd: number | null
        borrowAssets: number
        borrowAssetsUsd: number | null
      } | null
      market: { marketId: string; chain: { id: number } }
    }[]
    vaultPositions: {
      state: { assetsUsd: number | null } | null
      vault: ApiVault
    }[]
  } | null
}

export async function fetchUserPositions(address: string): Promise<UserPositions> {
  const results = await Promise.all(
    SUPPORTED_CHAIN_IDS.map((chainId) =>
      morphoQuery<PositionsData>(POSITIONS_QUERY, { chainId, address })
        // The API errors on addresses it has never seen — same as "no positions"
        .catch(() => ({ userByAddress: null }))
    )
  )

  return {
    markets: results.flatMap(
      (data) =>
        data.userByAddress?.marketPositions.flatMap((p) =>
          p.state && (p.state.supplyAssets > 0 || p.state.borrowAssets > 0)
            ? [
                {
                  marketId: p.market.marketId,
                  chainId: p.market.chain.id,
                  supplyAssets: p.state.supplyAssets,
                  supplyAssetsUsd: p.state.supplyAssetsUsd,
                  borrowAssets: p.state.borrowAssets,
                  borrowAssetsUsd: p.state.borrowAssetsUsd,
                  healthFactor: p.healthFactor,
                  priceVariationToLiquidationPrice: p.priceVariationToLiquidationPrice,
                },
              ]
            : []
        ) ?? []
    ),
    vaults: results.flatMap(
      (data) =>
        data.userByAddress?.vaultPositions.flatMap((p) =>
          p.state?.assetsUsd ? [{ vault: p.vault, assetsUsd: p.state.assetsUsd }] : []
        ) ?? []
    ),
  }
}

export const VAULT_TVL_MIN_USD = 5_000

export async function fetchMorphoVaults(revalidateSeconds?: number): Promise<ApiVault[]> {
  const data = await morphoQuery<{ vaults: { items: ApiVault[] } }>(
    VAULTS_QUERY,
    { chainIds: SUPPORTED_CHAIN_IDS, minTvlUsd: VAULT_TVL_MIN_USD },
    revalidateSeconds
  )
  return data.vaults.items
}

export interface VaultAllocation {
  market: ApiMarket
  supplyAssetsUsd: number
}

interface AllocationData {
  vaultByAddress: {
    state: {
      allocation: { supplyAssetsUsd: number | null; market: ApiMarket }[]
    } | null
  } | null
}

export async function fetchVaultAllocations(vault: ApiVault): Promise<VaultAllocation[]> {
  const data = await morphoQuery<AllocationData>(VAULT_ALLOCATION_QUERY, {
    address: vault.address,
    chainId: vault.chain.id,
  })
  return (
    data.vaultByAddress?.state?.allocation.map((a) => ({
      market: a.market,
      supplyAssetsUsd: a.supplyAssetsUsd ?? 0,
    })) ?? []
  )
}

export function morphoVaultUrl(vault: ApiVault): string {
  const slug = vault.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `https://app.morpho.org/${vault.chain.network.toLowerCase()}/vault/${vault.address}/${slug}`
}
