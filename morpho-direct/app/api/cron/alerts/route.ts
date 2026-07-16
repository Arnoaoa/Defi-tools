import { NextRequest, NextResponse } from 'next/server'
import { fetchMorphoMarkets, fetchUserPositions } from '@/lib/morpho-api'
import { checkPositions, findOpportunities, buildDigest, positionKey, sendTelegram } from '@/lib/alerts'

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
    const [markets, positions] = await Promise.all([
      fetchMorphoMarkets(),
      fetchUserPositions(address),
    ])

    const positionAlerts = checkPositions(markets, positions)
    const suppliedKeys = new Set(positions.map((p) => positionKey(p.chainId, p.marketId)))
    const { opportunities, rejections } = await findOpportunities(markets, suppliedKeys)

    const digest = buildDigest(positionAlerts, opportunities)
    const dryRun = request.nextUrl.searchParams.get('dry') === '1'
    if (digest && !dryRun) await sendTelegram(digest)

    return NextResponse.json({
      sent: digest !== null && !dryRun,
      positionsChecked: positions.length,
      positionAlerts: positionAlerts.length,
      opportunities: opportunities.length,
      rejections,
      digest,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
