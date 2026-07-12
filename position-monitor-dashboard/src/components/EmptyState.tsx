import { cn } from "@/lib/utils";

interface Props {
  title: string;
  hint?: string;
  className?: string;
}

export function EmptyState({ title, hint, className }: Props) {
  return (
    <div className={cn("py-16 flex flex-col items-center gap-3 text-center", className)}>
      <span className="display italic text-3xl text-[var(--ink-dim)]">
        {title}
      </span>
      {hint && <p className="text-sm text-[var(--ink-dim)] max-w-md">{hint}</p>}
    </div>
  );
}
