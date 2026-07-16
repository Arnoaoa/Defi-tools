<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Daily lending alerts (Telegram)

`/api/cron/alerts` (Vercel Cron, daily 07:00 UTC, see `vercel.json`) sends a Telegram digest when a monitored lending position's APY drops below 10% or a market offers ≥ 20% APY and passes factual checks: utilization < 99.9%, TVL ≥ $5k, collateral price stable over 7d (DefiLlama, depeg/hack proxy), and a KyberSwap sell quote of 10% of the pool's collateral at < 5% price impact. Risk grades are displayed, never used as a filter. Thresholds are constants at the top of `lib/alerts.ts`; Morpho GraphQL access is centralized in `lib/morpho-api.ts` (shared with `/api/markets`). Route is protected by `CRON_SECRET` (Bearer); env vars in `.env.example`. Test locally with `?dry=1` (computes everything, sends nothing).

# Local dev on Windows

Outbound TLS is intercepted on this machine — Node fetches fail unless the dev server runs with `NODE_OPTIONS=--use-system-ca` (use `pnpm dev:win`).
