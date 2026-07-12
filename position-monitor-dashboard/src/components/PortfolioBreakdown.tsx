"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { PortfolioRow, PortfolioCategory } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { fmtUsd, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const CATEGORY_LABEL: Record<PortfolioCategory, string> = {
  spot_volatile: "Spot · Volatile",
  spot_stable: "Spot · Stable",
  lending_collat: "Lending · Collateral",
  lending_debt: "Lending · Debt",
  perp_long: "Perp · Long",
  perp_short: "Perp · Short",
  pt: "Pendle PT",
  lp: "Liquidity Provider",
  other: "Other",
};

const CATEGORY_TONE: Record<PortfolioCategory, "healthy" | "watch" | "neutral" | "outline" | "urgent" | "critical"> = {
  spot_volatile: "outline",
  spot_stable: "neutral",
  lending_collat: "healthy",
  lending_debt: "critical",
  perp_long: "outline",
  perp_short: "watch",
  pt: "outline",
  lp: "outline",
  other: "neutral",
};

interface AssetSlot {
  value_usd: string;
  size_native: string;
  count: number;
}

function parseAssets(metricsJson: string | null): Record<string, AssetSlot> {
  if (!metricsJson) return {};
  try {
    const parsed = JSON.parse(metricsJson);
    return parsed.assets ?? {};
  } catch {
    return {};
  }
}

interface Props {
  rows: PortfolioRow[];
}

export function PortfolioBreakdown({ rows }: Props) {
  // Group rows by chain
  const byChain = rows.reduce<Record<string, PortfolioRow[]>>((acc, r) => {
    (acc[r.chain] ??= []).push(r);
    return acc;
  }, {});

  const chains = Object.keys(byChain).sort();

  if (rows.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center gap-3 text-center">
        <span className="display italic text-3xl text-[var(--ink-dim)]">
          No portfolio data yet
        </span>
        <p className="text-sm text-[var(--ink-dim)] max-w-md">
          Declare your wallets in <span className="font-mono">strategies.yaml</span> under
          the <span className="font-mono">wallets:</span> section, then run a cycle.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      {chains.map((chain) => (
        <div key={chain}>
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="eyebrow text-[var(--ink-mute)]">{chain}</h3>
            <span className="text-xs text-[var(--ink-dim)] tabular">
              {byChain[chain].reduce((a, r) => a + r.position_count, 0)} positions
            </span>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border-strong)]">
                <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]" />
                <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)]">Category</th>
                <th className="pb-2 pr-4 eyebrow text-[var(--ink-dim)] text-right">Value</th>
                <th className="pb-2 pr-1 eyebrow text-[var(--ink-dim)] text-right">Positions</th>
              </tr>
            </thead>
            <tbody>
              {byChain[chain].map((r) => (
                <CategoryRow key={`${r.chain}-${r.category}`} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function CategoryRow({ row }: { row: PortfolioRow }) {
  const [open, setOpen] = useState(false);
  const assets = parseAssets(row.metrics_json);
  const assetKeys = Object.keys(assets).sort(
    (a, b) =>
      parseFloat(assets[b].value_usd) - parseFloat(assets[a].value_usd),
  );

  const isDebt = row.category === "lending_debt";
  const valueDisplay = isDebt
    ? `−${fmtUsd(row.value_usd, { compact: true })}`
    : fmtUsd(row.value_usd, { compact: true });

  return (
    <>
      <tr
        onClick={() => setOpen(!open)}
        className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
      >
        <td className="py-3 pr-3 w-6 text-[var(--ink-dim)]">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              open && "rotate-90",
            )}
          />
        </td>
        <td className="py-3 pr-4">
          <div className="flex items-center gap-3">
            <Badge tone={CATEGORY_TONE[row.category]}>
              {CATEGORY_LABEL[row.category]}
            </Badge>
          </div>
        </td>
        <td
          className={cn(
            "py-3 pr-4 text-right tabular text-base",
            isDebt && "text-[var(--neg)]",
          )}
        >
          {valueDisplay}
        </td>
        <td className="py-3 pr-1 text-right tabular text-xs text-[var(--ink-mute)]">
          {row.position_count}
        </td>
      </tr>
      {open && assetKeys.length > 0 && (
        <tr className="bg-[var(--surface-2)]/40">
          <td colSpan={4} className="py-3 px-6">
            <table className="w-full text-sm">
              <tbody>
                {assetKeys.map((k) => (
                  <tr key={k}>
                    <td className="py-1.5 pr-4 text-xs text-[var(--ink-mute)] uppercase tracking-wider font-mono">
                      {k}
                    </td>
                    <td className="py-1.5 pr-4 text-right text-xs text-[var(--ink-mute)] tabular">
                      {fmtNumber(assets[k].size_native, 4)}
                    </td>
                    <td className="py-1.5 pr-1 text-right tabular text-sm text-[var(--ink)]">
                      {isDebt
                        ? `−${fmtUsd(assets[k].value_usd, { compact: true })}`
                        : fmtUsd(assets[k].value_usd, { compact: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
