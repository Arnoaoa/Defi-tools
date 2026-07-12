import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--surface-2)] text-[var(--ink-mute)] border border-[var(--border)]",
        healthy: "bg-[var(--st-healthy-bg)] text-[var(--st-healthy)]",
        watch: "bg-[var(--st-watch-bg)] text-[var(--st-watch)]",
        urgent: "bg-[var(--st-urgent-bg)] text-[var(--st-urgent)]",
        critical: "bg-[var(--st-critical-bg)] text-[var(--st-critical)]",
        outline: "border border-[var(--border-strong)] text-[var(--ink-mute)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props} />
  );
}
