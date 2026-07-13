'use client'

import { morphoAppUrl, type ApiMarket } from '@/lib/api'
import { getRiskAnalysis, getMarketRisk, isStale, GRADE_COLORS } from '@/lib/risk'
import type { SortBy } from './MarketBrowser'

interface MarketCardProps {
  market: ApiMarket
  sortBy: SortBy
  onClick: () => void
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
}

const APY_LABELS: Record<SortBy, string> = {
  liquidity: 'Supply APY',
  apy: 'Supply APY',
  apy7d: 'Supply APY (7d avg)',
  apy30d: 'Supply APY (30d avg)',
}

function displayedApy(market: ApiMarket, sortBy: SortBy): number | null {
  if (!market.state) return null
  if (sortBy === 'apy7d') return market.state.weeklySupplyApy
  if (sortBy === 'apy30d') return market.state.monthlySupplyApy
  return market.state.supplyApy
}

export function MarketCard({ market, sortBy, onClick }: MarketCardProps) {
  const risk = market.collateralAsset
    ? getRiskAnalysis(market.chain.id, market.collateralAsset.address)
    : null
  const marketRisk = risk ? getMarketRisk(market, risk) : null
  const stale = risk ? isStale(risk) : false
  const apyValue = displayedApy(market, sortBy)
  const supplyApy = apyValue !== null ? (apyValue * 100).toFixed(2) : '—'
  const borrowApy = market.state ? (market.state.borrowApy * 100).toFixed(2) : '—'
  const utilization = market.state ? (market.state.utilization * 100).toFixed(1) : '—'
  const lltv = (Number(market.lltv) / 1e18 * 100).toFixed(0)
  const chainName = CHAIN_NAMES[market.chain.id] ?? `Chain ${market.chain.id}`

  const tvlUsd = market.state?.supplyAssetsUsd
  const tvlFormatted = tvlUsd != null
    ? formatUsd(tvlUsd)
    : formatAssets(BigInt(market.state?.supplyAssets ?? '0'), market.loanAsset.decimals, market.loanAsset.symbol)

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
      className="w-full text-left rounded-xl p-5 cursor-pointer transition-all duration-150"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
      }}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-base" style={{ color: 'var(--foreground)' }}>
              {market.loanAsset.symbol}
            </span>
            {market.collateralAsset && (
              <>
                <span style={{ color: 'var(--muted)' }}>/</span>
                <span className="text-sm" style={{ color: 'var(--muted)' }}>
                  {market.collateralAsset.symbol}
                </span>
              </>
            )}
            {risk && marketRisk && (
              <span
                className="text-xs font-bold px-1.5 py-0.5 rounded"
                style={{
                  background: GRADE_COLORS[marketRisk.grade].bg,
                  color: GRADE_COLORS[marketRisk.grade].text,
                  opacity: stale ? 0.45 : 1,
                }}
                title={[
                  `Note marché : ${marketRisk.grade} (collatéral ${risk.grade}${risk.gradeModifier ?? ''})`,
                  ...marketRisk.reasons,
                  stale ? `⚠ Analyse du ${risk.analyzedAt} — re-check recommandé` : '',
                ].filter(Boolean).join('\n')}
              >
                {marketRisk.grade !== risk.grade ? `${risk.grade}→${marketRisk.grade}` : marketRisk.grade}
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: 'var(--border)', color: 'var(--muted)' }}
            >
              {chainName}
            </span>
            <a
              href={morphoAppUrl(market)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs px-2 py-0.5 rounded-full cursor-pointer transition-opacity hover:opacity-80"
              style={{ background: 'var(--border)', color: 'var(--muted)' }}
            >
              Morpho ↗
            </a>
          </span>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold" style={{ color: '#4ade80' }}>
            {supplyApy}%
          </div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {APY_LABELS[sortBy]}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="TVL" value={tvlFormatted} />
        <Stat label="Utilization" value={`${utilization}%`} />
        <Stat label="LLTV" value={`${lltv}%`} />
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          Borrow APY: <span style={{ color: 'var(--foreground)' }}>{borrowApy}%</span>
        </div>
        <div
          className="text-xs font-medium px-3 py-1 rounded-full"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Supply →
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <div className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
        {value}
      </div>
    </div>
  )
}

function formatUsd(num: number): string {
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(1)}B`
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`
  return `$${num.toFixed(2)}`
}

function formatAssets(value: bigint, decimals: number, symbol: string): string {
  const num = Number(value) / Number(10n ** BigInt(decimals))
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M ${symbol}`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K ${symbol}`
  return `${num.toFixed(2)} ${symbol}`
}
