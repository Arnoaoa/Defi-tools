"use client";
import { useState } from "react";
import { AlertCircle, AlertOctagon, AlertTriangle, Info } from "lucide-react";
import type { Alert, AlertLevel } from "@/lib/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { alertLevelColor, relativeTime, absoluteTime, titleCaseSlug } from "@/lib/format";
import { cn } from "@/lib/utils";

const LEVEL_ICON: Record<AlertLevel, React.ElementType> = {
  info: Info,
  warning: AlertCircle,
  urgent: AlertTriangle,
  critical: AlertOctagon,
};

function LevelIcon({ level }: { level: AlertLevel }) {
  const Icon = LEVEL_ICON[level];
  const tone = alertLevelColor(level);
  return (
    <Icon
      className={cn(
        "h-3.5 w-3.5",
        tone === "healthy" && "text-[var(--st-healthy)]",
        tone === "watch" && "text-[var(--st-watch)]",
        tone === "urgent" && "text-[var(--st-urgent)]",
        tone === "critical" && "text-[var(--st-critical)]",
        tone === "neutral" && "text-[var(--ink-dim)]",
      )}
    />
  );
}

interface AlertRowProps {
  alert: Alert;
  /** When true, render as table row (TR). When false, render as compact list item. */
  compact?: boolean;
}

export function AlertRow({ alert, compact = false }: AlertRowProps) {
  const [open, setOpen] = useState(false);
  const tone = alertLevelColor(alert.level);

  let payload: unknown = null;
  if (alert.payload_json) {
    try {
      payload = JSON.parse(alert.payload_json);
    } catch {
      payload = alert.payload_json;
    }
  }

  if (compact) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="w-full text-left flex items-start gap-3 py-3 px-4 -mx-4 rounded-md hover:bg-[var(--surface-2)] transition-colors"
        >
          <LevelIcon level={alert.level} />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-[var(--ink)] leading-snug truncate">
              {alert.message}
            </p>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--ink-dim)] tabular">
              <span>{relativeTime(alert.snapshot_ts)}</span>
              {alert.strategy_id && (
                <>
                  <span>·</span>
                  <span className="truncate">{alert.strategy_id}</span>
                </>
              )}
            </div>
          </div>
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent>
            <AlertDetail alert={alert} payload={payload} />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <>
      <tr
        onClick={() => setOpen(true)}
        className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
      >
        <td className="py-3 pl-1 pr-4 text-xs text-[var(--ink-dim)] tabular whitespace-nowrap">
          <span title={absoluteTime(alert.snapshot_ts)}>
            {relativeTime(alert.snapshot_ts)}
          </span>
        </td>
        <td className="py-3 pr-4">
          <Badge tone={tone}>
            <LevelIcon level={alert.level} />
            <span>{alert.level}</span>
          </Badge>
        </td>
        <td className="py-3 pr-4 text-xs text-[var(--ink-mute)] tabular">
          {alert.strategy_id ?? "—"}
        </td>
        <td className="py-3 pr-4 text-xs text-[var(--ink-mute)]">
          {titleCaseSlug(alert.type)}
        </td>
        <td className="py-3 pr-4 text-sm text-[var(--ink)] max-w-md truncate" title={alert.message}>
          {alert.message}
        </td>
        <td className="py-3 pr-1 text-right">
          <span
            className={cn(
              "text-[10px] uppercase tracking-wider tabular",
              alert.sent_at ? "text-[var(--ink-dim)]" : "text-[var(--st-watch)]",
            )}
          >
            {alert.sent_at ? "sent" : "queued"}
          </span>
        </td>
      </tr>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <AlertDetail alert={alert} payload={payload} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function AlertDetail({ alert, payload }: { alert: Alert; payload: unknown }) {
  const tone = alertLevelColor(alert.level);
  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-3 mb-2">
          <Badge tone={tone}>
            <LevelIcon level={alert.level} />
            <span>{alert.level}</span>
          </Badge>
          <span className="eyebrow">{titleCaseSlug(alert.type)}</span>
        </div>
        <SheetTitle>{alert.message}</SheetTitle>
        <SheetDescription>
          {absoluteTime(alert.snapshot_ts)}
          {alert.strategy_id && <> · strategy {alert.strategy_id}</>}
        </SheetDescription>
      </SheetHeader>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm pt-6 border-t border-[var(--border)]">
        <dt className="eyebrow">ID</dt>
        <dd className="font-mono text-xs text-[var(--ink-mute)]">#{alert.id}</dd>

        <dt className="eyebrow">Asset</dt>
        <dd className="font-mono text-xs text-[var(--ink)]">{alert.asset ?? "—"}</dd>

        <dt className="eyebrow">Delivery</dt>
        <dd className="text-xs text-[var(--ink-mute)] tabular">
          {alert.sent_at ? (
            <>Sent {relativeTime(alert.sent_at)} · {alert.delivery_attempts} attempt(s)</>
          ) : (
            <>Queued · {alert.delivery_attempts} attempt(s)</>
          )}
        </dd>

        {alert.last_error && (
          <>
            <dt className="eyebrow">Error</dt>
            <dd className="text-xs text-[var(--st-critical)] font-mono">{alert.last_error}</dd>
          </>
        )}
      </dl>

      {payload !== null && (
        <div className="mt-8">
          <span className="eyebrow">Payload</span>
          <pre className="mt-2 p-4 rounded-[var(--radius-card)] bg-[var(--bg)] border border-[var(--border)] text-[11px] leading-relaxed text-[var(--ink-mute)] font-mono overflow-x-auto">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}
