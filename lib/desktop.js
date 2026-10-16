/**
 * Keeping the packaged desktop wrapper in step with the harness.
 *
 * WHY THIS IS PART OF AN UPDATE
 * ----------------------------
 * `dsh-desktop` is an Electron shell around `dsh web`, and its own version
 * mirrors the harness version on purpose ("版本与 dsh 核心同步"): the shell
 * adapts to what it finds at runtime (it only passes `--no-open` to a 0.2+
 * core), and what ships in `dist/` is a 250 MB folder plus a 158 MB zip. Doing
 * that bump-and-repack by hand after every harness release is exactly the kind
 * of chore that gets forgotten, which leaves a distributable that claims a
 * version it was not built against.
 *
 * So the update transaction does it too, AFTER the harness is installed,
 * restarted and verified — and it can never do worse than report: a desktop
 * build that fails records its error and leaves the harness update alone.
 *
 * Success is judged on the ARTIFACT, not the exit code: the update finds the
 * payload electron-builder actually wrote (unpacked `resources/app/package.json`
 * or the packaged `resources/app.asar` of a default build), requires it to name
 * the harness version, requires its files to MATCH the project's shell files,
 * and requires the distributable zip to be a complete archive. A build that
 * exits 0 while shipping the old bundle is the failure mode worth catching — and
 * so is a bundle that names the right version but was built before the shell was
 * last edited.
 * @module dsh-auto-update/desktop
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { appendLog, closeQuietly, ensureDir, featureDir, processAlive, readJson, writeJsonAtomic } from './paths.js'
import { spawnNpm } from './npm.js'

/** The package name this module is allowed to touch. */
const PROJECT_NAME = 'dsh-desktop'

/** Modes, widest last. */
export const DESKTOP_MODES = ['off', 'version', 'package']

/** electron-builder's output directory when the project does not name one. */
const DEFAULT_OUTPUT_DIR = 'dist'

/** The executable's base name when the project's manifest does not name one. */
const DEFAULT_PRODUCT_NAME = 'DSH Desktop'

/** The end-of-central-directory signature every complete zip ends with. */
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06])

/**
 * How much newer than the payload a distributable may be before its age is
 * called a problem. Two seconds absorbs the filesystem's timestamp granularity
 * and the moment between writing the payload and archiving it; anything larger
 * means the archive was made from a DIFFERENT build.
 */
const ZIP_LAG_TOLERANCE = 2000

/**
 * The directories worth looking in for the desktop project, in order.
 *
 * Three cases, and the third is the one that matters in practice: the plugin
 * installs into the profile as a COPY (`file:` dependency), so its own
 * directory is `<profile>/node_modules/dsh-auto-update` and the project is not
 * beside it. The place it was installed FROM — recorded in the profile
 * manifest as the dependency's `file:` spec — is where the sibling project
 * lives, which is why the caller resolves that path and passes it in.
 * @param {string | null} dir - the configured directory, if any.
 * @param {string} [pluginDir] - this plugin's installed directory.
 * @param {string | null} [sourceDir] - the directory this plugin was installed from.
 * @returns {string[]} the candidate directories, deduplicated.
 */
export function desktopCandidates(dir, pluginDir, sourceDir) {
  const candidates = []
  if (typeof dir === 'string' && dir !== '') candidates.push(resolve(dir))
  if (typeof pluginDir === 'string' && pluginDir !== '') candidates.push(resolve(join(pluginDir, '..', PROJECT_NAME)))
  if (typeof sourceDir === 'string' && sourceDir !== '') candidates.push(resolve(join(sourceDir, '..', PROJECT_NAME)))
  return [...new Set(candidates)]
}

/**
 * Find the desktop project.
 *
 * A directory only counts when its manifest says it is `dsh-desktop` and it
 * carries a `main.js`: this module rewrites a version and runs a build, and
 * doing either to whatever directory happens to be configured would be a
 * genuinely bad bug.
 * @param {string | null} dir - the configured directory, or null to auto-detect.
 * @param {string} [pluginDir] - this plugin's installed directory.
 * @param {string | null} [sourceDir] - the directory this plugin was installed from.
 * @returns {{dir: string, manifest: object} | null} the project, or null when there is none.
 */
export function findDesktopProject(dir, pluginDir, sourceDir = null) {
  for (const candidate of desktopCandidates(dir, pluginDir, sourceDir)) {
    const manifest = readJsonQuietly(join(candidate, 'package.json'))
    if (manifest === null) continue
    if (manifest?.name !== PROJECT_NAME) continue
    if (!existsSync(join(candidate, 'main.js'))) continue
    return { dir: candidate, manifest }
  }
  return null
}

/**
 * Where the project writes its packaged output.
 *
 * Read from the project's own `build.directories.output`, because assuming
 * `dist` is the kind of assumption that silently turns the artifact check into
 * a check of a directory no build writes to any more.
 * @param {string} projectDir - the desktop project directory.
 * @param {object | null} [manifest] - the project's manifest.
 * @returns {string} the absolute output root.
 */
export function resolveOutputRoot(projectDir, manifest = null) {
  // Asked without a manifest, the project answers for itself: a caller that
  // looks under `dist` while the project builds into `build-out` inspects a
  // directory nothing writes to.
  const configured = (manifest ?? readJsonQuietly(join(projectDir, 'package.json')))?.build?.directories?.output
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(projectDir, configured.trim())
  return join(projectDir, DEFAULT_OUTPUT_DIR)
}

/**
 * Every packaged payload under the output root, newest first.
 *
 * NOTHING about the layout may be assumed. `electron-builder --win dir` names
 * its folder after the TARGET (`win-unpacked`), not after `productName`, and it
 * packs the payload into `resources/app.asar` unless the project sets
 * `asar: false` — so a check that hardcodes
 * `dist/<productName>/resources/app/package.json` cannot see a default build at
 * all, reports the payload as unreadable, and then rebuilds forever. A payload
 * is therefore DISCOVERED by looking for what electron-builder writes.
 *
 * Newest first, because the folder a build just wrote is that build's result: a
 * leftover from an earlier layout must not be allowed to answer for it. This is
 * also why the chosen folder is recorded in the state and the log.
 * @param {string} projectDir - the desktop project directory.
 * @param {object | null} [manifest] - the project's manifest.
 * @returns {{outputRoot: string, payloads: Array<{folder: string, layout: string, file: string, root: string, at: number}>}} what is there.
 */
