import { NextRequest, NextResponse } from 'next/server'
import { fetchMorphoMarkets, fetchMorphoVaults, fetchUserPositions } from '@/lib/morpho-api'
import {
  buildDigest,
  checkPositions,
  checkVaultPositions,
  positionKey,
  scanOpportunities,
  sendTelegram,
  type OpportunityScan,
} from '@/lib/alerts'

export const maxDuration = 30

const DEFAULT_POSITIONS_COOLDOWN_MINUTES = 6 * 60

// Best-effort dedup for frequent `scope=positions` pings: survives warm
// invocations, resets on cold start (worst case an early duplicate alert)
const lastPositionAlertAt = new Map<string, number>()

const EMPTY_SCAN: OpportunityScan = { marketOpportunities: [], vaultOpportunities: [], rejections: [] }

// Daily full digest triggered by Vercel Cron (see vercel.json). cron-job.org
// pings `?scope=positions` more frequently: positions-only checks (lending
// below / borrow above threshold), no opportunity scan, with per-position
// cooldown so a persisting condition doesn't alert on every ping.
// `?dry=1` computes everything and returns the digest instead of sending it.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const params = request.nextUrl.searchParams
  const authorized =
    secret && (request.headers.get('authorization') === `Bearer ${secret}` || params.get('key') === secret)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const address = process.env.MONITORED_ADDRESS
  if (!address) {
    return NextResponse.json({ error: 'MONITORED_ADDRESS manquant' }, { status: 500 })
  }

  const positionsOnly = params.get('scope') === 'positions'
  const dryRun = params.get('dry') === '1'

  try {
    const [markets, vaults, positions] = await Promise.all([
      fetchMorphoMarkets(),
      positionsOnly ? Promise.resolve([]) : fetchMorphoVaults(),
      fetchUserPositions(address),
    ])

    let positionAlerts = [
      ...checkPositions(markets, positions.markets),
      ...checkVaultPositions(positions.vaults),
    ]

    if (positionsOnly) {
      const cooldownMs =
        Number(params.get('cooldown') ?? DEFAULT_POSITIONS_COOLDOWN_MINUTES) * 60_000
      const now = Date.now()
      positionAlerts = positionAlerts.filter((a) => {
        const key = `${a.kind}:${a.url}`
        if (now - (lastPositionAlertAt.get(key) ?? 0) < cooldownMs) return false
        if (!dryRun) lastPositionAlertAt.set(key, now)
        return true
      })
    }

    const scan = positionsOnly
      ? EMPTY_SCAN
      : await scanOpportunities(
          markets,
          vaults,
          new Set(positions.markets.map((p) => positionKey(p.chainId, p.marketId))),
          new Set(positions.vaults.map((p) => p.vault.address.toLowerCase()))
        )

    const digest = buildDigest(positionAlerts, scan)
    if (digest && !dryRun) await sendTelegram(digest)

    return NextResponse.json({
      sent: digest !== null && !dryRun,
      scope: positionsOnly ? 'positions' : 'full',
      positionsChecked: positions.markets.length + positions.vaults.length,
      positionAlerts: positionAlerts.length,
      marketOpportunities: scan.marketOpportunities.length,
      vaultOpportunities: scan.vaultOpportunities.length,
      rejections: scan.rejections,
      digest,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
