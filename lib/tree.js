/**
 * What "installed" actually means on disk.
 *
 * npm writes the manifest first and unpacks the dependency tree afterwards, so
 * a package directory can name the target version long before it can boot. On
 * 2026-11-27 the update helper trusted that field, stopped npm mid-reify, and
 * the replacement it started died in 0.6 s with
 * `ERR_MODULE_NOT_FOUND … dsh-app-boot\index.js`. It did it again that evening
 * with a deeper hole: every DIRECT dependency was on disk, but the packages
 * they depend on were not (`dsh-goal\node_modules\zod\v4\core\util.js`), so a
 * one-level check said "complete" while the tree was 14 tarballs short.
 *
 * So the walk is recursive now: every package that is on disk must have the
 * dependencies its own manifest declares, resolved the way Node resolves them
 * (its own `node_modules`, then its parents'), and every declared entry point
 * must exist. `inspectTree` also folds the mtimes of everything it visited into
 * a fingerprint, which is what `watchInstallTree` samples: a tree that is still
 * being written moves, and a nested package being unpacked moves it too.
 * @module dsh-auto-update/tree
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { readJson } from './paths.js'

/** How many package directories one inspection may visit before it gives up walking. */
const MAX_PACKAGES = 4000

/** How deep the walk follows dependencies-of-dependencies. */
const MAX_DEPTH = 8

/**
 * A cheap top-level fingerprint of the install tree: the entry count of
 * `node_modules` plus the mtime of the directory and of the package manifest.
 * Kept for callers that only want a sample; `inspectTree` returns the deeper
 * fingerprint, and that is the one an install is judged on.
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
 * Resolve a dependency the way Node would: `<dir>/node_modules/<name>` for each
 * ancestor of `from`, stopping at `ceiling` (the package being installed).
 * @param {string} from - the package that declares the dependency.
 * @param {string} ceiling - the top of the install tree.
 * @param {string} dependency - the package name.
 * @returns {string | null} the dependency directory, or `null` when it is not on disk.
 */
function resolveDependency(from, ceiling, dependency) {
  const segments = dependency.split('/')
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', ...segments)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === ceiling) return null
    const parent = dirname(dir)
    if (parent === dir || !parent.startsWith(ceiling)) return null
    dir = parent
  }
}

/**
 * The file paths a package manifest declares as its entry points.
 *
 * `exports` is where modern ESM packages put this, and it nests conditions
 * (`{ ".": { import: "./x.js" } }`), so the strings are collected recursively
 * and wildcard patterns are skipped — a pattern cannot be resolved to one file.
 * @param {object} manifest - a parsed package.json.
 * @returns {string[]} relative paths declared by the manifest.
 */
function entryPointsOf(manifest) {
  const entries = []
  if (typeof manifest.main === 'string' && manifest.main !== '') entries.push(manifest.main)
  if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) if (typeof value === 'string') entries.push(value)
  }
  const collect = (node, depth) => {
    if (depth > 4 || node === null || typeof node !== 'object') return
    if (typeof node === 'string') {
      if (!node.includes('*') && node.startsWith('.')) entries.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) collect(item, depth + 1)
      return
    }
    for (const value of Object.values(node)) collect(value, depth + 1)
  }
  const exported = manifest.exports
  if (typeof exported === 'string') collect(exported, 0)
  else if (exported !== null && typeof exported === 'object') {
    const root = Object.hasOwn(exported, '.') ? exported['.'] : exported
    collect(root, 1)
  }
  return entries
}

/** Extensions Node tries when a manifest names a path without one. */
const ENTRY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node']

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a manifest-declared entry resolves to a file the way Node resolves it.
 *
 * Manifests are allowed to omit the extension and the index file: `ms` declares
 * `"main": "./index"` and `@eslint-community/regexpp` declares `"main": "index"`,
 * both of which build `index.js` on disk. A bare `existsSync` calls those
 * missing — on 2026-11-27 that turned a finished install of 0.2.2-rc.5 into
 * "the entry file(s) are not on disk yet", so the helper ran npm a second time
 * and recorded the transaction as failed while the new version was already
 * serving.
 * @param {string} dir - the package directory.
 * @param {string} entry - the path the manifest declares.
 * @returns {boolean} whether Node would find a file there.
 */
function resolvesEntry(dir, entry) {
  const base = join(dir, entry)
  if (isFile(base)) return true
  for (const extension of ENTRY_EXTENSIONS) if (isFile(`${base}${extension}`)) return true
  try {
    if (!statSync(base).isDirectory()) return false
  } catch {
    return false
  }
  return ENTRY_EXTENSIONS.some((extension) => isFile(join(base, `index${extension}`)))
}

