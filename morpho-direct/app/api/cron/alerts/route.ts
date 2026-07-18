import { NextRequest, NextResponse } from 'next/server'
import { morphoAppUrl } from '@/lib/api'
import { fetchEulerPositions, fetchEulerVaultInfos } from '@/lib/euler'
import { fetchMorphoMarkets, fetchMorphoVaults, fetchUserPositions, morphoVaultUrl } from '@/lib/morpho-api'
import {
  buildDigest,
  checkEulerPositions,
  checkPositions,
  checkVaultPositions,
  positionKey,
  scanOpportunities,
  sendTelegram,
  type OpportunityScan,
} from '@/lib/alerts'

export const maxDuration = 30

const DEFAULT_POSITIONS_COOLDOWN_MINUTES = 6 * 60
const DEFAULT_OPPORTUNITIES_COOLDOWN_MINUTES = 24 * 60

// Best-effort dedup for frequent scoped pings: survives warm invocations,
// resets on cold start (worst case an early duplicate alert)
const lastPositionAlertAt = new Map<string, number>()
const lastOpportunityAlertAt = new Map<string, number>()

const EMPTY_SCAN: OpportunityScan = { marketOpportunities: [], vaultOpportunities: [], rejections: [] }

// Daily full digest triggered by Vercel Cron (see vercel.json). cron-job.org
// pings scoped variants more frequently: `?scope=positions` (rate checks only)
// and `?scope=opportunities` (scan only), each with a cooldown so a persisting
// condition doesn't alert on every ping. The daily full digest never dedupes.
// `?dry=1` computes everything and returns the digest instead of sending it.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const params = request.nextUrl.searchParams
  const authorized =
    secret && (request.headers.get('authorization') === `Bearer ${secret}` || params.get('key') === secret)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Comma-separated list of monitored wallets
  const addresses = (process.env.MONITORED_ADDRESS ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  if (addresses.length === 0) {
    return NextResponse.json({ error: 'MONITORED_ADDRESS manquant' }, { status: 500 })
  }

  const scope = params.get('scope') // 'positions' | 'opportunities' | null (full)
  const withPositions = scope !== 'opportunities'
  const withScan = scope !== 'positions'
  const dryRun = params.get('dry') === '1'

  try {
    const [markets, vaults, perAddress, eulerPerAddress] = await Promise.all([
      fetchMorphoMarkets(),
      withScan ? fetchMorphoVaults() : Promise.resolve([]),
      Promise.all(addresses.map((a) => fetchUserPositions(a))),
      withPositions
        ? Promise.all(addresses.map((a) => fetchEulerPositions(a).catch(() => null)))
        : Promise.resolve([]),
    ])
    const positions = {
      markets: perAddress.flatMap((p) => p.markets),
      vaults: perAddress.flatMap((p) => p.vaults),
    }
    const eulerFailed = eulerPerAddress.some((p) => p === null)
    const eulerPositions = eulerPerAddress.flatMap((p) => p ?? [])
    const eulerVaultInfos = await fetchEulerVaultInfos(eulerPositions).catch(() => new Map())

    let positionAlerts = withPositions
      ? [
          ...checkPositions(markets, positions.markets),
          ...checkVaultPositions(positions.vaults),
          ...checkEulerPositions(eulerPositions, eulerVaultInfos),
        ]
      : []

    if (scope === 'positions') {
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

    const scan = withScan
      ? await scanOpportunities(
          markets,
          vaults,
          new Set(positions.markets.map((p) => positionKey(p.chainId, p.marketId))),
          new Set(positions.vaults.map((p) => p.vault.address.toLowerCase()))
        )
      : EMPTY_SCAN

    if (scope === 'opportunities') {
      const cooldownMs =
        Number(params.get('cooldown') ?? DEFAULT_OPPORTUNITIES_COOLDOWN_MINUTES) * 60_000
      const now = Date.now()
      const fresh = (url: string) => {
        if (now - (lastOpportunityAlertAt.get(url) ?? 0) < cooldownMs) return false
        if (!dryRun) lastOpportunityAlertAt.set(url, now)
        return true
      }
      scan.marketOpportunities = scan.marketOpportunities.filter((o) => fresh(morphoAppUrl(o.market)))
      scan.vaultOpportunities = scan.vaultOpportunities.filter((o) => fresh(morphoVaultUrl(o.vault)))
    }

    const digest = buildDigest(positionAlerts, scan)
    if (digest && !dryRun) await sendTelegram(digest)

    return NextResponse.json({
      sent: digest !== null && !dryRun,
      scope: scope ?? 'full',
      positionsChecked:
        positions.markets.length + positions.vaults.length + eulerPositions.length,
      positionAlerts: positionAlerts.length,
      marketOpportunities: scan.marketOpportunities.length,
      vaultOpportunities: scan.vaultOpportunities.length,
      rejections: eulerFailed ? [...scan.rejections, 'API Euler indisponible — positions Euler non vérifiées'] : scan.rejections,
      digest,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
