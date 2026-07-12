import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-[var(--radius-input)] bg-[var(--surface-2)] border border-[var(--border)] px-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-dim)]",
        "focus-visible:outline-none focus-visible:border-[var(--accent-mute)]",
        "transition-colors",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