export function listPayloads(projectDir, manifest = null) {
  const outputRoot = resolveOutputRoot(projectDir, manifest)
  const payloads = []
  let entries
  try {
    entries = readdirSync(outputRoot, { withFileTypes: true })
  } catch {
    return { outputRoot, payloads }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(outputRoot, entry.name)
    const unpacked = join(root, 'resources', 'app', 'package.json')
    const asar = join(root, 'resources', 'app.asar')
    try {
      if (existsSync(unpacked)) {
        payloads.push({ folder: entry.name, layout: 'unpacked', file: unpacked, root, at: statSync(unpacked).mtimeMs })
      } else if (existsSync(asar)) {
        payloads.push({ folder: entry.name, layout: 'asar', file: asar, root, at: statSync(asar).mtimeMs })
      }
    } catch {
      /* a folder that vanished under us is not a candidate */
    }
  }
  payloads.sort((left, right) => right.at - left.at)
  return { outputRoot, payloads }
}

/**
 * The payload the sync judges: the folder pinned by `zipSource` when it is set
 * and exists, otherwise the most recently written one.
 * @param {Array<object>} payloads - the candidates, newest first.
 * @param {string | null} [zipSource] - the pinned folder name, if any.
 * @returns {object | null} the chosen payload.
 */
export function choosePayload(payloads, zipSource = null) {
  if (payloads.length === 0) return null
  if (typeof zipSource === 'string' && zipSource !== '') {
    const pinned = payloads.find((item) => item.folder === zipSource)
    if (pinned !== undefined) return pinned
  }
  return payloads[0]
}

/**
 * Read an asar archive's header, and the `package.json` inside it.
 *
 * The format is Electron's pickle: a 4-byte size, the header's JSON size, the
 * header (a directory tree whose leaves carry `size` and an `offset` relative to
 * the payload), then the raw file contents — none of it compressed. Reading it
 * directly is what keeps the artifact check honest on the DEFAULT
 * electron-builder layout instead of degrading to "trust the exit code".
 * @param {string} asarPath - the archive.
 * @returns {{manifest: object | null, entries: Array<{path: string, size: number, offset: number}>, dataBase: number} | null} what was found.
 */
export function readAsar(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    // Electron's asar header is a doubled pickle, which is why parses that guess
    // the offsets fail on every REAL archive:
    //   [u32 4][u32 H][u32 P][u32 J][JSON of J bytes][file contents…]
    // where H = the header pickle's own length, P = its payload length and J =
    // the JSON's byte length; the contents start at 8 + H. Reading the JSON from
    // offset 8 or 12 (which this did until 2026-10-15) feeds the size prefixes to
    // JSON.parse, so an archive was reported unreadable: a DEFAULT
    // `electron-builder` build — the one that packs `resources/app.asar` — then
    // reported "no version" and every sync failed *after* a good build.
    // Verified against electron's own default_app.asar.
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) return null
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (!Number.isInteger(headerSize) || headerSize <= 8 || headerSize > 64 * 1024 * 1024) return null
    if (!Number.isInteger(jsonSize) || jsonSize <= 0 || jsonSize > headerSize) return null
    const header = Buffer.alloc(jsonSize)
    if (readSync(fd, header, 0, jsonSize, 16) !== jsonSize) return null
    const tree = JSON.parse(header.toString('utf8').replace(/^\uFEFF/u, '').replace(/\u0000+$/u, ''))
    const entries = []
    collectAsarEntries(tree?.files, '', entries)
    // Where the archived contents begin: past both pickles and the header block.
    const dataBase = 8 + headerSize
    const entry = entries.find((item) => item.path === 'package.json')
    if (entry === undefined || entry.size <= 0 || entry.size > 8 * 1024 * 1024) return { manifest: null, entries, dataBase }
    const body = Buffer.alloc(entry.size)
    if (readSync(fd, body, 0, entry.size, dataBase + entry.offset) !== entry.size) return { manifest: null, entries, dataBase }
    // The archived manifest is the file's bytes verbatim, so it can carry a
    // byte-order mark too.
    return { manifest: JSON.parse(body.toString('utf8').replace(/^\uFEFF/u, '')), entries, dataBase }
  } catch {
    return null
  } finally {
    closeQuietly(fd)
  }
}

/**
 * Flatten an asar header's directory tree into its file entries.
 * @param {object | undefined} node - a `files` node.
 * @param {string} prefix - the path so far.
 * @param {Array<{path: string, size: number, offset: number}>} into - the accumulator.
 * @returns {void}
 */
function collectAsarEntries(node, prefix, into) {
  if (node === null || typeof node !== 'object') return
  for (const [name, value] of Object.entries(node)) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (value !== null && typeof value === 'object' && value.files !== undefined) {
      collectAsarEntries(value.files, path, into)
      continue
    }
    const size = Number(value?.size)
    const offset = Number(value?.offset)
    if (Number.isFinite(size) && Number.isFinite(offset)) into.push({ path, size, offset })
  }
}

/**
 * Parse a JSON file, treating anything unreadable as absent.
 *
 * A leading byte-order mark is stripped first. Hand-written and
 * PowerShell-written manifests carry one, and `JSON.parse` rejects it outright —
 * so without this the payload reads as "not built" and the feature rebuilds a
 * good artifact on every single run.
 * @param {string} file - the file.
 * @returns {object | null} the parsed value, or null.
 */
function readJsonQuietly(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    return null
  }
}

/**
 * A file's size, or -1 when it cannot be read.
 * @param {string} file - the file.
 * @returns {number} the size.
 */
function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

/**
 * A file's content hash, or a token when it cannot be read.
 * @param {string} file - the file.
 * @returns {string} the digest.
 */
function hashOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return 'unreadable'
  }
}

/**
 * The digest of one range inside a file — an asar entry, without unpacking it.
 * @param {string} file - the archive.
 * @param {number} at - the absolute offset the bytes start at.
 * @param {number} size - how many bytes belong to the entry.
 * @returns {string | null} the digest, or null when it cannot be read.
 */
