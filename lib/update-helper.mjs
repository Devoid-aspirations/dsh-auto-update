/**
 * The detached update helper.
 *
 * Started by the plugin with a plan file and deliberately outliving the
 * harness it is replacing, this process is the only thing in the feature that
 * mutates the installation. It runs one linear transaction:
 *
 *   install the target version → verify what npm actually wrote → ask the
 *   running harness to step aside → wait for its port → bring a replacement
 *   up (when nobody else owns that job) → wait until it answers with the new
 *   version → on a boot that never comes, put the old version back.
 *
 * It is a separate process for one reason: the process that installs a new
 * harness cannot also be the process being replaced. Every phase writes to
 * `helper.json` and to the shared log, because when this works the harness
 * restarts and the only account of what happened is what was written down
 * beforehand.
 * @module dsh-auto-update/update-helper
 */

import { openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELPER_FILE, HELPER_SCHEMA, SHUTDOWN_PATH, STATUS_PATH, TOKEN_HEADER } from './protocol.js'
import { appendLog, closeQuietly, processAlive, readJson, writeJsonAtomic, rotateLog } from './paths.js'
import { installGlobal, installedGlobalVersion, globalRoot, resolveNpm, versionAt } from './npm.js'
import { syncDesktop } from './desktop.js'
import { inspectTree, treeFingerprint } from './tree.js'
import {
  healthCheck,
  portListening,
  respawnInvocation,
  resolveRestartMode,
  sleep,
  spawnDetached,
  waitForPortFree,
} from './restart.js'

/** The fallback shape of the plan, so a truncated file fails loudly, not subtly. */
const REQUIRED_PLAN_KEYS = ['package', 'fromVersion', 'toVersion', 'dir', 'logFile', 'pid', 'url', 'port']

/** This plugin's own directory — the desktop project is looked for beside it. */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Load and validate the plan.
 * @param {string} file - the plan path from argv.
 * @returns {object} the plan.
 * @throws {Error} when the file is missing or incomplete.
 */
function loadPlan(file) {
  const plan = readJson(file, null)
  if (plan === null || typeof plan !== 'object') throw new Error(`plan file ${file} is missing or unreadable`)
  for (const key of REQUIRED_PLAN_KEYS) {
    if (plan[key] === undefined || plan[key] === null) throw new Error(`plan file ${file} has no «${key}»`)
  }
  return plan
}

/**
 * Create the helper's logger and state writer for one run.
 * @param {object} plan - the validated plan.
 * @returns {{say: (message: string) => void, state: (patch: object) => void, read: () => object}} the helpers.
 */
function makeReporter(plan) {
  const stateFile = join(plan.dir, HELPER_FILE)
  const startedAt = Date.now()
  const say = (message) => appendLog(plan.logFile, `helper[${process.pid}]: ${message}`)
  const read = () => readJson(stateFile, null) ?? {}
  const state = (patch) => {
    const previous = read()
    writeJsonAtomic(stateFile, {
      ...previous,
      schema: HELPER_SCHEMA,
      pid: process.pid,
      startedAt,
      updatedAt: Date.now(),
      package: plan.package,
      from: plan.fromVersion,
      target: plan.toVersion,
      ...patch,
    })
  }
  return { say, state, read }
}

/**
 * Ask the running harness to exit, then make sure it actually did.
 *
 * The polite path is the helper's own shutdown route, which lets the harness
 * dispose its tree and flush sessions. Killing the pid is the fallback for a
 * harness that has already stopped answering; it is never the first choice,
 * because a SIGTERM'd harness is exactly the case where a supervisor's
 * restart-on-exit behaviour differs from a clean shutdown.
 * @param {object} plan - the plan.
 * @param {(message: string) => void} say - the logger.
 * @returns {Promise<boolean>} whether the old harness left its port.
 */
