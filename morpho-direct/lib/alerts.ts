import type { ApiMarket } from '@/lib/api'
import { morphoAppUrl } from '@/lib/api'
import type { EulerPosition, EulerVaultInfo } from '@/lib/euler'
import { eulerChainName, eulerVaultUrl, vaultKey } from '@/lib/euler'
import type { ApiVault, UserPosition, UserVaultPosition } from '@/lib/morpho-api'
import { fetchVaultAllocations, morphoVaultUrl } from '@/lib/morpho-api'
import { getRiskAnalysis, getMarketRisk } from '@/lib/risk'

export const POSITION_APY_ALERT = 0.10 // alert if a lending position's APY falls below this
export const BORROW_APY_ALERT = 0.10 // alert if a borrow position's rate rises above this
export const OPPORTUNITY_APY_MIN = 0.20 // candidate threshold for new opportunities
const POSITION_MIN_USD = 1 // ignore dust positions
const MARKET_TVL_MIN_USD = 5_000 // ignore dust markets below this
const SELL_TEST_FRACTION = 0.10 // liquidity check: quote selling 10% of pool collateral
const MAX_PRICE_IMPACT = 0.05 // reject if the sell quote loses more than this
const PRICE_DROP_REJECT = 0.20 // reject if collateral lost >20% over 7d (depeg/hack proxy)
const MAX_QUOTES_PER_RUN = 14 // global quote budget, stays under Vercel's 30s limit
const MAX_MARKET_CANDIDATES = 8
// Vaults with aberrant netApy are usually allocated to a broken (100% utilization)
// market and get rejected without spending any quote — screen enough of them in
// parallel so real opportunities below aren't starved by the cap.
const MAX_VAULT_CANDIDATES = 20
const VAULT_ALLOCATION_MIN_SHARE = 0.05 // ignore allocations under 5% of vault TVL

// Chain slugs shared by KyberSwap and DefiLlama for our supported chains
const CHAIN_SLUGS: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

export function positionKey(chainId: number, marketId: string): string {
  return `${chainId}-${marketId}`
}

// ---------------------------------------------------------------------------
// Position alerts

export interface PositionAlert {
  kind: 'lending' | 'borrow'
  label: string
  apy: number
  weeklyApy: number | null
  sizeUsd: number | null
  url: string
}

export function checkPositions(markets: ApiMarket[], positions: UserPosition[]): PositionAlert[] {
  const marketsByKey = new Map(markets.map((m) => [positionKey(m.chain.id, m.marketId), m]))

  return positions.flatMap((p) => {
    const market = marketsByKey.get(positionKey(p.chainId, p.marketId))
    if (!market?.state) return []
    const alerts: PositionAlert[] = []

    const supplyUsd = p.supplyAssetsUsd
    if (
      p.supplyAssets > 0 &&
      (supplyUsd === null || supplyUsd >= POSITION_MIN_USD) &&
      market.state.supplyApy < POSITION_APY_ALERT
    ) {
      alerts.push({
        kind: 'lending',
        label: marketLabel(market),
        apy: market.state.supplyApy,
        weeklyApy: market.state.weeklySupplyApy,
        sizeUsd: supplyUsd,
        url: morphoAppUrl(market),
      })
    }

    const borrowUsd = p.borrowAssetsUsd
    if (
      p.borrowAssets > 0 &&
      (borrowUsd === null || borrowUsd >= POSITION_MIN_USD) &&
      market.state.borrowApy > BORROW_APY_ALERT
    ) {
      alerts.push({
        kind: 'borrow',
        label: marketLabel(market),
        apy: market.state.borrowApy,
        weeklyApy: null,
        sizeUsd: borrowUsd,
        url: morphoAppUrl(market),
      })
    }

    return alerts
  })
}

export function checkEulerPositions(
  positions: EulerPosition[],
  vaultInfos: Map<string, EulerVaultInfo>
): PositionAlert[] {
  return positions.flatMap((p) => {
    const info = vaultInfos.get(vaultKey(p.chainId, p.vault))
    if (!info) return []
    const alerts: PositionAlert[] = []
    const label = `[Euler] ${info.assetSymbol} (${eulerChainName(p.chainId)})`
    const url = eulerVaultUrl(p.chainId, p.vault)

    const supplied = Number(p.assets) / 10 ** info.assetDecimals
    const suppliedUsd = info.assetPriceUsd !== null ? supplied * info.assetPriceUsd : null
    // Escrow-style collateral (0% native APY, yield lives in the token itself,
    // e.g. syzUSD/syrupUSDT loops) is not a lending position — don't alert on it
    const escrowCollateral = p.isCollateral && info.supplyApy === 0
    if (
      supplied > 0 &&
      !escrowCollateral &&
      (suppliedUsd === null || suppliedUsd >= POSITION_MIN_USD) &&
      info.supplyApy / 100 < POSITION_APY_ALERT
    ) {
      alerts.push({
        kind: 'lending',
        label,
        apy: info.supplyApy / 100,
        weeklyApy: null,
        sizeUsd: suppliedUsd,
        url,
      })
    }

    if (
      Number(p.borrowed) > 0 &&
      (p.debtUsd === null || p.debtUsd >= POSITION_MIN_USD) &&
      info.borrowApy / 100 > BORROW_APY_ALERT
    ) {
      alerts.push({
        kind: 'borrow',
        label,
        apy: info.borrowApy / 100,
        weeklyApy: null,
        sizeUsd: p.debtUsd,
        url,
      })
    }

    return alerts
  })
}

