/**
 * Release pre-flight: the three things that must agree before a tag is pushed.
 *
 * A release of this plugin is not just "the tests pass". It is the claim that
 * three separate copies of the same version string agree, and a `file:` install
 * breaks that claim silently, because the profile keeps a *copy* rather than a
 * link:
 *
 *   1. the repository manifest      package.json `version`      — what the tag names
 *   2. the installed copy           <profile>/node_modules/dsh-auto-update
 *   3. the running plugin           STATUS_PATH `pluginVersion`
 *
 * Copy 2 is what the user will actually run; copy 3 is what they are running
 * right now. Bumping 1 without re-installing 2 is the documented footgun
 * (README "Releases"): the banner in `$DSH_HOME/auto-update/update.log` keeps
 * printing the old number and the helper keeps importing old code. Worse, it
 * changes `ownVersion()` only on paper — so a "release" can exist on disk that
 * nothing has ever executed.
 *
 * So the checks are, in order:
 *   - the version is a plain `x.y.z` (no prerelease, no build metadata): the
 *     helper's plan/tag mapping and the `[plugin x.y.z]` commit convention both
 *     read it literally.
 *   - `git status --porcelain` is empty: a release is a commit, and a tag on a
 *     dirty tree cannot be reproduced from the repository.
 *   - the installed copy exists and its manifest reports the same version. This
 *     is the one that catches a forgotten re-install. A missing copy is a WARN
 *     (the plugin may simply not be installed on this machine) — but a *present*
 *     copy that disagrees is a FAIL, because that is exactly the broken state.
 *   - if a harness answers on the loopback port, its `pluginVersion` must match
 *     too. Unreachable is a SKIP: on a release machine the harness may not be
 *     running (and must not be restarted just to satisfy a checker).
 *
 * Deliberately not done here: installing the copy, restarting the harness,
 * tagging, pushing, `npm publish`. This script only *reads* state; the mutating
 * steps are in the README checklist where a human decides them, because every
 * one of them is observable to a running session.
 *
 * Usage:
 *   node scripts/release-check.mjs [--profile web] [--port 3080] [--json]
 *
 * Exit codes: 0 = every check passed (skips allowed), 1 = at least one FAIL,
 * 2 = the script could not read its own repository.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root — this file lives in `scripts/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read one `--flag value` pair, with a default.
 * @param {string[]} argv - process arguments.
 * @param {string} flag - the flag name, including dashes.
 * @param {string} fallback - the value when the flag is absent.
 * @returns {string} the value.
 */
function option(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  if (index === -1 || argv[index + 1] === undefined) return fallback
  return argv[index + 1]
}

const argv = process.argv.slice(2)
const PROFILE = option(argv, '--profile', process.env.DSH_PROFILE ?? 'web')
const PORT = Number(option(argv, '--port', process.env.DSH_WEB_PORT ?? '3080'))
const AS_JSON = argv.includes('--json')

/** @type {Array<{check: string, verdict: 'pass'|'fail'|'warn'|'skip', detail: string}>} */
const results = []

/**
 * Record one check.
 * @param {string} check - what was checked.
 * @param {'pass'|'fail'|'warn'|'skip'} verdict - the outcome.
 * @param {string} detail - the evidence, single line.
 */
function record(check, verdict, detail) {
  results.push({ check, verdict, detail })
}

/**
 * Read and parse a JSON file.
 * @param {string} path - the file.
 * @returns {object} the parsed document.
 * @throws {Error} when the file is missing or not JSON.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ── 1. the repository manifest ───────────────────────────────────────────────

/** The version this checkout claims to be. */
let repoVersion = null
try {
  const manifest = readJson(join(ROOT, 'package.json'))
  repoVersion = typeof manifest.version === 'string' ? manifest.version : null
  if (repoVersion === null) record('repo manifest has a version', 'fail', `${join(ROOT, 'package.json')} has no string "version"`)
  else record('repo version', 'pass', `package.json version = ${repoVersion}`)
} catch (error) {
  process.stderr.write(`cannot read the repository manifest: ${String(error?.message ?? error)}\n`)
  process.exit(2)
}

if (repoVersion !== null) {
  const plain = /^\d+\.\d+\.\d+$/u.test(repoVersion)
  record(
    'version is a plain x.y.z',
    plain ? 'pass' : 'fail',
    plain ? repoVersion : `${repoVersion} is not x.y.z — the helper maps plan targets and the "[plugin x.y.z]" commit convention both read the version literally`,
  )
}

// ── 2. the release is committed ──────────────────────────────────────────────

try {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (status === '') {
    record('working tree is clean', 'pass', 'git status --porcelain is empty')
  } else {
    const lines = status.split(/\r?\n/u)
    record('working tree is clean', 'fail', `${lines.length} uncommitted path(s): ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''}`)
  }
} catch (error) {
  record('working tree is clean', 'skip', `git unavailable: ${String(error?.message ?? error).split('\n')[0]}`)
}

// ── 3. the installed copy (the one that actually runs) ───────────────────────

const copyDir = join(homedir(), '.dsh', 'profiles', PROFILE, 'node_modules', 'dsh-auto-update')
try {
  const installed = readJson(join(copyDir, 'package.json'))
  if (installed.version === repoVersion) {
    record('installed copy matches the repo', 'pass', `${copyDir} → ${installed.version}`)
  } else {
    record(
      'installed copy matches the repo',
      'fail',
      `${copyDir} → ${installed.version}, repo → ${repoVersion}: re-install (Remove-Item the copy, then "dsh plugin --profile ${PROFILE} add \\"file:$PWD\\"") and restart before tagging`,
    )
  }
} catch (error) {
  record('installed copy matches the repo', 'warn', `no readable copy at ${copyDir} — the plugin is not installed for profile "${PROFILE}" here (${String(error?.code ?? error?.message ?? error)})`)
}

// ── 4. the running plugin (may legitimately not be running) ─────────────────‐

if (repoVersion !== null) {
  const url = `http://127.0.0.1:${PORT}/auto-update/api/v1/status`
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` },
      signal: AbortSignal.timeout(5000),
    })
    const body = response.ok ? await response.json() : null
    const running = body?.pluginVersion ?? null
    if (running === null) {
      record('running plugin reports the same version', 'skip', `${url} → HTTP ${response.status} without a pluginVersion field`)
    } else if (running === repoVersion) {
      record('running plugin reports the same version', 'pass', `pluginVersion = ${running}`)
    } else {
      record('running plugin reports the same version', 'fail', `pluginVersion = ${running}, repo → ${repoVersion}: the running instance still has the old copy loaded — restart the harness`)
    }
  } catch (error) {
    record('running plugin reports the same version', 'skip', `nothing answering on 127.0.0.1:${PORT} (${String(error?.cause?.code ?? error?.message ?? error)})`)
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

const failed = results.filter((entry) => entry.verdict === 'fail')

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ version: repoVersion, profile: PROFILE, port: PORT, results, ok: failed.length === 0 }, null, 2)}\n`)
} else {
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }
  for (const entry of results) process.stdout.write(`${mark[entry.verdict]}  ${entry.check}\n        ${entry.detail}\n`)
  process.stdout.write(failed.length === 0 ? `\nrelease pre-flight: OK (${repoVersion})\n` : `\nrelease pre-flight: ${failed.length} failure(s) — do not tag ${repoVersion}\n`)
}

process.exit(failed.length === 0 ? 0 : 1)
