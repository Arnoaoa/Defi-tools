'use client'

import { useState, useEffect, useMemo } from 'react'
import { MarketCard } from './MarketCard'
import { Positions } from './Positions'
import { SupplyModal } from './SupplyModal'
import { fetchMarkets, type ApiMarket } from '@/lib/api'

const CHAINS = [
  { id: 1, name: 'Ethereum' },
  { id: 8453, name: 'Base' },
]

export type SortBy = 'liquidity' | 'apy' | 'apy7d' | 'apy30d'

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'liquidity', label: 'Liquidity' },
  { value: 'apy', label: 'APY' },
  { value: 'apy7d', label: 'APY 7d' },
  { value: 'apy30d', label: 'APY 30d' },
]

const MIN_TVL_OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 3_000, label: '≥ $3K' },
  { value: 10_000, label: '≥ $10K' },
  { value: 100_000, label: '≥ $100K' },
  { value: 1_000_000, label: '≥ $1M' },
  { value: 10_000_000, label: '≥ $10M' },
]

const UTIL_OPTIONS = [
  { value: 'all', label: 'Any' },
  { value: 'lte95', label: '≤ 95%' },
  { value: 'lte90', label: '≤ 90%' },
  { value: 'gte90', label: '≥ 90%' },
  { value: 'gte95', label: '≥ 95%' },
]

function matchesUtil(utilization: number, filter: string): boolean {
  switch (filter) {
    case 'lte95': return utilization <= 0.95
    case 'lte90': return utilization <= 0.9
    case 'gte90': return utilization >= 0.9
    case 'gte95': return utilization >= 0.95
    default: return true
  }
}

const LOAN_ASSETS = ['USDC', 'USDT', 'WETH', 'EURC', 'cbBTC', 'WBTC', 'EURCV']

const MIN_APY_OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 0.05, label: '≥ 5%' },
  { value: 0.075, label: '≥ 7.5%' },
  { value: 0.1, label: '≥ 10%' },
]

function sortApy(market: ApiMarket, sortBy: SortBy): number {
  if (!market.state) return 0
  if (sortBy === 'apy7d') return market.state.weeklySupplyApy ?? 0
  if (sortBy === 'apy30d') return market.state.monthlySupplyApy ?? 0
  return market.state.supplyApy
}

export function FilterGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className="px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all"
          style={
            value === option.value
              ? { background: 'var(--accent)', color: 'white' }
              : {
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--muted)',
                }
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function MarketBrowser() {
  const [selectedChains, setSelectedChains] = useState<number[]>([1, 8453])
  const [markets, setMarkets] = useState<ApiMarket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('liquidity')
  const [minTvl, setMinTvl] = useState(0)
  const [utilFilter, setUtilFilter] = useState('all')
  const [minApy, setMinApy] = useState(0)
  const [loanAsset, setLoanAsset] = useState('all')
  const [selectedMarket, setSelectedMarket] = useState<ApiMarket | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchMarkets()
      .then((m) => { if (!cancelled) setMarkets(m) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const result = markets.filter((m) => {
      if (!selectedChains.includes(m.chain.id)) return false
      if (loanAsset !== 'all' && m.loanAsset.symbol !== loanAsset) return false
      if (q) {
        const matches =
          m.loanAsset.symbol.toLowerCase().includes(q) ||
          m.loanAsset.name.toLowerCase().includes(q) ||
          m.collateralAsset?.symbol.toLowerCase().includes(q) ||
          m.marketId.toLowerCase().includes(q)
        if (!matches) return false
      }
      if (minTvl > 0 && (m.state?.supplyAssetsUsd ?? 0) < minTvl) return false
      if (!matchesUtil(m.state?.utilization ?? 0, utilFilter)) return false
      if (minApy > 0 && sortApy(m, sortBy === 'liquidity' ? 'apy' : sortBy) < minApy) return false
      return true
    })
    if (sortBy === 'liquidity') return result // API order (TotalLiquidityUsd desc)
    return [...result].sort((a, b) => sortApy(b, sortBy) - sortApy(a, sortBy))
  }, [markets, search, sortBy, minTvl, utilFilter, minApy, loanAsset, selectedChains])

  function toggleChain(id: number) {
    setSelectedChains((prev) =>
      prev.includes(id)
        ? prev.length > 1 ? prev.filter((c) => c !== id) : prev
        : [...prev, id]
    )
  }

  return (
    <div className="flex-1 px-6 py-8 max-w-[1800px] mx-auto w-full">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--foreground)' }}>
          Morpho Markets
        </h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Supply directly to Morpho Blue markets — no vault intermediaries
        </p>
      </div>

      <Positions markets={markets} onManage={setSelectedMarket} />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {CHAINS.map((chain) => (
          <button
            key={chain.id}
            onClick={() => toggleChain(chain.id)}
            className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all"
            style={
              selectedChains.includes(chain.id)
                ? { background: 'var(--accent)', color: 'white' }
                : {
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--muted)',
                  }
            }
          >
            {chain.name}
          </button>
        ))}

        <div className="w-px h-6 mx-1" style={{ background: 'var(--border)' }} />

        <FilterGroup
          label="Sort by"
          options={SORT_OPTIONS}
          value={sortBy}
          onChange={setSortBy}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <FilterGroup label="Min TVL" options={MIN_TVL_OPTIONS} value={minTvl} onChange={setMinTvl} />
        <FilterGroup label="Utilization" options={UTIL_OPTIONS} value={utilFilter} onChange={setUtilFilter} />
        <FilterGroup label="Min APY" options={MIN_APY_OPTIONS} value={minApy} onChange={setMinApy} />

        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Loan asset</span>
          <select
            value={loanAsset}
            onChange={(e) => setLoanAsset(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm font-medium cursor-pointer outline-none"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: loanAsset === 'all' ? 'var(--muted)' : 'var(--foreground)',
            }}
          >
            <option value="all">All</option>
            {LOAN_ASSETS.map((symbol) => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by token (USDC, WETH, …) or market ID"
        className="w-full rounded-lg px-4 py-2.5 text-sm outline-none mb-6"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          color: 'var(--foreground)',
        }}
      />

      {loading && (
        <div className="text-center py-20" style={{ color: 'var(--muted)' }}>
          Loading markets…
        </div>
      )}

      {error && (
        <div
          className="p-4 rounded-xl text-sm"
          style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef4444' }}
        >
          Failed to load markets: {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
            {filtered.length} market{filtered.length !== 1 ? 's' : ''}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {filtered.map((market) => (
              <MarketCard
                key={`${market.chain.id}-${market.marketId}`}
                market={market}
                sortBy={sortBy}
                onClick={() => setSelectedMarket(market)}
              />
            ))}
          </div>
        </>
      )}

      {selectedMarket && (
        <SupplyModal market={selectedMarket} onClose={() => setSelectedMarket(null)} />
      )}
    </div>
  )
}
