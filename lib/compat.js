/**
 * The pre-flight compatibility gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The harness release channel is not the only thing that moves. `0.2.0`
 * renamed and split the client-side runtime packages, so a plugin whose
 * browser bundle was built against `@deepseek-ai/dsh-client-runtime/client`
 * stopped loading the moment the harness crossed that line: the new host's
 * client module table has no factory for a package that no longer exists, and
 * the failure surfaces in the browser as "插件加载失败 / 缺少模块表". An
 * unattended updater that crosses such a line on its own turns a working GUI
 * into a broken one at 3am.
 *
 * So before applying anything, this compares the package set the TARGET
 * harness will ship against the set the RUNNING one has, and then asks the
 * profile's own client plugins whether they depend on anything that is about
 * to disappear. Two dependency vectors are checked, because they fail
 * differently:
 *
 *   - a literal `require("@deepseek-ai/<removed>")` in the shipped bundle is a
 *     hard dependency: the bundle will not load at all;
 *   - a `dsh.client.inject` entry naming a removed package is a declared
 *     dependency on a service the host will no longer provide: the plugin may
 *     load degraded or not at all.
 *
 * A specifier ASSEMBLED from fragments (`["@deepseek-ai/dsh-client",
 * "-store"].join("")`) is the compatibility fallback newer builds use, so it
 * is reported as informational and never blocks.
 * @module dsh-auto-update/compat
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Where a client bundle may live when a package declares no `./client` export. */
const CLIENT_ENTRY_CANDIDATES = [
  'lib/client.js',
  'client/client.js',
  'client.js',
  'dist/client.js',
  'index.client.js',
]

/** File-size ceiling for scanning a bundle (minified bundles are large but bounded). */
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024

/**
 * The `@deepseek-ai/*` package names a directory of installed packages holds.
 * @param {string} dir - a `node_modules/@deepseek-ai` directory.
 * @returns {Set<string>} the package names found.
 */
export function packageNamesIn(dir) {
  const names = new Set()
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name)
    }
  } catch {
    /* an unreadable directory contributes nothing */
  }
  return names
}

/**
 * The `@deepseek-ai/*` packages the running harness ships.
 * @param {string | null} harnessDir - the harness package directory.
 * @returns {Set<string>} the names, empty when it cannot be read.
 */
export function runningPackageSet(harnessDir) {
  if (typeof harnessDir !== 'string' || harnessDir === '') return new Set()
  return packageNamesIn(join(harnessDir, 'node_modules', '@deepseek-ai'))
}

/**
 * The `@deepseek-ai/*` packages a target version's manifest says it needs.
 * @param {Record<string, string> | undefined} dependencies - the version's dependency map.
 * @returns {Set<string>} the names.
 */
export function targetPackageSet(dependencies) {
  const names = new Set()
  if (dependencies === null || typeof dependencies !== 'object') return names
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@deepseek-ai/')) names.add(name.slice('@deepseek-ai/'.length))
  }
  return names
}

/**
 * Packages the running harness has and the target does not.
 *
 * Only names matter: a package that is still present under a different version
 * keeps its specifier resolvable, which is the whole question here.
 * @param {Set<string>} running - names the running harness ships.
 * @param {Set<string>} target - names the target harness will ship.
 * @returns {string[]} the names that would disappear, sorted.
 */
export function removedPackages(running, target) {
  const gone = []
  for (const name of running) {
    if (!target.has(name)) gone.push(name)
  }
  return gone.sort()
}

/**
 * Resolve a package's client bundle path.
 * @param {string} packageDir - the package directory.
 * @param {object} manifest - its parsed manifest.
 * @returns {string | null} the absolute path, or null when the package ships no findable bundle.
 */
