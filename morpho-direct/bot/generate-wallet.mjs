// Generates the bot's dedicated wallet and writes bot/.env.bot (gitignored).
// The private key never leaves this machine and is only ever a gas payer:
// the exit proxy contract is the one authorized on Morpho, not this key.
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env.bot')

if (existsSync(envPath)) {
  console.error('bot/.env.bot existe déjà — suppression manuelle requise pour régénérer (sécurité).')
  process.exit(1)
}

const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)

writeFileSync(
  envPath,
  [
    `BOT_PRIVATE_KEY=${privateKey}`,
    'PROXY_ADDRESS=', // filled by compile-deploy.mjs
    'PRIORITY_GWEI=1',
    'MIN_WETH=0.005',
    '',
  ].join('\n'),
  { encoding: 'utf8' }
)

console.log('Wallet bot généré. Adresse à financer en ETH (mainnet) :')
console.log(account.address)
console.log('\nClé privée écrite dans bot/.env.bot (jamais commitée). ~0.02 ETH suffisent.')
