/**
 * The test runner.
 *
 * `node --test` starts each file as a child with PIPED stdio, which a harness
 * process running under a confinement layer is not allowed to create (the
 * spawn fails with EPERM before a single assertion runs). This runner starts
 * each file with `stdio: 'inherit'` instead, so the suite runs both in a plain
 * terminal and inside a restricted DSH session.
 *
 * Usage: `node test/run.mjs [name-filter]`
 * @module dsh-auto-update/test-runner
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2] ?? ''
const files = readdirSync(here)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .filter((entry) => filter === '' || entry.includes(filter))
  .sort()

if (files.length === 0) {
  process.stderr.write(`no test files matched ${JSON.stringify(filter)}\n`)
  process.exit(1)
}

let failed = 0
for (const file of files) {
  process.stdout.write(`\n── ${file} ─────────────────────────────────────────\n`)
  const code = await new Promise((settle) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit', windowsHide: true })
    child.on('error', (error) => {
      process.stderr.write(`could not start ${file}: ${String(error?.message ?? error)}\n`)
      settle(1)
    })
    child.on('close', (exit) => settle(exit ?? 1))
  })
  if (code !== 0) failed += 1
}

process.stdout.write(`\n${files.length - failed}/${files.length} test files passed\n`)
process.exit(failed === 0 ? 0 : 1)
