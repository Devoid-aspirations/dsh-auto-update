/**
 * Idle detection: is the harness in the middle of someone's work right now?
 *
 * An unattended update restarts the process, so it has to happen between
 * turns, not during one. Two independent signals answer that, because either
 * one alone has a blind spot:
 *
 *   - **turn events** (`turn/start` / `turn/end` on the session bus) are exact
 *     but only exist while the session service is composed and mounted;
 *   - **session-file activity** (mtime under `$DSH_HOME/sessions`) is a
 *     heuristic, but it is right precisely where the first signal is missing —
 *     the harness is busy if it is writing a transcript.
 *
 * Busy wins: the tracker reports idle only when nothing is in flight and both
 * signals have been quiet for the configured window.
 * @module dsh-auto-update/idle
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** How deep the session-directory scan goes (`<project>/session-*.jsonl`). */
const MAX_SCAN_DEPTH = 2

/**
 * The newest modification time under a directory tree, bounded in both depth
 * and entries so a machine with thousands of sessions cannot make a periodic
 * check expensive.
 * @param {string} root - the directory to scan.
 * @param {{maxDepth?: number, maxEntries?: number}} [limits] - traversal bounds.
 * @returns {number | null} the newest mtime in ms, or null when nothing was found.
 */
export function newestMtime(root, limits = {}) {
  const { maxDepth = MAX_SCAN_DEPTH, maxEntries = 4000 } = limits
  let newest = null
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth || visited > maxEntries) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited > maxEntries) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const at = statSync(full).mtimeMs
        if (newest === null || at > newest) newest = at
      } catch {
        /* a file that vanished between readdir and stat contributes nothing */
      }
    }
  }
  walk(root, 1)
  return newest
}

/**
 * Build the idle tracker used by the scheduler.
 * @param {{sessionsDir?: string | null, now?: () => number, fileCacheMs?: number}} [options] - knobs.
 * @returns {object} the tracker.
 */
export function createIdleTracker(options = {}) {
  const { sessionsDir = null, now = Date.now, fileCacheMs = 1000 } = options
  /** Sessions whose turn is currently open, so a missed end cannot wedge it. */
  const openTurns = new Map()
  let lastEventAt = 0
  let lastFileScan = 0
  let lastFileActivity = null

  /**
   * Note the start of a turn.
   * @param {unknown} sessionId - the session's id, when known.
   * @returns {void}
   */
  const noteTurnStart = (sessionId) => {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : `anonymous-${openTurns.size}`
    openTurns.set(key, now())
    lastEventAt = now()
  }

  /**
   * Note the end of a turn.
   * @param {unknown} sessionId - the session's id, when known.
   * @returns {void}
   */
  const noteTurnEnd = (sessionId) => {
    if (typeof sessionId === 'string' && sessionId !== '') openTurns.delete(sessionId)
    else openTurns.clear()
    lastEventAt = now()
  }

  /**
   * Note unrelated activity that still means "someone is here".
   * @returns {void}
   */
  const noteActivity = () => {
    lastEventAt = now()
  }

  /**
   * Forget turns that have been open implausibly long.
   *
   * A `turn/end` that never arrives — a killed client, a crashed loop — would
   * otherwise leave the tracker convinced the harness is busy forever, which
   * turns "wait for idle" into "never update". The ceiling is generous because
   * a real agent turn can legitimately run for a long time.
   * @param {number} [maxTurnMs] - the ceiling in ms.
   * @returns {number} how many stale turns were dropped.
   */
  const dropStaleTurns = (maxTurnMs = 6 * 60 * 60 * 1000) => {
    const cutoff = now() - maxTurnMs
    let dropped = 0
    for (const [key, at] of openTurns) {
      if (at < cutoff) {
        openTurns.delete(key)
        dropped += 1
      }
    }
    return dropped
  }

  /**
   * The newest session-transcript write, refreshed at most once per cache
   * window (the tracker is polled far more often than a transcript changes).
   * @param {boolean} [fresh] - read the tree now instead of reusing the cache;
   *   the apply decision must never act on a stale answer.
   * @returns {number | null} mtime in ms, or null when there is nothing to read.
   */
  const fileActivity = (fresh = false) => {
    if (sessionsDir === null) return null
    const at = now()
    if (!fresh && fileCacheMs > 0 && at - lastFileScan < fileCacheMs) return lastFileActivity
    lastFileScan = at
    lastFileActivity = newestMtime(sessionsDir)
    return lastFileActivity
  }

  /**
   * Whether the harness has been quiet for the configured window.
   * @param {number} idleSeconds - how long "quiet" means.
   * @returns {boolean} true when an update may proceed.
   */
  const isIdle = (idleSeconds) => {
    dropStaleTurns()
    if (openTurns.size > 0) return false
    const windowMs = Math.max(0, idleSeconds) * 1000
    const at = now()
    // Ages are clamped at zero: a filesystem timestamp can sit a few
    // milliseconds AHEAD of the clock (NTFS granularity), and a negative age
    // read literally would keep the harness permanently busy.
    if (Math.max(0, at - lastEventAt) < windowMs) return false
    const fileAt = fileActivity(true)
    if (fileAt !== null && Math.max(0, at - fileAt) < windowMs) return false
    return true
  }

  /**
   * A description of the current state, for the status document and the log.
   * @returns {{idle: boolean, openTurns: number, sinceLastEventMs: number | null, lastFileActivityMs: number | null}} the report.
   */
  const describe = () => {
    const at = now()
    const fileAt = fileActivity()
    return {
      idle: openTurns.size === 0,
      openTurns: openTurns.size,
      sinceLastEventMs: lastEventAt === 0 ? null : at - lastEventAt,
      lastFileActivityMs: fileAt === null ? null : at - fileAt,
    }
  }

  return { noteTurnStart, noteTurnEnd, noteActivity, dropStaleTurns, isIdle, describe, fileActivity }
}
