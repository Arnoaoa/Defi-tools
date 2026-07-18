// Deploys YnethxLiquidateExit from the bot wallet, with pre-flight checks:
// working tree must match the committed (audited) source, and the owner must
// still have a supply position on the market.
// Run with: NODE_OPTIONS=--use-system-ca node bot/deploy-liquidate.mjs
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import solc from 'solc'
import { createPublicClient, createWalletClient, http, formatEther, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

const botDir = dirname(fileURLToPath(import.meta.url))
const envPath = join(botDir, '.env.bot')
const sourceFile = 'YnethxLiquidateExit.sol'

const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const OWNER = getAddress('0x869A05FE6568b39b6202f6378f463e48bA2880B3')
const MARKET_ID = '0xf0edbb36183591ff28c56fdb283fdd6896cf1298990e5913208902adb87d2b75'
const RPC = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'

// Pre-flight: the file being deployed must be exactly the audited/committed one
try {
  execSync(`git diff --quiet HEAD -- bot/${sourceFile}`, { cwd: join(botDir, '..') })
} catch {
  console.error(`ABANDON : bot/${sourceFile} diffère de la version committée — re-audit requis.`)
  process.exit(1)
}
console.log('Pre-flight ✓ source identique à la version committée/auditée')

const source = readFileSync(join(botDir, sourceFile), 'utf8')
const input = {
  language: 'Solidity',
  sources: { [sourceFile]: { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}
const contract = out.contracts[sourceFile].YnethxLiquidateExit
const bytecode = `0x${contract.evm.bytecode.object}`
console.log(`Compilé ✓ (${(bytecode.length - 2) / 2} bytes)`)

const client = createPublicClient({ chain: mainnet, transport: http(RPC) })

const morphoAbi = [
  {
    name: 'position', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }],
  },
]
const pos = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_ID, OWNER] })
if (pos[0] === 0n) {
  console.error('ABANDON : OWNER n’a plus de position supply sur ce marché.')
  process.exit(1)
}
console.log(`Sanity ✓ position OWNER: ${pos[0]} shares`)

const env = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
}
if (!env.BOT_PRIVATE_KEY) throw new Error('BOT_PRIVATE_KEY manquant dans bot/.env.bot')
const account = privateKeyToAccount(env.BOT_PRIVATE_KEY)
const balance = await client.getBalance({ address: account.address })
console.log(`Wallet bot ${account.address} — solde ${formatEther(balance)} ETH`)
if (balance === 0n) throw new Error('Wallet bot non financé')

const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) })
const hash = await wallet.deployContract({ abi: contract.abi, bytecode })
console.log(`Déploiement envoyé: ${hash}`)
const receipt = await client.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Déploiement échoué')
console.log(`\nContrat déployé : ${receipt.contractAddress}`)
console.log(`Gas utilisé : ${receipt.gasUsed}`)

const updated = readFileSync(envPath, 'utf8')
writeFileSync(envPath, updated.replace(/\n?$/, `\nLIQUIDATE_EXIT_ADDRESS=${receipt.contractAddress}\n`))
console.log('bot/.env.bot mis à jour (LIQUIDATE_EXIT_ADDRESS).')
console.log(`\nÉtape suivante — wallet PRINCIPAL, via Etherscan sur le contrat Morpho ${MORPHO} :`)
console.log(`setAuthorization(${receipt.contractAddress}, true)`)
