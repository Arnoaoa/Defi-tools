import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatEther, getAddress } from 'viem'
import { mainnet } from 'viem/chains'
import priceWatchConfig from '@/data/price-watch.json'
import { eulerChainName, eulerVaultUrl, fetchEulerPositions, fetchEulerVaultInfos, vaultKey } from '@/lib/euler'
import { fetchUserPositions } from '@/lib/morpho-api'
import { MORPHO_BLUE_ADDRESS, MORPHO_BLUE_ABI, ORACLE_ABI, ORACLE_PRICE_SCALE } from '@/lib/morpho'
import { sendTelegram } from '@/lib/alerts'

export const maxDuration = 30

const HEALTH_FACTOR_ALERT = 1.15 // Morpho borrow position approaching liquidation
// Euler thresholds are separate: his Euler stable loops sit at HF 1.03-1.06 by
// design, so alert only on imminent danger or fast decay
const EULER_HEALTH_FACTOR_ALERT = 1.02
const EULER_DAYS_TO_LIQUIDATION_ALERT = 30
const DEFAULT_HEALTH_COOLDOWN_MINUTES = 60 // repeats are useful when near liquidation
const PRICE_RULE_COOLDOWN_MINUTES = 6 * 60 // a durably crossed limit shouldn't spam
const DUST_USD = 1

// ynETHx liquidation-profitability watch: alert when liquidating the remaining
// underwater borrower turns profitable (Curve effective price crosses
// oracle / LIF). The exit contract pattern is ready to redeploy if it fires.
const YNETHX_MARKET_ID = '0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75'
const YNETHX_BIG_BORROWER = getAddress('0x14bCD9da052Cdc6fE0b9446d5a616D5b7B4d4550')
const YNETHX_CURVE_POOL = getAddress('0xD65ed4BcE447195187f37cE7D82f56AdF1826F8F')
const LIQ_PROFIT_ALERT = 0.005 // alert when a 1 WETH liquidation slice yields > +0.5%

const CURVE_POOL_ABI = [
  {
    name: 'get_dy',
    type: 'function',
    inputs: [{ type: 'int128' }, { type: 'int128' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.NEXT_PUBLIC_ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'),
})

interface LiquidationProfitability {
  borrowerDebt: number
  pnlPctSlice: number // on a 1 WETH repay slice
  pnlPctFull: number // repaying the borrower's full debt
}

async function checkYnethxLiquidation(): Promise<LiquidationProfitability | null> {
  const morpho = { address: MORPHO_BLUE_ADDRESS, abi: MORPHO_BLUE_ABI } as const
  const marketId = YNETHX_MARKET_ID as `0x${string}`
  const [params, marketState, position] = await mainnetClient.multicall({
    contracts: [
      { ...morpho, functionName: 'idToMarketParams', args: [marketId] },
      { ...morpho, functionName: 'market', args: [marketId] },
      { ...morpho, functionName: 'position', args: [marketId, YNETHX_BIG_BORROWER] },
    ],
    allowFailure: false,
  })
  const [, , oracle, , lltvRaw] = params
  const [, , totalBorrowAssets, totalBorrowShares] = marketState
  const borrowShares = position[1]
  if (borrowShares === 0n || totalBorrowShares === 0n) return null // borrower gone

  const debtWei =
    (BigInt(borrowShares) * (totalBorrowAssets + 1n)) / (totalBorrowShares + 10n ** 6n)
  const lltv = Number(lltvRaw) / 1e18
  const lif = Math.min(1.15, 1 / (0.3 * lltv + 0.7))
  const oraclePrice = Number(
    await mainnetClient.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'price' })
  ) / Number(ORACLE_PRICE_SCALE)

  const pnlFor = async (repayWei: bigint) => {
    const seizedWei = BigInt(Math.round((Number(repayWei) * lif) / oraclePrice))
    const saleWei = await mainnetClient.readContract({
      address: YNETHX_CURVE_POOL,
      abi: CURVE_POOL_ABI,
      functionName: 'get_dy',
      args: [0n, 1n, seizedWei],
    })
    return Number(saleWei - repayWei) / Number(repayWei)
  }

  const sliceWei = debtWei < 10n ** 18n ? debtWei : 10n ** 18n
  const [pnlPctSlice, pnlPctFull] = await Promise.all([pnlFor(sliceWei), pnlFor(debtWei)])
  return { borrowerDebt: Number(formatEther(debtWei)), pnlPctSlice, pnlPctFull }
}

