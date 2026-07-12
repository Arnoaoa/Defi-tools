import { cn } from "@/lib/utils";

interface StatBoxProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  emphasis?: "default" | "muted";
  className?: string;
}

/**
 * Editorial KPI. Tiny eyebrow label + large tabular value + optional hint.
 * Used at the top of pages and inside strategy detail.
 */
export function StatBox({ label, value, hint, emphasis = "default", className }: StatBoxProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "tabular text-3xl font-light leading-none tracking-tight",
          emphasis === "muted" ? "text-[var(--ink-mute)]" : "text-[var(--ink)]",
        )}
      >
        {value}
      </span>
      {hint && (
        <span className="text-xs text-[var(--ink-dim)]">{hint}</span>
      )}
    </div>
  );
}