function hashOfRange(file, at, size) {
  let fd
  try {
    fd = openSync(file, 'r')
    const body = Buffer.alloc(size)
    if (readSync(fd, body, 0, size, at) !== size) return null
    return createHash('sha1').update(body).digest('hex')
  } catch {
    return null
  } finally {
    closeQuietly(fd)
  }
}

/**
 * Every file under a directory, relative to it.
 * @param {string} root - the directory to walk.
 * @param {{skipNodeModules?: boolean}} [options] - whether to skip a top-level `node_modules`.
 * @returns {Array<{path: string, file: string, size: number}>} the files.
 */
function walkFiles(root, options = {}) {
  const { skipNodeModules = false } = options
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (prefix === '' && skipNodeModules && entry.name === 'node_modules') continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, path)
        continue
      }
      out.push({ path, file: full, size: sizeOf(full) })
    }
  }
  walk(root, '')
  return out
}

/**
 * The files inside an unpacked `resources/app`, relative to it.
 *
 * `node_modules` is skipped: the build copies it from the project wholesale, so
 * comparing it would cost a walk over thousands of files to learn nothing.
 * @param {string} root - the packaged folder (the one holding `resources`).
 * @returns {Array<{path: string, file: string, size: number}>} the files.
 */
function unpackedFiles(root) {
  return walkFiles(join(root, 'resources', 'app'), { skipNodeModules: true })
}

/**
 * The files inside a packaged asar, with the sizes its header records.
 * @param {string} asarPath - the archive.
 * @returns {Array<{path: string, size: number, asar?: string, at?: number}>} the entries.
 */
function asarFiles(asarPath) {
  const asar = readAsar(asarPath)
  if (asar === null) return []
  return asar.entries
    .filter((entry) => !entry.path.startsWith('node_modules/'))
    // `at` is where the entry's bytes begin in the archive, so a same-size edit
    // inside a packed payload can still be caught by content and not just by size.
    .map((entry) => ({ path: entry.path, size: entry.size, asar: asarPath, at: asar.dataBase + entry.offset }))
}

/**
 * Whether a packaged file still holds exactly what the project holds.
 *
 * An unreadable payload file answers `true`: the size comparison has already run,
 * and a check that cannot read is not evidence of a difference.
 * @param {{file?: string, asar?: string, at?: number, size: number}} shipped - the packaged file.
 * @param {string} source - the project file.
 * @returns {boolean} whether they match.
 */
function sameBytes(shipped, source) {
  const digest = shipped.file !== undefined
    ? hashOf(shipped.file)
    : (shipped.asar === undefined || shipped.at === undefined ? null : hashOfRange(shipped.asar, shipped.at, shipped.size))
  if (digest === null) return true
  return digest === hashOf(source)
}

/**
 * Which of the packaged payload's files no longer match their sources.
 *
 * The version field alone cannot tell a current bundle from a stale one. A build
 * that ran BEFORE the shell was edited still names the version it was built for,
 * so the distributable ships old code while every version-shaped check says it
 * is current — which is exactly what happened here on 2026-10-15, when the
 * packaged `main.js` was three weeks older than the project's and the sync
 * reported `up-to-date`. So the shipped files are compared with the project's —
 * byte for byte in both layouts (a directory's files are hashed in place, an
 * asar entry is hashed at the offset its header records) — and the comparison
 * runs in both directions, so a source the build was TOLD to package and did not
 * is drift too.
 * @param {object} payload - the chosen payload.
 * @param {string} projectDir - the desktop project directory.
 * @returns {string[]} the paths that differ, capped so the state stays small.
 */
export function bundleDrift(payload, projectDir) {
  const files = payload.layout === 'unpacked' ? unpackedFiles(payload.root) : asarFiles(payload.file)
  const shipped = new Set(files.map((file) => file.path))
  const drift = []
  for (const file of files) {
    // electron-builder generates the app's own manifest; it is not a copy.
    if (file.path === 'package.json') continue
    const source = join(projectDir, ...file.path.split('/'))
    if (!existsSync(source)) {
      drift.push(`${file.path} (not in the project)`)
      continue
    }
    const sourceSize = sizeOf(source)
    if (sourceSize !== file.size) {
      drift.push(file.path)
    } else if (sourceSize <= 8 * 1024 * 1024 && !sameBytes(file, source)) {
      // Above 8 MB the size comparison stands alone: hashing it twice on every
      // inspection would cost more than the drift it could still catch.
      drift.push(file.path)
    }
    if (drift.length >= 5) return drift
  }
  // The other direction matters just as much: a source the build was TOLD to
  // package and did not. Adding a file to the shell and never rebuilding leaves
  // a payload that is missing it while every version-shaped check says current.
  for (const path of declaredSources(projectDir)) {
    if (shipped.has(path)) continue
    drift.push(`${path} (missing from the packaged build)`)
    if (drift.length >= 5) break
  }
  return drift
}

/**
 * The project files electron-builder is told to package.
 *
 * This is deliberately a SMALL reader of `build.files`, not a glob engine: the
 * shapes a desktop shell actually uses are literal names, `dir/**` and
 * `dir/*.ext`. Negations and brace expansions are skipped — an entry this
 * cannot read is one it must not claim to have checked.
 * @param {string} projectDir - the desktop project directory.
 * @returns {string[]} project-relative paths (forward slashes), best effort.
 */
function declaredSources(projectDir) {
  const manifest = readJsonQuietly(join(projectDir, 'package.json'))
  const entries = Array.isArray(manifest?.build?.files) ? manifest.build.files : []
  const out = new Set()
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const clean = entry.trim().replace(/^\.\//u, '').replace(/\/+$/u, '')
    if (clean === '' || clean.startsWith('!') || /[{}[\]]/u.test(clean)) continue
    if (!clean.includes('*')) {
      if (existsSync(join(projectDir, clean))) out.add(clean)
      continue
    }
    if (!clean.endsWith('/**')) continue
    const base = clean.slice(0, -3)
    for (const file of walkFiles(join(projectDir, base), { skipNodeModules: true })) out.add(`${base}/${file.path}`)
  }
  return [...out]
}

/**
 * Rewrite only the `version` field, leaving every other byte of the file alone.
 *
 * A JSON round trip would be simpler and would also reflow the author's file —
 * these manifests are hand-maintained, and a sync step that produces a large
 * cosmetic diff is a sync step nobody will trust.
 * @param {string} file - the manifest path.
 * @param {string} version - the new version.
 * @returns {{changed: boolean, previous: string | null, backup: string | null}} the outcome.
 */
