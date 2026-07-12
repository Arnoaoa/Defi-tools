import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] bg-[var(--surface)] border border-[var(--border)] overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function CardInteractive({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <Card
      className={cn("lift cursor-pointer", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pt-6 pb-3", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pb-6 pt-3", className)} {...props} />;
}
