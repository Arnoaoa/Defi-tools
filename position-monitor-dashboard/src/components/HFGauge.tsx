import { asNumber, fmtHf, hfStatus } from "@/lib/format";
import { cn } from "@/lib/utils";

interface HFGaugeProps {
  value: string | number | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Editorial HF indicator — vertical bar with threshold ticks at 1.0 / 1.2 / 1.5 / 2.0.
 * Less generic than a circle gauge, fits the typographic restraint.
 */
export function HFGauge({ value, size = "md", className }: HFGaugeProps) {
  const n = asNumber(value);
  const status = hfStatus(value);

  if (n === null) {
    return (
      <div className={cn("flex items-baseline gap-2", className)}>
        <span className="display text-2xl text-[var(--ink-dim)]">N/A</span>
        <span className="eyebrow text-[var(--ink-dim)]">No lending leg</span>
      </div>
    );
  }

  // Bar fills proportionally from 0 to 3 (cap), with thresholds at 1.0, 1.2, 1.5, 2.0
  const max = 3;
  const fill = Math.max(0, Math.min(n, max)) / max;

  const colorVar = `var(--st-${status})`;

  const heights = { sm: "h-1.5", md: "h-2", lg: "h-2.5" };
  const numberSize = { sm: "text-2xl", md: "text-4xl", lg: "text-5xl" };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-baseline gap-3">
        <span
          className={cn("display tabular font-light leading-none", numberSize[size])}
          style={{ color: colorVar }}
        >
          {fmtHf(value)}
        </span>
        <span className="eyebrow" style={{ color: colorVar }}>
          {status}
        </span>
      </div>
      <div className={cn("relative w-full rounded-full bg-[var(--surface-2)]", heights[size])}>
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-all duration-500")}
          style={{
            width: `${fill * 100}%`,
            background: `linear-gradient(90deg, ${colorVar} 0%, ${colorVar} 100%)`,
            opacity: 0.85,
          }}
        />
        {/* Threshold marks */}
        {[1.0, 1.2, 1.5, 2.0].map((t) => (
          <span
            key={t}
            className="absolute top-0 bottom-0 w-px bg-[var(--border-strong)]"
            style={{ left: `${(t / max) * 100}%` }}
            title={`HF ${t}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--ink-dim)] tabular pt-0.5">
        <span>0</span>
        <span>1.2</span>
        <span>1.5</span>
        <span>2.0</span>
        <span>3+</span>
      </div>
    </div>
  );
}
