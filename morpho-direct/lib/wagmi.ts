import { createConfig, http } from 'wagmi'
import { mainnet, base } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const wagmiConfig = createConfig({
  chains: [mainnet, base],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(process.env.NEXT_PUBLIC_ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'),
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base-rpc.publicnode.com'),
  },
  ssr: true,
})
