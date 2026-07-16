import { NextResponse } from 'next/server'
import { fetchMorphoMarkets } from '@/lib/morpho-api'

// Server-side proxy with Next's data cache: on upstream failure (e.g. the
// Morpho API 504 outage of 2026-07-16), the thrown error preserves the last
// successful cached payload, so the app keeps serving slightly stale markets.
export const revalidate = 300

export async function GET() {
  try {
    const markets = await fetchMorphoMarkets(300)
    return NextResponse.json({ markets })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'API Morpho indisponible'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
