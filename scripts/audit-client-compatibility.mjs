/**
 * Audit the profile's client plugins against the harness that is ACTUALLY
 * installed right now.
 *
 * The compatibility gate looks forward (what will the target release remove?).
 * This looks at the present: for every installed client plugin, which
 * `@deepseek-ai/*` packages does its bundle hard-require, and does the running
 * harness still ship them? A plugin whose bundle requires a package that is not
 * there cannot load — that is precisely the "缺少模块表 / Failed to load
 * plugins" failure, and it does not need another upgrade to be worth knowing.
 *
 * Unlike a version comparison this needs no history: it reads the installed
 * harness's own package list and the installed bundles, so it is also the right
 * check to run immediately AFTER an upgrade to see what the upgrade broke.
 *
 * Usage: node scripts/audit-client-compatibility.mjs [profile] [harness-dir]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { clientBundleOf, runningPackageSet } from '../lib/compat.js'
import { DSH_HOME, PROFILE_NAME, resolveHarnessDir } from './_env.mjs'

const profileName = process.argv[2] ?? PROFILE_NAME
const harnessDir = process.argv[3] ?? resolveHarnessDir()
const profileDir = join(DSH_HOME, 'profiles', profileName)
const modulesDir = join(profileDir, 'node_modules')

/** Every `@deepseek-ai/<name>` a bundle names, split by how it names it. */
function referencedPackages(text) {
  const hard = new Set()
  const assembled = new Set()
  for (const match of text.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/gu)) {
    hard.add(match[1].slice('@deepseek-ai/'.length).split('/')[0])
  }
  for (const match of text.matchAll(/["'](@deepseek-ai\/[^"']+)["']/gu)) {
    const name = match[1].slice('@deepseek-ai/'.length).split('/')[0]
    if (!hard.has(name)) assembled.add(name)
  }
  return { hard, assembled }
}

const shipped = runningPackageSet(harnessDir)
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const names = Object.keys(manifest.dependencies ?? {})

process.stdout.write(`profile   : ${profileDir}\n`)
process.stdout.write(`harness   : ${harnessDir}\n`)
process.stdout.write(`shipped   : ${shipped.size} @deepseek-ai/* packages\n\n`)

const rows = []
for (const name of names) {
  const dir = join(modulesDir, ...name.split('/'))
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    rows.push({ name, version: null, state: 'NOT INSTALLED' })
    continue
  }
  if (pkg.dsh?.client === undefined) {
    rows.push({ name, version: pkg.version, state: 'server-only' })
    continue
  }
  const injects = (Array.isArray(pkg.dsh.client.inject) ? pkg.dsh.client.inject : [])
    .filter((entry) => typeof entry === 'string' && entry.startsWith('@deepseek-ai/'))
    .map((entry) => entry.slice('@deepseek-ai/'.length).split('/')[0])
  const bundle = clientBundleOf(dir, pkg)
  let hard = new Set()
  let assembled = new Set()
  if (bundle !== null) {
    try {
      const text = readFileSync(bundle, 'utf8')
      const found = referencedPackages(text)
      hard = found.hard
      assembled = found.assembled
    } catch {
      /* unreadable bundle: reported as no references, with the path noted below */
    }
  }
  const missingHard = [...hard].filter((entry) => !shipped.has(entry)).sort()
  const missingInjects = [...new Set(injects)].filter((entry) => !shipped.has(entry)).sort()
  rows.push({
    name,
    version: pkg.version,
    bundle: bundle === null ? '(no bundle found)' : bundle.slice(dir.length + 1),
    state: missingHard.length > 0 ? 'WILL FAIL' : missingInjects.length > 0 ? 'degraded?' : bundle === null ? 'unverified' : 'ok',
    missingHard,
    missingInjects,
    hardCount: hard.size,
    fallbacks: [...assembled].filter((entry) => !shipped.has(entry)).sort(),
  })
}

for (const row of rows) {
  if (row.state === 'server-only' || row.state === 'NOT INSTALLED') {
    process.stdout.write(`${String(row.state).padEnd(10)} ${row.name}${row.version === null ? '' : `@${row.version}`}\n`)
    continue
  }
  process.stdout.write(`${String(row.state).padEnd(10)} ${row.name}@${row.version}  [${row.bundle}]\n`)
  if (row.missingHard.length > 0) {
    process.stdout.write(`           hard-requires packages the harness does NOT ship: ${row.missingHard.join(', ')}\n`)
  }
  if (row.missingInjects.length > 0) {
    process.stdout.write(`           injects packages the harness does NOT ship:    ${row.missingInjects.join(', ')}\n`)
  }
  if (row.fallbacks.length > 0) {
    process.stdout.write(`           probes (fallback, harmless):                   ${row.fallbacks.join(', ')}\n`)
  }
}

const failing = rows.filter((row) => row.state === 'WILL FAIL')
const degraded = rows.filter((row) => row.state === 'degraded?')
process.stdout.write(`\n${rows.length} dependencies checked: ${failing.length} will fail, ${degraded.length} possibly degraded\n`)
process.exit(failing.length === 0 ? 0 : 1)
