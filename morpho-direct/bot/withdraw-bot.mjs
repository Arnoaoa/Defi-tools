// Per-block ynETHx exit bot: watches available liquidity on the frozen market
// and triggers the locked exit proxy the moment anything is withdrawable.
// The proxy hardcodes market + owner + receiver, so this key is only a gas payer.
// Run with: NODE_OPTIONS=--use-system-ca node bot/withdraw-bot.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPublicClient, createWalletClient, http, webSocket, formatEther, parseEther, parseGwei, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

const botDir = dirname(fileURLToPath(import.meta.url))

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const OWNER = getAddress('0x869A05FE6568b39b6202f6378f463e48bA2880B3')
const MARKET_ID = '0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75'
const RPC_HTTP = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'
const RPC_WSS = process.env.ETH_RPC_WSS || 'wss://ethereum-rpc.publicnode.com'

function loadEnv(path) {
  const env = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  } catch {}
  return env
}

const botEnv = loadEnv(join(botDir, '.env.bot'))
const appEnv = loadEnv(join(botDir, '..', '.env.local'))

if (!botEnv.BOT_PRIVATE_KEY || !botEnv.PROXY_ADDRESS) {
  console.error('bot/.env.bot incomplet (BOT_PRIVATE_KEY / PROXY_ADDRESS) — lance generate-wallet puis compile-deploy.')
  process.exit(1)
}

const PROXY = getAddress(botEnv.PROXY_ADDRESS)
const MIN_ASSETS = parseEther(botEnv.MIN_WETH || '0.005')
const PRIORITY = parseGwei(botEnv.PRIORITY_GWEI || '1')
const account = privateKeyToAccount(botEnv.BOT_PRIVATE_KEY)

const morphoAbi = [
  {
    name: 'market', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' }, { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' }, { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' }, { name: 'fee', type: 'uint128' },
    ],
  },
  {
    name: 'position', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }],
  },
]

const proxyAbi = [
  { name: 'withdrawMax', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
]

const reader = createPublicClient({ chain: mainnet, transport: http(RPC_HTTP) })
const watcher = createPublicClient({ chain: mainnet, transport: webSocket(RPC_WSS) })
const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC_HTTP) })

async function telegram(text) {
  if (!appEnv.TELEGRAM_BOT_TOKEN || !appEnv.TELEGRAM_CHAT_ID) return
  await fetch(`https://api.telegram.org/bot${appEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: appEnv.TELEGRAM_CHAT_ID, text }),
  }).catch(() => {})
}

let inFlight = false
let lastLogged = ''

async function onBlock(blockNumber) {
  if (inFlight) return
  try {
    const [market, position] = await Promise.all([
      reader.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'market', args: [MARKET_ID] }),
      reader.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_ID, OWNER] }),
    ])
    const liquidity = market[0] - market[2]
    const myShares = position[0]

    if (myShares === 0n) {
      console.log(`[${blockNumber}] Position vidée — mission accomplie, arrêt du bot.`)
      await telegram('🏁 Bot ynETHx : position entièrement retirée, le bot s’arrête.')
      process.exit(0)
    }

    const line = `liq ${formatEther(liquidity)} WETH`
    if (line !== lastLogged) {
      console.log(`[${blockNumber}] ${line}`)
      lastLogged = line
    }
    if (liquidity < MIN_ASSETS) return

    inFlight = true
    console.log(`[${blockNumber}] Liquidité ${formatEther(liquidity)} WETH ≥ seuil — tentative de retrait…`)

    const { request } = await reader.simulateContract({
      address: PROXY, abi: proxyAbi, functionName: 'withdrawMax', account,
    })
    const hash = await wallet.writeContract({ ...request, maxPriorityFeePerGas: PRIORITY })
    console.log(`  tx: ${hash}`)
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 })

    if (receipt.status === 'success') {
      console.log('  ✓ retrait confirmé')
      await telegram(`✅ Bot ynETHx : retrait exécuté (bloc ${receipt.blockNumber}). Liquidité visée : ${formatEther(liquidity)} WETH. Tx: https://etherscan.io/tx/${hash}`)
    } else {
      console.log('  ✗ tx revert (probablement doublé par un concurrent)')
    }
  } catch (err) {
    // Simulation revert = someone drained it between blocks — normal, keep going
    const msg = err.shortMessage ?? err.message
    if (!msg.includes('NothingToWithdraw')) console.log(`  erreur: ${msg}`)
  } finally {
    inFlight = false
  }
}

console.log(`Bot ynETHx démarré — proxy ${PROXY}, payeur ${account.address}`)
console.log(`Seuil: ${formatEther(MIN_ASSETS)} WETH · priority fee: ${botEnv.PRIORITY_GWEI || '1'} gwei`)
reader.getBalance({ address: account.address }).then((b) => console.log(`Solde gas: ${formatEther(b)} ETH`))

watcher.watchBlockNumber({
  onBlockNumber: onBlock,
  onError: (e) => console.log(`watcher error: ${e.message}`),
})
