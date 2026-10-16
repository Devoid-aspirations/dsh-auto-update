/**
 * Repair the web profile's dependency spec for this plugin.
 *
 * Written as a Node script on purpose: the paths involved contain non-ASCII
 * characters, and every layer that reads them with the wrong encoding (a
 * PowerShell script read as ANSI, or `Start-Process` argument marshalling)
 * turns `其他` into `鍏朵粬` — which is exactly how the installed spec got
 * mangled once already. Node reads and writes UTF-8 by construction.
 *
 * Usage: node scripts/repair-profile.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROFILE_DIR, PLUGIN_DIR, resolvePnpm, toSpecPath } from './_env.mjs'

const PACKAGE = 'dsh-auto-update'

const manifestPath = join(PROFILE_DIR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const spec = `file:${toSpecPath(PLUGIN_DIR)}`
const before = manifest.dependencies?.[PACKAGE] ?? null
manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE]: spec }
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(PACKAGE)) bundles.push(PACKAGE)
manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`spec: ${before ?? '(none)'}\n   -> ${spec}\n`)

process.stdout.write(`pnpm install in ${PROFILE_DIR}\n`)
const pnpmBin = resolvePnpm()
if (pnpmBin === null) {
  process.stdout.write('pnpm not found: set DSH_AUTO_UPDATE_PNPM or install pnpm, then re-run.\n')
  process.exitCode = 1
} else {
  const pnpm = spawnSync(pnpmBin, ['install'], {
    cwd: PROFILE_DIR,
    stdio: 'inherit',
    shell: true,
  })
  process.stdout.write(`pnpm install exit: ${pnpm.status}\n`)
}

const installed = join(PROFILE_DIR, 'node_modules', PACKAGE)
process.stdout.write(`installed dir exists: ${existsSync(installed)}\n`)
if (existsSync(installed)) {
  process.stdout.write(`installed manifest: ${readFileSync(join(installed, 'package.json'), 'utf8').split('\n').slice(0, 4).join(' ')}\n`)
  try {
    process.stdout.write(`realpath: ${realpathSync(installed)}\n`)
  } catch (error) {
    process.stdout.write(`realpath failed: ${String(error?.message ?? error)}\n`)
  }
  process.stdout.write(`helper present: ${existsSync(join(installed, 'lib', 'update-helper.mjs'))}\n`)
}
process.exit(pnpm.status === 0 && existsSync(installed) ? 0 : 1)
