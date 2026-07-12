"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronDown, ChevronUp } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

import { usePosition, useFundingHistory } from "@/lib/api";
import { StatBox } from "@/components/StatBox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import {
  fmtUsd,
  fmtNumber,
  fmtPct,
  fmtHf,
  asNumber,
  signColor,
  relativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Liquidation distance tiers
// ---------------------------------------------------------------------------
function liqTier(pct: string | null): "critical" | "urgent" | "watch" | "healthy" {
  const n = asNumber(pct);
  if (n === null) return "healthy";
  if (n < 5) return "critical";
  if (n < 15) return "urgent";
  if (n < 30) return "watch";
  return "healthy";
}

const TIER_COLORS: Record<string, string> = {
  critical: "text-[var(--st-critical)]",
  urgent: "text-[var(--st-urgent)]",
  watch: "text-[var(--st-watch)]",
  healthy: "text-[var(--st-healthy)]",
};

// ---------------------------------------------------------------------------
// Funding chart
// ---------------------------------------------------------------------------
function FundingChart({ positionId }: { positionId: string }) {
  const { data, isLoading } = useFundingHistory(positionId, 168);

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data || data.length === 0) {
    return (
      <EmptyState title="No funding history" hint="No data returned for this market." />
    );
  }

  const chartData = data.map((p) => ({
    ts: p.ts,
    rate: parseFloat(p.rate) * 100,
  }));

  return (
    <ResponsiveContainer width="100%" height={192}>
      <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="ts"
          tickFormatter={(v) =>
            new Date(v * 1000).toLocaleDateString("en-GB", { month: "short", day: "numeric" })
          }
          tick={{ fontSize: 10, fill: "var(--ink-dim)", fontFamily: "var(--font-mono)" }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v) => `${v.toFixed(4)}%`}
          tick={{ fontSize: 10, fill: "var(--ink-dim)", fontFamily: "var(--font-mono)" }}
          axisLine={false}
          tickLine={false}
          width={68}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "4px",
            fontSize: "11px",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
          }}
          formatter={(v: number) => [`${v.toFixed(5)}%`, "Funding rate"]}
          labelFormatter={(v) =>
            new Date((v as number) * 1000).toLocaleString("en-GB", {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          }
        />
        <ReferenceLine y={0} stroke="var(--border-strong)" strokeDasharray="3 3" />
        <Line
          type="monotone"
          dataKey="rate"
          stroke="var(--accent)"
          dot={false}
          strokeWidth={1.5}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Raw payload collapsible
// ---------------------------------------------------------------------------
function RawPayload({ json }: { json: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (!json) return null;
  return (
    <div className="border border-[var(--border)] rounded-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-xs text-[var(--ink-dim)] hover:text-[var(--ink-mute)] cursor-pointer transition-colors"
      >
        <span className="eyebrow">Raw payload</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <pre className="px-4 pb-4 text-[10px] text-[var(--ink-dim)] font-mono overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(JSON.parse(json), null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side badge tone map
// ---------------------------------------------------------------------------
const SIDE_TONE: Record<string, "healthy" | "critical" | "outline" | "neutral"> = {
  long: "healthy",
  short: "critical",
  collateral: "outline",
  debt: "critical",
  spot: "neutral",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function PositionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: position, isLoading } = usePosition(id);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 lg:px-8 py-12">
        <Skeleton className="h-8 w-48 mb-8" />
        <Skeleton className="h-28 w-full mb-6" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!position) {
    return (
      <div className="max-w-4xl mx-auto px-6 lg:px-8 py-12">
        <EmptyState title="Position not found" hint="Check the position ID." />
      </div>
    );
  }

  const isPerp = position.protocol === "hyperliquid";
  const isLending =
    position.protocol === "morpho" ||
    position.protocol === "aave" ||
    position.protocol === "euler";

  const pnlColor = signColor(position.unrealized_pnl_usd);
  const tier = liqTier(position.distance_to_liq_pct);

  return (
    <div className="max-w-4xl mx-auto px-6 lg:px-8 py-12 animate-in">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink-mute)] transition-colors mb-8"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Overview
      </Link>

      {/* Header */}
      <div className="mb-10">
        <span className="eyebrow">{position.protocol} · {position.chain}</span>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="display text-4xl leading-tight text-[var(--ink)]">
            {position.asset}
          </h1>
          <Badge tone={SIDE_TONE[position.side] ?? "outline"}>{position.side}</Badge>
        </div>
        <p className="mt-2 text-xs text-[var(--ink-dim)] tabular-nums">
          updated {relativeTime(position.snapshot_ts)}
          {position.wallet && (
            <span className="ml-2 font-mono">
              · {position.wallet.slice(0, 6)}…{position.wallet.slice(-4)}
            </span>
          )}
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-8 pb-10 mb-10 border-b border-[var(--border)]">
        <StatBox
          label="Size"
          value={
            <span className="tabular-nums">
              {fmtNumber(position.size_native, 6)}
            </span>
          }
          hint={position.size_usd ? fmtUsd(position.size_usd) : undefined}
        />

        <StatBox
          label="PnL"
          value={
            <span
              className={cn(
                "tabular-nums",
                pnlColor === "pos" && "text-[var(--pos)]",
                pnlColor === "neg" && "text-[var(--neg)]",
              )}
            >
              {fmtUsd(position.unrealized_pnl_usd, { signed: true })}
            </span>
          }
        />

        {isPerp && (
          <StatBox
            label="Funding rate"
            value={
              <span className="tabular-nums">
                {position.funding_rate
                  ? fmtPct(String(parseFloat(position.funding_rate) * 100), 4)
                  : "—"}
              </span>
            }
            hint={
              position.funding_period_hours
                ? `${position.funding_period_hours}h period`
                : undefined
            }
          />
        )}

        {isLending && (
          <StatBox
            label="Health factor"
            value={
              <span className="tabular-nums">{fmtHf(position.health_factor)}</span>
            }
          />
        )}

        <StatBox
          label="Liq. distance"
          value={
            <span className={cn("tabular-nums", TIER_COLORS[tier])}>
              {position.distance_to_liq_pct
                ? fmtPct(position.distance_to_liq_pct, 1)
                : "—"}
            </span>
          }
          hint={
            position.liquidation_price
              ? `liq. @ ${fmtUsd(position.liquidation_price)}`
              : undefined
          }
        />

        <StatBox
          label="Entry price"
          value={
            <span className="tabular-nums">{fmtUsd(position.entry_price)}</span>
          }
          hint={
            position.mark_price
              ? `mark ${fmtUsd(position.mark_price)}`
              : undefined
          }
        />

        {(position.health_factor || position.liquidation_threshold) && (
          <StatBox
            label="Liq. threshold"
            value={
              <span className="tabular-nums">
                {position.liquidation_threshold
                  ? fmtPct(String(parseFloat(position.liquidation_threshold) * 100), 1)
                  : "—"}
              </span>
            }
          />
        )}
      </div>

      {/* Funding chart — Hyperliquid only */}
      {isPerp && (
        <div className="mb-10">
          <span className="eyebrow mb-4 block">Funding rate — 7 days</span>
          <FundingChart positionId={id} />
        </div>
      )}

      {/* Raw payload */}
      <RawPayload json={position.raw_json} />
    </div>
  );
}
