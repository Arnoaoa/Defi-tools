"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bell } from "lucide-react";
import { useHealth, useStats } from "@/lib/api";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/wallets", label: "Wallets" },
  { href: "/alerts", label: "Alerts" },
];

export function Header() {
  const pathname = usePathname();
  const { data: health } = useHealth();
  const { data: stats } = useStats();

  const isHealthy = health?.status === "healthy";

  const statusTone =
    health?.status === "healthy"
      ? "text-[var(--st-healthy)]"
      : health?.status === "silent"
        ? "text-[var(--st-watch)]"
        : "text-[var(--st-critical)]";

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-8">
          {/* Brand */}
          <Link href="/" className="flex items-baseline gap-3 group">
            <span className="display text-[22px] text-[var(--ink)] leading-none">
              Position
            </span>
            <span className="display italic text-[22px] text-[var(--accent)] leading-none transition-transform group-hover:translate-x-0.5">
              Monitor
            </span>
          </Link>

          {/* Nav */}
          <nav className="flex items-center gap-8">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "relative text-[13px] tracking-wider uppercase transition-colors py-1",
                    active
                      ? "text-[var(--ink)]"
                      : "text-[var(--ink-dim)] hover:text-[var(--ink-mute)]",
                  )}
                >
                  {item.label}
                  {active && (
                    <span className="absolute inset-x-0 -bottom-[21px] h-px bg-[var(--accent)]" />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Right status */}
          <div className="flex items-center gap-5">
            {/* Queued alerts */}
            {stats && stats.queued_alerts > 0 && (
              <Link
                href="/alerts?only_unsent=true"
                className="flex items-center gap-1.5 text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors"
                title={`${stats.queued_alerts} alerts queued`}
              >
                <Bell className="h-3.5 w-3.5" />
                <span className="tabular text-xs">{stats.queued_alerts}</span>
              </Link>
            )}

            {/* Health pill */}
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)]",
                statusTone,
              )}
              title={
                health?.last_cycle_ts
                  ? `Last cycle: ${relativeTime(health.last_cycle_ts)}`
                  : "Status unknown"
              }
            >
              <span
                className={cn(
                  "live-dot",
                  isHealthy && "text-[var(--st-healthy)]",
                )}
                style={
                  isHealthy
                    ? { backgroundColor: "var(--st-healthy)" }
                    : { backgroundColor: "currentColor" }
                }
              />
              <span className="text-[11px] tracking-wider uppercase">
                {health?.status ?? "—"}
              </span>
              {health?.last_cycle_ts && (
                <span className="text-[11px] text-[var(--ink-dim)] hidden sm:inline tabular">
                  · <Activity className="inline h-3 w-3 mr-1" />
                  {relativeTime(health.last_cycle_ts)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
