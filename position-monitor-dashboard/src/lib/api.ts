/**
 * Typed client for the Position Monitor FastAPI backend.
 * All numeric fields that are monetary or HF arrive as STRINGS (Decimal precision).
 * Parse only at display time via lib/format.
 */
import useSWR, { type SWRConfiguration } from "swr";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function fetcher<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API ${path} → ${res.status}`);
  }
  return res.json();
}

/** Generic mutation helper for POST/PATCH/DELETE.
 *  Throws an Error with `message` = API's `detail` on 4xx. */
export async function mutateApi<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    body:
      json !== undefined
        ? JSON.stringify(json)
        : (init.body as BodyInit | undefined),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: string })?.detail;
    throw new Error(detail ?? `API ${path} → ${res.status}`);
  }
  return data as T;
}

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export type HealthStatus = "healthy" | "silent" | "no_heartbeat";

export interface Health {
  status: HealthStatus;
  last_cycle_ts: number | null;
  silence_seconds: number | null;
  cycle_duration_ms: number | null;
  cycle_errors: number | null;
  last_cycle_log?: string | null;
}

export type StrategyType = "delta_neutral" | "passive" | "leveraged_yield" | "spot" | "composite";

export interface LegConfig {
  protocol: string;
  role: string;
  asset: string | null;
  chain: string | null;
  symbol: string | null;
}

export interface StrategySnapshot {
  id: number;
  snapshot_ts: number;
  strategy_id: string;
  net_delta_usd: string | null;
  delta_target_pct: string | null;
  delta_deviation_pct: string | null;
  composite_hf: string | null;
  pnl_unrealized_usd: string | null;
  pnl_funding_24h_usd: string | null;
  has_lending_leg: number;
  has_perp_leg: number;
  has_pt_leg: number;
  days_to_pendle_expiry: number | null;
  metrics_json?: string | null;
}

export interface Strategy {
  id: string;
  name: string;
  type: StrategyType;
  delta_target_pct: string;
  legs: LegConfig[];
  latest_snapshot: StrategySnapshot | null;
}

export interface Position {
  id: number;
  snapshot_ts: number;
  strategy_id: string;
  protocol: string;
  chain: string;
  asset: string;
  side: "long" | "short" | "collateral" | "debt" | "spot";
  size_native: string;
  size_usd: string | null;
  entry_price: string | null;
  mark_price: string | null;
  oracle_price: string | null;
  health_factor: string | null;
  liquidation_threshold: string | null;
  market_id: string | null;
  funding_rate: string | null;
  funding_period_hours: number | null;
  unrealized_pnl_usd: string | null;
  liquidation_price: string | null;
  pt_expiry_ts: number | null;
  market_liquidity_usd: string | null;
  implied_apy: string | null;
  wallet: string | null;
  raw_json?: string;
}

export interface StrategyDetail extends Strategy {
  positions: Position[];
}

export type AlertLevel = "info" | "warning" | "urgent" | "critical";

export type AlertType =
  | "hf_warning" | "hf_urgent" | "hf_critical"
  | "funding_flip_soft" | "funding_flip_confirmed" | "funding_flip_material"
  | "depeg_watch" | "depeg_confirmed"
  | "pendle_expiry_t30" | "pendle_expiry_t7" | "pendle_expiry_t1"
  | "drawdown_24h" | "delta_deviation"
  | "fetch_failed" | "degraded_mode" | "monitor_health";

export interface Alert {
  id: number;
  snapshot_ts: number;
  strategy_id: string | null;
  level: AlertLevel;
  type: AlertType;
  asset: string | null;
  message: string;
  payload_json: string | null;
  sent_at: number | null;
  delivery_attempts: number;
  last_error: string | null;
}

export interface Stats {
  strategies: number;
  queued_alerts: number;
  alerts_24h: Partial<Record<AlertLevel, number>>;
}

/* ---------------------------------------------------------------------------
 * Hooks
 * ------------------------------------------------------------------------- */

const DEFAULT_SWR: SWRConfiguration = {
  revalidateOnFocus: true,
  refreshInterval: 30_000,
};

const DETAIL_SWR: SWRConfiguration = {
  revalidateOnFocus: true,
  refreshInterval: 60_000,
};

export function useHealth() {
  return useSWR<Health>("/api/health", fetcher, DEFAULT_SWR);
}

export function useStats() {
  return useSWR<Stats>("/api/stats", fetcher, DEFAULT_SWR);
}

export function useStrategies() {
  return useSWR<Strategy[]>("/api/strategies", fetcher, DEFAULT_SWR);
}

export function useStrategy(id: string | null) {
  return useSWR<StrategyDetail>(
    id ? `/api/strategies/${id}` : null,
    fetcher,
    DETAIL_SWR,
  );
}

export function useStrategyHistory(id: string | null, days = 7) {
  return useSWR<StrategySnapshot[]>(
    id ? `/api/strategies/${id}/history?days=${days}` : null,
    fetcher,
    DETAIL_SWR,
  );
}

export interface AlertFilters {
  limit?: number;
  level?: AlertLevel;
  strategy_id?: string;
  only_unsent?: boolean;
}

/* ---------------------------------------------------------------------------
 * Portfolio + wallets
 * ------------------------------------------------------------------------- */

export type WalletGroup = "self" | "watch";

export interface Wallet {
  id: string;
  label: string;
  address: string;
  chain: string;
  group: WalletGroup;
  notes: string | null;
  auto_discover: boolean;
  created_at?: number;
}

export type PortfolioCategory =
  | "spot_volatile"
  | "spot_stable"
  | "lending_collat"
  | "lending_debt"
  | "perp_long"
  | "perp_short"
  | "pt"
  | "lp"
  | "other";

export interface PortfolioRow {
  id: number;
  snapshot_ts: number;
  grp: WalletGroup;
  chain: string;
  category: PortfolioCategory;
  value_usd: string;
  position_count: number;
  metrics_json: string | null;
}

export interface PortfolioSummary {
  group: WalletGroup;
  snapshot_ts: number | null;
  totals: {
    assets_usd: string;
    debt_usd: string;
    net_usd: string;
  };
  per_chain: Record<string, string>;
  per_category: Record<PortfolioCategory, string>;
  rows: PortfolioRow[];
}

export interface PortfolioHistoryPoint {
  snapshot_ts: number;
  total_usd: string;
}

export function useWallets(group?: WalletGroup) {
  const qs = group ? `?group=${group}` : "";
  return useSWR<Wallet[]>(`/api/wallets${qs}`, fetcher, DEFAULT_SWR);
}

export function usePortfolio(group: WalletGroup = "self") {
  return useSWR<PortfolioSummary>(
    `/api/portfolio?group=${group}`,
    fetcher,
    DEFAULT_SWR,
  );
}

export function usePortfolioHistory(group: WalletGroup = "self", days = 30) {
  return useSWR<PortfolioHistoryPoint[]>(
    `/api/portfolio/history?group=${group}&days=${days}`,
    fetcher,
    DETAIL_SWR,
  );
}

/* ---------------------------------------------------------------------------
 * Position detail
 * ------------------------------------------------------------------------- */

export interface EnrichedPosition extends Position {
  distance_to_liq_pct: string | null;
}

export interface FundingPoint {
  ts: number;
  rate: string;
}

export function usePosition(id: number | string | null) {
  return useSWR<EnrichedPosition>(
    id !== null && id !== undefined ? `/positions/${id}` : null,
    fetcher,
    DETAIL_SWR,
  );
}

export function useFundingHistory(id: number | string | null, hours = 168) {
  return useSWR<FundingPoint[]>(
    id !== null && id !== undefined ? `/positions/${id}/funding_history?hours=${hours}` : null,
    fetcher,
    DETAIL_SWR,
  );
}

export function useAlerts(filters: AlertFilters = {}) {
  const qs = new URLSearchParams();
  qs.set("limit", String(filters.limit ?? 100));
  if (filters.level) qs.set("level", filters.level);
  if (filters.strategy_id) qs.set("strategy_id", filters.strategy_id);
  if (filters.only_unsent) qs.set("only_unsent", "true");
  return useSWR<Alert[]>(`/api/alerts?${qs.toString()}`, fetcher, DEFAULT_SWR);
}

/* Manual positions */

export interface ManualPosition {
  id: string;
  wallet_id: string | null;
  chain: string;
  protocol: string;
  asset: string;
  side: "long" | "short" | "collateral" | "debt" | "spot";
  size_native: string;
  entry_price: string | null;
  entry_ts: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export function useManualPositions(walletId?: string) {
  const qs = walletId ? `?wallet_id=${walletId}` : "";
  return useSWR<ManualPosition[]>(`/api/manual_positions${qs}`, fetcher, DEFAULT_SWR);
}

/* Strategy CRUD */

export interface StrategyCrudLeg {
  protocol: string;
  role: string;
  asset: string | null;
  chain: string | null;
  symbol: string | null;
  wallet_id: string | null;
}

export interface StrategyCrud {
  id: string;
  name: string;
  type: string;
  delta_target_pct: string;
  notes: string | null;
  legs: StrategyCrudLeg[];
  created_at: number;
  updated_at: number;
}

export function useStrategiesCrud() {
  return useSWR<StrategyCrud[]>("/api/strategies_crud", fetcher, DEFAULT_SWR);
}
