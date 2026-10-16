/**
 * Machine-local paths for the scripts in this directory.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These diagnostics were written on one machine and had that machine's paths —
 * the home directory, the npm global root, the checkout — pasted into each of
 * them as string literals. That made every script wrong on any other machine
 * (and wrong on the author's own the moment the checkout moved), which is the
 * first thing a reader of a published copy would hit.
 *
 * So every path here is DERIVED, in this order of preference:
 *
 *   1. an environment variable, when the caller sets one;
 *   2. a value computed from the running process (its own location, the npm
 *      that launched the harness, the user profile);
 *   3. a platform-appropriate default.
 *
 * Nothing is hardcoded to a user name or a drive letter.
 * @module dsh-auto-update/scripts/env
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDshHome } from '../lib/paths.js'

const IS_WIN = process.platform === 'win32'
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

/** This checkout's root — the directory that contains `lib/`, `test/`, `scripts/`. */
export const PLUGIN_DIR = resolve(SCRIPTS_DIR, '..')

/** `$DSH_HOME` when set, else `~/.dsh` (the same rule the plugin itself uses). */
export const DSH_HOME = resolveDshHome(process.env, homedir())

/** Which profile to inspect; `DSH_PROFILE` overrides, `web` is the default. */
export const PROFILE_NAME = (process.env.DSH_PROFILE ?? 'web').trim() || 'web'

/** The profile's root (`$DSH_HOME/profiles/<name>`). */
export const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)

/** The profile's installed packages. */
export const PROFILE_MODULES = join(PROFILE_DIR, 'node_modules')

/** Whether a path is an existing regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every extension a runnable command can carry on this platform. */
const EXTS = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : ['']

/**
 * Find an executable on `PATH` (plus, on Windows, the npm global bin
 * directory, which a GUI-launched process often has missing from `PATH`).
 * @param {string} name - the command name, without extension.
 * @returns {string | null} the path, or null when it is nowhere to be found.
 */
function onPath(name) {
  const dirs = [
    ...String(process.env.PATH ?? '').split(IS_WIN ? ';' : ':'),
    ...(IS_WIN ? [join(process.env.APPDATA ?? '', 'npm')] : []),
  ].filter((dir) => dir !== '')
  for (const dir of dirs) {
    for (const ext of EXTS) {
      const candidate = join(dir, `${name}${ext}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * The directory npm installs global packages into.
 *
 * `npm root -g` is the only answer that stays right across nvm, fnm, Volta and
 * a plain installer, so it is asked, with the conventional locations as a
 * fallback for when npm is not runnable at all.
 * @returns {string} the global root.
 */
export function resolveGlobalRoot() {
  const configured = process.env.DSH_AUTO_UPDATE_GLOBAL_ROOT
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  // npm's own CLI is preferred over the `npm` shim: it is a `.js` file, so it
  // runs without a shell, which keeps this off the DEP0190 path entirely and
  // works the same on every platform.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (isFile(npmCli)) {
    const probe = spawnSync(process.execPath, [npmCli, 'root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const printed = String(probe.stdout ?? '').trim()
    if (probe.status === 0 && printed !== '') return printed
  }
  return IS_WIN
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules')
    : join(homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules')
}

/**
 * The installed `@deepseek-ai/dsh` package directory.
 * @returns {string} the package directory (whether or not it exists).
 */
export function resolveHarnessDir() {
  const configured = process.env.DSH_AUTO_UPDATE_HARNESS_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(resolveGlobalRoot(), '@deepseek-ai', 'dsh')
}

/**
 * The `@deepseek-ai` directory the installed harness keeps its own dependencies
 * in — what `runningPackageSet` needs to answer "does it still ship this?".
 * @returns {string} the scoped modules directory.
 */
export function resolveHarnessScope() {
  return join(resolveHarnessDir(), 'node_modules', '@deepseek-ai')
}

/**
 * The harness CLI entry point to launch a second instance with.
 * @returns {string} `.../@deepseek-ai/dsh/lib/bin.js`.
 */
export function resolveDshBin() {
  const configured = process.env.DSH_AUTO_UPDATE_DSH_BIN
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(resolveHarnessDir(), 'lib', 'bin.js')
}

/**
 * A usable pnpm.
 *
 * pnpm is not beside `node` the way npm is — it is wherever the user's chosen
 * installer put it — so this asks `PATH`, then pnpm's own global bin directory.
 * (Real-path, not the corepack shim: this is meant to run unattended.)
 * @returns {string | null} the executable, or null when pnpm is not installed.
 */
export function resolvePnpm() {
  const configured = process.env.DSH_AUTO_UPDATE_PNPM
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromPath = onPath('pnpm')
  if (fromPath !== null) return fromPath
  const pnpmHome = process.env.PNPM_HOME
  if (typeof pnpmHome === 'string' && pnpmHome.trim() !== '') {
    for (const ext of EXTS) {
      const candidate = join(pnpmHome, `pnpm${ext}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/** A path with forward slashes, for `file:` dependency specs and npm. */
export function toSpecPath(path) {
  return path.split(sep).join('/')
}

/**
 * Print the paths this module resolved — the first thing to check when a
 * script reports it cannot find something.
 * @returns {void}
 */
export function reportPaths() {
  const lines = [
    `plugin dir   : ${PLUGIN_DIR}`,
    `DSH home     : ${DSH_HOME}`,
    `profile      : ${PROFILE_DIR}`,
    `harness dir  : ${resolveHarnessDir()}${existsSync(resolveHarnessDir()) ? '' : '  (NOT FOUND)'}`,
    `pnpm         : ${resolvePnpm() ?? '(not found)'}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
