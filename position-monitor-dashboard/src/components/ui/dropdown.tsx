"use client";
import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export const DropdownContent = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[12rem] rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 shadow-2xl",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
DropdownContent.displayName = DropdownPrimitive.Content.displayName;

export const DropdownItem = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-[var(--ink)] outline-none transition-colors",
      "focus:bg-[var(--surface-2)] data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      className,
    )}
    {...props}
  />
));
DropdownItem.displayName = DropdownPrimitive.Item.displayName;

export const DropdownCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownPrimitive.CheckboxItem
    ref={ref}
    checked={checked}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 pl-8 text-sm text-[var(--ink)] outline-none transition-colors",
      "focus:bg-[var(--surface-2)]",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2.5 flex h-4 w-4 items-center justify-center">
      <DropdownPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5 text-[var(--accent)]" />
      </DropdownPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownPrimitive.CheckboxItem>
));
DropdownCheckboxItem.displayName = DropdownPrimitive.CheckboxItem.displayName;

export const DropdownSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-[var(--border)]", className)}
    {...props}
  />
));
DropdownSeparator.displayName = DropdownPrimitive.Separator.displayName;

export const DropdownLabel = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("eyebrow px-2.5 py-1.5", className)}
    {...props}
  />
);
