/**
 * Filesystem layout, atomic writes and append-only logging under
 * `$DSH_HOME/auto-update`.
 *
 * Everything this plugin persists lives in ONE directory so an operator can
 * read it, copy it into a bug report, or delete it to reset the feature. The
 * detached helper links against this module too, which is why it depends on
 * nothing but `node:fs`/`node:os`/`node:path`.
 * @module dsh-auto-update/paths
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** State file schema id; bumped when the shape changes incompatibly. */
export const STATE_SCHEMA = 'dsh-auto-update/v1'

/**
 * The harness home directory.
 * `$DSH_HOME` wins when set (the launcher resolves profiles through it), and
 * the historical `~/.dsh` is the fallback.
 * @param {NodeJS.ProcessEnv} [env] - environment, injectable for tests.
 * @param {string} [home] - the user's home directory, injectable for tests.
 * @returns {string} the absolute harness home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(home, '.dsh')
}

/**
 * The feature's own directory, created on demand.
 * @param {NodeJS.ProcessEnv} [env] - environment.
 * @param {string} [home] - home directory.
 * @returns {string} the absolute directory path.
 */
export function featureDir(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), 'auto-update')
}

/** The persisted state file. */
export function statePath(dir) {
  return join(dir, 'state.json')
}

/** The append-only log the plugin, the helper and the GUI share. */
export function logPath(dir) {
  return join(dir, 'update.log')
}

/** The in-flight guard; its presence means an update is being applied. */
export function lockPath(dir) {
  return join(dir, 'update.lock')
}

/** Where a helper job descriptor is written before the helper is spawned. */
export function planPath(dir, stamp) {
  return join(dir, `plan-${stamp}.json`)
}

/**
 * A file-local timestamp that is safe in a filename on every platform.
 * @param {Date} [now] - the instant to stamp.
 * @returns {string} e.g. `2026-02-04T09-31-07-123Z`.
 */
export function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * Create a directory (and its parents) when missing.
 * @param {string} dir - the directory path.
 * @returns {string} the same path, for chaining.
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Read a JSON file, tolerating every ordinary way it can be absent or broken.
 *
 * A leading byte-order mark is stripped: PowerShell's `Set-Content`/`Out-File`
 * write one by default on Windows, and `JSON.parse` rejects a document that
 * starts with one — so a hand-maintained manifest would read as "no file here".
 * @param {string} file - the path.
 * @param {unknown} [fallback] - value for a missing or unreadable file.
 * @returns {any} the parsed value or the fallback.
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    return fallback
  }
}

/**
 * Write JSON atomically: a same-directory temp file renamed over the target,
 * so a reader never sees a half-written state file and a crash never leaves a
 * truncated one.
 * @param {string} file - the destination path.
 * @param {unknown} value - the value to serialize.
 * @returns {boolean} true when the write landed.
 */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  try {
    ensureDir(join(file, '..'))
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* the temp file is best-effort garbage collection */
    }
    return false
  }
}

/**
 * Append one line to a log file, timestamped.
 * Logging never throws: a full disk must not take the harness down with it.
 * @param {string} file - the log path.
 * @param {string} line - the message (newlines are kept, the prefix is not repeated).
 * @returns {void}
 */
export function appendLog(file, line) {
  const text = String(line)
  const body = `${text.endsWith('\n') ? text : `${text}\n`}`
  try {
    ensureDir(join(file, '..'))
    appendFileSync(file, `[${new Date().toISOString()}] ${body}`, 'utf8')
  } catch {
    /* logging is best-effort by design */
  }
}

/**
 * Read the tail of a log file.
 * @param {string} file - the log path.
 * @param {number} [maxLines] - how many trailing lines to keep.
 * @returns {string[]} the lines, oldest first; empty when unreadable.
 */
export function readLogTail(file, maxLines = 200) {
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/u).filter((line) => line !== '')
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

