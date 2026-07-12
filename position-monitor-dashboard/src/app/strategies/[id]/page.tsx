"use client";
import { use } from "react";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useAlerts, useStrategy, useStrategyHistory } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { PositionsTable } from "@/components/PositionsTable";
import { HistoryCharts } from "@/components/HistoryCharts";
import { AlertRow } from "@/components/AlertRow";
import { HFGauge } from "@/components/HFGauge";
import { StatBox } from "@/components/StatBox";
import { fmtPct, fmtUsd, relativeTime, signColor, asNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function StrategyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: strategy, isLoading } = useStrategy(id);
  const { data: history } = useStrategyHistory(id, 7);
  const { data: alerts } = useAlerts({ strategy_id: id, limit: 200 });

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <Skeleton className="h-12 w-1/2 mb-8" />
        <Skeleton className="h-40 w-full mb-8" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
        <EmptyState
          title="Strategy not found"
          hint="It may have been removed from strategies.yaml."
        />
      </div>
    );
  }

  const snap = strategy.latest_snapshot;
  const capital = strategy.positions.reduce((acc, p) => {
    const v = asNumber(p.size_usd);
    return acc + (v !== null ? Math.abs(v) : 0);
  }, 0);

  const pnlColor = signColor(snap?.pnl_unrealized_usd);
  const fundingColor = signColor(snap?.pnl_funding_24h_usd);
  const deltaColor = signColor(snap?.net_delta_usd);

  return (
    <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12 animate-in">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink-mute)] transition-colors mb-8"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Overview
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-8 mb-10">
        <div className="flex-1 min-w-0">
          <span className="eyebrow">{strategy.id}</span>
          <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
            {strategy.name}
          </h1>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <Badge tone="outline">{strategy.type}</Badge>
            <span className="text-xs text-[var(--ink-dim)] tabular">
              {strategy.legs.length} legs
            </span>
            <span className="text-xs text-[var(--ink-dim)] tabular">
              target Δ {fmtPct(strategy.delta_target_pct, 1, true)}
            </span>
            {snap?.snapshot_ts && (
              <span className="text-xs text-[var(--ink-dim)] tabular">
                · updated {relativeTime(snap.snapshot_ts)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* KPI strip with HF gauge */}
      <div className="grid lg:grid-cols-[2fr_3fr] gap-12 pb-10 mb-10 border-b border-[var(--border)]">
        <div>
          <span className="eyebrow mb-3 block">Composite HF</span>
          <HFGauge value={snap?.composite_hf} size="lg" />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <StatBox
            label="Net Delta"
            value={
              <span
                className={cn(
                  deltaColor === "pos" && "text-[var(--pos)]",
                  deltaColor === "neg" && "text-[var(--neg)]",
                )}
              >
                {fmtUsd(snap?.net_delta_usd, { compact: true, signed: true })}
              </span>
            }
            hint={
              snap?.delta_deviation_pct
                ? `${fmtPct(snap.delta_deviation_pct, 2, true)} dev.`
                : undefined
            }
          />
          <StatBox
            label="PnL Unr."
            value={
              <span
                className={cn(
                  pnlColor === "pos" && "text-[var(--pos)]",
                  pnlColor === "neg" && "text-[var(--neg)]",
                )}
              >
                {fmtUsd(snap?.pnl_unrealized_usd, { compact: true, signed: true })}
              </span>
            }
          />
          <StatBox
            label="Funding 24h"
            value={
              <span
                className={cn(
                  fundingColor === "pos" && "text-[var(--pos)]",
                  fundingColor === "neg" && "text-[var(--neg)]",
                )}
              >
                {fmtUsd(snap?.pnl_funding_24h_usd, { compact: true, signed: true })}
              </span>
            }
          />
          <StatBox
            label="Capital Engaged"
            value={fmtUsd(capital, { compact: true })}
            hint={`${strategy.positions.length} positions`}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="positions">
        <TabsList>
          <TabsTrigger value="positions">Positions</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="alerts">
            Alerts {alerts && alerts.length > 0 && (
              <span className="ml-1.5 text-[10px] text-[var(--ink-dim)] tabular">
                {alerts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          <PositionsTable positions={strategy.positions} />
        </TabsContent>

        <TabsContent value="history">
          <HistoryCharts snapshots={history ?? []} />
        </TabsContent>

        <TabsContent value="alerts">
          {!alerts || alerts.length === 0 ? (
            <EmptyState
              title="No alerts"
              hint="This strategy has no alerts recorded yet."
            />
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--border-strong)]">
                  <th className="pb-2 pl-1 pr-4 eyebrow text-[var(--ink-dim)]">Time</th>
                  <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]">Level</th>
                  <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]">Strategy</th>
                  <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]">Type</th>
                  <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]">Message</th>
                  <th className="pb-2 pr-1 eyebrow text-[var(--ink-dim)] text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <AlertRow key={a.id} alert={a} />
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
