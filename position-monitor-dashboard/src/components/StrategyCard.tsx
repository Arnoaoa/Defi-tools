"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Strategy } from "@/lib/api";
import { CardInteractive, CardBody, CardHeader, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  asNumber,
  fmtUsd,
  fmtPct,
  fmtHf,
  hfStatus,
  relativeTime,
  signColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";

function typeTone(t: Strategy["type"]) {
  switch (t) {
    case "delta_neutral":
      return "outline";
    case "leveraged_yield":
      return "watch";
    case "passive":
    case "spot":
    case "composite":
    default:
      return "neutral";
  }
}

function typeLabel(t: Strategy["type"]): string {
  switch (t) {
    case "delta_neutral": return "Delta · Neutral";
    case "leveraged_yield": return "Leveraged";
    case "passive": return "Passive";
    case "spot": return "Spot";
    case "composite": return "Composite";
    default: return t;
  }
}

export function StrategyCard({ strategy }: { strategy: Strategy }) {
  const snap = strategy.latest_snapshot;
  const status = hfStatus(snap?.composite_hf);
  const delta = signColor(snap?.net_delta_usd);
  const pnl = signColor(snap?.pnl_unrealized_usd);

  return (
    <Link href={`/strategies/${strategy.id}`} className="block group">
      <CardInteractive className="relative flex flex-col h-full">
        {/* Status hairline accent on the left edge */}
        <span
          className={cn(
            "absolute left-0 top-6 bottom-6 w-px",
            status === "healthy" && "bg-[var(--st-healthy)]",
            status === "watch" && "bg-[var(--st-watch)]",
            status === "urgent" && "bg-[var(--st-urgent)]",
            status === "critical" && "bg-[var(--st-critical)]",
            status === "neutral" && "bg-[var(--border-strong)]",
          )}
          style={{ opacity: 0.5 }}
        />

        <CardHeader className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="display text-[22px] leading-tight text-[var(--ink)] truncate">
              {strategy.name}
            </h3>
            <div className="mt-2 flex items-center gap-2">
              <Badge tone={typeTone(strategy.type)}>{typeLabel(strategy.type)}</Badge>
              <span className="text-xs text-[var(--ink-dim)]">
                {strategy.legs.length} leg{strategy.legs.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <ArrowUpRight className="h-4 w-4 text-[var(--ink-dim)] group-hover:text-[var(--accent)] transition-colors" />
        </CardHeader>

        <CardBody className="grid grid-cols-2 gap-6 mt-1">
          {/* HF */}
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Health</span>
            {snap?.composite_hf !== null && snap?.composite_hf !== undefined ? (
              <div className="flex items-baseline gap-2">
                <span
                  className="display tabular text-3xl font-light leading-none"
                  style={{ color: `var(--st-${status})` }}
                >
                  {fmtHf(snap.composite_hf)}
                </span>
              </div>
            ) : (
              <span className="display text-2xl text-[var(--ink-dim)]">—</span>
            )}
          </div>

          {/* Net delta */}
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Net Delta</span>
            <span
              className={cn(
                "tabular text-2xl font-light leading-none",
                delta === "pos" && "text-[var(--pos)]",
                delta === "neg" && "text-[var(--neg)]",
                delta === "neutral" && "text-[var(--ink-mute)]",
              )}
            >
              {fmtUsd(snap?.net_delta_usd, { compact: true, signed: true })}
            </span>
            {snap?.delta_deviation_pct !== null &&
              snap?.delta_deviation_pct !== undefined && (
                <span className="text-[10px] text-[var(--ink-dim)] tabular">
                  {fmtPct(snap.delta_deviation_pct, 2, true)} of capital
                </span>
              )}
          </div>

          {/* PnL */}
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">PnL Unrealized</span>
            <span
              className={cn(
                "tabular text-xl font-light leading-none",
                pnl === "pos" && "text-[var(--pos)]",
                pnl === "neg" && "text-[var(--neg)]",
                pnl === "neutral" && "text-[var(--ink-mute)]",
              )}
            >
              {fmtUsd(snap?.pnl_unrealized_usd, { compact: true, signed: true })}
            </span>
          </div>

          {/* Funding 24h */}
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Funding 24h</span>
            <span className="tabular text-xl font-light leading-none text-[var(--ink-mute)]">
              {fmtUsd(snap?.pnl_funding_24h_usd, { compact: true, signed: true })}
            </span>
          </div>
        </CardBody>

        <CardFooter className="flex items-center justify-between pt-4 mt-auto border-t border-[var(--border)]">
          <span className="text-[11px] text-[var(--ink-dim)] tabular">
            {snap?.snapshot_ts ? `Updated ${relativeTime(snap.snapshot_ts)}` : "No snapshot yet"}
          </span>
          {snap?.days_to_pendle_expiry !== null &&
            snap?.days_to_pendle_expiry !== undefined && (
              <span className="text-[11px] text-[var(--ink-mute)] tabular">
                PT in {snap.days_to_pendle_expiry}d
              </span>
            )}
        </CardFooter>
      </CardInteractive>
    </Link>
  );
}
