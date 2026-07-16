import type { ApiMarket } from '@/lib/api'
import { morphoAppUrl } from '@/lib/api'
import type { UserPosition } from '@/lib/morpho-api'
import { getRiskAnalysis, getMarketRisk } from '@/lib/risk'

export const POSITION_APY_ALERT = 0.10 // alert if a lending position's APY falls below this
export const OPPORTUNITY_APY_MIN = 0.20 // candidate threshold for new opportunities
const MARKET_TVL_MIN_USD = 5_000 // ignore dust markets below this
const SELL_TEST_FRACTION = 0.10 // liquidity check: quote selling 10% of pool collateral
const MAX_PRICE_IMPACT = 0.05 // reject if the sell quote loses more than this
const PRICE_DROP_REJECT = 0.20 // reject if collateral lost >20% over 7d (depeg/hack proxy)
const MAX_QUOTES_PER_RUN = 12 // stay under Vercel's 30s function budget

// Chain slugs shared by KyberSwap and DefiLlama for our supported chains
const CHAIN_SLUGS: Record<number, string> = { 1: 'ethereum', 8453: 'base' }

export interface PositionAlert {
  market: ApiMarket
  supplyAssetsUsd: number | null
  supplyApy: number
  weeklySupplyApy: number | null
}

export function positionKey(chainId: number, marketId: string): string {
  return `${chainId}-${marketId}`
}

export function checkPositions(markets: ApiMarket[], positions: UserPosition[]): PositionAlert[] {
  const marketsByKey = new Map(markets.map((m) => [positionKey(m.chain.id, m.marketId), m]))

  return positions.flatMap((p) => {
    const market = marketsByKey.get(positionKey(p.chainId, p.marketId))
    if (!market?.state || market.state.supplyApy >= POSITION_APY_ALERT) return []
    return [
      {
        market,
        supplyAssetsUsd: p.supplyAssetsUsd,
        supplyApy: market.state.supplyApy,
        weeklySupplyApy: market.state.weeklySupplyApy,
      },
    ]
  })
}

