"use client";
import { useState, Suspense } from "react";
import { Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAlerts, useStrategies, type AlertLevel } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { AlertRow } from "@/components/AlertRow";
import {
  DropdownMenu,
  DropdownTrigger,
  DropdownContent,
  DropdownCheckboxItem,
  DropdownLabel,
} from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LEVELS: AlertLevel[] = ["info", "warning", "urgent", "critical"];

function AlertsContent() {
  const searchParams = useSearchParams();
  const initialUnsent = searchParams.get("only_unsent") === "true";

  const [activeLevel, setActiveLevel] = useState<AlertLevel | null>(null);
  const [activeStrategy, setActiveStrategy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyUnsent, setOnlyUnsent] = useState(initialUnsent);

  const { data: alerts, isLoading } = useAlerts({
    limit: 200,
    level: activeLevel ?? undefined,
    strategy_id: activeStrategy ?? undefined,
    only_unsent: onlyUnsent,
  });
  const { data: strategies } = useStrategies();

  const filtered = (alerts ?? []).filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.message.toLowerCase().includes(q) ||
      a.type.toLowerCase().includes(q) ||
      (a.asset?.toLowerCase().includes(q) ?? false) ||
      (a.strategy_id?.toLowerCase().includes(q) ?? false)
    );
  });

  return (
    <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12 animate-in">
      {/* Editorial title */}
      <div className="mb-12">
        <span className="eyebrow">Log</span>
        <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
          Alerts <em className="text-[var(--accent)]">history</em>.
        </h1>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-8 pb-6 border-b border-[var(--border)]">
        {/* Level chips */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveLevel(null)}
            className={cn(
              "text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors",
              activeLevel === null
                ? "bg-[var(--ink)] text-[var(--bg)]"
                : "text-[var(--ink-dim)] hover:text-[var(--ink-mute)]",
            )}
          >
            All
          </button>
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setActiveLevel(activeLevel === lv ? null : lv)}
              className={cn(
                "text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors border border-transparent",
                activeLevel === lv && lv === "info" && "bg-[var(--surface-2)] text-[var(--ink-mute)] border-[var(--border-strong)]",
                activeLevel === lv && lv === "warning" && "bg-[var(--st-watch-bg)] text-[var(--st-watch)]",
                activeLevel === lv && lv === "urgent" && "bg-[var(--st-urgent-bg)] text-[var(--st-urgent)]",
                activeLevel === lv && lv === "critical" && "bg-[var(--st-critical-bg)] text-[var(--st-critical)]",
                activeLevel !== lv && "text-[var(--ink-dim)] hover:text-[var(--ink-mute)]",
              )}
            >
              {lv}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-[var(--border)]" />

        {/* Strategy dropdown */}
        <DropdownMenu>
          <DropdownTrigger asChild>
            <Button variant="ghost" size="sm">
              {activeStrategy ?? "All strategies"}
            </Button>
          </DropdownTrigger>
          <DropdownContent align="start">
            <DropdownLabel>Strategy</DropdownLabel>
            <DropdownCheckboxItem
              checked={activeStrategy === null}
              onCheckedChange={() => setActiveStrategy(null)}
            >
              All strategies
            </DropdownCheckboxItem>
            {(strategies ?? []).map((s) => (
              <DropdownCheckboxItem
                key={s.id}
                checked={activeStrategy === s.id}
                onCheckedChange={() => setActiveStrategy(s.id)}
              >
                {s.id}
              </DropdownCheckboxItem>
            ))}
          </DropdownContent>
        </DropdownMenu>

        <div className="h-5 w-px bg-[var(--border)]" />

        {/* Unsent toggle */}
        <button
          onClick={() => setOnlyUnsent(!onlyUnsent)}
          className={cn(
            "flex items-center gap-2 text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors",
            onlyUnsent
              ? "bg-[var(--st-watch-bg)] text-[var(--st-watch)]"
              : "text-[var(--ink-dim)] hover:text-[var(--ink-mute)]",
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              onlyUnsent ? "bg-[var(--st-watch)]" : "bg-[var(--ink-dim)]",
            )}
          />
          Queued only
        </button>

        {/* Search */}
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ink-dim)]" />
          <Input
            placeholder="Search message, type, asset…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>

      {/* Counts */}
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">
          {filtered.length} result{filtered.length !== 1 ? "s" : ""}
        </span>
        {(activeLevel || activeStrategy || search || onlyUnsent) && (
          <button
            onClick={() => {
              setActiveLevel(null);
              setActiveStrategy(null);
              setSearch("");
              setOnlyUnsent(false);
            }}
            className="text-xs text-[var(--ink-dim)] hover:text-[var(--ink)] transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No alerts match"
          hint="Try clearing filters or widening the search."
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
            {filtered.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AlertsPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12">
          <Skeleton className="h-16 w-1/2 mb-8" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <AlertsContent />
    </Suspense>
  );
}