export function writeManifestVersion(file, version) {
  const text = readFileSync(file, 'utf8')
  const match = /^(\s*"version"\s*:\s*")([^"]*)(")/mu.exec(text)
  if (match === null) return { changed: false, previous: null, backup: null }
  const previous = match[2]
  if (previous === version) return { changed: false, previous, backup: null }
  const backup = `${file}.bak-${previous}`
  try {
    if (!existsSync(backup)) copyFileSync(file, backup)
  } catch {
    /* a backup that cannot be written must not stop the sync */
  }
  const next = `${text.slice(0, match.index)}${match[1]}${version}${match[3]}${text.slice(match.index + match[0].length)}`
  writeFileSync(file, next, 'utf8')
  return { changed: true, previous, backup }
}

/**
 * The version the PACKAGED app reports — the artifact, not the intent.
 *
 * Discovered, never assumed: the folder and the layout come from what is
 * actually in the output root (see `listPayloads`), and the version is read out
 * of the payload — from the app's manifest when it is a directory, and from the
 * asar archive when it is packed.
 * @param {string} projectDir - the desktop project directory.
 * @param {{manifest?: object | null, zipSource?: string | null}} [options] - the project's manifest and any pinned payload folder.
 * @returns {{version: string | null, source: string | null, file: string | null, at: number | null, folder: string | null, layout: string | null, root: string | null, outputRoot: string}} what was found.
 */
export function readPackagedVersion(projectDir, options = {}) {
  const manifest = options.manifest ?? readJsonQuietly(join(projectDir, 'package.json'))
  const { outputRoot, payloads } = listPayloads(projectDir, manifest)
  const payload = choosePayload(payloads, options.zipSource ?? null)
  if (payload === null) {
    return { version: null, source: null, file: null, at: null, folder: null, layout: null, root: null, outputRoot }
  }
  let version = null
  if (payload.layout === 'unpacked') {
    const app = readJsonQuietly(payload.file)
    if (typeof app?.version === 'string') version = app.version
  } else {
    const asar = readAsar(payload.file)
    if (typeof asar?.manifest?.version === 'string') version = asar.manifest.version
  }
  return {
    version,
    source: relative(projectDir, payload.file).split(sep).join('/'),
    file: payload.file,
    at: payload.at,
    folder: payload.folder,
    layout: payload.layout,
    root: payload.root,
    outputRoot,
  }
}

/**
 * Whether a file is a COMPLETE zip archive.
 *
 * `existsSync` is not that question: a refresh that died halfway leaves a
 * truncated file, which would then be reported as a current distributable for
 * ever. A zip always ends with an end-of-central-directory record (`PK\x05\x06`)
 * within its last 64 KiB (a trailing archive comment may push it that far). Its
 * mtime comes back too: an archive older than the payload it should contain is a
 * different question, answered by the plan.
 * @param {string} file - the candidate.
 * @returns {{valid: boolean, bytes: number | null, at: number | null}} the verdict, with its size and age.
 */
export function inspectZip(file) {
  if (typeof file !== 'string' || file === '') return { valid: false, bytes: null, at: null }
  let size
  let at
  try {
    const info = statSync(file)
    size = info.size
    at = info.mtimeMs
  } catch {
    return { valid: false, bytes: null, at: null }
  }
  if (size < 22) return { valid: false, bytes: size, at }
  let fd
  try {
    fd = openSync(file, 'r')
    const window = Math.min(size, 64 * 1024 + 22)
    const tail = Buffer.alloc(window)
    readSync(fd, tail, 0, window, size - window)
    return { valid: tail.includes(EOCD), bytes: size, at }
  } catch {
    return { valid: false, bytes: size, at }
  } finally {
    closeQuietly(fd)
  }
}

/**
 * What this sync would do, without doing it.
 *
 * The verdict rests on the ARTIFACT, not on a version string: the version the
 * packaged payload names, the files that payload actually contains, and whether
 * the distributable is a complete archive NEWER than the payload it should hold.
 * A version-shaped check alone answers `up-to-date` for a bundle built before the
 * shell was last edited — which is exactly how a stale desktop app was reported
 * current on 2026-10-15.
 * @param {{project: object | null, mode: string, harnessVersion: string | null, zipPath?: string | null, zipSource?: string | null, zipExpected?: boolean}} args - the inputs.
 * @returns {{action: 'off' | 'no-project' | 'up-to-date' | 'version' | 'package', reason: string, projectVersion: string | null, packagedVersion: string | null, packagedAt: number | null, payload: string | null, payloadLayout: string | null, payloadFile: string | null, outputRoot: string | null, drift: string[], zip: {valid: boolean, bytes: number | null, at: number | null} | null, stalePackage: boolean}} the plan.
 */