/**
 * Rotate a log file once it grows past a ceiling, so a long-lived install
 * cannot fill the disk with one feature's history.
 * @param {string} file - the log path.
 * @param {number} [maxBytes] - rotate above this size.
 * @returns {boolean} whether a rotation happened.
 */
export function rotateLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size <= maxBytes) return false
    const previous = `${file}.1`
    try {
      rmSync(previous, { force: true })
    } catch {
      /* a missing previous rotation is the normal case */
    }
    renameSync(file, previous)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a process is alive, without signalling it destructively.
 * `process.kill(pid, 0)` is the POSIX idiom and works on Windows too.
 * @param {number | null | undefined} pid - the process id.
 * @returns {boolean} true when the process exists.
 */
export function processAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/**
 * Acquire the update lock, breaking a stale one left by a crashed run.
 * @param {string} dir - the feature directory.
 * @param {{staleMs?: number, kind?: string}} [options] - staleness ceiling and label.
 * @returns {{ok: boolean, holder?: object, reason?: string}} the outcome; on
 *   failure `holder` carries the existing lock's record.
 */
export function acquireLock(dir, options = {}) {
  const { staleMs = 45 * 60 * 1000, kind = 'update' } = options
  const file = lockPath(dir)
  const holder = readJson(file, null)
  if (holder !== null && typeof holder === 'object') {
    const age = Date.now() - (typeof holder.at === 'number' ? holder.at : 0)
    const alive = processAlive(holder.pid)
    if (age < staleMs && alive) return { ok: false, holder, reason: 'busy' }
    appendLog(logPath(dir), `lock: breaking a stale lock from pid ${holder.pid ?? '?'} (age ${Math.round(age / 1000)}s, alive=${alive})`)
  }
  ensureDir(dir)
  const record = { pid: process.pid, at: Date.now(), kind, boot: `${process.pid}-${Date.now()}` }
  return writeJsonAtomic(file, record) ? { ok: true, holder: record } : { ok: false, reason: 'unwritable' }
}

/**
 * Release the update lock.
 *
 * This process may release a lock it owns, and it may also clear one whose
 * holder is no longer alive: nothing is left to release that lock, and keeping
 * it only makes the next acquire log a "breaking a stale lock" line about a
 * process that died long ago.
 * @param {string} dir - the feature directory.
 * @returns {void}
 */
export function releaseLock(dir) {
  const file = lockPath(dir)
  const holder = readJson(file, null)
  const ours = holder !== null && typeof holder === 'object' && holder.pid === process.pid
  if (holder !== null && typeof holder === 'object' && !ours && processAlive(holder.pid)) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* a lock that cannot be removed expires on its own */
  }
}

/**
 * Close a descriptor this process opened, tolerating a stdio token such as
 * `'ignore'` and a descriptor that was never opened. Closing the parent's copy
 * of a spawn target is always safe: the child holds its own duplicate.
 * @param {number | string} fd - the descriptor, or the token used in its place.
 * @returns {void}
 */
export function closeQuietly(fd) {
  if (typeof fd !== 'number') return
  try {
    closeSync(fd)
  } catch {
    /* an already-closed descriptor is not worth reporting */
  }
}

/** The plan files `planPath` writes; nothing else in the directory matches. */
const PLAN_FILE = /^plan-.*\.json$/

/**
 * Remove the plan files old updates left behind.
 *
 * Every apply writes one and nothing ever removed them, so an installation that
 * has been updating for months accumulates one file per update forever. The
 * window is generous: a plan is the record of what an in-flight helper is doing,
 * so only plans far older than any run can be are pruned.
 * @param {string} dir - the feature directory.
 * @param {{keepMs?: number, now?: number}} [options] - how long to keep them.
 * @returns {string[]} the names that were removed.
 */
export function prunePlans(dir, options = {}) {
  const { keepMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = options
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (!PLAN_FILE.test(name)) continue
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs < keepMs) continue
      rmSync(file, { force: true })
      removed.push(name)
    } catch {
      /* a plan that cannot be inspected or removed is not worth failing over */
    }
  }
  return removed
}
