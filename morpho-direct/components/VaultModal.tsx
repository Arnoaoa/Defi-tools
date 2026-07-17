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
import type { YieldPool } from '@/lib/yields'
import { ERC20_ABI, ERC4626_ABI, formatAmount } from '@/lib/morpho'

interface VaultModalProps {
  pool: YieldPool // must be a morpho-vault pool (pool id = `${chainId}-${vaultAddress}`)
  onClose: () => void
}

type Tab = 'deposit' | 'withdraw'
type Action = 'approve' | 'deposit' | 'withdraw'

function safeParseUnits(value: string, decimals: number): bigint {
  if (!value) return 0n
  try {
    const parsed = parseUnits(value, decimals)
    return parsed > 0n ? parsed : 0n
  } catch {
    return 0n
  }
}

export function VaultModal({ pool, onClose }: VaultModalProps) {
  const [tab, setTab] = useState<Tab>('deposit')
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

  const vaultAddress = pool.pool.slice(pool.pool.indexOf('-') + 1) as `0x${string}`
  const assetAddress = pool.underlyingToken as `0x${string}`
  const txChainId = pool.chainId as 1 | 8453
  const needsSwitch = chainId !== pool.chainId
  const symbol = pool.symbol

  // Reads target the vault's chain explicitly — only writes require the switch
  const { data: vaultAsset } = useReadContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: 'asset',
    chainId: txChainId,
  })
  // Same spirit as the market ID check in SupplyModal: never send funds if the
  // vault's declared asset doesn't match what our API said it was
  const assetMatches =
    vaultAsset === undefined || vaultAsset.toLowerCase() === assetAddress.toLowerCase()

  const { data: decimals } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    chainId: txChainId,
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, vaultAddress] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: assetAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: shares, refetch: refetchShares } = useReadContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { data: depositedAssets, refetch: refetchDeposited } = useReadContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: 'convertToAssets',
    args: shares !== undefined ? [shares] : undefined,
    chainId: txChainId,
    query: { enabled: shares !== undefined },
  })

  const { data: maxDeposit } = useReadContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: 'maxDeposit',
    args: address ? [address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  // MetaMorpho's maxWithdraw already accounts for liquidity available in the
  // vault's underlying markets — this is the true instantly-withdrawable amount
  const { data: maxWithdraw, refetch: refetchMaxWithdraw } = useReadContract({
    address: vaultAddress,
    abi: ERC4626_ABI,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    chainId: txChainId,
    query: { enabled: !!address },
  })

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!isSuccess) return
    refetchAllowance()
    refetchBalance()
    refetchShares()
    refetchDeposited()
    refetchMaxWithdraw()
    if (lastAction === 'deposit') setAmount('')
    if (lastAction === 'withdraw') {
      setWithdrawAmount('')
      setWithdrawMax(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, txHash])

  const dec = decimals ?? 18
  const amountBigInt = useMemo(() => safeParseUnits(amount, dec), [amount, dec])
  const withdrawBigInt = useMemo(() => safeParseUnits(withdrawAmount, dec), [withdrawAmount, dec])

  const needsApproval = tab === 'deposit' && amountBigInt > 0n && (allowance ?? 0n) < amountBigInt
  const insufficientBalance = balance !== undefined && amountBigInt > balance
  const overDepositCap = maxDeposit !== undefined && amountBigInt > maxDeposit
  const requestedWithdraw = withdrawMax ? (maxWithdraw ?? 0n) : withdrawBigInt
  const withdrawTooMuch = !withdrawMax && depositedAssets !== undefined && withdrawBigInt > depositedAssets
  const lowLiquidity =
    maxWithdraw !== undefined && requestedWithdraw > maxWithdraw && requestedWithdraw > 0n

  function handleDeposit() {
    if (!address || amountBigInt === 0n || decimals === undefined) return

    if (needsApproval) {
      setLastAction('approve')
      writeContract({
        address: assetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [vaultAddress, amountBigInt],
        chainId: txChainId,
      })
      return
    }

    setLastAction('deposit')
    writeContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: 'deposit',
      args: [amountBigInt, address],
      chainId: txChainId,
    })
  }

  function handleWithdraw() {
    if (!address) return
    setLastAction('withdraw')
    const fullExitPossible =
      shares !== undefined &&
      shares > 0n &&
      depositedAssets !== undefined &&
      maxWithdraw !== undefined &&
      maxWithdraw >= depositedAssets

    if (withdrawMax && fullExitPossible) {
      // Full exit: burn all shares so no dust position remains
      writeContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'redeem',
        args: [shares, address, address],
        chainId: txChainId,
      })
    } else {
      const assets = withdrawMax ? (maxWithdraw ?? 0n) : withdrawBigInt
      if (assets === 0n || withdrawTooMuch) return
      writeContract({
        address: vaultAddress,
        abi: ERC4626_ABI,
        functionName: 'withdraw',
        args: [assets, address, address],
        chainId: txChainId,
      })
    }
  }

  const errorMessage = writeError ? ((writeError as BaseError).shortMessage ?? writeError.message) : null
  const successMessage = isSuccess
    ? lastAction === 'approve'
      ? '✓ Approval confirmed — you can now deposit'
      : lastAction === 'withdraw'
      ? '✓ Withdrawal confirmed'
      : '✓ Deposit confirmed'
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
              {pool.poolMeta ?? 'Morpho Vault'}
              <span style={{ color: 'var(--muted)' }}> · {symbol}</span>
            </h2>
            <div className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
              Net APY: <span style={{ color: '#4ade80' }}>{pool.apy.toFixed(2)}%</span>
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

        {!assetMatches && (
          <div
            className="mb-4 p-3 rounded-lg text-sm"
            style={{ background: '#7f1d1d', color: '#fca5a5', border: '1px solid #ef4444' }}
          >
            ⚠️ Vault asset mismatch — on-chain asset() does not match API data. Aborting for security.
          </div>
        )}

        {pool.listed === false && (
          <div
            className="mb-5 p-3 rounded-lg text-sm"
            style={{ background: '#78350f', color: '#fcd34d' }}
          >
            ⚠️ Vault non curaté par Morpho — vérifie le curateur et les marchés sous-jacents.
            La sortie dépend de la liquidité de ces marchés (voir « Withdrawable now »).
          </div>
        )}

        {address && (
          <div
            className="mb-5 p-3 rounded-lg grid grid-cols-3 gap-3"
            style={{ background: 'var(--background)' }}
          >
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Wallet</div>
              <div className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>
                {balance !== undefined ? formatAmount(balance, dec) : '—'} {symbol}
              </div>
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Deposited</div>
              <div className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>
                {depositedAssets !== undefined ? formatAmount(depositedAssets, dec) : '—'} {symbol}
              </div>
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>Withdrawable now</div>
              <div className="font-medium text-sm" style={{ color: 'var(--foreground)' }}>
                {maxWithdraw !== undefined ? formatAmount(maxWithdraw, dec) : '—'} {symbol}
              </div>
            </div>
          </div>
        )}

        <div className="flex rounded-lg mb-5 p-1" style={{ background: 'var(--background)' }}>
          {(['deposit', 'withdraw'] as Tab[]).map((t) => (
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
            onClick={() => switchChain({ chainId: pool.chainId })}
            className="w-full py-3 rounded-xl font-semibold cursor-pointer"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Switch to {pool.chainId === 8453 ? 'Base' : 'Ethereum'}
          </button>
        ) : tab === 'deposit' ? (
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
                    onClick={() => setAmount(formatUnits(balance, dec))}
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
              {overDepositCap && !insufficientBalance && (
                <p className="text-xs mt-1.5" style={{ color: '#fca5a5' }}>
                  Exceeds vault deposit cap ({maxDeposit !== undefined ? formatAmount(maxDeposit, dec) : '—'} {symbol})
                </p>
              )}
            </div>

            {successMessage && (
              <div className="p-3 rounded-lg text-sm" style={{ background: '#14532d', color: '#86efac' }}>
                {successMessage}
              </div>
            )}

            {errorMessage && !isPending && (
              <div className="p-3 rounded-lg text-sm break-words" style={{ background: '#7f1d1d', color: '#fca5a5' }}>
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleDeposit}
              disabled={
                !assetMatches ||
                amountBigInt === 0n ||
                insufficientBalance ||
                overDepositCap ||
                decimals === undefined ||
                isPending ||
                isConfirming
              }
              className="w-full py-3 rounded-xl font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                ? 'Confirming…'
                : needsApproval
                ? `Approve ${symbol}`
                : 'Deposit'}
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
                {maxWithdraw !== undefined && maxWithdraw > 0n && (
                  <button
                    onClick={() => {
                      setWithdrawAmount(formatUnits(maxWithdraw, dec))
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
                  Exceeds your deposited balance
                </p>
              )}
            </div>

            {lowLiquidity && (
              <div className="p-3 rounded-lg text-sm" style={{ background: '#78350f', color: '#fcd34d' }}>
                ⚠️ Requested amount exceeds what the vault can withdraw right now
                (limited by underlying market liquidity) — the transaction will revert.
              </div>
            )}

            {successMessage && (
              <div className="p-3 rounded-lg text-sm" style={{ background: '#14532d', color: '#86efac' }}>
                {successMessage}
              </div>
            )}

            {errorMessage && !isPending && (
              <div className="p-3 rounded-lg text-sm break-words" style={{ background: '#7f1d1d', color: '#fca5a5' }}>
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleWithdraw}
              disabled={
                !assetMatches ||
                isPending ||
                isConfirming ||
                (withdrawMax
                  ? (maxWithdraw ?? 0n) === 0n
                  : withdrawBigInt === 0n || withdrawTooMuch)
              }
              className="w-full py-3 rounded-xl font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                ? 'Confirming…'
                : withdrawMax
                ? 'Withdraw Max'
                : 'Withdraw'}
            </button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
          <span>
            Vault: <span className="font-mono">{vaultAddress.slice(0, 10)}…</span>
          </span>
          <span>·</span>
          <a
            href={pool.url}
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
