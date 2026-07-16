'use client'

import { useMemo, useState } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import type { ApiMarket } from '@/lib/api'
import {
  MORPHO_BLUE_ADDRESS,
  MORPHO_BLUE_ABI,
  ORACLE_ABI,
  ORACLE_PRICE_SCALE,
  sharesToAssets,
  formatAmount,
} from '@/lib/morpho'
import { getRiskAnalysis, getMarketRisk, GRADE_COLORS } from '@/lib/risk'

interface PositionsProps {
  markets: ApiMarket[]
  onManage: (market: ApiMarket) => void
}

type Tab = 'lending' | 'borrowing'

interface RawPosition {
  market: ApiMarket
  supplyShares: bigint
  borrowShares: bigint
  collateral: bigint
}

function loanPriceUsd(market: ApiMarket): number | null {
  const s = market.state
  if (!s?.supplyAssetsUsd || !s.supplyAssets) return null
  const tokens = Number(s.supplyAssets) / 10 ** market.loanAsset.decimals
  return tokens > 0 ? s.supplyAssetsUsd / tokens : null
}

function usd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export function Positions({ markets, onManage }: PositionsProps) {
  const { address } = useAccount()
  const [tab, setTab] = useState<Tab>('lending')

  // Phase 1 — position(marketId, user) on every known market, batched by
  // wagmi/viem into multicalls per chain. Works even when the Morpho API lags.
  const positionContracts = useMemo(
    () =>
      address
        ? markets.map((m) => ({
            address: MORPHO_BLUE_ADDRESS,
            abi: MORPHO_BLUE_ABI,
            functionName: 'position' as const,
            args: [m.marketId as `0x${string}`, address] as const,
            chainId: m.chain.id as 1 | 8453,
          }))
        : [],
    [markets, address]
  )

  const { data: positionResults, isLoading } = useReadContracts({
    contracts: positionContracts,
    query: { enabled: positionContracts.length > 0 },
  })

  const active = useMemo<RawPosition[]>(() => {
    if (!positionResults) return []
    const out: RawPosition[] = []
    positionResults.forEach((res, i) => {
      if (res.status !== 'success') return
      const [supplyShares, borrowShares, collateral] = res.result as readonly [bigint, bigint, bigint]
      if (supplyShares > 0n || borrowShares > 0n || collateral > 0n) {
        out.push({ market: markets[i], supplyShares, borrowShares, collateral })
      }
    })
    return out
  }, [positionResults, markets])

  // Phase 2 — market state (share→asset conversion) for active positions only,
  // plus oracle price for borrow positions (LTV/health).
  const stateContracts = useMemo(
    () =>
      active.flatMap((p) => [
        {
          address: MORPHO_BLUE_ADDRESS,
          abi: MORPHO_BLUE_ABI,
          functionName: 'market' as const,
          args: [p.market.marketId as `0x${string}`] as const,
          chainId: p.market.chain.id as 1 | 8453,
        },
        {
          address: (p.market.oracle?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
          abi: ORACLE_ABI,
          functionName: 'price' as const,
          chainId: p.market.chain.id as 1 | 8453,
        },
      ]),
    [active]
  )

  const { data: stateResults } = useReadContracts({
    contracts: stateContracts,
    query: { enabled: stateContracts.length > 0 },
  })

  const rows = useMemo(() => {
    return active.map((p, i) => {
      const marketRes = stateResults?.[i * 2]
      const priceRes = stateResults?.[i * 2 + 1]
      const marketState =
        marketRes?.status === 'success'
          ? (marketRes.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint])
          : null
      const oraclePrice = priceRes?.status === 'success' ? (priceRes.result as bigint) : null

      const suppliedAssets = marketState
        ? sharesToAssets(p.supplyShares, marketState[0], marketState[1])
        : null
      // borrowShares → assets uses the borrow side of the market accounting
      const borrowedAssets =
        marketState && marketState[3] > 0n
          ? (p.borrowShares * (marketState[2] + 1n)) / (marketState[3] + 10n ** 6n)
          : marketState
          ? 0n
          : null

      // Collateral valued in loan-token terms via the market's oracle
      const collateralInLoan =
        oraclePrice !== null ? (p.collateral * oraclePrice) / ORACLE_PRICE_SCALE : null

      const lltv = Number(p.market.lltv) / 1e18
      const ltv =
        borrowedAssets !== null && collateralInLoan !== null && collateralInLoan > 0n
          ? Number(borrowedAssets) / Number(collateralInLoan)
          : null

      return { ...p, suppliedAssets, borrowedAssets, collateralInLoan, ltv, lltv }
    })
  }, [active, stateResults])

  const lendingRows = rows.filter((r) => r.supplyShares > 0n)
  const borrowRows = rows.filter((r) => r.borrowShares > 0n || r.collateral > 0n)

  if (!address) return null
  if (!isLoading && active.length === 0) return null

  const currentRows = tab === 'lending' ? lendingRows : borrowRows

  return (
    <div
      className="mb-8 rounded-xl p-5"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
          Your positions
        </h2>
        <div className="flex rounded-lg p-1" style={{ background: 'var(--background)' }}>
          {(['lending', 'borrowing'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-4 py-1.5 rounded-md text-sm font-medium cursor-pointer transition-all"
              style={
                tab === t
                  ? { background: 'var(--accent)', color: 'white' }
                  : { color: 'var(--muted)' }
              }
            >
              {t === 'lending' ? `Lending (${lendingRows.length})` : `Borrowing (${borrowRows.length})`}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <p className="text-sm py-2" style={{ color: 'var(--muted)' }}>
          Scanning your positions on-chain…
        </p>
      )}

      {!isLoading && currentRows.length === 0 && (
        <p className="text-sm py-2" style={{ color: 'var(--muted)' }}>
          No {tab} position found.
        </p>
      )}

      {currentRows.map((row) => {
        const m = row.market
        const price = loanPriceUsd(m)
        const risk = m.collateralAsset ? getRiskAnalysis(m.chain.id, m.collateralAsset.address) : null
        const marketRisk = risk ? getMarketRisk(m, risk) : null
        const supplyApy = m.state ? (m.state.supplyApy * 100).toFixed(2) : '—'
        const borrowApy = m.state ? (m.state.borrowApy * 100).toFixed(2) : '—'

        return (
          <div
            key={`${m.chain.id}-${m.marketId}`}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <div className="min-w-[160px]">
              <div className="flex items-center gap-2">
                <span className="font-medium" style={{ color: 'var(--foreground)' }}>
                  {m.loanAsset.symbol}
                  {m.collateralAsset && (
                    <span style={{ color: 'var(--muted)' }}> / {m.collateralAsset.symbol}</span>
                  )}
                </span>
                {marketRisk && (
                  <span
                    className="text-[10px] font-bold px-1 py-0.5 rounded"
                    style={{ background: GRADE_COLORS[marketRisk.grade].bg, color: GRADE_COLORS[marketRisk.grade].text }}
                  >
                    {marketRisk.grade}
                  </span>
                )}
              </div>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{m.chain.network}</span>
            </div>

            {tab === 'lending' ? (
              <>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>Supplied</div>
                  <div className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {row.suppliedAssets !== null
                      ? `${formatAmount(row.suppliedAssets, m.loanAsset.decimals)} ${m.loanAsset.symbol}`
                      : '…'}
                    {row.suppliedAssets !== null && price !== null && (
                      <span className="text-xs ml-1.5" style={{ color: 'var(--muted)' }}>
                        ≈ {usd((Number(row.suppliedAssets) / 10 ** m.loanAsset.decimals) * price)}
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>APY</div>
                  <div className="text-sm font-medium" style={{ color: '#4ade80' }}>{supplyApy}%</div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>Collateral</div>
                  <div className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {m.collateralAsset
                      ? `${formatAmount(row.collateral, m.collateralAsset.decimals)} ${m.collateralAsset.symbol}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>Borrowed</div>
                  <div className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {row.borrowedAssets !== null
                      ? `${formatAmount(row.borrowedAssets, m.loanAsset.decimals)} ${m.loanAsset.symbol}`
                      : '…'}
                    <span className="text-xs ml-1.5" style={{ color: 'var(--muted)' }}>@ {borrowApy}%</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>LTV / LLTV</div>
                  <div
                    className="text-sm font-medium"
                    style={{
                      color:
                        row.ltv === null
                          ? 'var(--muted)'
                          : row.ltv > row.lltv * 0.95
                          ? '#fca5a5'
                          : row.ltv > row.lltv * 0.8
                          ? '#fcd34d'
                          : '#4ade80',
                    }}
                  >
                    {row.ltv !== null ? `${(row.ltv * 100).toFixed(1)}%` : '—'}
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {' '}/ {(row.lltv * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </>
            )}

            <button
              onClick={() => onManage(m)}
              className="ml-auto text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Manage
            </button>
          </div>
        )
      })}
    </div>
  )
}
