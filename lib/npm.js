/**
 * Everything the feature needs to know about the npm side of the machine:
 * which npm to drive, where the harness package actually lives, what version
 * is on disk, and how to install a global upgrade while streaming its output
 * into our log.
 *
 * The install is the one irreversible step in this feature, so the identity
 * checks here are deliberately strict: the running harness must be a global
 * npm install of the expected package before anything is written.
 * @module dsh-auto-update/npm
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { appendLog, closeQuietly } from './paths.js'

/** The package this feature updates. */
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/**
 * How long one `npm install -g` may take before it is killed.
 * A cold global install over a slow link is minutes, not seconds; the market
 * uses the same 15-minute ceiling for its own plugin installs.
 * @returns {number} the timeout in milliseconds.
 */
export function installTimeoutMs() {
  const configured = Number(process.env.DSH_AUTO_UPDATE_INSTALL_TIMEOUT_MS)
  if (Number.isFinite(configured) && configured > 0) return configured
  return 15 * 60 * 1000
}

/**
 * Argument-free way to describe an npm invocation: how to start it, and
 * whether a shell has to do the starting.
 * @typedef {{file: string, viaShell: boolean, source: string}} NpmInvocation
 */

/**
 * Whether a file exists and is a file.
 * @param {string} path - the candidate.
 * @returns {boolean} true when it is a regular file.
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Locate a usable npm.
 *
 * The Node installation that runs this process always ships npm beside its own
 * binary, so that directory is probed before PATH — a Windows host started
 * from a GUI can have a PATH without the Node directory in it (a case the
 * market hit in #167). `npm.ps1` is skipped on purpose: a default Restricted
 * PowerShell execution policy refuses it before it can run.
 * @param {{npmBin?: string | null, env?: NodeJS.ProcessEnv, execPath?: string}} [options] - knobs.
 * @returns {NpmInvocation} the invocation to spawn.
 */
export function resolveNpm(options = {}) {
  const { npmBin = null, env = process.env, execPath = process.execPath } = options
  const win = process.platform === 'win32'
  const names = win ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm']

  if (typeof npmBin === 'string' && npmBin.trim() !== '') {
    const explicit = npmBin.trim()
    if (isFile(explicit)) {
      return { file: explicit, viaShell: win && /\.(?:cmd|bat)$/iu.test(explicit), source: 'config' }
    }
    // A bare name is still useful (it resolves through PATH at spawn time).
    return { file: explicit, viaShell: win, source: 'config-name' }
  }

  const fromEnv = env.DSH_AUTO_UPDATE_NPM
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const candidate = fromEnv.trim()
    return { file: candidate, viaShell: win && /\.(?:cmd|bat)$/iu.test(candidate), source: 'env' }
  }

  const nodeDir = dirname(execPath)
  for (const name of names) {
    const candidate = join(nodeDir, name)
    if (isFile(candidate)) return { file: candidate, viaShell: win && name.endsWith('.cmd'), source: 'node-dir' }
  }

  const pathDirs = String(env.PATH ?? '').split(delimiter).filter((part) => part !== '')
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return { file: candidate, viaShell: win && name.endsWith('.cmd'), source: 'path' }
    }
  }

  return { file: win ? 'npm.cmd' : 'npm', viaShell: win, source: 'fallback' }
}

/**
 * Spawn a resolved npm invocation.
 *
 * Windows `.cmd` shims cannot start without a shell, and Node's
 * `shell: true` + argv form is deprecated (DEP0190), so the shim path goes
 * through `cmd.exe /d /s /c` with an explicitly built, quoted command line.
 * @param {NpmInvocation} npm - the invocation.
 * @param {string[]} args - its arguments.
 * @param {import('node:child_process').SpawnOptions} options - spawn options.
 * @returns {import('node:child_process').ChildProcess} the child.
 */
