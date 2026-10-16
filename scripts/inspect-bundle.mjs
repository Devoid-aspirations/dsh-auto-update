/**
 * Print the code around every occurrence of a needle in a (usually minified)
 * bundle, so a reference can be read in its own context instead of inferred
 * from a one-line match.
 *
 * Usage: node scripts/inspect-bundle.mjs <file> <needle> [window-chars]
 */

import { readFileSync } from 'node:fs'

const [file, needle, windowArg] = process.argv.slice(2)
if (file === undefined || needle === undefined) {
  process.stderr.write('usage: node scripts/inspect-bundle.mjs <file> <needle> [window]\n')
  process.exit(2)
}
const window = Number(windowArg ?? 700)
const text = readFileSync(file, 'utf8')
let index = text.indexOf(needle)
let found = 0
if (index === -1) {
  process.stdout.write(`no occurrence of ${JSON.stringify(needle)}\n`)
  process.exit(0)
}
while (index !== -1 && found < 4) {
  found += 1
  const from = Math.max(0, index - window)
  const to = Math.min(text.length, index + needle.length + window)
  process.stdout.write(`\n--- occurrence ${found} (offset ${index}) ---\n${text.slice(from, to)}\n`)
  index = text.indexOf(needle, index + needle.length)
}
process.stdout.write(`\n${found} occurrence(s) shown\n`)
