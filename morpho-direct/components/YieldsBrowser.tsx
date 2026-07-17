'use client'

import { useEffect, useMemo, useState } from 'react'
import { fetchYields, YIELD_PROJECTS, type YieldPool, type YieldProject } from '@/lib/yields'
import { getRiskAnalysis, isStale, GRADE_COLORS } from '@/lib/risk'
import { FilterGroup } from './MarketBrowser'
import { VaultModal } from './VaultModal'

const CHAIN_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'Ethereum', label: 'Ethereum' },
  { value: 'Base', label: 'Base' },
]

const PROJECT_OPTIONS = [
  { value: 'all', label: 'All' },
  ...Object.entries(YIELD_PROJECTS).map(([value, label]) => ({ value, label })),
]

const MIN_TVL_OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 100_000, label: '≥ $100K' },
  { value: 1_000_000, label: '≥ $1M' },
  { value: 10_000_000, label: '≥ $10M' },
]

const MIN_APY_OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 0.05, label: '≥ 5%' },
  { value: 0.075, label: '≥ 7.5%' },
  { value: 0.1, label: '≥ 10%' },
]

function formatUsd(num: number): string {
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(1)}B`
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`
  return `$${num.toFixed(0)}`
}

const PROJECT_COLORS: Record<YieldProject, string> = {
  'morpho-vault': '#6366f1',
  'aave-v3': '#8b5cf6',
  'aave-v4': '#a855f7',
  'euler-v2': '#10b981',
}

export function YieldsBrowser() {
  const [pools, setPools] = useState<YieldPool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState('all')
  const [chain, setChain] = useState('all')
  const [minTvl, setMinTvl] = useState(100_000)
  const [minApy, setMinApy] = useState(0)
  const [search, setSearch] = useState('')
  const [selectedVault, setSelectedVault] = useState<YieldPool | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchYields()
      .then((p) => { if (!cancelled) setPools(p) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return pools
      .filter((p) => {
        if (project !== 'all' && p.project !== project) return false
        if (chain !== 'all' && p.chain !== chain) return false
        if (p.tvlUsd < minTvl) return false
        if (p.apy / 100 < minApy) return false
        if (q && !p.symbol.toLowerCase().includes(q) && !(p.poolMeta ?? '').toLowerCase().includes(q)) return false
        return true
      })
      .sort((a, b) => b.apy - a.apy)
  }, [pools, project, chain, minTvl, minApy, search])

  return (
    <div className="flex-1 px-6 py-8 max-w-[1800px] mx-auto w-full">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--foreground)' }}>
          Yields — Morpho · Aave · Euler
        </h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Supply rates across protocols (Ethereum + Base) — Morpho vaults from the Morpho API
          (including non-curated), Aave/Euler from DefiLlama, refreshed hourly
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <FilterGroup label="Protocol" options={PROJECT_OPTIONS} value={project} onChange={setProject} />
        <FilterGroup label="Chain" options={CHAIN_OPTIONS} value={chain} onChange={setChain} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <FilterGroup label="Min TVL" options={MIN_TVL_OPTIONS} value={minTvl} onChange={setMinTvl} />
        <FilterGroup label="Min APY" options={MIN_APY_OPTIONS} value={minApy} onChange={setMinApy} />
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by asset (USDC, WETH, …)"
        className="w-full rounded-lg px-4 py-2.5 text-sm outline-none mb-6"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
      />

      {loading && (
        <div className="text-center py-20" style={{ color: 'var(--muted)' }}>Loading yields…</div>
      )}

      {error && (
        <div className="p-4 rounded-xl text-sm" style={{ background: '#7f1d1d', color: '#fca5a5' }}>
          Failed to load yields: {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
            {filtered.length} pool{filtered.length !== 1 ? 's' : ''} — sorted by APY
          </div>

          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <div
              className="grid grid-cols-[110px_1fr_90px_110px_110px_100px_150px] gap-2 px-4 py-2.5 text-xs font-medium"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}
            >
              <span>Protocol</span>
              <span>Asset</span>
              <span>Chain</span>
              <span className="text-right">APY</span>
              <span className="text-right">Base / Reward</span>
              <span className="text-right">TVL</span>
              <span></span>
            </div>

            {filtered.slice(0, 150).map((pool) => {
              const risk = pool.underlyingToken ? getRiskAnalysis(pool.chainId, pool.underlyingToken) : null
              return (
                <div
                  key={pool.pool}
                  className="grid grid-cols-[110px_1fr_90px_110px_110px_100px_150px] gap-2 px-4 py-3 text-sm items-center"
                  style={{ borderTop: '1px solid var(--border)', color: 'var(--foreground)' }}
                >
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full w-fit"
                    style={{ background: `${PROJECT_COLORS[pool.project]}22`, color: PROJECT_COLORS[pool.project] }}
                  >
                    {YIELD_PROJECTS[pool.project]}
                  </span>
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{pool.symbol}</span>
                    {risk && (
                      <span
                        className="text-[10px] font-bold px-1 py-0.5 rounded shrink-0"
                        style={{
                          background: GRADE_COLORS[risk.grade].bg,
                          color: GRADE_COLORS[risk.grade].text,
                          opacity: isStale(risk) ? 0.45 : 1,
                        }}
                        title={`Risque de l'actif prêté : ${risk.grade} — ${risk.summary}`}
                      >
                        {risk.grade}
                      </span>
                    )}
                    {pool.poolMeta && (
                      <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>{pool.poolMeta}</span>
                    )}
                    {pool.listed === false && (
                      <span
                        className="text-[10px] px-1 py-0.5 rounded shrink-0"
                        style={{ background: '#78350f', color: '#fcd34d' }}
                        title="Vault non curaté par Morpho — vérifier le curateur et les allocations avant dépôt"
                      >
                        non curaté
                      </span>
                    )}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{pool.chain}</span>
                  <span className="text-right font-semibold" style={{ color: '#4ade80' }}>
                    {pool.apy.toFixed(2)}%
                  </span>
                  <span className="text-right text-xs" style={{ color: 'var(--muted)' }}>
                    {(pool.apyBase ?? 0).toFixed(1)}% / {(pool.apyReward ?? 0).toFixed(1)}%
                  </span>
                  <span className="text-right text-xs">{formatUsd(pool.tvlUsd)}</span>
                  <span className="flex items-center justify-end gap-2">
                    {pool.project === 'morpho-vault' && (
                      <button
                        onClick={() => setSelectedVault(pool)}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer"
                        style={{ background: 'var(--accent)', color: 'white' }}
                      >
                        Deposit
                      </button>
                    )}
                    <a
                      href={pool.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs cursor-pointer transition-opacity hover:opacity-80"
                      style={{ color: 'var(--muted)' }}
                    >
                      {pool.project === 'morpho-vault' ? 'Morpho ↗' : 'Llama ↗'}
                    </a>
                  </span>
                </div>
              )
            })}
          </div>

          {filtered.length > 150 && (
            <p className="text-xs mt-3" style={{ color: 'var(--muted)' }}>
              150 premiers affichés — affine les filtres pour voir le reste.
            </p>
          )}
        </>
      )}

      {selectedVault && <VaultModal pool={selectedVault} onClose={() => setSelectedVault(null)} />}
    </div>
  )
}