export interface Opportunity {
  market: ApiMarket
  grade: string | null // null = collateral never analyzed
  sellTestUsd: number
  priceImpact: number
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

interface KyberQuote {
  amountInUsd: number
  amountOutUsd: number
}

async function fetchKyberSellQuote(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<KyberQuote | null> {
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

export interface OpportunityScan {
  opportunities: Opportunity[]
  rejections: string[]
}

function marketLabel(m: ApiMarket): string {
  return `${m.loanAsset.symbol}/${m.collateralAsset?.symbol ?? '?'} (${m.chain.network})`
}

// Candidates = high-APY markets that pass factual sanity checks only (no risk-grade
// filter): live market, real TVL, collateral price stable over 7d (depeg/hack proxy),
// and enough DEX liquidity to sell 10% of the pool's collateral at < 5% impact —
// i.e. liquidators could actually exit the collateral.
export async function findOpportunities(
  markets: ApiMarket[],
  excludeKeys: Set<string>
): Promise<OpportunityScan> {
  const candidates = markets
    .filter(
      (m) =>
        m.collateralAsset &&
        m.oracle &&
        m.state &&
        m.state.supplyApy >= OPPORTUNITY_APY_MIN &&
        m.state.utilization < 0.999 && // 100% utilization = broken market, displayed rate is fictional
        (m.state.supplyAssetsUsd ?? 0) >= MARKET_TVL_MIN_USD &&
        !excludeKeys.has(positionKey(m.chain.id, m.marketId))
    )
    .sort((a, b) => (b.state?.supplyApy ?? 0) - (a.state?.supplyApy ?? 0))
    .slice(0, MAX_QUOTES_PER_RUN)

  const rejections: string[] = []

  const coinKeys = candidates.map(
    (m) => `${CHAIN_SLUGS[m.chain.id]}:${m.collateralAsset!.address.toLowerCase()}`
  )
  // On DefiLlama outage, skip the depeg filter rather than losing the whole run
  const priceChanges = await fetchPriceChanges7d([...new Set(coinKeys)]).catch(() => {
    rejections.push('DefiLlama indisponible — check dépeg 7j non appliqué')
    return {} as Record<string, number>
  })

  const opportunities: Opportunity[] = []

  for (const market of candidates) {
    const label = marketLabel(market)
    const collateral = market.collateralAsset!
    const state = market.state!

    const change7d = priceChanges[`${CHAIN_SLUGS[market.chain.id]}:${collateral.address.toLowerCase()}`]
    if (change7d !== undefined && change7d <= -PRICE_DROP_REJECT * 100) {
      rejections.push(`${label} : prix collatéral ${change7d.toFixed(1)} % sur 7j — dépeg/hack probable`)
      continue
    }

    const amountIn = state.collateralAssets ? sellTestAmount(state.collateralAssets) : null
    if (amountIn === null) {
      rejections.push(`${label} : collatéral on-pool inconnu — liquidité invérifiable`)
      continue
    }

    // Sequential on purpose: KyberSwap public rate limit is ~1 req/s
    const quote = await fetchKyberSellQuote(
      market.chain.id,
      collateral.address,
      market.loanAsset.address,
      amountIn
    )
    if (!quote) {
      rejections.push(`${label} : aucune route de vente du collatéral — liquidité insuffisante`)
      continue
    }

    const priceImpact = 1 - quote.amountOutUsd / quote.amountInUsd
    if (priceImpact > MAX_PRICE_IMPACT) {
      rejections.push(
        `${label} : impact ${(priceImpact * 100).toFixed(1)} % en vendant ${usd(quote.amountInUsd)} de collatéral`
      )
      continue
    }

    const analysis = getRiskAnalysis(market.chain.id, collateral.address)
    opportunities.push({
      market,
      grade: analysis ? getMarketRisk(market, analysis).grade : null,
      sellTestUsd: quote.amountInUsd,
      priceImpact,
    })
  }

  return { opportunities, rejections }
}

function usd(value: number): string {
  return `${Math.round(value).toLocaleString('fr-BE')} $`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`
}

export function buildDigest(positionAlerts: PositionAlert[], opportunities: Opportunity[]): string | null {
  if (positionAlerts.length === 0 && opportunities.length === 0) return null

  const date = new Date().toLocaleDateString('fr-BE', {
    timeZone: 'Europe/Brussels',
    day: '2-digit',
    month: '2-digit',
  })
  const lines: string[] = [`🔔 Morpho Direct — ${date}`]

  if (positionAlerts.length > 0) {
    lines.push('', `⚠️ Positions sous ${pct(POSITION_APY_ALERT)} :`)
    for (const alert of positionAlerts) {
      const weekly = alert.weeklySupplyApy !== null ? ` (7j : ${pct(alert.weeklySupplyApy)})` : ''
      const size = alert.supplyAssetsUsd !== null ? ` — ${usd(alert.supplyAssetsUsd)}` : ''
      lines.push(
        `• ${marketLabel(alert.market)} — ${pct(alert.supplyApy)}${weekly}${size}`,
        `  ${morphoAppUrl(alert.market)}`
      )
    }
  }

  if (opportunities.length > 0) {
    lines.push('', `💡 Opportunités (APY ≥ ${pct(OPPORTUNITY_APY_MIN)}, prix stable 7j, liquidité OK) :`)
    for (const opp of opportunities) {
      const risk = opp.grade ? `grade ${opp.grade}` : '⚠️ à analyser'
      lines.push(
        `• ${marketLabel(opp.market)} — ${pct(opp.market.state!.supplyApy)} — ${risk} — vente 10 % pool (${usd(opp.sellTestUsd)}) : impact ${pct(opp.priceImpact)}`,
        `  ${morphoAppUrl(opp.market)}`
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
