"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { mutate as swrMutate } from "swr";
import { Trash2, Plus, Loader2, Copy, Check, ArrowLeft } from "lucide-react";
import Link from "next/link";
import {
  useWallets,
  useManualPositions,
  mutateApi,
  type ManualPosition,
} from "@/lib/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { truncAddr, absoluteTime, titleCaseSlug, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const SIDES = ["long", "short", "collateral", "debt", "spot"] as const;
type Side = (typeof SIDES)[number];

const SIDE_TONE: Record<Side, "healthy" | "critical" | "neutral" | "watch" | "outline"> = {
  long: "healthy",
  short: "critical",
  collateral: "neutral",
  debt: "watch",
  spot: "outline",
};

export default function WalletDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: wallets, isLoading: walletsLoading } = useWallets();
  const { data: positions, isLoading: posLoading } = useManualPositions(id);

  const wallet = wallets?.find((w) => w.id === id);

  const [copied, setCopied] = useState(false);

  function copy() {
    if (!wallet) return;
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (walletsLoading) {
    return (
      <div className="max-w-5xl mx-auto px-6 lg:px-8 py-12 space-y-4 animate-in">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="max-w-5xl mx-auto px-6 lg:px-8 py-12 animate-in">
        <EmptyState title="Wallet not found" hint={`No wallet with id '${id}'.`} />
        <div className="mt-6">
          <Link
            href="/wallets"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-mute)] hover:text-[var(--ink)] transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to wallets
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-8 py-12 animate-in">
      <div className="mb-2">
        <Link
          href="/wallets"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink-mute)] transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-3 w-3" />
          Wallets
        </Link>
      </div>

      {/* Header */}
      <div className="mb-10">
        <span className="eyebrow">Wallet · {id}</span>
        <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
          {wallet.label}
          <em className="text-[var(--accent)]">.</em>
        </h1>
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 group">
            <span className="font-mono text-[11px] text-[var(--ink-dim)]">
              {truncAddr(wallet.address, 12, 10)}
            </span>
            <button
              onClick={copy}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--ink-dim)] hover:text-[var(--ink)] cursor-pointer"
              title="Copy address"
            >
              {copied ? (
                <Check className="h-3 w-3 text-[var(--st-healthy)]" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
          <Badge tone={wallet.group === "self" ? "healthy" : "outline"}>
            {wallet.group}
          </Badge>
          <Badge tone="neutral">{wallet.chain}</Badge>
        </div>
        {wallet.notes && (
          <p className="mt-2 text-sm text-[var(--ink-dim)] italic">{wallet.notes}</p>
        )}
      </div>

      {/* Manual positions list */}
      <section className="mb-12">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="display text-2xl text-[var(--ink)]">
            Manual positions{" "}
            <span className="text-[var(--ink-dim)]">·</span>{" "}
            <span className="text-sm text-[var(--ink-dim)] tabular">
              {positions?.length ?? 0}
            </span>
          </h2>
        </div>

        {posLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !positions || positions.length === 0 ? (
          <EmptyState
            title="No manual positions"
            hint="Add one below. Useful for Apex Omni (Mode B) or any adapter-less asset."
          />
        ) : (
          <Card>
            <CardBody className="py-1">
              <div className="divide-y divide-[var(--border)]">
                {positions.map((p) => (
                  <PositionRow key={p.id} position={p} walletId={id} />
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </section>

      {/* Add form */}
      <section>
        <h2 className="display text-2xl text-[var(--ink)] mb-6">Add position</h2>
        <AddPositionForm walletId={id} />
      </section>
    </div>
  );
}

function PositionRow({ position, walletId }: { position: ManualPosition; walletId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    setDeleting(true);
    try {
      await mutateApi(`/api/manual_positions/${position.id}`, { method: "DELETE" });
      await swrMutate(`/api/manual_positions?wallet_id=${walletId}`);
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex items-start gap-4 py-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-[var(--ink)] font-medium font-mono">{position.id}</span>
          <Badge tone={SIDE_TONE[position.side as Side]}>
            {position.side}
          </Badge>
          <Badge tone="neutral">{position.protocol}</Badge>
          <Badge tone="neutral">{position.chain}</Badge>
        </div>
        <div className="mt-1 text-xs text-[var(--ink-dim)] space-x-4">
          <span>
            <span className="text-[var(--ink-mute)]">{position.asset}</span>
            {" "}
            <span className="font-mono tabular">{fmtNumber(position.size_native, 8)}</span>
          </span>
          {position.entry_price && (
            <span>entry <span className="font-mono tabular">${fmtNumber(position.entry_price, 2)}</span></span>
          )}
          {position.entry_ts && (
            <span className="text-[var(--ink-dim)]">{absoluteTime(position.entry_ts)}</span>
          )}
        </div>
        {position.notes && (
          <p className="mt-0.5 text-xs text-[var(--ink-dim)] italic">{position.notes}</p>
        )}
      </div>

      {confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onDelete}
            disabled={deleting}
            className="bg-[var(--st-critical-bg)] text-[var(--st-critical)] hover:bg-[var(--st-critical)] hover:text-[var(--bg)]"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Delete"}
          </Button>
        </div>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setConfirming(true)}
          aria-label="Delete position"
          className="shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  id: "",
  chain: "apex",
  protocol: "apex_omni",
  asset: "BTC",
  side: "short" as Side,
  size_native: "",
  entry_price: "",
  entry_datetime: "",
  notes: "",
};

function AddPositionForm({ walletId }: { walletId: string }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  function autoSlug(asset: string, side: string) {
    const base = `${walletId}_${asset}_${side}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return base.slice(0, 64);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const entry_ts = form.entry_datetime
        ? Math.floor(new Date(form.entry_datetime).getTime() / 1000)
        : null;

      await mutateApi("/api/manual_positions", {
        method: "POST",
        json: {
          id: form.id.trim(),
          wallet_id: walletId || null,
          chain: form.chain.trim(),
          protocol: form.protocol.trim(),
          asset: form.asset.trim().toUpperCase(),
          side: form.side,
          size_native: form.size_native.trim(),
          entry_price: form.entry_price.trim() || null,
          entry_ts,
          notes: form.notes.trim() || null,
        },
      });
      await swrMutate(`/api/manual_positions?wallet_id=${walletId}`);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-[var(--border-strong)]">
      <CardHeader>
        <h3 className="display text-xl text-[var(--ink)]">New manual position</h3>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="grid sm:grid-cols-2 gap-5">
          <Field label="ID (slug)" required>
            <Input
              value={form.id}
              onChange={(e) =>
                set("id", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
              }
              placeholder={autoSlug(form.asset, form.side)}
              pattern="^[a-z0-9_]+$"
              required
            />
          </Field>

          <Field label="Side" required>
            <div className="inline-flex items-center gap-1 p-1 rounded-[var(--radius-input)] bg-[var(--surface-2)] border border-[var(--border)] w-full flex-wrap">
              {SIDES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => set("side", s)}
                  className={cn(
                    "flex-1 px-2 py-1 rounded-md text-xs uppercase tracking-wider transition-colors cursor-pointer",
                    form.side === s
                      ? "bg-[var(--ink)] text-[var(--bg)]"
                      : "text-[var(--ink-dim)] hover:text-[var(--ink)]",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Asset" required>
            <Input
              value={form.asset}
              onChange={(e) => {
                const asset = e.target.value.toUpperCase();
                set("asset", asset);
                if (!form.id) set("id", autoSlug(asset, form.side));
              }}
              placeholder="BTC"
              required
            />
          </Field>

          <Field label="Size (native)" required>
            <Input
              value={form.size_native}
              onChange={(e) => set("size_native", e.target.value)}
              placeholder="0.5"
              className="font-mono"
              required
            />
          </Field>

          <Field label="Chain" required>
            <Input
              value={form.chain}
              onChange={(e) => set("chain", e.target.value.toLowerCase())}
              placeholder="apex"
              required
            />
          </Field>

          <Field label="Protocol" required>
            <Input
              value={form.protocol}
              onChange={(e) => set("protocol", e.target.value.toLowerCase())}
              placeholder="apex_omni"
              required
            />
          </Field>

          <Field label="Entry price (optional)">
            <Input
              value={form.entry_price}
              onChange={(e) => set("entry_price", e.target.value)}
              placeholder="95000"
              className="font-mono"
            />
          </Field>

          <Field label="Entry date (optional)">
            <Input
              type="datetime-local"
              value={form.entry_datetime}
              onChange={(e) => set("entry_datetime", e.target.value)}
            />
          </Field>

          <Field label="Notes (optional)" className="sm:col-span-2">
            <Input
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Context, trade rationale, etc."
            />
          </Field>

          {error && (
            <div className="sm:col-span-2 text-[var(--st-critical)] text-sm flex items-start gap-2">
              <span className="font-mono text-xs uppercase tracking-wider">error</span>
              <span>{error}</span>
            </div>
          )}

          <div className="sm:col-span-2 flex justify-end pt-2">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Save position
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="eyebrow">
        {label}
        {required && <span className="ml-1 text-[var(--accent)]">*</span>}
      </span>
      {children}
    </label>
  );
}