export function planDesktopSync(args) {
  const { project, mode, harnessVersion, zipPath = null, zipSource = null, zipExpected = true } = args
  const empty = {
    projectVersion: null,
    packagedVersion: null,
    packagedAt: null,
    payload: null,
    payloadLayout: null,
    payloadFile: null,
    outputRoot: null,
    drift: [],
    zip: null,
    stalePackage: false,
  }
  if (mode === 'off') return { ...empty, action: 'off', reason: 'desktop sync is disabled' }
  if (project === null) return { ...empty, action: 'no-project', reason: `no ${PROJECT_NAME} project was found` }
  const projectVersion = typeof project.manifest.version === 'string' ? project.manifest.version : null
  const packaged = readPackagedVersion(project.dir, { manifest: project.manifest, zipSource })
  const drift = packaged.root === null ? [] : bundleDrift({ layout: packaged.layout, root: packaged.root, file: packaged.file }, project.dir)
  // No archive is judged when the sync does not maintain one: with the zip turned
  // off, "the zip is missing" would ask for a build on every single run.
  const zip = zipPath === null || !zipExpected ? null : inspectZip(zipPath)
  const wantPackage = mode === 'package'
  const versionMatches = harnessVersion !== null && projectVersion === harnessVersion
  const packagedMatches = packaged.version === harnessVersion
  const zipOk = zip === null || zip.valid
  // A complete archive is not automatically the RIGHT one. A build that wrote a
  // fresh payload and then died before the zip step — or an archive rebuilt by
  // hand from an older folder — leaves a file that every existence check calls
  // current while it still holds the previous build. The state alone cannot see
  // that, so the ordering is compared: the archive must not predate the payload.
  const zipLagging = zip !== null && zip.valid
    && packaged.at !== null && zip.at !== null && zip.at + ZIP_LAG_TOLERANCE < packaged.at
  const stalePackage = wantPackage && (!packagedMatches || !zipOk || drift.length > 0 || zipLagging)
  const common = {
    projectVersion,
    packagedVersion: packaged.version,
    packagedAt: packaged.at,
    payload: packaged.folder,
    payloadLayout: packaged.layout,
    payloadFile: packaged.file,
    outputRoot: packaged.outputRoot ?? null,
    drift,
    zip,
  }
  if (versionMatches && !stalePackage) {
    return {
      ...common,
      action: 'up-to-date',
      reason: `manifest and packaged build both name ${harnessVersion ?? '?'}${packaged.folder === null ? '' : ` (payload ${packaged.folder} matches the project)`}`,
      stalePackage: false,
    }
  }
  const reasons = []
  if (!versionMatches) reasons.push(`manifest says ${projectVersion ?? '?'}`)
  if (wantPackage && !packagedMatches) reasons.push(`packaged build says ${packaged.version ?? 'not built'}`)
  if (wantPackage && drift.length > 0) reasons.push(`the packaged build does not match the project (${drift.join(', ')})`)
  if (wantPackage && zip !== null && !zip.valid) reasons.push(zip.bytes === null ? 'the distributable zip is missing' : 'the distributable zip is incomplete')
  if (wantPackage && zipLagging) reasons.push('the distributable zip predates the packaged build')
  return {
    ...common,
    action: wantPackage ? 'package' : 'version',
    reason: reasons.join('; '),
    stalePackage,
  }
}

/**
 * Run one command with its output captured through FILES (never pipes — a
 * confined harness cannot create the pipes `stdio: 'pipe'` needs).
 * @param {{file: string, viaShell: boolean}} invocation - what to run.
 * @param {string[]} args - its arguments.
 * @param {{cwd: string, logFile: string, timeoutMs: number, env?: NodeJS.ProcessEnv}} options - the run.
 * @returns {Promise<{code: number | null, timedOut: boolean, error: string | null}>} the outcome.
 */
export function runCaptured(invocation, args, options) {
  const { cwd, logFile, timeoutMs, env = process.env } = options
  const say = (line) => appendLog(logFile, line)
  return new Promise((settle) => {
    let out
    try {
      out = openSync(logFile, 'a')
    } catch {
      settle({ code: null, timedOut: false, error: `cannot write ${logFile}` })
      return
    }
    say(`$ ${invocation.file} ${args.join(' ')}  (cwd ${cwd})`)
    let child
    let timedOut = false
    try {
      child = spawnNpm(invocation, args, { cwd, env, stdio: ['ignore', out, out] })
    } catch (error) {
      closeQuietly(out)
      settle({ code: null, timedOut, error: String(error?.message ?? error) })
      return
    }
    // The child holds its own duplicate; the parent's copy would leak.
    closeQuietly(out)
    const timer = setTimeout(() => {
      timedOut = true
      say(`! exceeded ${Math.round(timeoutMs / 1000)}s — killing the whole tree`)
      killTree(child)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ code: null, timedOut, error: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      say(`$ exit ${code ?? 'null'}${timedOut ? ' (timed out)' : ''}`)
      settle({ code, timedOut, error: null })
    })
  })
}

/**
 * Kill a child process AND its descendants.
 *
 * `child.kill()` signals only the process that was spawned. On Windows that is
 * `cmd.exe`, which dies on demand while npm and electron-builder carry on
 * running and writing into the output directory — so the NEXT sync starts a
 * second build beside the first and the two corrupt each other's artifact.
 * `taskkill /T` takes the tree down instead.
 * @param {import('node:child_process').ChildProcess} child - the process to kill.
 * @returns {void}
 */
function killTree(child) {
  const pid = child?.pid
  if (process.platform === 'win32' && typeof pid === 'number') {
    try {
      const result = spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      if (result.status === 0) return
    } catch {
      /* fall through to the direct signal */
    }
  }
  try {
    child?.kill()
  } catch {
    /* nothing left to signal */
  }
}

/**
 * Refresh the distributable zip from the packaged payload folder.
 *
 * The archive is written under a temporary name, validated, and only then moved
 * over the real one. That ordering is the point: the zip IS the artifact the
 * user ships, so a refresh that fails must leave the previous distributable in
 * place. The old code deleted the target first and wrote into the live path, so
 * one failed build meant no distributable at all, and a reader could pick up a
 * half-written archive in the meantime.
 *
 * Each platform's own archiver is tried first: `tar -a` on Windows (bsdtar
 * writes a real ZipFile there, in seconds) with the PowerShell cmdlet as the
 * fallback, and `zip` elsewhere — macOS `tar` cannot write a zip at all and GNU
 * tar only can from 1.35 on, so a single hardcoded tool cannot cover both.
 * @param {{outputRoot?: string, distDir?: string, folder?: string, productName?: string, zipPath: string, logFile: string, timeoutMs: number}} options - the archive.
 * @returns {Promise<{ok: boolean, error: string | null, size: number | null}>} the outcome.
 */
