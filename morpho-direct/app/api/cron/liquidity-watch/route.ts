import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatUnits } from 'viem'
import { mainnet, base } from 'viem/chains'
import { MORPHO_BLUE_ADDRESS, MORPHO_BLUE_ABI, ERC20_ABI } from '@/lib/morpho'
import { sendTelegram } from '@/lib/alerts'

const CHAINS = {
  1: {
    chain: mainnet,
    rpc: process.env.NEXT_PUBLIC_ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    network: 'ethereum',
  },
  8453: {
    chain: base,
    rpc: process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base-rpc.publicnode.com',
    network: 'base',
  },
} as const

const DEFAULT_MIN_ASSETS = 0.01 // in loan-token units
const DEFAULT_COOLDOWN_MINUTES = 15

// Best-effort anti-spam: survives warm invocations of the same serverless
// instance, which frequent pings keep alive. Worst case a cold start re-alerts
// early — acceptable for a "withdraw now" signal.
const lastAlertAt = new Map<string, number>()

// High-frequency watcher for a 100%-utilization market the user has lent in:
// pinged externally (cron-job.org — Vercel Hobby crons are daily-only), it
// reads liquidity on-chain (no API lag) and alerts the moment a liquidation
// or repay frees enough to withdraw.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  const params = request.nextUrl.searchParams
  const authorized =
    secret && (request.headers.get('authorization') === `Bearer ${secret}` || params.get('key') === secret)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const marketId = params.get('marketId')
  if (!marketId?.startsWith('0x')) {
    return NextResponse.json({ error: 'marketId manquant' }, { status: 400 })
  }
  const chainId = Number(params.get('chainId') ?? 1) as keyof typeof CHAINS
  const chainConfig = CHAINS[chainId]
  if (!chainConfig) {
    return NextResponse.json({ error: `chainId non supporté : ${chainId}` }, { status: 400 })
  }
  const minAssets = Number(params.get('min') ?? DEFAULT_MIN_ASSETS)
  const cooldownMs = Number(params.get('cooldown') ?? DEFAULT_COOLDOWN_MINUTES) * 60_000

  try {
    const client = createPublicClient({ chain: chainConfig.chain, transport: http(chainConfig.rpc) })
    const morpho = { address: MORPHO_BLUE_ADDRESS, abi: MORPHO_BLUE_ABI } as const

    const [marketState, marketParams] = await client.multicall({
      contracts: [
        { ...morpho, functionName: 'market', args: [marketId as `0x${string}`] },
        { ...morpho, functionName: 'idToMarketParams', args: [marketId as `0x${string}`] },
      ],
      allowFailure: false,
    })
    const [totalSupplyAssets, , totalBorrowAssets] = marketState
    const [loanToken, collateralToken] = marketParams
    if (totalSupplyAssets === 0n) {
      return NextResponse.json({ error: 'marché inconnu on-chain (totalSupplyAssets = 0)' }, { status: 400 })
    }

    const [decimals, loanSymbol, collateralSymbol] = await client.multicall({
      contracts: [
        { address: loanToken, abi: ERC20_ABI, functionName: 'decimals' },
        { address: loanToken, abi: ERC20_ABI, functionName: 'symbol' },
        { address: collateralToken, abi: ERC20_ABI, functionName: 'symbol' },
      ],
      allowFailure: false,
    })

    const liquidity = totalSupplyAssets - totalBorrowAssets
    const liquidityAssets = Number(formatUnits(liquidity, decimals))
    const utilization = Number(totalBorrowAssets) / Number(totalSupplyAssets)
    const marketLabel = `${loanSymbol}/${collateralSymbol}`

    let alerted = false
    if (liquidityAssets >= minAssets) {
      const watchKey = `${chainId}-${marketId}`
      const last = lastAlertAt.get(watchKey) ?? 0
      if (Date.now() - last >= cooldownMs) {
        await sendTelegram(
          [
            `🚨 Liquidité dispo sur ${marketLabel} (${chainConfig.network}) : ${liquidityAssets.toFixed(4)} ${loanSymbol}`,
            `Utilisation : ${(utilization * 100).toFixed(2)} % — retire maintenant, premier arrivé premier servi.`,
            `https://app.morpho.org/${chainConfig.network}/market/${marketId}`,
          ].join('\n')
        )
        lastAlertAt.set(watchKey, Date.now())
        alerted = true
      }
    }

    return NextResponse.json({
      market: marketLabel,
      liquidity: liquidityAssets,
      utilization,
      threshold: minAssets,
      alerted,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