/**
 * Whether the tree is really installed, rather than merely renamed into place.
 *
 * The version field is the first thing npm writes and the last thing it
 * deserves trust for, so the check is: the manifest names the target, every
 * declared dependency of every package on disk resolves, and the entry points
 * those manifests declare are there. `optionalDependencies` are deliberately
 * not required (a platform-specific package may legitimately be absent), and a
 * package that declares no dependencies only has to satisfy its entry points.
 * @param {string | null} packageDir - the harness package directory.
 * @param {string} name - the package name.
 * @param {string} target - the version being installed.
 * @returns {{ok: boolean, reason: string, missing: string[], fingerprint: string | null, packages: number}} the verdict.
 */
export function inspectTree(packageDir, name, target) {
  if (packageDir === null) {
    return { ok: false, reason: 'the global root could not be located', missing: [], fingerprint: null, packages: 0 }
  }
  // A caller may hand this either separator; every comparison below is a path
  // prefix test, so the tree root is normalised once instead of at each use.
  const treeRoot = resolve(packageDir)
  const root = readJson(join(treeRoot, 'package.json'))
  const version = root !== null && typeof root.version === 'string' ? root.version : null
  if (version !== target) {
    return {
      ok: false,
      reason: `the manifest says ${version ?? 'nothing readable'}, not ${target}`,
      missing: [],
      fingerprint: null,
      packages: 0,
    }
  }

  let hash = 2166136261
  const remember = (dir) => {
    try {
      const stamp = Math.round(statSync(dir).mtimeMs)
      for (const char of `${dir}:${stamp}`) hash = (((hash ^ char.charCodeAt(0)) * 16777619) >>> 0)
    } catch {
      // A directory that vanished between readdir and stat cannot be fingerprinted.
    }
  }

  const missing = []
  const entriesMissing = []
  const dependenciesOfRoot = root.dependencies !== null && typeof root.dependencies === 'object' ? Object.keys(root.dependencies) : []
  const missingRootDependencies = []
  const queue = [{ dir: treeRoot, depth: 0, owner: name, root: true }]
  const seen = new Set()
  let packages = 0

  while (queue.length > 0 && packages < MAX_PACKAGES) {
    const current = queue.shift()
    if (seen.has(current.dir)) continue
    seen.add(current.dir)
    packages += 1
    remember(current.dir)
    let manifest = current.root ? root : readJson(join(current.dir, 'package.json'))
    if (manifest === null) {
      // The directory exists but its manifest does not: that is an unpacked
      // directory in progress, not a package.
      missing.push(`${current.owner} is not unpacked yet`)
      continue
    }
    const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? Object.keys(manifest.dependencies) : []
    for (const dependency of dependencies) {
      const resolved = resolveDependency(current.dir, treeRoot, dependency)
      if (resolved === null) {
        if (current.root) missingRootDependencies.push(dependency)
        else missing.push(`${current.owner} → ${dependency}`)
        continue
      }
      if (current.depth < MAX_DEPTH) queue.push({ dir: resolved, depth: current.depth + 1, owner: dependency, root: false })
    }
    for (const entry of entryPointsOf(manifest)) {
      if (!resolvesEntry(current.dir, entry)) entriesMissing.push(current.root ? entry : `${current.owner}/${entry}`)
    }
  }

  const fingerprint = packages === 0 ? null : `${packages}:${hash}`
  if (missingRootDependencies.length > 0) {
    const sample = missingRootDependencies.slice(0, 3).join(', ')
    const rest = missingRootDependencies.length > 3 ? ', …' : ''
    return {
      ok: false,
      reason: `${missingRootDependencies.length} of ${dependenciesOfRoot.length} dependency package(s) are not unpacked yet (${sample}${rest})`,
      missing: missingRootDependencies,
      fingerprint,
      packages,
    }
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? ', …' : ''
    return {
      ok: false,
      reason: `${missing.length} nested dependency package(s) are not unpacked yet (${sample}${rest})`,
      missing,
      fingerprint,
      packages,
    }
  }
  if (entriesMissing.length > 0) {
    const sample = entriesMissing.slice(0, 3).join(', ')
    const rest = entriesMissing.length > 3 ? ', …' : ''
    return {
      ok: false,
      reason: `the entry file(s) are not on disk yet (${sample}${rest})`,
      missing: entriesMissing,
      fingerprint,
      packages,
    }
  }
  return {
    ok: true,
    reason: `${target}${name === '' ? '' : ` (${name})`} with ${dependenciesOfRoot.length} dependencies and ${packages} package(s) checked`,
    missing: [],
    fingerprint,
    packages,
  }
}
