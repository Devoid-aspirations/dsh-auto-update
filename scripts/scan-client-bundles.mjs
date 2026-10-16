/**
 * Scan the web profile's client bundles for references to packages the
 * running harness no longer ships.
 *
 * The 0.1.x → 0.2.0 harness release dropped and split several client-side
 * packages. A plugin whose client bundle was built against the old ones keeps
 * a bare `require("@deepseek-ai/dsh-client-runtime/client")` in its bundle,
 * and the new host has no module-table factory for that specifier — which is
 * the "缺少模块表 / 构建时外部依赖项漂移" failure. This finds every such
 * reference still present in what is installed.
 *
 * Usage: node scripts/scan-client-bundles.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PROFILE_MODULES, resolveHarnessScope } from './_env.mjs'

const MODULES = PROFILE_MODULES
const HARNESS = resolveHarnessScope()

/** Packages the harness no longer ships (confirmed against the installed list). */
const REMOVED = [
  'dsh-client-runtime',
  'dsh-client-web-react',
  'dsh-client-schema-form',
  'dsh-client-web',
  'dsh-code-runtime',
  'dsh-host-apiproxy',
  'dsh-settings-file',
  'dsh-agent-presets',
  'dsh-tool-subagent-report',
  'dsh-workflow-worker-thread',
]
const PATTERN = new RegExp(`@deepseek-ai/(${REMOVED.join('|')})(?![\\w-])`, 'g')

/** Packages the running harness DOES ship, read from its own directory. */
const shipped = new Set(readdirSync(HARNESS))

/** Every package directory installed in the profile (one level of scoping). */
function packageDirs() {
  const out = []
  for (const entry of readdirSync(MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('@')) {
      const scope = join(MODULES, entry.name)
      for (const inner of readdirSync(scope, { withFileTypes: true })) {
        if (inner.isDirectory() || inner.isSymbolicLink()) out.push(join(scope, inner.name))
      }
      continue
    }
    out.push(join(MODULES, entry.name))
  }
  return out
}

/** Read a package's manifest, or null. */
function manifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Client-ish JS files a package ships, bounded in size. */
function clientFiles(dir) {
  const out = []
  const walk = (current, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      try {
        const size = statSync(full).size
        if (size > 12 * 1024 * 1024) continue
        out.push(full)
      } catch {
        /* unreadable file contributes nothing */
      }
    }
  }
  walk(dir, 0)
  return out
}

let offenders = 0
let scanned = 0
for (const dir of packageDirs()) {
  const pkg = manifest(dir)
  if (pkg === null) continue
  // Only packages with a client surface can hit this failure at all.
  if (pkg.dsh?.client === undefined) continue
  const hits = []
  for (const file of clientFiles(dir)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanned += 1
    for (const match of text.matchAll(PATTERN)) {
      const name = match[1]
      hits.push({
        file: file.slice(dir.length + 1),
        spec: `@deepseek-ai/${name}`,
        stillShipped: shipped.has(`dsh-${name.replace(/^dsh-/, '')}`) || shipped.has(name),
        context: text.slice(Math.max(0, match.index - 90), match.index + 90).replace(/\s+/gu, ' '),
      })
    }
  }
  if (hits.length === 0) continue
  offenders += 1
  process.stdout.write(`\n### ${pkg.name}@${pkg.version}\n`)
  for (const hit of hits.slice(0, 6)) {
    process.stdout.write(`  ${hit.spec}  in ${hit.file}  (still shipped by 0.2.0: ${hit.stillShipped})\n`)
    process.stdout.write(`      …${hit.context}…\n`)
  }
  if (hits.length > 6) process.stdout.write(`  …and ${hits.length - 6} more references\n`)
}

process.stdout.write(`\nscanned ${scanned} client files; ${offenders} package(s) reference removed packages\n`)