export function spawnNpm(npm, args, options) {
  if (!npm.viaShell || process.platform !== 'win32') {
    return spawn(npm.file, args, { ...options, shell: false, windowsHide: true })
  }
  const quote = (part) => (/[\s"&|<>^()%!]/u.test(part) ? `"${part.replace(/"/g, '""')}"` : part)
  const line = [npm.file, ...args].map(quote).join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true,
    windowsHide: true,
  })
}

/**
 * Run one npm command, capturing its output THROUGH FILES rather than pipes.
 *
 * Not a style choice: a harness running under a confinement layer can be
 * forbidden from creating the pipes `spawn` uses for `stdio: 'pipe'` (and
 * `spawnSync`'s capture) — the spawn then fails with EPERM before npm ever
 * runs. Files are always writable where the feature is already writing its
 * own state, so this path works in the environments the pipe path does not.
 * @param {NpmInvocation} npm - the invocation.
 * @param {string[]} args - the arguments.
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv, outFile?: string | null, errFile?: string | null, prefix?: string}} [options]
 *   - knobs; `outFile`/`errFile` receive the streams when given.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean, error: Error | null}>} the outcome.
 */
export function spawnCaptured(npm, args, options = {}) {
  const {
    timeoutMs = 30000,
    env = process.env,
    outFile = null,
    errFile = null,
    prefix = 'dsh-auto-update-',
  } = options
  const scratch = outFile === null || errFile === null ? mkdtempSync(join(tmpdir(), prefix)) : null
  const outPath = outFile ?? join(scratch, 'stdout.log')
  const errPath = errFile ?? join(scratch, 'stderr.log')
  const readOrEmpty = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  return new Promise((settle) => {
    let outFd
    let errFd
    try {
      outFd = openSync(outPath, 'a')
      errFd = openSync(errPath, 'a')
    } catch (error) {
      if (scratch !== null) rmSync(scratch, { recursive: true, force: true })
      settle({ code: null, stdout: '', stderr: '', timedOut: false, error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    const finish = (result) => {
      try {
        rmSync(scratch ?? join(tmpdir(), 'never'), { recursive: true, force: true })
      } catch {
        /* scratch cleanup is best-effort */
      }
      settle(result)
    }
    let child
    let timedOut = false
    try {
      child = spawnNpm(npm, args, { env, stdio: ['ignore', outFd, errFd] })
    } catch (error) {
      closeQuietly(outFd)
      closeQuietly(errFd)
      finish({ code: null, stdout: readOrEmpty(outPath), stderr: readOrEmpty(errPath), timedOut, error: error instanceof Error ? error : new Error(String(error)) })
      return
    }
    // The child writes through its own duplicates of these descriptors; keeping
    // the parent's copies open would leak one handle per npm run.
    closeQuietly(outFd)
    closeQuietly(errFd)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* reported through the timeout flag */
      }
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({
        code: null,
        stdout: readOrEmpty(outPath),
        stderr: readOrEmpty(errPath),
        timedOut,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stdout: readOrEmpty(outPath), stderr: readOrEmpty(errPath), timedOut, error: null })
    })
  })
}

/**
 * Run one npm command and collect its output.
 * @param {NpmInvocation} npm - the invocation.
 * @param {string[]} args - the arguments.
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv}} [options] - knobs.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean, error: Error | null}>} the outcome.
 */
export function runNpm(npm, args, options = {}) {
  const { timeoutMs = 30000, env = process.env } = options
  return spawnCaptured(npm, args, { timeoutMs, env })
}

/**
 * The directory of the package that is running this process.
 *
 * `process.argv[1]` is the CLI entry (`…/@deepseek-ai/dsh/lib/bin.js`), which
 * makes this the running installation rather than whichever copy happens to
 * sort first on the disk — the distinction that decides whether installing a
 * new version changes anything at all.
 * @param {string[]} [argv] - argv, injectable for tests.
 * @returns {string | null} the package directory, or null for a layout we cannot read.
 */
export function runningHarnessDir(argv = process.argv) {
  const entry = argv[1]
  if (typeof entry !== 'string' || entry === '') return null
  const absolute = resolve(entry)
  // …/«pkg»/lib/bin.js  →  …/«pkg»
  const packageDir = dirname(dirname(absolute))
  const manifest = readManifest(packageDir)
  if (manifest !== null) return packageDir
  // Source layout: …/apps/cli/src/bin.ts or …/apps/cli/lib/bin.js
  const appDir = dirname(dirname(packageDir))
  return readManifest(appDir) === null ? null : appDir
}

/**
 * Read and validate a package manifest.
 * @param {string} dir - the package directory.
 * @param {string} [name] - the package name it must declare; omit to accept any.
 * @returns {{name: string, version: string} | null} the manifest, or null when
 *   the directory is not that package.
 */
export function readManifest(dir, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof manifest?.version !== 'string') return null
    if (typeof manifest?.name !== 'string') return null
    if (name !== undefined && manifest.name !== name) return null
    return { name: manifest.name, version: manifest.version }
  } catch {
    return null
  }
}

/**
 * The installed version of a package rooted at `dir`.
 * @param {string} dir - the package directory.
 * @param {string} [name] - the expected package name.
 * @returns {string | null} the version, or null.
 */
export function versionAt(dir, name = HARNESS_PACKAGE) {
  const manifest = readManifest(dir, name)
  return manifest === null ? null : manifest.version
}

/**
 * npm's global root — where a global install writes packages.
 * @param {NpmInvocation} npm - the npm invocation.
 * @returns {Promise<string | null>} the absolute path, or null when npm cannot say.
 */
export async function globalRoot(npm) {
  const result = await runNpm(npm, ['root', '-g'], { timeoutMs: 30000 })
  if (result.code !== 0) return null
  const path = result.stdout.trim().split(/\r?\n/u).pop()?.trim()
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * Whether a package directory sits inside npm's global root.
 * @param {string} packageDir - the harness package directory.
 * @param {string} root - npm's global root.
 * @returns {boolean} true when the install is the one a global install owns.
 */
export function isInsideGlobalRoot(packageDir, root) {
  if (typeof root !== 'string' || root === '') return false
  const normalize = (value) => resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
  return normalize(packageDir).startsWith(normalize(root))
}

/**
 * The version of the harness package a global root currently holds.
 * @param {NpmInvocation} npm - the npm invocation.
 * @param {string} [name] - the package name.
 * @returns {Promise<string | null>} the on-disk version, or null.
 */
export async function installedGlobalVersion(npm, name = HARNESS_PACKAGE) {
  const root = await globalRoot(npm)
  if (root === null) return null
  return versionAt(join(root, ...name.split('/')), name)
}

/**
 * Every global package directory npm's root holds — the raw material for
 * picking an install root when the harness itself cannot be found.
 * @param {string} root - npm's global root.
 * @returns {string[]} absolute package directories.
 */
export function globalPackageDirs(root) {
  const out = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('@')) {
        const scope = join(root, entry.name)
        try {
          for (const scoped of readdirSync(scope, { withFileTypes: true })) {
            if (scoped.isDirectory() || scoped.isSymbolicLink()) out.push(join(scope, scoped.name))
          }
        } catch {
          /* an unreadable scope contributes nothing */
        }
        continue
      }
      out.push(join(root, entry.name))
    }
  } catch {
    /* an unreadable root contributes nothing */
  }
  return out
}

/**
 * Install one global package spec, streaming npm's output into our log.
 *
 * The output is kept in a bounded ring so a failure can quote npm's own words
 * back to the operator without holding a megabyte of progress bars in memory.
 * @param {NpmInvocation} npm - the npm invocation.
 * @param {string} spec - e.g. `@deepseek-ai/dsh@0.2.0-rc.2`.
 * @param {{registry?: string | null, logFile?: string | null, timeoutMs?: number, env?: NodeJS.ProcessEnv, onProgress?: (line: string) => void}} [options]
 *   - knobs; `logFile` receives every line as it arrives.
 * @returns {Promise<{code: number | null, timedOut: boolean, output: string, lines: string[]}>} the outcome.
 */
export async function installGlobal(npm, spec, options = {}) {
  const {
    registry = null,
    logFile = null,
    timeoutMs = installTimeoutMs(),
    env = process.env,
    onProgress = null,
    installArgs = [],
  } = options
  const args = ['install', '-g', spec, '--no-audit', '--no-fund', '--loglevel=error']
  // Operator-supplied extras come before the explicit registry so the config
  // key still wins, and they are passed as separate argv entries — never
  // concatenated into one string.
  for (const extra of installArgs) {
    if (typeof extra === 'string' && extra !== '') args.push(extra)
  }
  if (typeof registry === 'string' && registry !== '') args.push(`--registry=${registry}`)
  // npm's own output goes straight to the log file: a detached helper has no
  // pipe to read, and npm's progress lines are exactly what an operator needs
  // when an install fails at 3am.
  const result = await spawnCaptured(npm, args, {
    timeoutMs,
    env,
    outFile: typeof logFile === 'string' && logFile !== '' ? logFile : null,
    errFile: typeof logFile === 'string' && logFile !== '' ? logFile : null,
  })
  const text = `${result.stdout}${result.stderr}`
  const lines = text.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line !== '').slice(-400)
  if (typeof logFile === 'string' && logFile !== '') {
    appendLog(logFile, `npm install ${spec} exited with code ${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`)
  }
  if (typeof onProgress === 'function') {
    for (const line of lines.slice(-20)) {
      try {
        onProgress(line)
      } catch {
        /* a progress sink must never break the install */
      }
    }
  }
  return {
    code: result.code,
    timedOut: result.timedOut,
    output: lines.join('\n'),
    lines,
    error: result.error,
  }
}

/**
 * Whether a directory looks like a source checkout rather than an installed
 * package — the check that stops an automatic update from overwriting a
 * developer's working tree.
 * @param {string} dir - the harness package directory.
 * @returns {boolean} true when it is a checkout.
 */
export function looksLikeSourceCheckout(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  if (existsSync(join(dir, 'src')) && existsSync(join(dir, 'tsconfig.json'))) return true
  if (!dir.includes(`${delimiter === ';' ? '\\' : '/'}node_modules`)) {
    // Not under a node_modules directory at all: pnpm workspaces and repo
    // checkouts live at `apps/cli`.
    return /[\\/]apps[\\/]/u.test(dir) || !dir.includes('node_modules')
  }
  return false
}
