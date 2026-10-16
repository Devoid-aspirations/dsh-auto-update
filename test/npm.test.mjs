/**
 * The npm invocation, against a package manager that records what it was asked
 * to do.
 *
 * `installArgs` existed in the configuration and in the plan but never reached
 * the command line, so this case pins the exact argv — including that an
 * operator's extras stay separate arguments and stay in front of the explicit
 * registry, which has to keep winning.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HARNESS_PACKAGE, installGlobal } from '../lib/npm.js'
import { clean, writeFakeNpm } from './support/sandbox.mjs'

/**
 * Read a file, tolerating one that was never written.
 * @param {string} file - the path.
 * @returns {string} the content.
 */
function readOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

test('extra install arguments reach npm as separate argv entries, before the registry', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-npm-'))
  const root = join(base, 'npmroot')
  const capture = join(base, 'install.log')
  const npmLog = join(base, 'npm.log')
  const npm = writeFakeNpm(join(base, 'bin'), root)

  const result = await installGlobal(npm, `${HARNESS_PACKAGE}@0.2.0-rc.2`, {
    registry: 'https://registry.example.test',
    installArgs: ['--foreground-scripts', '--omit=optional'],
    logFile: capture,
    timeoutMs: 60_000,
    env: { ...process.env, FAKE_NPM_ROOT: root, FAKE_NPM_LOG: npmLog },
  })
  assert.equal(result.code, 0, `the fake npm should succeed (log: ${readOrEmpty(capture).slice(-500)})`)

  assert.match(
    readOrEmpty(npmLog),
    /install -g @deepseek-ai\/dsh@0\.2\.0-rc\.2 --no-audit --no-fund --loglevel=error --foreground-scripts --omit=optional --registry=https:\/\/registry\.example\.test/u,
    'the extras ride along as their own arguments, ahead of the registry',
  )
  clean(base)
})

test('an empty extra is dropped instead of becoming an empty argument', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-npm-blank-'))
  const root = join(base, 'npmroot')
  const capture = join(base, 'install.log')
  const npmLog = join(base, 'npm.log')
  const npm = writeFakeNpm(join(base, 'bin'), root)

  const result = await installGlobal(npm, `${HARNESS_PACKAGE}@0.2.0-rc.2`, {
    // The config layer trims and drops blanks; this asserts the last line of
    // defence, so an entry that arrives empty never reaches the command line.
    installArgs: ['', '--ignore-scripts'],
    logFile: capture,
    timeoutMs: 60_000,
    env: { ...process.env, FAKE_NPM_ROOT: root, FAKE_NPM_LOG: npmLog },
  })
  assert.equal(result.code, 0)
  const lines = readOrEmpty(npmLog).trim().split(/\r?\n/u)
  assert.equal(
    lines[0],
    `npm install -g ${HARNESS_PACKAGE}@0.2.0-rc.2 --no-audit --no-fund --loglevel=error --ignore-scripts`,
    'the empty entry contributes nothing and the real one keeps its place',
  )
  assert.equal(lines[1], `installed ${HARNESS_PACKAGE}@0.2.0-rc.2`, 'and the install itself happened')
  clean(base)
})
