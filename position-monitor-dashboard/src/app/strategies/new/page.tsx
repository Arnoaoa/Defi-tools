"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { mutateApi, useWallets, type StrategyCrudLeg } from "@/lib/api";

const STRATEGY_TYPES = [
  "delta_neutral",
  "passive",
  "leveraged_yield",
  "spot",
  "composite",
] as const;

const PROTOCOLS = [
  "hyperliquid",
  "morpho",
  "aave",
  "pendle",
  "euler",
  "apex_omni",
] as const;

const ROLES = [
  "spot",
  "short_perp",
  "long_perp",
  "collateral",
  "debt",
] as const;

const CHAINS = [
  { value: "", label: "— none —" },
  { value: "ethereum", label: "Ethereum" },
  { value: "arbitrum", label: "Arbitrum" },
  { value: "base", label: "Base" },
  { value: "optimism", label: "Optimism" },
  { value: "avalanche", label: "Avalanche" },
] as const;

const SLUG_RE = /^[a-z0-9_]+$/;

type LegDraft = Omit<StrategyCrudLeg, "symbol"> & { symbol: string };

function emptyLeg(): LegDraft {
  return {
    protocol: "hyperliquid",
    role: "spot",
    asset: "",
    chain: null,
    symbol: "",
    wallet_id: null,
  };
}

export default function NewStrategyPage() {
  const router = useRouter();
  const { data: wallets } = useWallets();

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("composite");
  const [deltaTargetPct, setDeltaTargetPct] = useState("0");
  const [notes, setNotes] = useState("");
  const [legs, setLegs] = useState<LegDraft[]>([emptyLeg()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateLeg(index: number, patch: Partial<LegDraft>) {
    setLegs((prev) =>
      prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)),
    );
  }

  function removeLeg(index: number) {
    setLegs((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!SLUG_RE.test(id)) {
      setError("ID must be lowercase alphanumeric + underscore only");
      return;
    }
    if (legs.length === 0) {
      setError("At least one leg is required");
      return;
    }

    setSubmitting(true);
    try {
      await mutateApi("/api/strategies_crud", {
        method: "POST",
        json: {
          id,
          name,
          type,
          delta_target_pct: deltaTargetPct,
          notes: notes || null,
          legs: legs.map((l) => ({
            protocol: l.protocol,
            role: l.role,
            asset: l.asset || null,
            chain: l.chain || null,
            symbol: l.symbol || null,
            wallet_id: l.wallet_id || null,
          })),
        },
      });
      router.push(`/strategies/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 lg:px-8 py-12">
      <div className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer mb-4"
        >
          <ChevronLeft className="size-4" /> Back
        </Link>
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-1">
          Strategies · New
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Compose a strategy</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Core fields */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">ID (slug)</label>
            <input
              type="text"
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my_strategy"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">Lowercase, alphanumeric, underscores</p>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BTC delta-neutral"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
            >
              {STRATEGY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Delta target (%)</label>
            <input
              type="number"
              step="any"
              value={deltaTargetPct}
              onChange={(e) => setDeltaTargetPct(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional context..."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>

        {/* Legs */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold">Legs</h2>
            <button
              type="button"
              onClick={() => setLegs((prev) => [...prev, emptyLeg()])}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline cursor-pointer"
            >
              <Plus className="size-4" /> Add leg
            </button>
          </div>

          <div className="space-y-4">
            {legs.map((leg, i) => (
              <div
                key={i}
                className="rounded-lg border border-border p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Leg {i + 1}
                  </span>
                  {legs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLeg(i)}
                      className="text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Protocol</label>
                    <select
                      value={leg.protocol}
                      onChange={(e) => updateLeg(i, { protocol: e.target.value })}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                    >
                      {PROTOCOLS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Role</label>
                    <select
                      value={leg.role}
                      onChange={(e) => updateLeg(i, { role: e.target.value })}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Asset</label>
                    <input
                      type="text"
                      value={leg.asset ?? ""}
                      onChange={(e) =>
                        updateLeg(i, { asset: e.target.value || null })
                      }
                      placeholder="BTC"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Chain</label>
                    <select
                      value={leg.chain ?? ""}
                      onChange={(e) =>
                        updateLeg(i, { chain: e.target.value || null })
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                    >
                      {CHAINS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Wallet</label>
                    <select
                      value={leg.wallet_id ?? ""}
                      onChange={(e) =>
                        updateLeg(i, { wallet_id: e.target.value || null })
                      }
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                    >
                      <option value="">— none —</option>
                      {wallets?.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
          >
            {submitting ? "Creating…" : "Create strategy"}
          </button>
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
