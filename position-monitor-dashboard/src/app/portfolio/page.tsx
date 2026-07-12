"use client";
import { useState } from "react";
import {
  usePortfolio,
  usePortfolioHistory,
  useWallets,
  type WalletGroup,
} from "@/lib/api";
import { StatBox } from "@/components/StatBox";
import { Skeleton } from "@/components/ui/skeleton";
import { PortfolioBreakdown } from "@/components/PortfolioBreakdown";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { asNumber, fmtUsd, relativeTime, truncAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function PortfolioPage() {
  const [group, setGroup] = useState<WalletGroup>("self");
  const { data: portfolio, isLoading } = usePortfolio(group);
  const { data: history } = usePortfolioHistory(group, 30);
  const { data: wallets } = useWallets(group);

  const total = asNumber(portfolio?.totals.net_usd) ?? 0;
  const assets = asNumber(portfolio?.totals.assets_usd) ?? 0;
  const debt = asNumber(portfolio?.totals.debt_usd) ?? 0;
  const leverage = assets > 0 ? (assets - total) / assets : 0;

  const historyData = (history ?? []).map((p) => ({
    ts: p.snapshot_ts,
    value: asNumber(p.total_usd),
    label: relativeTime(p.snapshot_ts),
  }));

  return (
    <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12 animate-in">
      {/* Editorial title */}
      <div className="mb-12 flex items-end justify-between flex-wrap gap-6">
        <div>
          <span className="eyebrow">Portfolio</span>
          <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
            All <em className="text-[var(--accent)]">positions</em>,
            <br />one view.
          </h1>
        </div>
        <GroupSwitcher value={group} onChange={setGroup} />
      </div>

      {/* KPI strip */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 pb-12 border-b border-[var(--border)]">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 pb-12 border-b border-[var(--border)]">
          <StatBox
            label="Net Value"
            value={fmtUsd(total, { compact: true })}
            hint={
              portfolio?.snapshot_ts
                ? `as of ${relativeTime(portfolio.snapshot_ts)}`
                : "no snapshot yet"
            }
          />
          <StatBox
            label="Assets"
            value={
              <span className="text-[var(--pos)]">
                {fmtUsd(assets, { compact: true })}
              </span>
            }
            hint={
              portfolio
                ? `${Object.keys(portfolio.per_chain).length} chains`
                : undefined
            }
          />
          <StatBox
            label="Debt"
            value={
              debt > 0 ? (
                <span className="text-[var(--neg)]">
                  −{fmtUsd(debt, { compact: true })}
                </span>
              ) : (
                "—"
              )
            }
          />
          <StatBox
            label="Leverage"
            value={leverage > 0.01 ? `${leverage.toFixed(2)}×` : "—"}
            hint={leverage > 1 ? "looped" : undefined}
          />
        </div>
      )}

      {/* History chart + chain split */}
      <div className="grid lg:grid-cols-[3fr_2fr] gap-10 mt-12">
        <div>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="display text-2xl text-[var(--ink)]">30-day trend</h2>
            <span className="eyebrow">{historyData.length} snapshots</span>
          </div>
          <Card>
            <CardBody className="p-6">
              {historyData.length === 0 ? (
                <div className="h-64 flex items-center justify-center">
                  <span className="display italic text-2xl text-[var(--ink-dim)]">
                    No history yet
                  </span>
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={historyData}
                      margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
                    >
                      <CartesianGrid
                        stroke="var(--border)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: "var(--ink-dim)", fontSize: 10 }}
                        axisLine={{ stroke: "var(--border)" }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: "var(--ink-dim)", fontSize: 10 }}
                        axisLine={{ stroke: "var(--border)" }}
                        tickLine={false}
                        tickFormatter={(v) =>
                          new Intl.NumberFormat("en-US", {
                            notation: "compact",
                            maximumFractionDigits: 1,
                          }).format(v)
                        }
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--surface)",
                          border: "1px solid var(--border-strong)",
                          borderRadius: "8px",
                          fontSize: "12px",
                          color: "var(--ink)",
                        }}
                        formatter={(v: number | null) => [
                          fmtUsd(v ?? 0, { compact: true }),
                          "Net value",
                        ]}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="var(--accent)"
                        strokeWidth={1.5}
                        dot={false}
                        activeDot={{ r: 4, fill: "var(--accent)" }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Wallets list */}
        <div>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="display text-2xl text-[var(--ink)]">Wallets</h2>
            <span className="eyebrow">{wallets?.length ?? 0} declared</span>
          </div>
          <Card>
            <CardBody className="py-2">
              {!wallets || wallets.length === 0 ? (
                <div className="py-10 text-center">
                  <span className="display italic text-xl text-[var(--ink-dim)]">
                    No wallets declared
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {wallets.map((w) => (
                    <div key={w.id} className="py-3 flex items-baseline gap-3">
                      <span className="flex-1 min-w-0 truncate text-sm text-[var(--ink)]">
                        {w.label}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--ink-dim)]">
                        {truncAddr(w.address)}
                      </span>
                      <Badge
                        tone={w.group === "self" ? "healthy" : "outline"}
                      >
                        {w.group}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Breakdown table */}
      <div className="mt-16">
        <h2 className="display text-2xl text-[var(--ink)] mb-6">
          By chain & category
        </h2>
        {isLoading ? (
          <Skeleton className="h-96" />
        ) : (
          <PortfolioBreakdown rows={portfolio?.rows ?? []} />
        )}
      </div>
    </div>
  );
}

function GroupSwitcher({
  value,
  onChange,
}: {
  value: WalletGroup;
  onChange: (v: WalletGroup) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full bg-[var(--surface)] border border-[var(--border)]">
      {(["self", "watch"] as WalletGroup[]).map((g) => (
        <button
          key={g}
          onClick={() => onChange(g)}
          className={cn(
            "px-4 py-1.5 rounded-full text-[11px] uppercase tracking-wider transition-colors",
            value === g
              ? "bg-[var(--ink)] text-[var(--bg)]"
              : "text-[var(--ink-dim)] hover:text-[var(--ink)]",
          )}
        >
          {g}
        </button>
      ))}
    </div>
  );
}
