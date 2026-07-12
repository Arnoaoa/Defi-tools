import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-input)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-mute)] disabled:opacity-40 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--ink)] text-[var(--bg)] hover:bg-[var(--accent)] hover:text-[var(--bg)]",
        ghost:
          "text-[var(--ink-mute)] hover:text-[var(--ink)] hover:bg-[var(--surface-2)]",
        outline:
          "border border-[var(--border-strong)] text-[var(--ink)] hover:bg-[var(--surface-2)]",
        subtle:
          "bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[color-mix(in_srgb,var(--surface-2)_70%,var(--ink-mute))]",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-9 px-3.5",
        lg: "h-10 px-4 text-[15px]",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