async function stopHost(plan, say) {
  const grace = (plan.timeouts?.stopGraceSeconds ?? 30) * 1000
  let asked = false
  if (typeof plan.shutdownUrl === 'string' && plan.shutdownUrl !== '' && typeof plan.token === 'string') {
    try {
      const response = await fetch(plan.shutdownUrl, {
        method: 'POST',
        headers: {
          [TOKEN_HEADER]: plan.token,
          'content-type': 'application/json',
          // The shutdown route refuses a mutation that carries no same-origin
          // Origin header. Without this the graceful path answered 403 every
          // time, and every update killed the harness with SIGTERM instead of
          // letting it dispose its tree and flush its sessions.
          origin: new URL(plan.shutdownUrl).origin,
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      })
      asked = response.ok || response.status === 202
      say(asked ? `shutdown accepted by the harness (HTTP ${response.status})` : `shutdown request refused (HTTP ${response.status})`)
    } catch (error) {
      say(`shutdown request failed: ${String(error?.message ?? error)}`)
    }
  }
  if (!asked && Number.isInteger(plan.pid) && plan.pid > 0 && plan.pid !== process.pid) {
    // A hard kill is the fallback, not the plan: a SIGTERM'd harness skips the
    // disposal a clean shutdown performs.
    say(`falling back to SIGTERM for pid ${plan.pid}`)
    try {
      process.kill(plan.pid, 'SIGTERM')
      asked = true
    } catch (error) {
      say(`SIGTERM failed: ${String(error?.message ?? error)}`)
    }
  }

  const until = Date.now() + grace
  while (Date.now() < until) {
    const listening = await portListening({ port: plan.port })
    const alive = processAlive(plan.pid)
    if (!listening && !alive) return true
    if (!listening) {
      // The port is what the replacement needs; a lingering parent that no
      // longer serves is fine, but note it so a stuck disposal is visible.
      say(`port ${plan.port} is free while pid ${plan.pid} is still alive`)
      return true
    }
    await sleep(400)
  }
  say(`the harness did not leave port ${plan.port} within ${Math.round(grace / 1000)}s`)
  return false
}

/**
 * Start a replacement harness detached from this helper.
 * @param {object} plan - the plan, carrying the invocation to replay.
 * @param {(message: string) => void} say - the logger.
 * @returns {{pid: number | null, error: Error | null}} the started process.
 */
function spawnReplacement(plan, say) {
  const launch = plan.launch
  if (launch === null || typeof launch !== 'object' || typeof launch.file !== 'string') {
    say('no launch invocation recorded in the plan — cannot start a replacement')
    return { pid: null, error: new Error('no-launch-invocation') }
  }
  const spec = respawnInvocation(launch)
  const outFile = join(plan.dir, 'harness-restart.out.log')
  const errFile = join(plan.dir, 'harness-restart.err.log')
  let out = 'ignore'
  let err = 'ignore'
  try {
    out = openSync(outFile, 'a')
    err = openSync(errFile, 'a')
  } catch {
    /* falling back to discarded output is better than not starting at all */
  }
  const started = spawnDetached(spec, {
    cwd: typeof launch.cwd === 'string' && launch.cwd !== '' ? launch.cwd : process.cwd(),
    env: process.env,
    out,
    err,
    onError: (error) => say(`could not start the replacement: ${String(error?.message ?? error)}`),
    onExit: (code) => say(`the replacement exited with code ${code ?? 'null'}`),
  })
  // The child owns duplicates of both descriptors; holding the parent's copies
  // open would leak a handle for the rest of this helper's life.
  closeQuietly(out)
  closeQuietly(err)
  if (started.error !== null) {
    say(`could not start the replacement: ${String(started.error.message)}`)
    return { pid: null, error: started.error }
  }
  say(`replacement started (pid ${started.pid}) via ${spec.file}`)
  return { pid: started.pid, error: null }
}

/**
 * Wait until the harness answers with the expected version.
 *
 * A single answer is not enough — a boot that fails its own activation audit
 * has already bound the port by the time it refuses the composition — so the
 * service must keep answering with the right version for a settle window.
 * A 404 on the status route — and a 200 that carries no `running` string — are
 * both treated as "up but unverifiable": the harness itself is running, which
 * is what the rollback decision turns on, and the plugin needing a fix is not a
 * reason to reinstall the old harness. Rolling a healthy update back because
 * our own route could not name the version once destroyed a good 0.2.0-rc.2
 * install, so the port answering is the evidence that decides it.
 * @param {object} plan - the plan.
 * @param {string} expected - the version the replacement should report.
 * @param {{timeoutSeconds: number, say: (message: string) => void}} options - knobs.
 * @returns {Promise<{ok: boolean, reason: string, running: string | null, verified: boolean}>} the verdict.
 */
async function verifyRunning(plan, expected, options) {
  const { timeoutSeconds, say } = options
  const settleMs = (plan.timeouts?.settleSeconds ?? 8) * 1000
  const deadline = Date.now() + timeoutSeconds * 1000
  let steadySince = null
  let lastRunning = null
  let lastReason = 'nothing answered'
  /**
   * Accept a replacement that answers on its own port while our route cannot
   * name its version. The port is what the decision turns on, and the answer
   * has to hold for the settle window so a boot that fails its own audit after
   * binding the port is not mistaken for a healthy one.
   * @param {string} reason - what could not be confirmed, for the log and the verdict.
   * @returns {Promise<boolean>} whether the settle window has passed.
   */
  const acceptUnverified = async (reason) => {
    lastRunning = null
    lastReason = reason
    if (!(await portListening({ port: plan.port }))) {
      steadySince = null
      return false
    }
    if (steadySince === null) steadySince = Date.now()
    else if (Date.now() - steadySince >= settleMs) {
      // One more look once the window is up: the route is usually registered a
      // moment after the port first answers, so a late sample often turns
      // "unverified" into a named success. A miss changes nothing — the port is
      // still what the decision turns on.
      const late = await healthCheck({ url: plan.url, path: STATUS_PATH, timeoutMs: 3000 })
      const named = late.ok && typeof late.running === 'string' ? late.running : null
      if (named !== null) lastRunning = named
      say(`${reason} — accepting the replacement as up but unverified${named === null ? '' : ` (the route named ${named} on a late check)`}`)
      return true
    }
    return false
  }
  while (Date.now() < deadline) {
    const health = await healthCheck({ url: plan.url, path: STATUS_PATH, timeoutMs: 3000 })
    if (health.ok) {
      const isNewBoot = health.bootId === null || health.bootId !== plan.bootId
      if (health.running === expected && isNewBoot) {
        lastRunning = health.running
        lastReason = `serving ${expected}`
        if (steadySince === null) steadySince = Date.now()
        else if (Date.now() - steadySince >= settleMs) {
          return { ok: true, reason: `the replacement is serving ${expected}`, running: expected, verified: true }
        }
      } else if (health.running === null) {
        // The route answered but named no version: the harness is up and our own
        // endpoint is registered, we simply cannot read the version from it.
        if (await acceptUnverified('the service answered, but the auto-update route reported no version')) {
          return { ok: true, reason: lastReason, running: null, verified: false }
        }
      } else {
        steadySince = null
        lastRunning = health.running
        lastReason = `the service reports ${health.running}, expected ${expected}`
      }
    } else if (health.status === 404) {
      // The harness is up; our own route is not registered (a plugin that did
      // not load). Confirm the port answers and accept it, loudly.
      if (await acceptUnverified('the harness is serving, but the auto-update route is not registered')) {
        return { ok: true, reason: lastReason, running: null, verified: false }
      }
    } else {
      steadySince = null
      lastReason = health.error ?? 'no answer'
    }
    await sleep(700)
  }
  say(`verification window closed: ${lastReason}`)
  return { ok: false, reason: `no healthy ${expected} within ${timeoutSeconds}s (${lastReason})`, running: lastRunning, verified: false }
}

/**
 * Put the previous version back after a replacement never came up.
 * @param {object} plan - the plan.
 * @param {object} context - the reporter and logger.
 * @returns {Promise<{ok: boolean, reason: string}>} the outcome.
 */
async function rollback(plan, context) {
  const { say, state } = context
  state({ phase: 'rolling-back', error: null })
  say(`rolling back to ${plan.fromVersion}`)
  const npm = resolveNpm({ npmBin: plan.npm?.file ?? null })
  const install = await installGlobal(npm, `${plan.package}@${plan.fromVersion}`, {
    registry: plan.registry ?? null,
    installArgs: Array.isArray(plan.installArgs) ? plan.installArgs : [],
    logFile: plan.logFile,
    timeoutMs: (plan.timeouts?.installSeconds ?? 900) * 1000,
    env: process.env,
  })
  if (install.code !== 0) {
    return { ok: false, reason: `reinstalling ${plan.fromVersion} failed with code ${install.code}` }
  }
  const restored = await installedGlobalVersion(npm, plan.package)
  if (restored !== plan.fromVersion) {
    return { ok: false, reason: `npm reports ${restored} on disk after reinstalling ${plan.fromVersion}` }
  }
  if (plan.restart === true) {
    const mode = resolveRestartMode({ restartMode: plan.restartMode ?? 'auto' }, plan.supervisor ?? null)
    if (mode === 'respawn') {
      spawnReplacement(plan, say)
    } else {
      say('restart is owned by the shell — waiting for it to bring the old version back')
    }
    const verdict = await verifyRunning(plan, plan.fromVersion, {
      timeoutSeconds: Math.min(90, plan.timeouts?.healthSeconds ?? 150),
      say,
    })
    if (!verdict.ok) return { ok: false, reason: `the rolled-back version never came up (${verdict.reason})` }
  }
  return { ok: true, reason: `restored ${plan.fromVersion}` }
}

/**
 * Bring the packaged desktop wrapper in step with the version just installed.
 *
 * Deliberately non-fatal and deliberately LAST: by the time this runs the
 * harness is installed, restarted and answering, so a desktop build that fails
 * — a missing toolchain, a full disk, an Electron download — must not turn a
 * successful harness update into a failed one. Its outcome is recorded either
 * way, and the panel shows it.
 * @param {object} plan - the plan, carrying the desktop block.
 * @param {object} context - the reporter.
 * @param {string} version - the version to sync the wrapper to.
 * @returns {Promise<object | null>} the sync outcome, or null when it is off.
 */
async function syncDesktopAfterUpdate(plan, context, version) {
  const { say, state } = context
  const desktop = plan.desktop ?? null
  const mode = desktop?.mode ?? 'off'
  if (mode === 'off') return null
  say(`desktop sync (${mode}) → ${version}`)
  state({ phase: 'desktop-syncing' })
  const result = await syncDesktop({
    projectDir: desktop?.projectDir ?? null,
    pluginDir: PLUGIN_DIR,
    sourceDir: desktop?.sourceDir ?? null,
    mode,
    harnessVersion: version,
    logFile: plan.logFile,
    buildCommand: desktop?.buildCommand ?? null,
    refreshZipArtifact: desktop?.refreshZip !== false,
    zipName: desktop?.zipName ?? 'DSH-Desktop-绿色版.zip',
    zipSource: desktop?.zipSource ?? null,
    timeoutMs: (desktop?.timeoutMinutes ?? 30) * 60 * 1000,
    env: process.env,
  })
  state({ desktop: result })
  say(`desktop sync: ${result.status}${result.error === null || result.error === undefined ? '' : ` — ${result.error}`} (${result.detail})`)
  return result
}

/**
 * Windows reports "the old package could not be moved out of the way" as
 * EBUSY/EPERM, with errno -4082. Matching that shape is what keeps the retry
 * narrow: a missing version or a registry refusal must never cost the user a
 * harness restart.
 */
const LOCKED_TREE = /EBUSY|EPERM|resource busy|being used by another process|errno\s*-4082/iu

/**
 * Every piece of text an npm outcome carries.
 *
 * `installGlobal` streams npm's output into the log file and returns it as
 * `output`/`lines` (not `stderr`), so a matcher that only looked at `stderr`
 * would see nothing at all — which is exactly the bug that made the original
 * failure look like a bare exit code.
 *
 * @param {{stderr?: string, stdout?: string, output?: string, lines?: string[], error?: Error | null}} failure - one npm outcome.
 * @returns {string} the searchable text.
 */
function failureText(failure) {
  const parts = [failure.stderr, failure.stdout, failure.output, failure.error?.message]
  if (Array.isArray(failure.lines)) parts.push(failure.lines.join('\n'))
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n')
}

/**
 * @param {object} failure - one npm outcome.
 * @returns {boolean} whether npm failed because the install tree was in use.
 */
function looksLikeLockedTree(failure) {
  return LOCKED_TREE.test(failureText(failure))
}

/**
 * The sentence that goes into the record when npm fails.
 *
 * An exit code alone is what made the 0.2.2-rc.3 incident unreadable: the code
 * was 4294963214 (that is -4082 unsigned) and the line explaining it
 * (`EBUSY … rename …`) only ever reached update.log. The last few `npm error`
 * lines are the part a human can act on.
 *
 * @param {{code?: number | null, stderr?: string, stdout?: string, output?: string, lines?: string[], timedOut?: boolean, error?: Error | null}} failure - one npm outcome.
 * @returns {string} the reason to record.
 */
function describeInstallFailure(failure) {
  if (failure.timedOut === true) return 'npm install timed out'
  const exit = failure.code === null || failure.code === undefined ? 'no exit code' : `exit code ${failure.code}`
  const lines = failureText(failure)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const meaningful = lines.filter((line) => /^npm\s+(error|ERR!)/iu.test(line))
  const picked = (meaningful.length > 0 ? meaningful : lines).slice(-3).join(' | ')
  if (picked === '') return `npm install failed (${exit})`
  const trimmed = picked.length > 400 ? `${picked.slice(0, 400)}…` : picked
  return `npm install failed (${exit}): ${trimmed}`
}

/**
 * Start the version that is still on disk after a failed attempt, and wait for
 * it to answer.
 *
 * Only reached after the harness was asked to stop, where the alternative is a
 * machine with nothing listening on the port — so "started" is worth verifying
 * before the record claims it.
 *
 * @param {object} plan - the validated plan.
 * @param {{say: (message: string) => void}} context - the reporter.
 * @returns {Promise<{ok: boolean, reason: string}>} whether it came back.
 */
async function restartInstalledVersion(plan, context) {
  const { say } = context
  const mode = resolveRestartMode({ restartMode: plan.restartMode ?? 'auto' }, plan.supervisor ?? null)
  if (mode !== 'respawn') {
    say('the restart is owned by the process supervisor — it brings the harness back')
    return { ok: false, reason: 'the restart is owned by the process supervisor' }
  }
  const started = spawnReplacement(plan, say)
  if (started.error !== null) {
    say('starting the installed version failed')
    return { ok: false, reason: 'the replacement could not be started' }
  }
  const healthSeconds = plan.timeouts?.healthSeconds ?? 150
  const verdict = await verifyRunning(plan, plan.fromVersion, {
    timeoutSeconds: Math.min(20, Math.round(healthSeconds * 0.2)),
    say,
  })
  say(verdict.ok ? 'the installed version is serving again' : `the installed version did not answer: ${verdict.reason}`)
  return verdict
}

/**
 * Watch the install tree while npm runs.
 *
 * npm can finish the reify — the package directory holds the target — and then
 * fail to exit: a locked descriptor, a wedged cleanup, a wrapper that outlived
 * its child. The helper cannot tell that apart from a hang by npm's exit code
 * alone, so it reads the one thing npm cannot misreport: the tree on disk. Once
 * the target is there, waiting for npm to admit it buys nothing, and one real
 * upgrade sat in `installing` for twenty minutes because it did.
 *
 * What counts as "there" is `inspectTree` plus a quiet window: the version in
 * the manifest is not the install (see `inspectTree`), and a tree that is still
 * being unpacked is not quiet either, so a landing has to survive two samples
 * (about eight seconds) with an identical fingerprint.
 * @param {string | null} packageDir - the harness package directory.
 * @param {object} plan - the update plan.
 * @param {() => void} onLanded - called once, when the target is really installed.
 * @param {(line: string) => void} say - the reporter.
 * @returns {() => void} stops watching.
 */
function watchInstallTree(packageDir, plan, onLanded, say) {
  if (packageDir === null) return () => {}
  let landed = false
  let lastFingerprint = null
  let quietSamples = 0
  let announcedWaiting = false
  const timer = setInterval(() => {
    if (landed) return
    let version = null
    try {
      version = versionAt(packageDir, plan.package)
    } catch {
      return
    }
    if (version !== plan.toVersion) return
    const tree = inspectTree(packageDir, plan.package, plan.toVersion)
    if (!tree.ok) {
      quietSamples = 0
      lastFingerprint = null
      if (!announcedWaiting) {
        announcedWaiting = true
        say(`${plan.toVersion} is in the manifest but the tree is still being written (${tree.reason}) — waiting for npm to finish`)
      }
      return
    }
    const fingerprint = treeFingerprint(packageDir)
    if (fingerprint === null || fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint
      quietSamples = 1
      return
    }
    quietSamples += 1
    if (quietSamples < 2) return
    landed = true
    clearInterval(timer)
    onLanded()
  }, 4000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Install the target, but stop waiting once the tree holds it.
 * @param {NpmInvocation} npm - the invocation.
 * @param {object} plan - the update plan.
 * @param {object} installOptions - `installGlobal` knobs.
 * @param {(line: string) => void} say - the reporter.
 * @param {string | null} packageDir - where the package lives on disk.
 * @returns {Promise<object>} npm's outcome, marked `salvaged` when the wait was cut short.
 */
async function installWithSalvage(npm, plan, installOptions, say, packageDir) {
  const controller = new AbortController()
  let salvaged = false
  const stopWatching = watchInstallTree(packageDir, plan, () => {
    salvaged = true
    say(`${plan.toVersion} is on disk while npm is still running — not waiting for npm to exit`)
    controller.abort()
  }, say)
  try {
    const result = await installGlobal(npm, `${plan.package}@${plan.toVersion}`, {
      ...installOptions,
      signal: controller.signal,
    })
    // npm's own outcome is kept even when it was stopped: `aborted: true` and
    // `code: null` are the difference between "npm finished" and "the tree was
    // believed over the process", and the caller checks the tree again on the
    // strength of that difference.
    return salvaged ? { ...result, code: 0, error: null, salvaged: true } : result
  } finally {
    stopWatching()
  }
}

/**
 * Run one update transaction, start to finish.
 * @param {object} plan - the update plan.
 * @param {{say: (line: string) => void, state: (patch: object) => void}} context - the reporter.
 * @returns {Promise<void>} resolves when the transaction is over.
 */
async function run(plan, context) {
  const { say, state } = context
  const npm = resolveNpm({ npmBin: plan.npm?.file ?? null })
  const timeouts = plan.timeouts ?? {}
  say(`plan: ${plan.package} ${plan.fromVersion} -> ${plan.toVersion}; host pid ${plan.pid}; supervisor ${plan.supervisor ?? 'none'}; restart ${plan.restart === false ? 'no' : (plan.restartMode ?? 'auto')}`)
  state({ phase: 'starting', error: null, verified: null, restartMode: plan.restartMode ?? 'auto' })

  // ── the version on disk is the precondition, not the running version: a
  // previous helper may have installed this very target and then failed to
  // restart, in which case installing again is pointless but harmless, and
  // a DIFFERENT version means someone else already acted.
  const root = await globalRoot(npm)
  const packageDir = root === null ? null : join(root, ...plan.package.split('/'))
  const before = packageDir === null ? null : versionAt(packageDir, plan.package)
  say(`on-disk version before install: ${before ?? 'unknown'}`)
  if (before !== null && before !== plan.fromVersion && before !== plan.toVersion) {
    state({ phase: 'failed', error: `on-disk version changed to ${before} since the plan was written` })
    say(`aborting: on-disk version is ${before}, neither ${plan.fromVersion} nor ${plan.toVersion}`)
    return
  }

  const installOptions = {
    registry: plan.registry ?? null,
    installArgs: Array.isArray(plan.installArgs) ? plan.installArgs : [],
    logFile: plan.logFile,
    timeoutMs: (timeouts.installSeconds ?? 900) * 1000,
    env: process.env,
  }
  let install = null
  let hostStopped = false
  if (before !== plan.toVersion) {
    state({ phase: 'installing' })
    install = await installWithSalvage(npm, plan, installOptions, say, packageDir)
    if (install.code !== 0 && looksLikeLockedTree(install)) {
      // The tree npm has to replace is held open by the harness that runs from
      // it, so no retry can succeed while that process lives: on Windows the
      // restore of the old package fails with EBUSY and leaves the install
      // alone. Step aside first — and only for this failure. Any other npm
      // error is reported without touching the running harness.
      say('npm could not replace the install tree because the running harness holds it open — stopping the harness first')
      state({ phase: 'stopping', detail: 'the install tree is in use; stopping the harness before the retry' })
      hostStopped = await stopHost(plan, say)
      if (!hostStopped) {
        const reason = `the install tree is in use and the running harness did not exit; ${describeInstallFailure(install)}`
        say(reason)
        state({ phase: 'deferred', error: null, detail: reason })
        return
      }
      state({ phase: 'installing', detail: 'retrying the install with the harness stopped' })
      install = await installWithSalvage(npm, plan, installOptions, say, packageDir)
    }
    if (install.code !== 0) {
      const reason = describeInstallFailure(install)
      say(reason)
      if (hostStopped) {
        // Nothing is serving the port any more, so a failed retry has to put
        // the old version back up before it is reported.
        const back = await restartInstalledVersion(plan, context)
        state({
          phase: 'failed',
          error: reason,
          detail: `the harness was stopped to retry the install; ${back.ok ? `${plan.fromVersion} is serving again` : `the previous version could not be confirmed: ${back.reason}`}`,
        })
      } else {
        state({ phase: 'failed', error: reason })
      }
      return
    }
  } else {
    say(`${plan.toVersion} is already on disk — skipping the install`)
  }

  const installed = await installedGlobalVersion(npm, plan.package)
  if (installed !== plan.toVersion) {
    const reason = `npm left ${installed ?? 'nothing readable'} on disk instead of ${plan.toVersion}`
    say(reason)
    // pnpm's release-age policy and lagging mirrors both turn an explicit
    // target into a different build; the old version is still installed, so
    // there is nothing to restore — only to report.
    state({ phase: 'failed', error: reason })
    return
  }
  // The version in the manifest is not the install. npm writes that field
  // first and unpacks the dependency tree afterwards; on 2026-11-27 the helper
  // trusted it, stopped npm mid-reify, and the replacement died in 0.6 s with
  // `ERR_MODULE_NOT_FOUND … dsh-app-boot\index.js`. `watchInstallTree` now only
  // lands on a complete tree, so a hole here means npm itself stopped early —
  // in which case it gets one plain run to finish rather than a restart on a
  // half-installed release.
  let tree = inspectTree(packageDir, plan.package, plan.toVersion)
  if (!tree.ok) {
    const salvaged = install !== null && install.salvaged === true
    say(`the tree is not complete yet: ${tree.reason}${salvaged ? ' (npm had been stopped early)' : ''} — letting npm finish`)
    state({ phase: 'installing', detail: 'finishing an incomplete install' })
    const finish = await installGlobal(npm, `${plan.package}@${plan.toVersion}`, installOptions)
    tree = inspectTree(packageDir, plan.package, plan.toVersion)
    if (!tree.ok) {
      const reason = `the install is incomplete: ${tree.reason}; ${finish.code === 0 ? 'npm reported success anyway' : describeInstallFailure(finish)}`
      say(reason)
      if (hostStopped) {
        const back = await restartInstalledVersion(plan, context)
        state({
          phase: 'failed',
          error: reason,
          detail: `the harness was stopped for the install; ${back.ok ? `${plan.fromVersion} is serving again` : `the previous version could not be confirmed: ${back.reason}`}`,
        })
      } else {
        state({ phase: 'failed', error: reason })
      }
      return
    }
    say(`the tree is complete after npm finished: ${tree.reason}`)
  }
  say(`${plan.toVersion} is on disk`)
  state({ phase: 'installed', installedVersion: installed })

  if (plan.restart !== true) {
    state({ phase: 'deferred', error: null, detail: 'installed; a restart is needed to take effect' })
    say('restart disabled by configuration — the new version takes effect on the next start')
    return
  }

  state({ phase: 'stopping' })
  // The retry path above may already have stopped it; a second request would
  // hit a dead port and then a dead pid.
  const stopped = hostStopped || await stopHost(plan, say)
  if (!stopped) {
    // The install is good and the new version is on disk. Killing a harness
    // that would not step aside risks two hosts fighting for one port, and
    // rolling back would throw away a successful install — so say exactly
    // what is true: it is installed, it is not loaded yet.
    state({ phase: 'deferred', error: null, detail: 'the running harness did not exit; the new version is installed and loads on the next restart' })
    say('the running harness did not exit — deferring to the next restart')
    return
  }

  const mode = resolveRestartMode({ restartMode: plan.restartMode ?? 'auto' }, plan.supervisor ?? null)
  say(`restart mode: ${mode}`)
  if (mode === 'respawn') {
    const started = spawnReplacement(plan, say)
    if (started.error !== null) {
      say('the replacement could not be started')
    }
  } else {
    say('the restart is owned by the process supervisor — waiting for it')
  }

  state({ phase: 'verifying' })
  const healthSeconds = timeouts.healthSeconds ?? 150
  const verdict = await verifyRunning(plan, plan.toVersion, {
    timeoutSeconds: Math.round(healthSeconds * 0.6),
    say,
  })
  if (verdict.ok) {
    state({ phase: 'succeeded', error: null, verified: verdict.verified, detail: verdict.reason })
    say(`update complete: ${verdict.reason}`)
    await syncDesktopAfterUpdate(plan, context, plan.toVersion)
    state({ phase: 'succeeded' })
    return
  }
  say(`verification failed: ${verdict.reason}`)

  // A supervisor may simply be slower than the first window; only respawn
  // ourselves when nobody else is trying.
  if (mode === 'exit-only') {
    say('the supervisor did not bring the harness back in time — starting it ourselves')
    spawnReplacement(plan, say)
    const second = await verifyRunning(plan, plan.toVersion, {
      timeoutSeconds: Math.round(healthSeconds * 0.4),
      say,
    })
    if (second.ok) {
      state({ phase: 'succeeded', error: null, verified: second.verified, detail: second.reason })
      say(`update complete after a fallback start: ${second.reason}`)
      await syncDesktopAfterUpdate(plan, context, plan.toVersion)
      state({ phase: 'succeeded' })
      return
    }
  }

  if (plan.rollback !== true) {
    state({ phase: 'failed', error: verdict.reason })
    say('rollback is disabled — leaving the new version installed but unverified')
    return
  }
  const restored = await rollback(plan, context)
  if (restored.ok) {
    state({ phase: 'rolled-back', error: null, detail: `${verdict.reason}; ${restored.reason}` })
    say(`rolled back: ${restored.reason}`)
  } else {
    state({ phase: 'failed', error: `${verdict.reason}; rollback failed: ${restored.reason}` })
    say(`rollback failed: ${restored.reason}`)
  }
}

const planFile = process.argv[2]
if (typeof planFile !== 'string' || planFile === '') {
  process.stderr.write('dsh-auto-update helper: usage: node update-helper.mjs <plan.json>\n')
  process.exit(2)
}

let plan
try {
  plan = loadPlan(planFile)
} catch (error) {
  process.stderr.write(`dsh-auto-update helper: ${String(error?.message ?? error)}\n`)
  process.exit(2)
}

const reporter = makeReporter(plan)
const { say, state } = reporter
rotateLog(plan.logFile)
say(`helper ${process.pid} started with plan ${planFile}`)
process.on('exit', (code) => say(`helper exiting (code ${code})`))
process.on('uncaughtException', (error) => {
  say(`helper crashed: ${error?.stack ?? String(error)}`)
  state({ phase: 'failed', error: `helper crashed: ${String(error?.message ?? error)}` })
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  say(`helper rejected: ${error?.stack ?? String(error)}`)
  state({ phase: 'failed', error: `helper rejected: ${String(error?.message ?? error)}` })
  process.exit(1)
})

try {
  await run(plan, reporter)
} catch (error) {
  say(`run failed: ${error?.stack ?? String(error)}`)
  state({ phase: 'failed', error: String(error?.message ?? error) })
}
process.exit(0)
