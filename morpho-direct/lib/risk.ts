import riskIndex from '@/data/risk-index.json'
import type { ApiMarket } from '@/lib/api'

export type RiskGrade = 'A' | 'B' | 'C' | 'D'

export interface RiskAnalysis {
  symbol: string
  grade: RiskGrade
  gradeModifier: '+' | '-' | null
  components: Record<string, string>
  redFlags: string[]
  maxAllocation: string
  summary: string
  incidents: string[]
  controversies: string[]
  dependencies: {
    issuer: string
    custodians: string[]
    underlyings: string[]
    keyCounterparties: string[]
  } | null
  exitLiquidity: {
    morphoTvlUsd: number
    dailyLiquidityUsd: number
    ratioPct: number
    note: string
  } | null
  analyzedAt: string
  vaultNote: string
}

const index = riskIndex as unknown as Record<string, RiskAnalysis>

const STALE_AFTER_DAYS = 30

export function getRiskAnalysis(chainId: number, collateralAddress: string): RiskAnalysis | null {
  return index[`${chainId}-${collateralAddress.toLowerCase()}`] ?? null
}

export function isStale(analysis: RiskAnalysis): boolean {
  const ageMs = Date.now() - new Date(analysis.analyzedAt).getTime()
  return ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
}

export function formatGrade(analysis: RiskAnalysis): string {
  return `${analysis.grade}${analysis.gradeModifier ?? ''}`
}

const GRADES: RiskGrade[] = ['A', 'B', 'C', 'D']

function downgrade(grade: RiskGrade, steps: number): RiskGrade {
  return GRADES[Math.min(GRADES.indexOf(grade) + steps, GRADES.length - 1)]
}

export interface MarketRisk {
  grade: RiskGrade
  reasons: string[]
}

// Market grade = collateral grade degraded by live market signals (weakest-link spirit):
// non-Chainlink oracle, near-full utilization, aggressive LLTV, thin market.
export function getMarketRisk(market: ApiMarket, collateral: RiskAnalysis): MarketRisk {
  let grade = collateral.grade
  const reasons: string[] = []

  const oracleType = market.oracle?.type
  if (oracleType === 'CustomOracle' || oracleType === 'Unknown') {
    grade = downgrade(grade, 1)
    reasons.push(`oracle ${oracleType === 'Unknown' ? 'non identifié' : 'custom'} (non-Chainlink)`)
  }

  const utilization = market.state?.utilization ?? 0
  if (utilization >= 0.999) {
    grade = 'D'
    reasons.push('utilisation 100 % — retraits bloqués, taux affiché fictif')
  } else if (utilization > 0.95) {
    grade = downgrade(grade, 1)
    reasons.push(`utilisation ${(utilization * 100).toFixed(1)} % — capacité de retrait limitée`)
  }

  const lltv = Number(market.lltv) / 1e18
  if (lltv >= 0.945) {
    grade = downgrade(grade, 1)
    reasons.push(`LLTV ${(lltv * 100).toFixed(1)} % — marge de liquidation très faible`)
  }

  const marketTvl = market.state?.supplyAssetsUsd ?? 0
  if (marketTvl > 0 && marketTvl < 100_000) {
    grade = downgrade(grade, 1)
    reasons.push('TVL du marché < 100 K$ — liquidateurs potentiellement absents')
  }

  return { grade, reasons }
}

export const GRADE_COLORS: Record<RiskGrade, { bg: string; text: string }> = {
  A: { bg: '#14532d', text: '#4ade80' },
  B: { bg: '#1e3a5f', text: '#60a5fa' },
  C: { bg: '#78350f', text: '#fcd34d' },
  D: { bg: '#7f1d1d', text: '#fca5a5' },
}

export const COMPONENT_LABELS: Record<string, string> = {
  assetDesign: 'Asset design',
  issuer: 'Émetteur / protocole',
  depegBacking: 'Dépeg / backing',
  counterparty: 'Counterparty',
  recentSecurity: 'Sécurité',
}
