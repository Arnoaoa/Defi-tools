// Merges data/risk-analyses/*.json fragments into data/risk-index.json
// keyed by `${chainId}-${collateralAddressLowercase}` for direct lookup in the app.
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fragmentsDir = join(root, 'data', 'risk-analyses')
const outFile = join(root, 'data', 'risk-index.json')

// Isolated weakness ("+") vs pervasive weakness ("-"): count components sitting
// at the global (worst) grade. Not computed for grade A (nothing above it).
function gradeModifier(grade, components) {
  if (grade === 'A' || !components) return null
  const atWorst = Object.values(components).filter((g) => g === grade).length
  if (atWorst === 1) return '+'
  if (atWorst >= 4) return '-'
  return null
}

const index = {}
const files = readdirSync(fragmentsDir).filter((f) => f.endsWith('.json'))

for (const file of files) {
  const analysis = JSON.parse(readFileSync(join(fragmentsDir, file), 'utf8'))
  for (const [chainId, address] of Object.entries(analysis.addresses ?? {})) {
    index[`${chainId}-${address.toLowerCase()}`] = {
      symbol: analysis.symbol,
      grade: analysis.grade,
      gradeModifier: gradeModifier(analysis.grade, analysis.components),
      components: analysis.components,
      redFlags: analysis.redFlags ?? [],
      maxAllocation: analysis.maxAllocation,
      summary: analysis.summary,
      incidents: analysis.incidents ?? [],
      controversies: analysis.controversies ?? [],
      dependencies: analysis.dependencies ?? null,
      exitLiquidity: analysis.exitLiquidity ?? null,
      analyzedAt: analysis.analyzedAt,
      vaultNote: analysis.vaultNote,
    }
  }
}

writeFileSync(outFile, JSON.stringify(index, null, 2))
console.log(`risk-index.json: ${files.length} analyses, ${Object.keys(index).length} entries`)
