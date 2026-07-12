"use client";
import { useState } from "react";
import { mutate as swrMutate } from "swr";
import { Plus, Trash2, Loader2, Copy, Check, Radar, ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  useWallets,
  mutateApi,
  type Wallet,
  type WalletGroup,
} from "@/lib/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { truncAddr, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const CHAINS = [
  "ethereum",
  "arbitrum",
  "base",
  "optimism",
  "avalanche",
  "polygon",
  "bsc",
  "hyperliquid",
];

export default function WalletsPage() {
  const { data: wallets, isLoading } = useWallets();

  const self = (wallets ?? []).filter((w) => w.group === "self");
  const watch = (wallets ?? []).filter((w) => w.group === "watch");

  return (
    <div className="max-w-5xl mx-auto px-6 lg:px-8 py-12 animate-in">
      {/* Editorial title */}
      <div className="mb-12">
        <span className="eyebrow">Setup</span>
        <h1 className="display text-5xl mt-3 leading-tight text-[var(--ink)]">
          Wallets <em className="text-[var(--accent)]">registry</em>.
        </h1>
        <p className="mt-4 text-sm text-[var(--ink-mute)] max-w-xl leading-relaxed">
          Declare the addresses the monitor tracks.{" "}
          <span className="text-[var(--ink)]">Self</span> wallets count toward
          your portfolio and trigger alerts.{" "}
          <span className="text-[var(--ink)]">Watch</span> wallets are
          read-only observations (whales, strategies to copy).
        </p>
      </div>

      {/* Add form */}
      <AddWalletForm />

      {isLoading ? (
        <div className="mt-12 space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <>
          <WalletGroup label="Self" wallets={self} group="self" />
          <WalletGroup label="Watch" wallets={watch} group="watch" />
        </>
      )}
    </div>
  );
}

