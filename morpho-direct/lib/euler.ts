// Euler v2 (EVK) positions via the public Euler v3 REST API — one call returns
// all chains and all sub-accounts for an owner address. Trustless fallback if
// this API ever dies: the on-chain Lens contracts (AccountLens/VaultLens,
// addresses in github.com/euler-xyz/euler-interfaces).
const EULER_API = 'https://v3.euler.finance/v3'

// USD unit-of-account sentinel used by Euler (ISO 4217 code 840)
const USD_UNIT = '0x0000000000000000000000000000000000000348'

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  56: 'BNB',
  9745: 'Plasma',
}

export function eulerChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `chain ${chainId}`
}

export interface EulerPosition {
  chainId: number
  account: string
  owner: string
  vault: string
  assets: string
  borrowed: string
  isCollateral: boolean
  isController: boolean
  // Health data, only present on borrow (controller) positions with USD unit of account
  healthFactor: number | null
  daysToLiquidation: number | 'Infinity' | 'MoreThanAYear' | null
  debtUsd: number | null
}

interface RawLiquidity {
  unitOfAccount: string
  daysToLiquidation: number | 'Infinity' | 'MoreThanAYear'
  liabilityValue: { liquidation: string }
  totalCollateralValue: { liquidation: string }
}

interface RawPosition {
  chainId: number
  account: string
  vault: string
  assets: string
  borrowed: string
  isCollateral: boolean
  isController: boolean
  subAccount: { owner: string } | null
  liquidity: RawLiquidity | null
}

async function eulerJson<T>(path: string): Promise<T> {
  const res = await fetch(`${EULER_API}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`API Euler indisponible (${res.status})`)
  return res.json()
}

export async function fetchEulerPositions(address: string): Promise<EulerPosition[]> {
  const positions: EulerPosition[] = []
  for (let offset = 0; ; offset += 20) {
    const json = await eulerJson<{ data: RawPosition[]; meta: { hasMore: boolean } }>(
      `/accounts/${address}/positions?offset=${offset}`
    )
    for (const p of json.data) {
      const usdDenominated =
        p.liquidity !== null && p.liquidity.unitOfAccount.toLowerCase() === USD_UNIT
      const liability = usdDenominated ? Number(p.liquidity!.liabilityValue.liquidation) / 1e18 : null
      const collateral = usdDenominated
        ? Number(p.liquidity!.totalCollateralValue.liquidation) / 1e18
        : null
      positions.push({
        chainId: p.chainId,
        account: p.account,
        owner: p.subAccount?.owner ?? address,
        vault: p.vault,
        assets: p.assets,
        borrowed: p.borrowed,
        isCollateral: p.isCollateral,
        isController: p.isController,
        healthFactor: liability && collateral && liability > 0 ? collateral / liability : null,
        daysToLiquidation: p.liquidity?.daysToLiquidation ?? null,
        debtUsd: liability,
      })
    }
    if (!json.meta.hasMore) break
  }
  return positions
}

export interface EulerVaultInfo {
  chainId: number
  address: string
  assetSymbol: string
  assetDecimals: number
  supplyApy: number // percent number, e.g. 5.14
  borrowApy: number
  assetPriceUsd: number | null // implied from totalSupplyUsd / totalAssets
}

interface RawVault {
  chainId: number
  address: string
  asset: { symbol: string; decimals: number }
  supplyApy: number
  borrowApy: number
  totalAssets: string
  totalSupplyUsd: number | null
}

export function vaultKey(chainId: number, vault: string): string {
  return `${chainId}-${vault.toLowerCase()}`
}

// APYs change constantly — always fetched fresh (callers only pass the few
// vaults they actually need, so call volume stays trivial)
export async function fetchEulerVaultInfos(
  positions: EulerPosition[]
): Promise<Map<string, EulerVaultInfo>> {
  const unique = [
    ...new Map(positions.map((p) => [vaultKey(p.chainId, p.vault), p] as const)).values(),
  ]
  const infos = new Map<string, EulerVaultInfo>()

  await Promise.all(
    unique.map(async (p) => {
      const json = await eulerJson<{ data?: RawVault } | RawVault>(
        `/evk/vaults/${p.chainId}/${p.vault}`
      )
      const v = ('data' in json && json.data ? json.data : json) as RawVault
      const totalTokens = Number(v.totalAssets) / 10 ** v.asset.decimals
      infos.set(vaultKey(p.chainId, p.vault), {
        chainId: p.chainId,
        address: p.vault,
        assetSymbol: v.asset.symbol,
        assetDecimals: v.asset.decimals,
        supplyApy: v.supplyApy,
        borrowApy: v.borrowApy,
        assetPriceUsd:
          v.totalSupplyUsd !== null && totalTokens > 0 ? v.totalSupplyUsd / totalTokens : null,
      })
    })
  )

  return infos
}

export function eulerVaultUrl(chainId: number, vault: string): string {
  return `https://app.euler.finance/vault/${vault}?network=${eulerChainName(chainId).toLowerCase()}`
}
