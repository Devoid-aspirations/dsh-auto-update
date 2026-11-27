/**
 * What "installed" actually means on disk.
 *
 * npm writes the manifest first and unpacks the dependency tree afterwards, so
 * a package directory can name the target version long before it can boot. On
 * 2026-11-27 the update helper trusted that field, stopped npm mid-reify, and
 * the replacement it started died in 0.6 s with
 * `ERR_MODULE_NOT_FOUND … dsh-app-boot\index.js`.
 *
 * Two questions are therefore asked separately: `inspectTree` — are the
 * contents there (version, every declared dependency, the entry points) — and
 * `treeFingerprint` — has anything written to the tree since the last sample.
 * A landing needs both, twice.
 * @module dsh-auto-update/tree
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readJson } from './paths.js'

/**
 * A fingerprint of the install tree that moves whenever npm writes to it:
 * the entry count of `node_modules` plus the mtime of the directory and of the
 * package manifest. Cheap enough to sample every few seconds (three syscalls),
 * and sensitive to every phase npm goes through — it renames `node_modules`
 * into place, then unpacks dependencies into it one tarball at a time.
 * @param {string} packageDir - the harness package directory.
 * @returns {string | null} a comparable fingerprint (`null` when nothing is readable).
 */
export function treeFingerprint(packageDir) {
  try {
    const manifest = statSync(join(packageDir, 'package.json')).mtimeMs
    const nodeModules = join(packageDir, 'node_modules')
    let entries = 0
    let dirMs = 0
    try {
      entries = readdirSync(nodeModules).length
      dirMs = statSync(nodeModules).mtimeMs
    } catch {
      // Not created yet — a tree with no node_modules is still a valid sample.
    }
    return `${entries}:${Math.round(dirMs)}:${Math.round(manifest)}`
  } catch {
    return null
  }
}

/**
 * Whether the tree is really installed, rather than merely renamed into place.
 *
 * The version field is the first thing npm writes and the last thing it
 * deserves trust for, so the check is: the manifest names the target, every
 * declared dependency resolves, and the declared entry points are on disk.
 * `optionalDependencies` are deliberately not required (a platform-specific
 * package may legitimately be absent), and a manifest that declares no
 * dependencies at all only has to satisfy the version and entry-point checks.
 * @param {string | null} packageDir - the harness package directory.
 * @param {string} name - the package name.
 * @param {string} target - the version being installed.
 * @returns {{ok: boolean, reason: string, missing: string[]}} the verdict.
 */
export function inspectTree(packageDir, name, target) {
  if (packageDir === null) return { ok: false, reason: 'the global root could not be located', missing: [] }
  const manifest = readJson(join(packageDir, 'package.json'))
  const version = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
  if (version !== target) {
    return { ok: false, reason: `the manifest says ${version ?? 'nothing readable'}, not ${target}`, missing: [] }
  }
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? Object.keys(manifest.dependencies) : []
  const missing = dependencies.filter((dependency) => !existsSync(join(packageDir, 'node_modules', ...dependency.split('/'), 'package.json')))
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? ', …' : ''
    return { ok: false, reason: `${missing.length} of ${dependencies.length} dependency package(s) are not unpacked yet (${sample}${rest})`, missing }
  }
  const entryPoints = []
  if (typeof manifest.main === 'string' && manifest.main !== '') entryPoints.push(manifest.main)
  if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) if (typeof value === 'string') entryPoints.push(value)
  }
  const missingEntries = entryPoints.filter((entry) => !existsSync(join(packageDir, entry)))
  if (missingEntries.length > 0) {
    return { ok: false, reason: `the entry file(s) are not on disk yet (${missingEntries.join(', ')})`, missing: missingEntries }
  }
  return { ok: true, reason: `${target}${name === '' ? '' : ` (${name})`} with ${dependencies.length} dependencies`, missing: [] }
}