function AddWalletForm() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    id: "",
    label: "",
    address: "",
    chain: "ethereum",
    group: "self" as WalletGroup,
    notes: "",
    auto_discover: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForm({
      id: "",
      label: "",
      address: "",
      chain: "ethereum",
      group: "self",
      notes: "",
      auto_discover: true,
    });
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await mutateApi("/api/wallets", {
        method: "POST",
        json: {
          id: form.id.trim(),
          label: form.label.trim(),
          address: form.address.trim(),
          chain: form.chain,
          group: form.group,
          notes: form.notes.trim() || null,
          auto_discover: form.auto_discover,
        },
      });
      await swrMutate("/api/wallets");
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-slug from label
  function autoSlug(label: string) {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
  }

  if (!open) {
    return (
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-6 mb-2">
        <div>
          <span className="eyebrow">Add a wallet</span>
          <p className="text-sm text-[var(--ink-mute)] mt-1">
            Register a new self-owned wallet or a wallet to watch.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} variant="primary" size="md">
          <Plus className="h-4 w-4" />
          New wallet
        </Button>
      </div>
    );
  }

  return (
    <Card className="border-[var(--border-strong)]">
      <CardHeader>
        <h2 className="display text-2xl text-[var(--ink)]">Register a wallet</h2>
      </CardHeader>
      <CardBody>
        <form onSubmit={submit} className="grid sm:grid-cols-2 gap-5">
          <Field label="Label" required>
            <Input
              value={form.label}
              onChange={(e) => {
                const label = e.target.value;
                setForm({
                  ...form,
                  label,
                  // Suggest slug if user hasn't manually edited
                  id: form.id === "" || form.id === autoSlug(form.label) ? autoSlug(label) : form.id,
                });
              }}
              placeholder="Main wallet"
              required
            />
          </Field>

          <Field label="Identifier (slug)" required>
            <Input
              value={form.id}
              onChange={(e) =>
                setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })
              }
              placeholder="arnaud_main"
              pattern="^[a-z0-9_-]+$"
              required
            />
          </Field>

          <Field label="Address" required className="sm:col-span-2">
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="0x… or chain-specific format"
              className="font-mono"
              required
            />
          </Field>

          <Field label="Chain">
            <select
              value={form.chain}
              onChange={(e) => setForm({ ...form, chain: e.target.value })}
              className="flex h-9 w-full rounded-[var(--radius-input)] bg-[var(--surface-2)] border border-[var(--border)] px-3 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:border-[var(--accent-mute)] transition-colors"
            >
              {CHAINS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Group">
            <div className="inline-flex items-center gap-1 p-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-full">
              {(["self", "watch"] as WalletGroup[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setForm({ ...form, group: g })}
                  className={cn(
                    "flex-1 px-3 py-1 rounded-md text-xs uppercase tracking-wider transition-colors",
                    form.group === g
                      ? "bg-[var(--ink)] text-[var(--bg)]"
                      : "text-[var(--ink-dim)] hover:text-[var(--ink)]",
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Notes" className="sm:col-span-2">
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Optional — context, strategy hint, etc."
            />
          </Field>

          <div className="sm:col-span-2 flex items-start gap-3 px-3 py-3 rounded-md border border-[var(--border)] bg-[var(--surface-2)]">
            <button
              type="button"
              role="switch"
              aria-checked={form.auto_discover}
              onClick={() =>
                setForm({ ...form, auto_discover: !form.auto_discover })
              }
              className={cn(
                "shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors relative",
                form.auto_discover
                  ? "bg-[var(--st-healthy)] border-[var(--st-healthy)]"
                  : "bg-[var(--surface)] border-[var(--border-strong)]",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-[var(--bg)] transition-transform",
                  form.auto_discover ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm text-[var(--ink)] font-medium">
                <Radar className="h-3.5 w-3.5 text-[var(--accent)]" />
                Auto-discover positions
              </div>
              <p className="mt-1 text-xs text-[var(--ink-mute)] leading-relaxed">
                When enabled, the monitor scans this wallet across all supported
                protocols every cycle. Off = only positions referenced by explicit
                strategies are fetched.
              </p>
            </div>
          </div>

          {error && (
            <div className="sm:col-span-2 text-[var(--st-critical)] text-sm flex items-start gap-2">
              <span className="font-mono text-xs uppercase tracking-wider">
                error
              </span>
              <span>{error}</span>
            </div>
          )}

          <div className="sm:col-span-2 flex items-center justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Save wallet
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

function WalletGroup({
  label,
  wallets,
  group,
}: {
  label: string;
  wallets: Wallet[];
  group: WalletGroup;
}) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="display text-2xl text-[var(--ink)]">
          {label}{" "}
          <span className="text-[var(--ink-dim)]">·</span>{" "}
          <span className="text-sm text-[var(--ink-dim)] tabular">
            {wallets.length}
          </span>
        </h2>
      </div>

      {wallets.length === 0 ? (
        <EmptyState
          title={`No ${group} wallets`}
          hint={`Add one above with the ${group} group.`}
        />
      ) : (
        <Card>
          <CardBody className="py-1">
            <div className="divide-y divide-[var(--border)]">
              {wallets.map((w) => (
                <WalletRow key={w.id} wallet={w} />
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </section>
  );
}

function WalletRow({ wallet }: { wallet: Wallet }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function onDelete() {
    setDeleting(true);
    try {
      await mutateApi(`/api/wallets/${wallet.id}`, { method: "DELETE" });
      await swrMutate("/api/wallets");
    } catch {
      setDeleting(false);
    }
  }

  async function toggleDiscover() {
    if (wallet.group !== "self") return; // only self wallets are scanned
    setToggling(true);
    try {
      await mutateApi(`/api/wallets/${wallet.id}`, {
        method: "PATCH",
        json: { auto_discover: !wallet.auto_discover },
      });
      await swrMutate("/api/wallets");
    } finally {
      setToggling(false);
    }
  }

  function copy() {
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center gap-4 py-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-[var(--ink)] font-medium">
            {wallet.label}
          </span>
          <span className="text-xs text-[var(--ink-dim)] font-mono">
            {wallet.id}
          </span>
          <Badge tone={wallet.group === "self" ? "healthy" : "outline"}>
            {wallet.group}
          </Badge>
          <Badge tone="neutral">{wallet.chain}</Badge>
        </div>
        <div className="mt-1.5 flex items-center gap-2 group">
          <span className="font-mono text-[11px] text-[var(--ink-dim)]">
            {truncAddr(wallet.address, 10, 8)}
          </span>
          <button
            onClick={copy}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--ink-dim)] hover:text-[var(--ink)]"
            title="Copy address"
          >
            {copied ? (
              <Check className="h-3 w-3 text-[var(--st-healthy)]" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        {wallet.notes && (
          <p className="mt-1 text-xs text-[var(--ink-dim)] italic">
            {wallet.notes}
          </p>
        )}
      </div>

      {wallet.group === "self" && (
        <button
          onClick={toggleDiscover}
          disabled={toggling}
          className={cn(
            "shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-colors text-[10px] uppercase tracking-wider",
            wallet.auto_discover
              ? "bg-[var(--st-healthy-bg)] border-transparent text-[var(--st-healthy)]"
              : "bg-transparent border-[var(--border-strong)] text-[var(--ink-dim)] hover:text-[var(--ink-mute)]",
          )}
          title={
            wallet.auto_discover
              ? "Auto-discover ON — scans every protocol each cycle"
              : "Auto-discover OFF — only positions referenced by strategies are fetched"
          }
        >
          {toggling ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Radar className="h-3 w-3" />
          )}
          {wallet.auto_discover ? "Discover" : "Manual"}
        </button>
      )}

      <Link
        href={`/wallets/${wallet.id}`}
        className="shrink-0 flex items-center gap-1 text-xs text-[var(--ink-dim)] hover:text-[var(--ink)] transition-colors cursor-pointer"
        title="View wallet detail"
      >
        View
        <ArrowRight className="h-3 w-3" />
      </Link>

      {confirming ? (
        <div className="flex items-center gap-2">
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
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Confirm delete"
            )}
          </Button>
        </div>
      ) : (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setConfirming(true)}
          aria-label="Delete wallet"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
