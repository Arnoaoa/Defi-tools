// Simulates YnethxLiquidateExit.execute() against live chain state with
// eth_call overrides (contract code + Morpho authorization), WITHOUT deploying
// or signing anything. Bisects minOut to report exactly how much WETH the
// owner would receive if the transaction ran right now.
// Run with: NODE_OPTIONS=--use-system-ca node bot/simulate-liquidate.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import solc from 'solc'
import { createPublicClient, http, keccak256, encodeAbiParameters, encodeFunctionData, formatEther, parseEther, toHex } from 'viem'
import { mainnet } from 'viem/chains'

const botDir = dirname(fileURLToPath(import.meta.url))

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'
const OWNER = '0x869A05FE6568b39b6202f6378f463e48bA2880B3'
const FAKE = '0x2222222222222222222222222222222222222222'
const BORROWER = process.argv[2] ?? '0x646aa9Db3EB25bcf03ECCD98a589E50f5af2230F'
// isAuthorized mapping lives at storage slot 6 of Morpho Blue (empirically
// proven by the exit-proxy simulation)
const AUTH_MAPPING_SLOT = 6n

const source = readFileSync(join(botDir, 'YnethxLiquidateExit.sol'), 'utf8')
const input = {
  language: 'Solidity',
  sources: { 'c.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage)
  process.exit(1)
}
const contract = out.contracts['c.sol'].YnethxLiquidateExit
const runtime = '0x' + contract.evm.deployedBytecode.object
console.log(`Compilé ✓ (${(runtime.length - 2) / 2} bytes) — emprunteur cible: ${BORROWER}`)

const client = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com') })
const h1 = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [OWNER, AUTH_MAPPING_SLOT]))
const authSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [FAKE, h1]))
const overrides = { [FAKE]: { code: runtime }, [MORPHO]: { stateDiff: { [authSlot]: toHex(1n, { size: 32 }) } } }

async function simulate(minOut) {
  try {
    await client.request({
      method: 'eth_call',
      params: [
        { to: FAKE, data: encodeFunctionData({ abi: contract.abi, functionName: 'execute', args: [BORROWER, minOut] }) },
        'latest',
        overrides,
      ],
    })
    return true
  } catch {
    return false
  }
}

if (!(await simulate(0n))) {
  console.log('✗ La simulation revert même au plancher (0,58 WETH) — conditions actuelles insuffisantes, rien à faire.')
  process.exit(1)
}

// Bisect the highest passing minOut = exact amount OWNER would receive
let lo = parseEther('0.58')
let hi = parseEther('0.75')
while (hi - lo > parseEther('0.0002')) {
  const mid = (lo + hi) / 2n
  ;(await simulate(mid)) ? (lo = mid) : (hi = mid)
}
console.log(`✓ Exécution valide MAINTENANT — tu recevrais entre ${formatEther(lo)} et ${formatEther(hi)} WETH au total (position entière retirée).`)