export async function refreshZip(options) {
  const { zipPath, logFile, timeoutMs } = options
  const outputRoot = options.outputRoot ?? options.distDir
  const folder = options.folder ?? options.productName
  const say = (line) => appendLog(logFile, line)
  if (typeof folder !== 'string' || folder.trim() === '') return { ok: false, error: 'there is no packaged folder to archive', size: null }
  const source = join(outputRoot, folder)
  if (!existsSync(source)) return { ok: false, error: `the packaged folder ${source} does not exist`, size: null }
  // The temporary name keeps the archive's own extension: `tar -a` picks the
  // format from it, and `DSH-Desktop-绿色版.zip.part` is not a name it recognizes
  // — the "zip" it then wrote was a plain tar, which the validation below
  // rejected, so every refresh failed after the build had already succeeded.
  const extension = extname(zipPath)
  const partial = extension === '' ? `${zipPath}.part` : `${zipPath.slice(0, -extension.length)}.part${extension}`
  try {
    if (existsSync(partial)) rmSync(partial, { force: true })
  } catch (error) {
    return { ok: false, error: `cannot clear ${partial}: ${String(error?.message ?? error)}`, size: null }
  }
  // Which archiver exists is a property of the host, not of the caller, and no
  // single one spans the platforms this plugin runs on: `tar -a -c` writes a
  // real ZipFile on Windows (bsdtar) but cannot write a zip on macOS and only
  // does with GNU tar 1.35+. So the platform's first choice runs first, and the
  // rest of the list is kept as a fallback — a host that has several tools
  // still gets an archive. On Unix the first choice is `zip`, which is the one
  // tool guaranteed to produce a zip on every distribution.
  let made = false
  const candidates = archiveCommands(partial, outputRoot, folder, source)
  if (candidates.length === 0) {
    say(`no archiver found on ${process.platform}: expected tar + Compress-Archive on Windows, or 'zip' on PATH elsewhere`)
  }
  for (const [index, candidate] of candidates.entries()) {
    const run = await runCaptured(candidate.invocation, candidate.args, { cwd: candidate.cwd ?? outputRoot, logFile, timeoutMs })
    made = run.code === 0 && existsSync(partial)
    // A failure that wrote a half archive would make the next candidate refuse
    // to overwrite it, so clear it before trying the next tool.
    if (!made) {
      say(`${candidate.label} failed (${run.error ?? `exit ${run.code}`})${index === 0 ? ' — trying the next archiver' : ''}`)
      try {
        if (existsSync(partial)) rmSync(partial, { force: true })
      } catch {
        /* a half-written archive is not worth keeping */
      }
    }
    if (made) break
  }
  if (!made) {
    return { ok: false, error: `could not rebuild ${basename(zipPath)} (the previous one is untouched)`, size: null }
  }
  const check = inspectZip(partial)
  if (!check.valid) {
    try {
      rmSync(partial, { force: true })
    } catch {
      /* an incomplete archive is useless anyway */
    }
    return { ok: false, error: `${basename(zipPath)} was written but is not a complete zip (${check.bytes ?? 0} bytes)`, size: check.bytes }
  }
  try {
    renameSync(partial, zipPath)
  } catch (error) {
    try {
      rmSync(partial, { force: true })
    } catch {
      /* the validated archive could not be moved, so it is not the distributable */
    }
    return { ok: false, error: `cannot move the new archive into place: ${String(error?.message ?? error)}`, size: check.bytes }
  }
  say(`refreshed ${basename(zipPath)} (${check.bytes} bytes) from ${folder}`)
  return { ok: true, error: null, size: check.bytes }
}

/**
 * Find an executable on PATH.
 *
 * `where`/`which` are avoided because spawning them costs a process and their
 * output differs by platform; the PATH walk is what both of them do anyway.
 * Windows also has the `.cmd`/`.bat` shims npm and the bundled tools install.
 * @param {string} name - the bare executable name (no directory).
 * @returns {string | null} the first match, or null when the tool is absent.
 */
function findExecutable(name) {
  const dirs = String(process.env.PATH ?? '').split(delimiter).filter((part) => part !== '')
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  // A service or GUI process can be started with a PATH that misses the
  // standard locations, so they are consulted as well; on Windows they are the
  // same directories PATH already covers, so this costs nothing there.
  const roots = process.platform === 'win32' ? dirs : [...dirs, '/usr/local/bin', '/usr/bin', '/bin']
  for (const dir of roots) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch {
        // A PATH entry can be unreadable (a disconnected drive); skip it.
      }
    }
  }
  return null
}

/**
 * The archivers to try, best first, for a host that must end up with a real zip.
 *
 * Windows keeps its historical order: bsdtar (which writes a ZipFile for a
 * `.zip` name) and then `Compress-Archive`. Elsewhere the first choice is
 * `zip`, because that is the only tool that produces a zip on every
 * distribution — macOS `tar` cannot, and GNU tar needs 1.35+. The caller has
 * already proved the folder exists, so `tar -C` and `zip -r` name it directly.
 * @param {string} partial - the archive to write.
 * @param {string} outputRoot - the directory holding the payload.
 * @param {string} folder - the payload directory name.
 * @param {string} source - the payload directory path.
 * @returns {{label: string, invocation: {file: string, viaShell: boolean}, args: string[], cwd: string}[]} ordered candidates.
 */
function archiveCommands(partial, outputRoot, folder, source) {
  const list = []
  if (process.platform === 'win32') {
    list.push({
      label: 'tar.exe',
      invocation: { file: 'tar.exe', viaShell: false },
      args: ['-a', '-c', '-f', partial, '-C', outputRoot, folder],
      cwd: outputRoot,
    })
    const script = `Compress-Archive -LiteralPath ${quotePowerShell(source)} -DestinationPath ${quotePowerShell(partial)} -Force`
    list.push({
      label: 'Compress-Archive',
      invocation: { file: 'powershell.exe', viaShell: false },
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      cwd: outputRoot,
    })
  }
  // On Unix `zip` is the first choice (and the only one that works on macOS);
  // on Windows it is the last resort for a host that has it but not the above.
  const zip = findExecutable('zip')
  if (zip !== null) {
    list.push({
      label: 'zip',
      invocation: { file: zip, viaShell: false },
      args: ['-r', '-q', '-X', partial, folder],
      cwd: outputRoot,
    })
  }
  return list
}

/**
 * Quote a value for a single-quoted PowerShell string.
 * @param {string} value - the raw value.
 * @returns {string} a safe `'…'` literal.
 */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

