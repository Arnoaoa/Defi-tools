import type { Position } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  asNumber,
  fmtHf,
  fmtNumber,
  fmtPct,
  fmtUsd,
  hfStatus,
  signColor,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  positions: Position[];
}

function PositionRow({ p }: { p: Position }) {
  const hfStatusName = hfStatus(p.health_factor);
  const pnlColor = signColor(p.unrealized_pnl_usd);
  const funding = asNumber(p.funding_rate);

  return (
    <tr className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors">
      <td className="py-3 pl-1 pr-3 font-mono text-xs text-[var(--ink)] uppercase tracking-wider">
        {p.asset}
      </td>
      <td className="py-3 pr-3">
        <Badge tone={p.side === "long" || p.side === "spot" || p.side === "collateral" ? "outline" : "neutral"}>
          {p.side}
        </Badge>
      </td>
      <td className="py-3 pr-3 text-right tabular text-xs text-[var(--ink-mute)]">
        {fmtNumber(p.size_native, 4)}
      </td>
      <td className="py-3 pr-3 text-right tabular text-sm text-[var(--ink)]">
        {fmtUsd(p.size_usd, { compact: true })}
      </td>
      <td className="py-3 pr-3 text-right tabular text-xs text-[var(--ink-mute)]">
        {fmtUsd(p.entry_price)}
      </td>
      <td className="py-3 pr-3 text-right tabular text-xs text-[var(--ink-mute)]">
        {fmtUsd(p.mark_price)}
      </td>
      <td className="py-3 pr-3 text-right tabular text-xs">
        {p.health_factor !== null ? (
          <span style={{ color: `var(--st-${hfStatusName})` }}>
            {fmtHf(p.health_factor)}
          </span>
        ) : (
          <span className="text-[var(--ink-dim)]">—</span>
        )}
      </td>
      <td className="py-3 pr-3 text-right tabular text-xs">
        {funding !== null ? (
          <span className={cn(funding < 0 ? "text-[var(--neg)]" : "text-[var(--pos)]")}>
            {fmtPct(funding * 100, 4, true)}
          </span>
        ) : (
          <span className="text-[var(--ink-dim)]">—</span>
        )}
      </td>
      <td className={cn(
        "py-3 pr-1 text-right tabular text-xs",
        pnlColor === "pos" && "text-[var(--pos)]",
        pnlColor === "neg" && "text-[var(--neg)]",
        pnlColor === "neutral" && "text-[var(--ink-dim)]",
      )}>
        {p.unrealized_pnl_usd !== null
          ? fmtUsd(p.unrealized_pnl_usd, { compact: true, signed: true })
          : "—"}
      </td>
    </tr>
  );
}

export function PositionsTable({ positions }: Props) {
  // Group by protocol
  const grouped = positions.reduce<Record<string, Position[]>>((acc, p) => {
    (acc[p.protocol] ??= []).push(p);
    return acc;
  }, {});

  const protocols = Object.keys(grouped).sort();

  if (positions.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center gap-3 text-center">
        <span className="display italic text-3xl text-[var(--ink-dim)]">
          No positions yet
        </span>
        <p className="text-sm text-[var(--ink-dim)] max-w-md">
          Run a monitor cycle to populate this strategy with live positions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {protocols.map((protocol) => (
        <div key={protocol}>
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="eyebrow text-[var(--ink-mute)]">{protocol}</h3>
            <span className="text-xs text-[var(--ink-dim)] tabular">
              {grouped[protocol].length} position{grouped[protocol].length !== 1 ? "s" : ""}
            </span>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border-strong)]">
                <th className="pb-2 pl-1 pr-3 eyebrow text-[var(--ink-dim)]">Asset</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)]">Side</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">Size</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">USD</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">Entry</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">Mark</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">HF</th>
                <th className="pb-2 pr-3 eyebrow text-[var(--ink-dim)] text-right">Funding</th>
                <th className="pb-2 pr-1 eyebrow text-[var(--ink-dim)] text-right">PnL</th>
              </tr>
            </thead>
            <tbody>
              {grouped[protocol].map((p) => (
                <PositionRow key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
