"use client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StrategySnapshot } from "@/lib/api";
import { asNumber, fmtHf, fmtPct, relativeTime } from "@/lib/format";

interface Props {
  snapshots: StrategySnapshot[];
}

function tooltipStyle() {
  return {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    padding: "8px 12px",
    fontSize: "12px",
    color: "var(--ink)",
  };
}

export function HistoryCharts({ snapshots }: Props) {
  const data = snapshots.map((s) => ({
    ts: s.snapshot_ts,
    hf: asNumber(s.composite_hf),
    delta_pct: asNumber(s.delta_deviation_pct),
    label: relativeTime(s.snapshot_ts),
  }));

  if (data.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center gap-3 text-center">
        <span className="display italic text-3xl text-[var(--ink-dim)]">
          No history yet
        </span>
        <p className="text-sm text-[var(--ink-dim)] max-w-md">
          Charts will populate after a few monitor cycles.
        </p>
      </div>
    );
  }

  return (
    <div className="grid lg:grid-cols-2 gap-8">
      {/* Health Factor chart */}
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <span className="eyebrow">Composite HF</span>
          <span className="text-xs text-[var(--ink-dim)] tabular">
            {data.length} snapshots
          </span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />
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
                domain={[0, 3]}
                tickFormatter={(v) => v.toFixed(1)}
              />
              <Tooltip
                contentStyle={tooltipStyle()}
                cursor={{ stroke: "var(--accent-mute)", strokeWidth: 1 }}
                formatter={(value: number | null) =>
                  value === null ? "—" : [fmtHf(value), "HF"]
                }
              />
              {/* Threshold bands */}
              <ReferenceArea y1={0} y2={1.2} fill="var(--st-critical)" fillOpacity={0.06} />
              <ReferenceArea y1={1.2} y2={1.5} fill="var(--st-urgent)" fillOpacity={0.06} />
              <ReferenceArea y1={1.5} y2={2.0} fill="var(--st-watch)" fillOpacity={0.06} />
              <ReferenceLine y={1.0} stroke="var(--st-critical)" strokeDasharray="3 3" />
              <ReferenceLine y={1.2} stroke="var(--st-urgent)" strokeDasharray="3 3" />
              <ReferenceLine y={1.5} stroke="var(--st-watch)" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="hf"
                stroke="var(--accent)"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 4, fill: "var(--accent)" }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Delta deviation chart */}
      <div>
        <div className="flex items-baseline justify-between mb-4">
          <span className="eyebrow">Delta deviation</span>
          <span className="text-xs text-[var(--ink-dim)] tabular">% of capital</span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />
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
                tickFormatter={(v) => `${v.toFixed(1)}%`}
              />
              <Tooltip
                contentStyle={tooltipStyle()}
                cursor={{ stroke: "var(--accent-mute)", strokeWidth: 1 }}
                formatter={(value: number | null) =>
                  value === null ? "—" : [fmtPct(value, 2, true), "Deviation"]
                }
              />
              {/* Acceptable band ±5% */}
              <ReferenceArea y1={-5} y2={5} fill="var(--st-healthy)" fillOpacity={0.06} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <Line
                type="monotone"
                dataKey="delta_pct"
                stroke="var(--accent)"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 4, fill: "var(--accent)" }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