/**
 * Bring the desktop wrapper in step with a harness version.
 *
 * Order matters: the version is written first, so a build that fails still
 * leaves the project declaring the version it is about to be rebuilt for — and
 * the next run sees exactly what is left to do.
 * @param {object} args - the sync inputs.
 * @param {string | null} args.projectDir - the configured project directory, or null.
 * @param {string} [args.pluginDir] - this plugin's directory, for the sibling default.
 * @param {string} args.mode - `off`, `version` or `package`.
 * @param {string | null} args.harnessVersion - the version to sync to.
 * @param {string} args.logFile - where the run is logged.
 * @param {string | null} [args.buildCommand] - override for the build step (an argv array).
 * @param {boolean} [args.refreshZipArtifact] - whether to rebuild the zip too.
 * @param {string | null} [args.zipName] - the zip's file name inside `dist`.
 * @param {string | null} [args.productName] - the executable's base name; defaults to the manifest's `productName`.
 * @param {string | null} [args.zipSource] - the pinned payload folder to sync, or null to pick the newest.
 * @param {number} [args.timeoutMs] - one build's ceiling.
 * @param {NodeJS.ProcessEnv} [args.env] - the environment for child processes.
 * @param {(productName: string) => boolean | null} [args.appRunning] - the running-app probe (injected by tests).
 * @param {string | null} [args.lockDir] - the directory the build lock lives in (injected by tests).
 * @returns {Promise<object>} the outcome — never throws; failures are values.
 */
export async function syncDesktop(args) {
  const {
    projectDir = null,
    pluginDir = '',
    sourceDir = null,
    mode = 'package',
    harnessVersion = null,
    logFile,
    buildCommand = null,
    refreshZipArtifact = true,
    zipName = 'DSH-Desktop-绿色版.zip',
    productName = null,
    zipSource = null,
    timeoutMs = 30 * 60 * 1000,
    env = process.env,
    appRunning = desktopAppRunning,
    lockDir = null,
  } = args
  const started = Date.now()
  const say = (line) => appendLog(logFile, `desktop: ${line}`)
  const result = {
    mode,
    status: 'skipped',
    projectDir: null,
    harnessVersion,
    projectVersion: null,
    packagedVersion: null,
    payload: null,
    payloadLayout: null,
    drift: [],
    versionChanged: false,
    repackaged: false,
    zipRefreshed: false,
    zipSize: null,
    backup: null,
    detail: '',
    error: null,
    startedAt: started,
    finishedAt: started,
  }
  const finish = (patch) => ({ ...result, ...patch, finishedAt: Date.now() })

  const project = findDesktopProject(projectDir, pluginDir, sourceDir)
  if (mode === 'off') return finish({ status: 'skipped', detail: 'desktop sync is disabled' })
  if (harnessVersion === null) return finish({ status: 'skipped', detail: 'the harness version is unknown, so there is nothing to sync to' })
  if (project === null) {
    const searched = desktopCandidates(projectDir, pluginDir, sourceDir)
    return finish({ status: 'no-project', detail: `no ${PROJECT_NAME} project found; looked in ${searched.join(', ')}` })
  }
  result.projectDir = project.dir
  // The output directory is the project's to choose (`build.directories.output`),
  // so ask the manifest instead of assuming `dist`.
  const outputRoot = resolveOutputRoot(project.dir, project.manifest)
  // The executable is named after the manifest's `productName` — the field
  // electron-builder itself reads — so a hardcoded name would probe for a process
  // that does not exist and let a build run against a locked, open app.
  const appName = productName ?? (typeof project.manifest.productName === 'string' && project.manifest.productName.trim() !== ''
    ? project.manifest.productName.trim()
    : DEFAULT_PRODUCT_NAME)
  const zipPath = join(outputRoot, zipName)
  const plan = planDesktopSync({ project, mode, harnessVersion, zipPath, zipSource, zipExpected: refreshZipArtifact })
  result.projectVersion = plan.projectVersion
  result.packagedVersion = plan.packagedVersion
  result.payload = plan.payload
  result.payloadLayout = plan.payloadLayout
  result.drift = plan.drift
  if (plan.payload !== null && plan.drift.length > 0) say(`the packaged build drifted from the project: ${plan.drift.join(', ')}`)
  if (plan.zip !== null && !plan.zip.valid) say(`${zipName} is ${plan.zip.bytes === null ? 'missing' : `incomplete (${plan.zip.bytes} bytes)`}`)
  if (plan.action === 'up-to-date') return finish({ status: 'up-to-date', detail: plan.reason })
  say(`${plan.action}: ${plan.reason} → ${harnessVersion}`)

  // The app cannot be replaced while it is running: Windows locks a running
  // program's own files, so electron-builder would fail partway through and
  // leave a half-written payload where a good one was. Skipping is the honest
  // outcome — the stale state stays visible, with the reason attached.
  if (appRunning(appName) === true) {
    return finish({
      status: 'skipped',
      detail: `${appName} is running; close it and sync again (its files are locked while it runs)`,
    })
  }

  // One build per project at a time: the host can sync on demand while the
  // helper is syncing after an update, and two electron-builder runs writing the
  // same output directory corrupt each other's artifact.
  const lockIn = lockDir ?? featureDir(env)
  const lock = acquireBuildLock(lockIn, logFile)
  if (!lock.ok) {
    return finish({
      status: 'skipped',
      detail: `another desktop sync is already building (pid ${lock.holder?.pid ?? '?'})`,
    })
  }
  try {
    return await syncDesktopLocked({ project, outputRoot, zipPath, zipName, productName: appName, zipSource, mode, harnessVersion, logFile, buildCommand, refreshZipArtifact, timeoutMs, env, plan, say, finish })
  } finally {
    releaseBuildLock(lockIn)
  }
}

/**
 * The body of a desktop sync, with the build lock already held.
 * @param {object} args - the resolved inputs plus the plan.
 * @returns {Promise<object>} the outcome.
 */
