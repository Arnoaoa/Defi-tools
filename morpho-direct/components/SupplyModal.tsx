'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useChainId,
  useSwitchChain,
} from 'wagmi'
import { parseUnits, formatUnits, type BaseError } from 'viem'
import { morphoAppUrl, type ApiMarket } from '@/lib/api'
import { getRiskAnalysis, getMarketRisk, isStale, formatGrade, GRADE_COLORS, COMPONENT_LABELS } from '@/lib/risk'
import {
  MORPHO_BLUE_ADDRESS,
  MORPHO_BLUE_ABI,
  ERC20_ABI,
  MarketParams,
  computeMarketId,
  sharesToAssets,
  formatAmount,
} from '@/lib/morpho'

interface SupplyModalProps {
  market: ApiMarket
  onClose: () => void
}

type Tab = 'supply' | 'withdraw'
type Action = 'approve' | 'supply' | 'withdraw'

function safeParseUnits(value: string, decimals: number): bigint {
  if (!value) return 0n
  try {
    const parsed = parseUnits(value, decimals)
    return parsed > 0n ? parsed : 0n
  } catch {
    return 0n
  }
}

export function SupplyModal({ market, onClose }: SupplyModalProps) {
  const [tab, setTab] = useState<Tab>('supply')
  const [showRiskDetail, setShowRiskDetail] = useState(false)
  const risk = market.collateralAsset
    ? getRiskAnalysis(market.chain.id, market.collateralAsset.address)
    : null
  const marketRisk = risk ? getMarketRisk(market, risk) : null
  const riskStale = risk ? isStale(risk) : false
  const [amount, setAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawMax, setWithdrawMax] = useState(false)
  const [lastAction, setLastAction] = useState<Action | null>(null)
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const needsSwitch = chainId !== market.chain.id
  const txChainId = market.chain.id as 1 | 8453

  const marketParams: MarketParams = {
    loanToken: market.loanAsset.address as `0x${string}`,
    collateralToken: (market.collateralAsset?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    oracle: (market.oracle?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    irm: market.irmAddress as `0x${string}`,
    lltv: BigInt(market.lltv),
  }

  const computedId = computeMarketId(marketParams)
  const idMatchesApi = computedId.toLowerCase() === market.marketId.toLowerCase()

  // Reads target the market's chain explicitly — they work regardless of the
  // wallet's currently connected network. Only writes require the switch.
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: market.loanAsset.address as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, MORPHO_BLUE_ADDRESS] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: market.loanAsset.address as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: positionData, refetch: refetchPosition } = useReadContract({
    address: MORPHO_BLUE_ADDRESS,
    abi: MORPHO_BLUE_ABI,
    functionName: 'position',
    args: address ? [computedId, address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: marketState, refetch: refetchMarket } = useReadContract({
    address: MORPHO_BLUE_ADDRESS,
    abi: MORPHO_BLUE_ABI,
    functionName: 'market',
    args: [computedId],
    chainId: txChainId,
  })

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!isSuccess) return
    refetchAllowance()
    refetchBalance()
    refetchPosition()
    refetchMarket()
    if (lastAction === 'supply') setAmount('')
    if (lastAction === 'withdraw') {
      setWithdrawAmount('')
      setWithdrawMax(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, txHash])

  const decimals = market.loanAsset.decimals
  const symbol = market.loanAsset.symbol

  const amountBigInt = useMemo(() => safeParseUnits(amount, decimals), [amount, decimals])
  const withdrawBigInt = useMemo(() => safeParseUnits(withdrawAmount, decimals), [withdrawAmount, decimals])

  const supplyShares = positionData?.[0] ?? 0n
  const totalSupplyAssets = marketState?.[0] ?? 0n
  const totalSupplyShares = marketState?.[1] ?? 0n
  const totalBorrowAssets = marketState?.[2] ?? 0n
  const availableLiquidity = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n
  const suppliedAssets = sharesToAssets(supplyShares, totalSupplyAssets, totalSupplyShares)

  const needsApproval = tab === 'supply' && amountBigInt > 0n && (allowance ?? 0n) < amountBigInt
  const insufficientBalance = balance !== undefined && amountBigInt > balance
  const requestedWithdraw = withdrawMax ? suppliedAssets : withdrawBigInt
  const withdrawTooMuch = !withdrawMax && withdrawBigInt > suppliedAssets
  const lowLiquidity = marketState !== undefined && requestedWithdraw > availableLiquidity && requestedWithdraw > 0n

  function handleSupply() {
    if (!address || amountBigInt === 0n) return

    if (needsApproval) {
      setLastAction('approve')
      writeContract({
        address: market.loanAsset.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [MORPHO_BLUE_ADDRESS, amountBigInt],
        chainId: txChainId,
      })
      return
    }

    setLastAction('supply')
    writeContract({
      address: MORPHO_BLUE_ADDRESS,
      abi: MORPHO_BLUE_ABI,
      functionName: 'supply',
      args: [marketParams, amountBigInt, 0n, address, '0x'],
      chainId: txChainId,
    })
  }

  function handleWithdraw() {
    if (!address) return
    setLastAction('withdraw')
    if (withdrawMax) {
      if (supplyShares === 0n) return
      // Full exit: burn all shares so no dust position remains
      writeContract({
        address: MORPHO_BLUE_ADDRESS,
        abi: MORPHO_BLUE_ABI,
        functionName: 'withdraw',
        args: [marketParams, 0n, supplyShares, address, address],
        chainId: txChainId,
      })
    } else {
      if (withdrawBigInt === 0n || withdrawTooMuch) return
      writeContract({
        address: MORPHO_BLUE_ADDRESS,
        abi: MORPHO_BLUE_ABI,
        functionName: 'withdraw',
        args: [marketParams, withdrawBigInt, 0n, address, address],
        chainId: txChainId,
      })
    }
  }

  const supplyApy = market.state ? (market.state.supplyApy * 100).toFixed(2) : '—'
  const errorMessage = writeError ? ((writeError as BaseError).shortMessage ?? writeError.message) : null
  const successMessage = isSuccess
    ? lastAction === 'approve'
      ? '✓ Approval confirmed — you can now supply'
      : lastAction === 'withdraw'
      ? '✓ Withdrawal confirmed'
      : '✓ Supply confirmed'
    : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
              {market.loanAsset.symbol}
              {market.collateralAsset && (
                <span style={{ color: 'var(--muted)' }}>
                  {' '}/ {market.collateralAsset.symbol}
                </span>
              )}
            </h2>
            <div className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
              Supply APY: <span style={{ color: '#4ade80' }}>{supplyApy}%</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-2xl leading-none cursor-pointer"
            style={{ color: 'var(--muted)' }}
          >
            ×
          </button>
        </div>

        {!idMatchesApi && (
          <div
            className="mb-4 p-3 rounded-lg text-sm"
            style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef4444' }}
          >
            ⚠️ Market ID mismatch — computed ID does not match API. Aborting for security.
          </div>
        )}

        {risk && marketRisk && (
          <div
            className="mb-5 p-3 rounded-lg"
            style={{ background: 'var(--background)', border: '1px solid var(--border)' }}
          >
            <button
              onClick={() => setShowRiskDetail(!showRiskDetail)}
              className="w-full flex items-center justify-between cursor-pointer"
            >
              <span className="flex items-center gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
                <span
                  className="text-sm font-bold px-2 py-0.5 rounded"
                  style={{ background: GRADE_COLORS[marketRisk.grade].bg, color: GRADE_COLORS[marketRisk.grade].text }}
                >
                  {marketRisk.grade}
                </span>
                Marché · collatéral {formatGrade(risk)} ({risk.symbol})
              </span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {showRiskDetail ? '▲' : '▼ détails'}
              </span>
            </button>

            {riskStale && (
              <div className="mt-2 text-xs" style={{ color: '#fcd34d' }}>
                ⏳ Analyse du {risk.analyzedAt} (&gt; 30 jours) — re-check sécurité recommandé avant dépôt
              </div>
            )}

            {marketRisk.reasons.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: '#fcd34d' }}>
                {marketRisk.reasons.map((reason, i) => (
                  <div key={i}>▾ {reason}</div>
                ))}
              </div>
            )}

            {risk.redFlags.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: '#fca5a5' }}>
                ⚠️ {risk.redFlags.join(' · ')}
              </div>
            )}

            {showRiskDetail && (
              <div className="mt-3 space-y-3 text-sm">
                <p style={{ color: 'var(--foreground)' }}>{risk.summary}</p>

                <div className="grid grid-cols-1 gap-1">
                  {Object.entries(risk.components).map(([key, grade]) => (
                    <div key={key} className="flex items-center justify-between text-xs">
                      <span style={{ color: 'var(--muted)' }}>{COMPONENT_LABELS[key] ?? key}</span>
                      <span className="font-bold" style={{ color: GRADE_COLORS[grade as keyof typeof GRADE_COLORS]?.text ?? 'var(--foreground)' }}>
                        {grade}
                      </span>
                    </div>
                  ))}
                </div>

                {risk.exitLiquidity && risk.exitLiquidity.ratioPct > 0 && (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    <div className="font-medium mb-1" style={{ color: 'var(--foreground)' }}>Liquidité de sortie</div>
                    <div>
                      TVL Morpho / liquidité 24 h :{' '}
                      <span style={{ color: risk.exitLiquidity.ratioPct > 30 ? '#fca5a5' : risk.exitLiquidity.ratioPct > 10 ? '#fcd34d' : '#4ade80' }}>
                        {risk.exitLiquidity.ratioPct.toFixed(0)} %
                      </span>
                      {risk.exitLiquidity.ratioPct > 30 && ' — sortie difficile en cas de stress'}
                    </div>
                  </div>
                )}

                {risk.dependencies && (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    <div className="font-medium mb-1" style={{ color: 'var(--foreground)' }}>Dépendances</div>
                    <div>Émetteur : {risk.dependencies.issuer}</div>
                    {risk.dependencies.custodians.length > 0 && <div>Custody : {risk.dependencies.custodians.join(', ')}</div>}
                    {risk.dependencies.underlyings.length > 0 && <div>Sous-jacents : {risk.dependencies.underlyings.join(', ')}</div>}
                    {risk.dependencies.keyCounterparties.length > 0 && <div>Contreparties : {risk.dependencies.keyCounterparties.join(', ')}</div>}
                  </div>
                )}

                {(risk.incidents.length > 0 || risk.controversies.length > 0) && (
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    <div className="font-medium mb-1" style={{ color: 'var(--foreground)' }}>Incidents & controverses</div>
                    {risk.incidents.map((incident, i) => (
                      <div key={`i${i}`}>• {incident}</div>
                    ))}
                    {risk.controversies.map((controversy, i) => (
                      <div key={`c${i}`}>• {controversy}</div>
                    ))}
                  </div>
                )}

                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  Allocation max recommandée : <span style={{ color: 'var(--foreground)' }}>{risk.maxAllocation}</span>
                  {' · '}Analysé le {risk.analyzedAt}
                  {' · '}Note vault : <span className="font-mono">{risk.vaultNote}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {address && (
          <div
            className="mb-5 p-3 rounded-lg grid grid-cols-2 gap-3"
            style={{ background: 'var(--background)' }}
          >
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Wallet balance</div>
              <div className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>
                {balance !== undefined ? formatAmount(balance, decimals) : '—'} {symbol}
              </div>
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Your supply</div>
              <div className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>
                {formatAmount(suppliedAssets, decimals)} {symbol}
              </div>
            </div>
          </div>
        )}

        <div
          className="flex rounded-lg mb-5 p-1"
          style={{ background: 'var(--background)' }}
        >
          {(['supply', 'withdraw'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 rounded-md text-sm font-medium cursor-pointer transition-all"
              style={
                tab === t
                  ? { background: 'var(--accent)', color: 'white' }
                  : { color: 'var(--muted)' }
              }
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {!address ? (
          <p className="text-center text-sm py-4" style={{ color: 'var(--muted)' }}>
            Connect your wallet to continue
          </p>
        ) : needsSwitch ? (
          <button
            onClick={() => switchChain({ chainId: market.chain.id })}
            className="w-full py-3 rounded-xl font-semibold cursor-pointer"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Switch to {market.chain.id === 8453 ? 'Base' : 'Ethereum'}
          </button>
        ) : tab === 'supply' ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--muted)' }}>
                Amount ({symbol})
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                  style={{
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    color: 'var(--foreground)',
                  }}
                />
                {balance !== undefined && balance > 0n && (
                  <button
                    onClick={() => setAmount(formatUnits(balance, decimals))}
                    className="px-3 py-2 rounded-lg text-xs cursor-pointer"
                    style={{ background: 'var(--border)', color: 'var(--muted)' }}
                  >
                    MAX
                  </button>
                )}
              </div>
              {insufficientBalance && (
                <p className="text-xs mt-1.5" style={{ color: '#fca5a5' }}>
                  Insufficient balance
                </p>
              )}
            </div>

            {successMessage && (
              <div
                className="p-3 rounded-lg text-sm"
                style={{ background: '#14532d', color: '#86efac' }}
              >
                {successMessage}
              </div>
            )}

            {errorMessage && !isPending && (
              <div
                className="p-3 rounded-lg text-sm break-words"
                style={{ background: '#7f1d1d', color: '#fca5a5' }}
              >
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleSupply}
              disabled={!idMatchesApi || amountBigInt === 0n || insufficientBalance || isPending || isConfirming}
              className="w-full py-3 rounded-xl font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                ? 'Confirming…'
                : needsApproval
                ? `Approve ${symbol}`
                : 'Supply'}
            </button>

            {needsApproval && (
              <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
                Step 1 of 2: Approve exact amount (not unlimited)
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-2" style={{ color: 'var(--muted)' }}>
                Amount ({symbol})
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  value={withdrawAmount}
                  onChange={(e) => {
                    setWithdrawAmount(e.target.value)
                    setWithdrawMax(false)
                  }}
                  placeholder="0.00"
                  className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
                  style={{
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    color: 'var(--foreground)',
                  }}
                />
                {supplyShares > 0n && (
                  <button
                    onClick={() => {
                      setWithdrawAmount(formatUnits(suppliedAssets, decimals))
                      setWithdrawMax(true)
                    }}
                    className="px-3 py-2 rounded-lg text-xs cursor-pointer"
                    style={{ background: 'var(--border)', color: 'var(--muted)' }}
                  >
                    MAX
                  </button>
                )}
              </div>
              {withdrawTooMuch && (
                <p className="text-xs mt-1.5" style={{ color: '#fca5a5' }}>
                  Exceeds your supplied balance
                </p>
              )}
            </div>

            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              Market liquidity: {formatAmount(availableLiquidity, decimals)} {symbol}
            </div>

            {lowLiquidity && (
              <div
                className="p-3 rounded-lg text-sm"
                style={{ background: '#78350f', color: '#fcd34d' }}
              >
                ⚠️ Requested amount exceeds available market liquidity — the transaction will
                revert. Withdraw less, or wait for borrowers to repay.
              </div>
            )}

            {successMessage && (
              <div
                className="p-3 rounded-lg text-sm"
                style={{ background: '#14532d', color: '#86efac' }}
              >
                {successMessage}
              </div>
            )}

            {errorMessage && !isPending && (
              <div
                className="p-3 rounded-lg text-sm break-words"
                style={{ background: '#7f1d1d', color: '#fca5a5' }}
              >
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleWithdraw}
              disabled={
                !idMatchesApi ||
                isPending ||
                isConfirming ||
                (withdrawMax ? supplyShares === 0n : withdrawBigInt === 0n || withdrawTooMuch)
              }
              className="w-full py-3 rounded-xl font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                ? 'Confirming…'
                : withdrawMax
                ? 'Withdraw All'
                : 'Withdraw'}
            </button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
          <span>
            Market ID:{' '}
            <span className="font-mono">{market.marketId.slice(0, 10)}…</span>
          </span>
          <span>·</span>
          <a
            href={morphoAppUrl(market)}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer underline transition-opacity hover:opacity-80"
            style={{ color: 'var(--muted)' }}
          >
            View on Morpho ↗
          </a>
        </div>
      </div>
    </div>
  )
}