// Price rules live in data/price-watch.json. `coin` is a DefiLlama coins id
// ("coingecko:ethereum" or "ethereum:0x<token>"). Each rule needs at least one
// trigger: `below` / `above` (absolute USD price) or `dropPct24h` / `risePct24h`
// (percentage move over 24h, positive numbers).
interface PriceRule {
  coin: string
  label: string
  below?: number
  above?: number
  dropPct24h?: number
  risePct24h?: number
}

// Best-effort anti-spam across warm invocations (same pattern as liquidity-watch)
const lastAlertAt = new Map<string, number>()

async function llamaJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`DefiLlama API error (${res.status})`)
  return res.json()
}

// Pinged frequently by cron-job.org: watches configured coin prices (absolute
// thresholds + 24h moves) and the health factor of every Morpho borrow
// position, so liquidation risk alerts within minutes, not hours.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const params = request.nextUrl.searchParams
  const authorized =
    secret && (request.headers.get('authorization') === `Bearer ${secret}` || params.get('key') === secret)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const addresses = (process.env.MONITORED_ADDRESS ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  const dryRun = params.get('dry') === '1'
  const healthCooldownMs =
    Number(params.get('cooldown') ?? DEFAULT_HEALTH_COOLDOWN_MINUTES) * 60_000
  const priceCooldownMs = PRICE_RULE_COOLDOWN_MINUTES * 60_000
  const rules = priceWatchConfig.rules as PriceRule[]

  try {
    const coins = [...new Set(rules.map((r) => r.coin))].join(',')
    const [prices, changes, positions, eulerPositions] = await Promise.all([
      coins
        ? llamaJson<{ coins: Record<string, { price: number }> }>(
            `https://coins.llama.fi/prices/current/${coins}`
          )
        : Promise.resolve({ coins: {} as Record<string, { price: number }> }),
      coins
        ? llamaJson<{ coins: Record<string, number> }>(
            `https://coins.llama.fi/percentage/${coins}?period=1d`
          ).catch(() => ({ coins: {} as Record<string, number> }))
        : Promise.resolve({ coins: {} as Record<string, number> }),
      Promise.all(addresses.map((a) => fetchUserPositions(a))).then((all) => ({
        markets: all.flatMap((p) => p.markets),
      })),
      Promise.all(addresses.map((a) => fetchEulerPositions(a).catch(() => []))).then((all) =>
        all.flat()
      ),
    ])

    // Stable `key` per condition (never includes the fluctuating price) so the
    // cooldown actually mutes repeats; a new condition still alerts while
    // another one is muted
    const triggered: { key: string; text: string }[] = []
    const checked: Record<string, { price: number | null; change24h: number | null }> = {}

    for (const rule of rules) {
      const price = prices.coins[rule.coin]?.price ?? null
      const change24h = changes.coins[rule.coin] ?? null
      checked[rule.label] = { price, change24h }
      const priceStr = price !== null ? `${price.toLocaleString('fr-BE')} $` : ''

      if (price !== null && rule.below !== undefined && price <= rule.below) {
        triggered.push({
          key: `${rule.coin}:below`,
          text: `📉 ${rule.label} à ${priceStr} — sous ton seuil de ${rule.below.toLocaleString('fr-BE')} $`,
        })
      }
      if (price !== null && rule.above !== undefined && price >= rule.above) {
        triggered.push({
          key: `${rule.coin}:above`,
          text: `📈 ${rule.label} à ${priceStr} — au-dessus de ton seuil de ${rule.above.toLocaleString('fr-BE')} $`,
        })
      }
      if (change24h !== null && rule.dropPct24h !== undefined && change24h <= -rule.dropPct24h) {
        triggered.push({
          key: `${rule.coin}:drop`,
          text: `🩸 ${rule.label} : ${change24h.toFixed(1)} % sur 24h${priceStr ? ` (${priceStr})` : ''}`,
        })
      }
      if (change24h !== null && rule.risePct24h !== undefined && change24h >= rule.risePct24h) {
        triggered.push({
          key: `${rule.coin}:rise`,
          text: `🚀 ${rule.label} : +${change24h.toFixed(1)} % sur 24h${priceStr ? ` (${priceStr})` : ''}`,
        })
      }
    }

    const atRisk =
      positions?.markets.filter(
        (p) => p.borrowAssets > 0 && p.healthFactor !== null && p.healthFactor < HEALTH_FACTOR_ALERT
      ) ?? []
    for (const p of atRisk) {
      const distance =
        p.priceVariationToLiquidationPrice !== null
          ? ` — liquidation à ${(p.priceVariationToLiquidationPrice * 100).toFixed(1)} % du prix actuel`
          : ''
      triggered.push({
        key: `hf:${p.chainId}-${p.marketId}`,
        text: `🚨 Health factor ${p.healthFactor!.toFixed(3)} (< ${HEALTH_FACTOR_ALERT}) sur un emprunt Morpho${distance}\nhttps://app.morpho.org/${p.chainId === 1 ? 'ethereum' : 'base'}/market/${p.marketId}`,
      })
    }

    const eulerAtRisk = eulerPositions.filter(
      (p) =>
        p.isController &&
        Number(p.borrowed) > 0 &&
        (p.debtUsd === null || p.debtUsd >= DUST_USD) &&
        ((p.healthFactor !== null && p.healthFactor < EULER_HEALTH_FACTOR_ALERT) ||
          (typeof p.daysToLiquidation === 'number' &&
            p.daysToLiquidation < EULER_DAYS_TO_LIQUIDATION_ALERT))
    )
    // Vault metadata fetched only for at-risk positions (normally zero)
    const eulerInfos = eulerAtRisk.length
      ? await fetchEulerVaultInfos(eulerAtRisk).catch(() => new Map())
      : new Map()
    for (const p of eulerAtRisk) {
      const symbol = eulerInfos.get(vaultKey(p.chainId, p.vault))?.assetSymbol ?? p.vault.slice(0, 8)
      const hf = p.healthFactor !== null ? `HF ${p.healthFactor.toFixed(3)}` : 'HF inconnu'
      const ttl =
        typeof p.daysToLiquidation === 'number' ? ` — liquidation estimée dans ${p.daysToLiquidation} j` : ''
      const debt = p.debtUsd !== null ? ` — dette ${Math.round(p.debtUsd).toLocaleString('fr-BE')} $` : ''
      triggered.push({
        key: `ehf:${p.chainId}-${p.vault}-${p.account.toLowerCase()}`,
        text: `🚨 [Euler] ${symbol} (${eulerChainName(p.chainId)}) : ${hf}${debt}${ttl}\n${eulerVaultUrl(p.chainId, p.vault)}`,
      })
    }

    // On failure (RPC flake), skip this check rather than losing the whole run
    const liq = await checkYnethxLiquidation().catch(() => null)
    if (liq && liq.pnlPctSlice >= LIQ_PROFIT_ALERT) {
      triggered.push({
        key: 'ynethx-liq-profit',
        text: `💰 Liquidation ynETHx RENTABLE : ${(liq.pnlPctSlice * 100).toFixed(2)} % sur 1 WETH, ${(liq.pnlPctFull * 100).toFixed(2)} % sur la totalité (dette ${liq.borrowerDebt.toFixed(3)} WETH). Le contrat d'exit est prêt à être adapté — fenêtre probablement courte.`,
      })
    }

    const now = Date.now()
    const fresh = triggered.filter((t) => {
      const cooldownMs = t.key.startsWith('hf:') ? healthCooldownMs : priceCooldownMs
      if (now - (lastAlertAt.get(t.key) ?? 0) < cooldownMs) return false
      if (!dryRun) lastAlertAt.set(t.key, now)
      return true
    })

    const message = fresh.map((t) => t.text).join('\n')
    if (message && !dryRun) await sendTelegram(`⚡ Price watch\n${message}`)

    return NextResponse.json({
      sent: Boolean(message) && !dryRun,
      rules: rules.length,
      checked,
      borrowPositionsAtRisk: atRisk.length + eulerAtRisk.length,
      eulerPositionsChecked: eulerPositions.length,
      ynethxLiquidation: liq,
      triggered: triggered.map((t) => t.text),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
