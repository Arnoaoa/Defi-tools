"use client";
import { useAlerts, useStats, useStrategies, useHealth } from "@/lib/api";
import { StrategyCard } from "@/components/StrategyCard";
import { StatBox } from "@/components/StatBox";
import { AlertRow } from "@/components/AlertRow";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardBody } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";

export default function OverviewPage() {
  const { data: strategies, isLoading: stratsLoading } = useStrategies();
  const { data: stats } = useStats();
  const { data: alerts } = useAlerts({ limit: 12 });
  const { data: health } = useHealth();

  const nonInfoAlerts = (alerts ?? []).filter((a) => a.level !== "info").slice(0, 10);

  const total24h =
    (stats?.alerts_24h.info ?? 0) +
    (stats?.alerts_24h.warning ?? 0) +
    (stats?.alerts_24h.urgent ?? 0) +
    (stats?.alerts_24h.critical ?? 0);

  const uptimeStr = health?.last_cycle_ts
    ? relativeTime(health.last_cycle_ts)
    : "—";

  return (
    <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12 animate-in">
      {/* Editorial title */}
      <div className="mb-12">
        <span className="eyebrow">Overview</span>
        <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
          Composite <em className="text-[var(--accent)]">strategies</em>
          <br />
          at a glance.
        </h1>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-10 pb-12 border-b border-[var(--border)]">
        <StatBox
          label="Strategies"
          value={stats?.strategies ?? "—"}
          hint="active in config"
        />
        <StatBox
          label="Alerts · 24h"
          value={total24h.toLocaleString()}
          hint={
            stats?.alerts_24h.critical
              ? `${stats.alerts_24h.critical} critical`
              : stats?.alerts_24h.urgent
                ? `${stats.alerts_24h.urgent} urgent`
                : "no critical events"
          }
        />
        <StatBox
          label="Queue"
          value={stats?.queued_alerts ?? "—"}
          hint={stats && stats.queued_alerts > 0 ? "pending Telegram" : "delivered"}
        />
        <StatBox
          label="Last cycle"
          value={uptimeStr}
          hint={
            health?.cycle_duration_ms
              ? `${(health.cycle_duration_ms / 1000).toFixed(1)}s duration`
              : undefined
          }
        />
      </div>

      {/* Body: strategies grid + alerts rail */}
      <div className="grid lg:grid-cols-[1fr_320px] gap-10 mt-12">
        {/* Strategies grid */}
        <section>
          <div className="flex items-baseline justify-between mb-6">
            <h2 className="display text-2xl text-[var(--ink)]">Strategies</h2>
            <span className="eyebrow">
              {strategies?.length ?? 0} total
            </span>
          </div>

          {stratsLoading && (
            <div className="grid sm:grid-cols-2 gap-6">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-64 rounded-[var(--radius-card)]" />
              ))}
            </div>
          )}

          {!stratsLoading && strategies && strategies.length === 0 && (
            <EmptyState
              title="No strategies yet"
              hint="Declare strategies in strategies.yaml and run a monitor cycle."
            />
          )}

          {!stratsLoading && strategies && strategies.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-6">
              {strategies.map((s) => (
                <StrategyCard key={s.id} strategy={s} />
              ))}
            </div>
          )}
        </section>

        {/* Right rail: recent alerts */}
        <aside>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="display text-2xl text-[var(--ink)]">Recent</h2>
            <a
              href="/alerts"
              className="eyebrow text-[var(--ink-dim)] hover:text-[var(--ink)] transition-colors"
            >
              View all →
            </a>
          </div>
          <Card>
            <CardBody className="py-1">
              {nonInfoAlerts.length === 0 ? (
                <div className="py-10 text-center">
                  <span className="display italic text-xl text-[var(--ink-dim)]">
                    All quiet
                  </span>
                  <p className="text-xs text-[var(--ink-dim)] mt-1">
                    no warning-level events
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {nonInfoAlerts.map((a) => (
                    <AlertRow key={a.id} alert={a} compact />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
