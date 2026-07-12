'use client'

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi'
import { mainnet, base } from 'wagmi/chains'

const CHAIN_LABELS: Record<number, string> = {
  [mainnet.id]: 'Ethereum',
  [base.id]: 'Base',
}

export function Header() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()

  const chainLabel = CHAIN_LABELS[chainId] ?? `Chain ${chainId}`
  const shortAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''

  return (
    <header
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}
      className="px-6 py-4 flex items-center justify-between"
    >
      <div className="flex items-center gap-3">
        <div
          style={{ background: 'var(--accent)' }}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-sm font-bold"
        >
          M
        </div>
        <span className="font-semibold text-lg" style={{ color: 'var(--foreground)' }}>
          Morpho Direct
        </span>
      </div>

      {isConnected ? (
        <div className="flex items-center gap-3">
          <span
            className="text-xs px-2.5 py-1 rounded-full"
            style={{ background: 'var(--border)', color: 'var(--muted)' }}
          >
            {chainLabel}
          </span>
          <button
            onClick={() => disconnect()}
            className="text-sm px-4 py-2 rounded-lg cursor-pointer transition-opacity hover:opacity-80"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
            }}
          >
            {shortAddress}
          </button>
        </div>
      ) : (
        <button
          onClick={() => connect({ connector: connectors[0] })}
          className="text-sm px-4 py-2 rounded-lg font-medium cursor-pointer"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Connect Wallet
        </button>
      )}
    </header>
  )
}
