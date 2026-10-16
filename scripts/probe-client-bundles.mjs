/**
 * Ask the RUNNING harness what it serves for every client plugin's bundle.
 *
 * The two failures the user saw are both client-side: the browser loads
 * `/plugins/<pkg>/client.js` and that script either fails to load or dies
 * resolving a bare specifier the host's module table no longer provides.
 * Without a browser, the closest honest check is the transport itself: does
 * the host serve each bundle, and does the served text still hard-require a
 * package the running harness does not ship?
 *
 * Usage: node scripts/probe-client-bundles.mjs [port] [--file]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PROFILE_DIR } from './_env.mjs'

const PORT = Number(process.argv[2]) || 3080
const FROM_DISK = process.argv.includes('--file')
const PROFILE = PROFILE_DIR
const MODULES = join(PROFILE, 'node_modules')

/** Packages the running 0.2.0 harness does not ship. */
const REMOVED = ['dsh-client-runtime', 'dsh-client-web-react', 'dsh-client-schema-form', 'dsh-client-web']

/** Read the profile's installed client plugins. */
function clientPlugins() {
  const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  const names = Object.keys(manifest.dependencies ?? {})
  const out = []
  for (const name of names) {
    const dir = join(MODULES, ...name.split('/'))
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      out.push({ name, dir: null, version: null, client: null })
      continue
    }
    out.push({ name, dir, version: pkg.version, client: pkg.dsh?.client ?? null })
  }
  return out
}

/**
 * Classify how a bundle refers to a removed package.
 *
 * A specifier assembled from fragments and wrapped in try/catch is a
 * deliberate compatibility fallback (the 0.4.x family builds the new AND the
 * legacy seed name that way, preferring the new one). A literal specifier in
 * a require() call is a hard dependency that will throw on this harness.
 */
function classify(text, name) {
  const literal = new RegExp(`require\\(\\s*"@deepseek-ai/${name}[^"]*"\\s*\\)`, 'u')
  const assembled = new RegExp(`"@deepseek-ai/${name}"`, 'u')
  if (literal.test(text)) return 'HARD'
  if (assembled.test(text)) return 'fallback'
  return null
}

/** Probe one bundle over HTTP. */
async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const body = response.ok ? await response.text() : ''
    return { status: response.status, size: body.length, body, type: response.headers.get('content-type') }
  } catch (error) {
    return { status: null, size: 0, body: '', type: null, error: String(error?.message ?? error) }
  }
}

const rows = []
for (const plugin of clientPlugins()) {
  if (plugin.client === null) {
    rows.push({ ...plugin, note: 'not a client plugin' })
    continue
  }
  const encoded = plugin.name.split('/').map(encodeURIComponent).join('/')
  const url = `http://127.0.0.1:${PORT}/plugins/${encoded}/client.js`
  const result = await probe(url)
  const text = FROM_DISK && plugin.dir !== null ? readFileSync(join(plugin.dir, 'lib', 'client.js'), 'utf8') : result.body
  const verdicts = REMOVED.map((name) => ({ name, kind: classify(text, name) })).filter((entry) => entry.kind !== null)
  rows.push({ ...plugin, ...result, verdicts })
}

for (const row of rows) {
  const label = `${row.name}@${row.version ?? '?'}`
  if (row.note !== undefined) {
    process.stdout.write(`${label.padEnd(48)} client: none\n`)
    continue
  }
  const status = row.status === null ? `ERROR ${row.error ?? ''}` : `HTTP ${row.status}`
  const legacy = row.verdicts.map((entry) => `${entry.name}:${entry.kind}`).join(' ') || 'clean of removed packages'
  process.stdout.write(`${label.padEnd(48)} ${status.padEnd(12)} ${String(row.size).padStart(8)}B  ${legacy}\n`)
}