export function checkVaultPositions(positions: UserVaultPosition[]): PositionAlert[] {
  return positions.flatMap((p) => {
    if (p.assetsUsd < POSITION_MIN_USD || !p.vault.state) return []
    if (p.vault.state.netApy >= POSITION_APY_ALERT) return []
    return [
      {
        kind: 'lending' as const,
        label: vaultLabel(p.vault),
        apy: p.vault.state.netApy,
        weeklyApy: null,
        sizeUsd: p.assetsUsd,
        url: morphoVaultUrl(p.vault),
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// Exit check — can a liquidator actually sell this market's collateral?

interface ExitCheck {
  ok: boolean
  reason?: string
  sellTestUsd: number
  priceImpact: number
}

interface ScanContext {
  priceChanges: Record<string, number>
  exitCache: Map<string, ExitCheck>
  quotesLeft: number
}

function coinKey(market: ApiMarket): string {
  return `${CHAIN_SLUGS[market.chain.id]}:${market.collateralAsset!.address.toLowerCase()}`
}

// 7d price change (%) per `chain:address` coin key, batched in one call
async function fetchPriceChanges7d(coinKeys: string[]): Promise<Record<string, number>> {
  if (coinKeys.length === 0) return {}
  const res = await fetch(`https://coins.llama.fi/percentage/${coinKeys.join(',')}?period=1w`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`DefiLlama price API error (${res.status})`)
  const json: { coins: Record<string, number> } = await res.json()
  return json.coins
}

// Floats >= 2^53 are always integer-valued, so BigInt(Math.round()) never throws
function sellTestAmount(rawCollateralAssets: string | number): bigint | null {
  const amount = Number(rawCollateralAssets) * SELL_TEST_FRACTION
  if (!Number.isFinite(amount) || amount < 1) return null
  return BigInt(Math.round(amount))
}

async function fetchKyberSellQuote(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<{ amountInUsd: number; amountOutUsd: number } | null> {
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
  })
  const res = await fetch(
    `https://aggregator-api.kyberswap.com/${CHAIN_SLUGS[chainId]}/api/v1/routes?${params}`,
    { headers: { 'x-client-id': 'morpho-direct' }, cache: 'no-store' }
  )
  if (!res.ok) return null

  const json = await res.json()
  const summary = json?.data?.routeSummary
  if (!summary) return null

  const amountInUsd = Number(summary.amountInUsd)
  const amountOutUsd = Number(summary.amountOutUsd)
  if (!Number.isFinite(amountInUsd) || !Number.isFinite(amountOutUsd) || amountInUsd <= 0) {
    return null
  }
  return { amountInUsd, amountOutUsd }
}

async function checkMarketExit(market: ApiMarket, ctx: ScanContext): Promise<ExitCheck> {
  const key = positionKey(market.chain.id, market.marketId)
  const cached = ctx.exitCache.get(key)
  if (cached) return cached

  const check = await computeMarketExit(market, ctx)
  ctx.exitCache.set(key, check)
  return check
}

async function computeMarketExit(market: ApiMarket, ctx: ScanContext): Promise<ExitCheck> {
  const state = market.state!
  const collateral = market.collateralAsset!
  const fail = (reason: string): ExitCheck => ({ ok: false, reason, sellTestUsd: 0, priceImpact: 0 })

  if (state.utilization >= 0.999) {
    // 100% utilization = broken market, displayed rate is fictional (msY/AZND)
    return fail('utilisation 100 % — marché cassé, taux fictif')
  }

  const change7d = ctx.priceChanges[coinKey(market)]
  if (change7d !== undefined && change7d <= -PRICE_DROP_REJECT * 100) {
    return fail(`prix collatéral ${change7d.toFixed(1)} % sur 7j — dépeg/hack probable`)
  }

  const amountIn = state.collateralAssets ? sellTestAmount(state.collateralAssets) : null
  if (amountIn === null) return fail('collatéral on-pool inconnu — liquidité invérifiable')

  if (ctx.quotesLeft <= 0) return fail('budget de quotes épuisé — non vérifié ce run')
  ctx.quotesLeft--

  // Sequential on purpose: KyberSwap public rate limit is ~1 req/s
  const quote = await fetchKyberSellQuote(
    market.chain.id,
    collateral.address,
    market.loanAsset.address,
    amountIn
  )
  if (!quote) return fail('aucune route de vente du collatéral — liquidité insuffisante')

  const priceImpact = 1 - quote.amountOutUsd / quote.amountInUsd
  if (priceImpact > MAX_PRICE_IMPACT) {
    return fail(`impact ${(priceImpact * 100).toFixed(1)} % en vendant ${usd(quote.amountInUsd)} de collatéral`)
  }

  return { ok: true, sellTestUsd: quote.amountInUsd, priceImpact }
}

// ---------------------------------------------------------------------------
// Opportunity scan — markets and vaults share the exit checks and quote budget

export interface MarketOpportunity {
  market: ApiMarket
  grade: string | null // null = collateral never analyzed
  exit: ExitCheck
}

export interface VaultOpportunity {
  vault: ApiVault
  worstExit: ExitCheck
  worstMarketLabel: string
}

export interface OpportunityScan {
  marketOpportunities: MarketOpportunity[]
  vaultOpportunities: VaultOpportunity[]
  rejections: string[]
}

function marketLabel(m: ApiMarket): string {
  return `${m.loanAsset.symbol}/${m.collateralAsset?.symbol ?? '?'} (${m.chain.network})`
}

function vaultLabel(v: ApiVault): string {
  return `[Vault] ${v.name} (${v.chain.network})`
}

function isMarketCandidate(m: ApiMarket): boolean {
  return Boolean(
    m.collateralAsset &&
      m.oracle &&
      m.state &&
      m.state.supplyApy >= OPPORTUNITY_APY_MIN &&
      // Filter broken markets before the candidate cap so they don't starve real ones
      // (utilization is re-checked in computeMarketExit for vault allocations)
      m.state.utilization < 0.999 &&
      (m.state.supplyAssetsUsd ?? 0) >= MARKET_TVL_MIN_USD
  )
}

// Candidates = high-yield markets/vaults that pass factual sanity checks only
// (no risk-grade filter): live market, real TVL, collateral price stable over
// 7d (depeg/hack proxy), and enough DEX liquidity to sell 10% of the pool's
// collateral at < 5% impact — i.e. liquidators could actually exit.
export async function scanOpportunities(
  markets: ApiMarket[],
  vaults: ApiVault[],
  excludeMarketKeys: Set<string>,
  excludeVaultAddresses: Set<string>
): Promise<OpportunityScan> {
  const marketCandidates = markets
    .filter((m) => isMarketCandidate(m) && !excludeMarketKeys.has(positionKey(m.chain.id, m.marketId)))
    .sort((a, b) => (b.state?.supplyApy ?? 0) - (a.state?.supplyApy ?? 0))
    .slice(0, MAX_MARKET_CANDIDATES)

  const vaultCandidates = vaults
    .filter(
      (v) =>
        v.state &&
        v.state.netApy >= OPPORTUNITY_APY_MIN &&
        !excludeVaultAddresses.has(v.address.toLowerCase())
    )
    .sort((a, b) => (b.state?.netApy ?? 0) - (a.state?.netApy ?? 0))
    .slice(0, MAX_VAULT_CANDIDATES)

  const rejections: string[] = []

  const allocationsByVault = new Map(
    await Promise.all(
      vaultCandidates.map(async (v) => {
        const allocations = await fetchVaultAllocations(v).catch(() => null)
        const minUsd = (v.state?.totalAssetsUsd ?? 0) * VAULT_ALLOCATION_MIN_SHARE
        return [
          v.address,
          // Idle allocations (no collateral) are just liquidity — nothing to check
          allocations?.filter((a) => a.supplyAssetsUsd >= minUsd && a.market.collateralAsset) ?? null,
        ] as const
      })
    )
  )

  const allocationMarkets = [...allocationsByVault.values()].flat().map((a) => a?.market)
  const coinKeys = [...marketCandidates, ...allocationMarkets]
    .filter((m): m is ApiMarket => Boolean(m?.collateralAsset))
    .map(coinKey)

  const ctx: ScanContext = {
    // On DefiLlama outage, skip the depeg filter rather than losing the whole run
    priceChanges: await fetchPriceChanges7d([...new Set(coinKeys)]).catch(() => {
      rejections.push('DefiLlama indisponible — check dépeg 7j non appliqué')
      return {}
    }),
    exitCache: new Map(),
    quotesLeft: MAX_QUOTES_PER_RUN,
  }

  const marketOpportunities: MarketOpportunity[] = []
  for (const market of marketCandidates) {
    const exit = await checkMarketExit(market, ctx)
    if (!exit.ok) {
      rejections.push(`${marketLabel(market)} : ${exit.reason}`)
      continue
    }
    const analysis = getRiskAnalysis(market.chain.id, market.collateralAsset!.address)
    marketOpportunities.push({
      market,
      grade: analysis ? getMarketRisk(market, analysis).grade : null,
      exit,
    })
  }

  const vaultOpportunities: VaultOpportunity[] = []
  for (const vault of vaultCandidates) {
    const allocations = allocationsByVault.get(vault.address)
    if (!allocations) {
      rejections.push(`${vaultLabel(vault)} : allocations irrécupérables — non vérifié`)
      continue
    }
    if (allocations.length === 0) {
      rejections.push(`${vaultLabel(vault)} : aucune allocation vérifiable`)
      continue
    }

    let worst: { exit: ExitCheck; label: string } | null = null
    let rejected = false
    for (const allocation of allocations) {
      const exit = await checkMarketExit(allocation.market, ctx)
      if (!exit.ok) {
        rejections.push(`${vaultLabel(vault)} : alloc ${marketLabel(allocation.market)} — ${exit.reason}`)
        rejected = true
        break
      }
      if (!worst || exit.priceImpact > worst.exit.priceImpact) {
        worst = { exit, label: marketLabel(allocation.market) }
      }
    }
    if (!rejected && worst) {
      vaultOpportunities.push({ vault, worstExit: worst.exit, worstMarketLabel: worst.label })
    }
  }

  return { marketOpportunities, vaultOpportunities, rejections }
}

// ---------------------------------------------------------------------------
// Digest

function usd(value: number): string {
  return `${Math.round(value).toLocaleString('fr-BE')} $`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`
}

export function buildDigest(positionAlerts: PositionAlert[], scan: OpportunityScan): string | null {
  const { marketOpportunities, vaultOpportunities } = scan
  if (positionAlerts.length === 0 && marketOpportunities.length === 0 && vaultOpportunities.length === 0) {
    return null
  }

  const date = new Date().toLocaleDateString('fr-BE', {
    timeZone: 'Europe/Brussels',
    day: '2-digit',
    month: '2-digit',
  })
  const lines: string[] = [`🔔 Morpho Direct — ${date}`]

  const lendingAlerts = positionAlerts.filter((a) => a.kind === 'lending')
  const borrowAlerts = positionAlerts.filter((a) => a.kind === 'borrow')

  const pushAlertLines = (alerts: PositionAlert[]) => {
    for (const alert of alerts) {
      const weekly = alert.weeklyApy !== null ? ` (7j : ${pct(alert.weeklyApy)})` : ''
      const size = alert.sizeUsd !== null ? ` — ${usd(alert.sizeUsd)}` : ''
      lines.push(`• ${alert.label} — ${pct(alert.apy)}${weekly}${size}`, `  ${alert.url}`)
    }
  }

  if (lendingAlerts.length > 0) {
    lines.push('', `⚠️ Lending sous ${pct(POSITION_APY_ALERT)} :`)
    pushAlertLines(lendingAlerts)
  }

  if (borrowAlerts.length > 0) {
    lines.push('', `🔺 Emprunts au-dessus de ${pct(BORROW_APY_ALERT)} :`)
    pushAlertLines(borrowAlerts)
  }

  if (marketOpportunities.length > 0 || vaultOpportunities.length > 0) {
    lines.push('', `💡 Opportunités (APY ≥ ${pct(OPPORTUNITY_APY_MIN)}, prix stable 7j, liquidité OK) :`)
    for (const opp of marketOpportunities) {
      const risk = opp.grade ? `grade ${opp.grade}` : '⚠️ à analyser'
      lines.push(
        `• ${marketLabel(opp.market)} — ${pct(opp.market.state!.supplyApy)} — ${risk} — vente 10 % pool (${usd(opp.exit.sellTestUsd)}) : impact ${pct(opp.exit.priceImpact)}`,
        `  ${morphoAppUrl(opp.market)}`
      )
    }
    for (const opp of vaultOpportunities) {
      const curated = opp.vault.listed ? '' : ' — non curaté'
      lines.push(
        `• ${vaultLabel(opp.vault)} — ${pct(opp.vault.state!.netApy)} net${curated} — pire alloc ${opp.worstMarketLabel} : impact ${pct(opp.worstExit.priceImpact)} (vente ${usd(opp.worstExit.sellTestUsd)})`,
        `  ${morphoVaultUrl(opp.vault)}`
      )
    }
  }

  return lines.join('\n')
}

const TELEGRAM_MAX_LENGTH = 4096

export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants')

  const body =
    text.length > TELEGRAM_MAX_LENGTH ? `${text.slice(0, TELEGRAM_MAX_LENGTH - 1)}…` : text
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
  })
  if (!res.ok) throw new Error(`Telegram API error ${res.status}: ${await res.text()}`)
}