export function clientBundleOf(packageDir, manifest) {
  const declared = manifest?.exports?.['./client']
  const declaredPath =
    typeof declared === 'string'
      ? declared
      : declared !== null && typeof declared === 'object'
        ? (declared.default ?? declared.import ?? declared.require ?? null)
        : null
  const candidates = []
  if (typeof declaredPath === 'string') candidates.push(declaredPath)
  const fromDsh = manifest?.dsh?.client?.entry ?? manifest?.dsh?.client?.bundle
  if (typeof fromDsh === 'string') candidates.push(fromDsh)
  candidates.push(...CLIENT_ENTRY_CANDIDATES)
  for (const candidate of candidates) {
    const full = join(packageDir, candidate.replace(/^\.\//u, ''))
    try {
      if (statSync(full).isFile()) return full
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Whether a bundle hard-requires a package, versus probing it as a fallback.
 *
 * A literal specifier inside a `require("…")` call is hard: it throws the
 * moment the module table cannot answer. The same string built at runtime
 * (`["@deepseek-ai/dsh-client", "-store"].join("")`) is the pattern newer
 * builds use to prefer a new seed name and fall back to the old one, so it is
 * news, not a blocker.
 * @param {string} text - the bundle's source.
 * @param {string} packageName - the package name without its scope.
 * @returns {'hard' | 'fallback' | null} how the bundle refers to it.
 */
export function referenceKind(text, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const hard = new RegExp(`require\\(\\s*["']@deepseek-ai/${escaped}(?:/[^"']*)?["']\\s*\\)`, 'u')
  if (hard.test(text)) return 'hard'
  const assembled = new RegExp(`["']@deepseek-ai/${escaped}["']`, 'u')
  return assembled.test(text) ? 'fallback' : null
}

/**
 * Inspect every client plugin the profile has installed.
 * @param {{modulesDir: string, names: string[], removed: string[]}} options - the scan inputs.
 * @returns {{findings: object[], scanned: number, unreadable: number}} what was found.
 */
export function scanClientPlugins(options) {
  const { modulesDir, names, removed } = options
  const findings = []
  let scanned = 0
  let unreadable = 0
  for (const name of names) {
    const packageDir = join(modulesDir, ...name.split('/'))
    let manifest
    try {
      // A byte-order mark (PowerShell writes one by default) would make this
      // throw, and a plugin the scan cannot read is one whose hard dependency on
      // a removed package the gate never sees.
      manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8').replace(/^\uFEFF/u, ''))
    } catch {
      unreadable += 1
      continue
    }
    if (manifest?.dsh?.client === undefined) continue
    scanned += 1
    const injects = Array.isArray(manifest.dsh.client.inject) ? manifest.dsh.client.inject : []
    const removedInjects = injects
      .filter((entry) => typeof entry === 'string' && entry.startsWith('@deepseek-ai/'))
      .map((entry) => entry.slice('@deepseek-ai/'.length))
      .filter((entry) => removed.includes(entry))
    const bundle = clientBundleOf(packageDir, manifest)
    const hard = []
    const fallback = []
    if (bundle !== null) {
      try {
        const size = statSync(bundle).size
        if (size <= MAX_BUNDLE_BYTES) {
          const text = readFileSync(bundle, 'utf8')
          for (const gone of removed) {
            const kind = referenceKind(text, gone)
            if (kind === 'hard') hard.push(gone)
            else if (kind === 'fallback') fallback.push(gone)
          }
        }
      } catch {
        unreadable += 1
      }
    }
    if (hard.length === 0 && removedInjects.length === 0 && fallback.length === 0) continue
    findings.push({
      name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      bundle: bundle === null ? null : bundle.slice(packageDir.length + 1),
      hard: [...new Set(hard)],
      injects: [...new Set(removedInjects)],
      fallback: [...new Set(fallback)],
    })
  }
  return { findings, scanned, unreadable }
}

/**
 * Decide what the scan means for this update.
 * @param {{findings: object[], scanned: number, unreadable: number}} scan - the scan result.
 * @returns {{blocking: object[], warning: object[], ok: boolean}} the split.
 */
export function splitFindings(scan) {
  const blocking = scan.findings.filter((entry) => entry.hard.length > 0)
  const warning = scan.findings.filter((entry) => entry.hard.length === 0)
  return { blocking, warning, ok: blocking.length === 0 }
}

/**
 * Fold a compatibility verdict into a check result, in one place, so the
 * scheduler, the dashboard and the agent tool cannot disagree about whether an
 * update is safe to apply unattended.
 * @param {object} check - the check result produced by `checkForUpdate`.
 * @param {{ok: boolean, blocking: object[], warning: object[], scanned: number, removed: string[], target: string} | null} compat - the verdict, or null when not evaluated.
 * @param {object} config - the effective configuration.
 * @returns {object} the check result with `compatibility` attached and `blocked` set when the gate fires.
 */
export function applyCompatibilityGate(check, compat, config) {
  if (compat === null || config.compatibilityGate === 'off') return check
  const gate = config.compatibilityGate ?? 'block'
  const blocked = compat.ok === false && gate === 'block'
  const detail = compat.ok
    ? compat.warning.length === 0
      ? 'no profile plugin depends on a package this release removes'
      : `${compat.warning.length} profile plugin(s) still probe a removed package as a fallback`
    : `${compat.blocking.length} profile plugin(s) hard-require packages ${compat.target} removes` +
      ` (${compat.removed.join(', ')}): ` +
      compat.blocking.map((entry) => `${entry.name}@${entry.version ?? '?'} → ${entry.hard.join(', ')}`).join('; ')
  return {
    ...check,
    compatibility: { ...compat, gate, detail, blocked },
    blocked: blocked || check.blocked === true,
    blockReason: blocked ? detail : (check.blockReason ?? null),
    decision: blocked ? 'plugin-incompatible' : check.decision,
    reason: blocked ? `${check.reason}; withheld: ${detail}` : check.reason,
  }
}
