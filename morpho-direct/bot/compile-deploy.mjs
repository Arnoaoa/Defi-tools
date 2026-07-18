// Compiles YnethxExitProxy.sol with solc-js and deploys it from the bot wallet.
// Run with: NODE_OPTIONS=--use-system-ca node bot/compile-deploy.mjs
// Pass --dry to compile + run sanity checks without deploying.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import solc from 'solc'
import { createPublicClient, createWalletClient, http, formatEther, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

const botDir = dirname(fileURLToPath(import.meta.url))
const envPath = join(botDir, '.env.bot')

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const OWNER = getAddress('0x869A05FE6568b39b6202f6378f463e48bA2880B3')
const MARKET_ID = '0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75'
const WETH = getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
const RPC = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'

function loadEnv() {
  const env = {}
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

function compile() {
  const source = readFileSync(join(botDir, 'YnethxExitProxy.sol'), 'utf8')
  const input = {
    language: 'Solidity',
    sources: { 'YnethxExitProxy.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage)
    process.exit(1)
  }
  const contract = output.contracts['YnethxExitProxy.sol'].YnethxExitProxy
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }
}

const morphoAbi = [
  {
    name: 'idToMarketParams', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' }, { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
    ],
  },
  {
    name: 'position', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }],
  },
]

const run = async () => {
  const { abi, bytecode } = compile()
  console.log(`Compilé ✓ (bytecode ${(bytecode.length - 2) / 2} bytes)`)

  const client = createPublicClient({ chain: mainnet, transport: http(RPC) })

  // Sanity checks before spending gas — never trust hardcoded values blindly
  const [params, pos] = await Promise.all([
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'idToMarketParams', args: [MARKET_ID] }),
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_ID, OWNER] }),
  ])
  if (getAddress(params[0]) !== WETH) throw new Error(`loanToken inattendu: ${params[0]}`)
  if (pos[0] === 0n) throw new Error('OWNER n’a aucune position supply sur ce marché')
  console.log(`Sanity ✓ — marché WETH/ynETHx, position OWNER: ${pos[0]} shares`)

  if (process.argv.includes('--dry')) {
    console.log('--dry : pas de déploiement.')
    return
  }

  const env = loadEnv()
  if (!env.BOT_PRIVATE_KEY) throw new Error('BOT_PRIVATE_KEY manquant dans bot/.env.bot')
  const account = privateKeyToAccount(env.BOT_PRIVATE_KEY)
  const balance = await client.getBalance({ address: account.address })
  console.log(`Wallet bot ${account.address} — solde ${formatEther(balance)} ETH`)
  if (balance === 0n) throw new Error('Wallet bot non financé')

  const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) })
  const hash = await wallet.deployContract({ abi, bytecode })
  console.log(`Déploiement envoyé: ${hash}`)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Déploiement échoué')
  console.log(`\nProxy déployé : ${receipt.contractAddress}`)

  const updated = readFileSync(envPath, 'utf8').replace(/^PROXY_ADDRESS=.*$/m, `PROXY_ADDRESS=${receipt.contractAddress}`)
  writeFileSync(envPath, updated)
  console.log('bot/.env.bot mis à jour avec PROXY_ADDRESS.')
  console.log(`\nÉtape suivante (wallet principal, via Etherscan sur ${MORPHO}) :`)
  console.log(`setAuthorization(${receipt.contractAddress}, true)`)
}

run().catch((e) => { console.error('ERREUR:', e.message); process.exit(1) })