async function syncDesktopLocked(args) {
  const { project, outputRoot, zipPath, zipName, productName, zipSource, harnessVersion, logFile, buildCommand, refreshZipArtifact, timeoutMs, env, plan, say, finish } = args

  // 1. the manifest, so the project declares what it is about to build
  let versionChanged = false
  let backup = null
  try {
    const written = writeManifestVersion(join(project.dir, 'package.json'), harnessVersion)
    versionChanged = written.changed
    backup = written.backup
    if (written.changed) say(`manifest version ${written.previous ?? '?'} → ${harnessVersion}${written.backup === null ? '' : ` (backup ${basename(written.backup)})`}`)
  } catch (error) {
    return finish({ status: 'failed', error: `cannot write the project manifest: ${String(error?.message ?? error)}`, detail: 'version' })
  }
  const patched = { versionChanged, backup, projectVersion: harnessVersion }
  if (plan.action === 'version') {
    return finish({ ...patched, status: 'version-synced', detail: `manifest synced to ${harnessVersion}; the packaged build is still ${plan.packagedVersion ?? 'not built'}` })
  }

  // 2. the build
  const invocation = buildCommand === null
    ? { file: 'npm.cmd', viaShell: true, args: ['run', 'dist:dir'] }
    : { file: buildCommand[0], viaShell: /\.(?:cmd|bat)$/iu.test(buildCommand[0]), args: buildCommand.slice(1) }
  say(`building: ${invocation.file} ${invocation.args.join(' ')}`)
  try {
    mkdirSync(outputRoot, { recursive: true })
  } catch {
    /* the build creates its own output directory */
  }
  const build = await runCaptured(invocation, invocation.args, { cwd: project.dir, logFile, timeoutMs, env })
  if (build.code !== 0) {
    return finish({
      ...patched,
      status: 'failed',
      error: `the desktop build exited with ${build.error ?? `code ${build.code}`}${build.timedOut ? ' (timed out)' : ''}`,
      detail: 'build',
    })
  }

  // 3. verify the ARTIFACT, not the exit code — and verify it against the project
  const packaged = readPackagedVersion(project.dir, { manifest: project.manifest, zipSource })
  const drift = packaged.root === null ? [] : bundleDrift({ layout: packaged.layout, root: packaged.root, file: packaged.file }, project.dir)
  const verified = {
    ...patched,
    packagedVersion: packaged.version,
    payload: packaged.folder,
    payloadLayout: packaged.layout,
    drift,
  }
  if (packaged.version !== harnessVersion) {
    return finish({
      ...verified,
      status: 'failed',
      error: `the build finished but the packaged app reports ${packaged.version ?? 'no version'}, not ${harnessVersion}`,
      detail: 'artifact',
    })
  }
  if (drift.length > 0) {
    return finish({
      ...verified,
      status: 'failed',
      error: `the packaged app names ${harnessVersion} but does not match the project: ${drift.join(', ')}`,
      detail: 'artifact',
    })
  }
  const repackaged = { ...verified, repackaged: true }

  // 4. the distributable
  if (refreshZipArtifact) {
    const zip = await refreshZip({ outputRoot, folder: packaged.folder, productName, zipPath, logFile, timeoutMs })
    if (!zip.ok) {
      return finish({ ...repackaged, status: 'packaged-no-zip', error: zip.error, detail: `rebuilt ${packaged.folder ?? productName} but could not refresh ${zipName}` })
    }
    return finish({
      ...repackaged,
      status: 'packaged',
      zipRefreshed: true,
      zipSize: zip.size,
      detail: `rebuilt ${packaged.folder ?? productName} at ${harnessVersion} and refreshed ${zipName}`,
    })
  }
  return finish({
    ...repackaged,
    status: 'packaged',
    detail: `rebuilt ${packaged.folder ?? productName} at ${harnessVersion}`,
  })
}

/**
 * Whether the packaged desktop app is running right now.
 *
 * `electron-builder` replaces the payload folder in place, and Windows will not
 * let it replace the files of a running program: a build started while the user
 * has the app open fails partway and leaves a half-written payload where a good
 * one was. So the app is asked about first, and a probe that cannot run reports
 * `null` (unknown) rather than blocking a sync it cannot judge.
 *
 * `tasklist` writes to a FILE, never a pipe: a confined harness cannot create
 * the pipe a captured stdio would need.
 * @param {string} productName - the executable's base name, without `.exe`.
 * @param {{timeoutMs?: number, probeFile?: string}} [options] - the probe's ceiling and scratch file.
 * @returns {boolean | null} running, not running, or unknown.
 */
export function desktopAppRunning(productName, options = {}) {
  if (process.platform !== 'win32' || typeof productName !== 'string' || productName.trim() === '') return null
  const { timeoutMs = 15_000, probeFile = join(tmpdir(), `dsh-desktop-probe-${process.pid}.txt`) } = options
  let out
  try {
    out = openSync(probeFile, 'w')
  } catch {
    return null
  }
  try {
    const probe = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${productName}.exe`, '/NH', '/FO', 'CSV'], {
      stdio: ['ignore', out, out],
      timeout: timeoutMs,
      windowsHide: true,
    })
    if (probe.error !== undefined && probe.error !== null) return null
  } catch {
    return null
  } finally {
    closeQuietly(out)
  }
  try {
    return readFileSync(probeFile, 'utf8').includes(`${productName}.exe`)
  } catch {
    return null
  } finally {
    try {
      rmSync(probeFile, { force: true })
    } catch {
      /* the scratch file is disposable */
    }
  }
}

/**
 * Take the desktop build lock.
 * @param {string} dir - the feature directory that holds the lock.
 * @param {string} logFile - the log to record a broken stale lock in.
 * @param {number} [staleMs] - the age at which a live-looking lock is presumed dead.
 * @returns {{ok: boolean, holder: object | null}} the outcome.
 */
function acquireBuildLock(dir, logFile, staleMs = 30 * 60 * 1000) {
  const file = join(dir, 'desktop-build.lock')
  const holder = readJson(file, null)
  if (holder !== null && typeof holder === 'object') {
    const age = Date.now() - (typeof holder.at === 'number' ? holder.at : 0)
    const alive = processAlive(holder.pid)
    if (age < staleMs && alive) return { ok: false, holder }
    appendLog(logFile, `desktop: breaking a stale build lock from pid ${holder.pid ?? '?'} (age ${Math.round(age / 1000)}s, alive=${alive})`)
  }
  ensureDir(dir)
  return writeJsonAtomic(file, { pid: process.pid, at: Date.now(), kind: 'desktop-build' })
    ? { ok: true, holder: null }
    : { ok: false, holder: null }
}

/**
 * Release the desktop build lock — this process's own, or a dead holder's.
 * @param {string} dir - the feature directory that holds the lock.
 * @returns {void}
 */
function releaseBuildLock(dir) {
  const file = join(dir, 'desktop-build.lock')
  const holder = readJson(file, null)
  if (holder !== null && typeof holder === 'object' && holder.pid !== process.pid && processAlive(holder.pid)) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* a lock that cannot be removed expires on its own */
  }
}
