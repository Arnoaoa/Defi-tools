/**
 * Display formatters. All monetary values arrive as strings (Decimal).
 * Parsing happens here, never silently in components.
 */

export function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

const usdFull = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtUsd(value: string | number | null | undefined, opts?: { compact?: boolean; signed?: boolean }) {
  const n = asNumber(value);
  if (n === null) return "—";
  const formatter = opts?.compact ? usdCompact : usdFull;
  const formatted = formatter.format(Math.abs(n));
  if (!opts?.signed) return n < 0 ? `-${formatted}` : formatted;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${formatted}`;
}

export function fmtPct(value: string | number | null | undefined, digits = 2, signed = false) {
  const n = asNumber(value);
  if (n === null) return "—";
  const out = n.toFixed(digits) + "%";
  if (!signed) return out;
  return n > 0 ? `+${out}` : out;
}

export function fmtNumber(value: string | number | null | undefined, digits = 4) {
  const n = asNumber(value);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtHf(value: string | number | null | undefined) {
  const n = asNumber(value);
  if (n === null) return "—";
  return n.toFixed(3);
}

/** Sign-based color token name (use as Tailwind class fragment). */
export function signColor(value: string | number | null | undefined): "pos" | "neg" | "neutral" {
  const n = asNumber(value);
  if (n === null || n === 0) return "neutral";
  return n > 0 ? "pos" : "neg";
}

/** Health factor bucket → status color name. */
export function hfStatus(hf: string | number | null | undefined): "healthy" | "watch" | "urgent" | "critical" | "neutral" {
  const n = asNumber(hf);
  if (n === null) return "neutral";
  if (n >= 2) return "healthy";
  if (n >= 1.5) return "watch";
  if (n >= 1.2) return "urgent";
  return "critical";
}

export function alertLevelColor(level: string): "healthy" | "watch" | "urgent" | "critical" | "neutral" {
  switch (level) {
    case "info":
      return "neutral";
    case "warning":
      return "watch";
    case "urgent":
      return "urgent";
    case "critical":
      return "critical";
    default:
      return "neutral";
  }
}

/** Relative time from a unix timestamp (seconds). */
export function relativeTime(unixSec: number | null | undefined): string {
  if (!unixSec) return "—";
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

export function absoluteTime(unixSec: number | null | undefined): string {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Truncate an Ethereum address: 0x0104...c703a */
export function truncAddr(addr: string | null | undefined, head = 6, tail = 5): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function titleCaseSlug(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/[_-]/g, " ")
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
