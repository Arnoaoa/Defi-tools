import { NextRequest, NextResponse } from 'next/server'
import priceWatchConfig from '@/data/price-watch.json'
import { fetchUserPositions } from '@/lib/morpho-api'
import { sendTelegram } from '@/lib/alerts'

export const maxDuration = 30

const HEALTH_FACTOR_ALERT = 1.15 // borrow position approaching liquidation
const DEFAULT_HEALTH_COOLDOWN_MINUTES = 60 // repeats are useful when near liquidation
const PRICE_RULE_COOLDOWN_MINUTES = 6 * 60 // a durably crossed limit shouldn't spam

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

  const address = process.env.MONITORED_ADDRESS
  const dryRun = params.get('dry') === '1'
  const healthCooldownMs =
    Number(params.get('cooldown') ?? DEFAULT_HEALTH_COOLDOWN_MINUTES) * 60_000
  const priceCooldownMs = PRICE_RULE_COOLDOWN_MINUTES * 60_000
  const rules = priceWatchConfig.rules as PriceRule[]

  try {
    const coins = [...new Set(rules.map((r) => r.coin))].join(',')
    const [prices, changes, positions] = await Promise.all([
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
      address ? fetchUserPositions(address) : Promise.resolve(null),
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
        text: `🚨 Health factor ${p.healthFactor!.toFixed(3)} (< ${HEALTH_FACTOR_ALERT}) sur un emprunt${distance}\nhttps://app.morpho.org/${p.chainId === 1 ? 'ethereum' : 'base'}/market/${p.marketId}`,
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
      borrowPositionsAtRisk: atRisk.length,
      triggered: triggered.map((t) => t.text),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
