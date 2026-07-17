import { NextRequest, NextResponse } from 'next/server'
import { fetchMorphoMarkets, fetchMorphoVaults, fetchUserPositions } from '@/lib/morpho-api'
import {
  buildDigest,
  checkPositions,
  checkVaultPositions,
  positionKey,
  scanOpportunities,
  sendTelegram,
} from '@/lib/alerts'

export const maxDuration = 30

// Daily digest triggered by Vercel Cron (see vercel.json). `?dry=1` computes
// everything and returns the digest in the response instead of sending it.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const address = process.env.MONITORED_ADDRESS
  if (!address) {
    return NextResponse.json({ error: 'MONITORED_ADDRESS manquant' }, { status: 500 })
  }

  try {
    const [markets, vaults, positions] = await Promise.all([
      fetchMorphoMarkets(),
      fetchMorphoVaults(),
      fetchUserPositions(address),
    ])

    const positionAlerts = [
      ...checkPositions(markets, positions.markets),
      ...checkVaultPositions(positions.vaults),
    ]
    const suppliedMarketKeys = new Set(positions.markets.map((p) => positionKey(p.chainId, p.marketId)))
    const suppliedVaults = new Set(positions.vaults.map((p) => p.vault.address.toLowerCase()))
    const scan = await scanOpportunities(markets, vaults, suppliedMarketKeys, suppliedVaults)

    const digest = buildDigest(positionAlerts, scan)
    const dryRun = request.nextUrl.searchParams.get('dry') === '1'
    if (digest && !dryRun) await sendTelegram(digest)

    return NextResponse.json({
      sent: digest !== null && !dryRun,
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
