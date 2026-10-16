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
import { installGlobal, installedGlobalVersion, resolveNpm } from './npm.js'
import { syncDesktop } from './desktop.js'
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
      say(`${reason} — accepting the replacement as up but unverified`)
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
 * The transaction.
 * @param {object} plan - the validated plan.
 * @param {object} context - the reporter.
 * @returns {Promise<void>} resolves when the run is recorded.
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
  const before = await installedGlobalVersion(npm, plan.package)
  say(`on-disk version before install: ${before ?? 'unknown'}`)
  if (before !== null && before !== plan.fromVersion && before !== plan.toVersion) {
    state({ phase: 'failed', error: `on-disk version changed to ${before} since the plan was written` })
    say(`aborting: on-disk version is ${before}, neither ${plan.fromVersion} nor ${plan.toVersion}`)
    return
  }

  if (before !== plan.toVersion) {
    state({ phase: 'installing' })
    const install = await installGlobal(npm, `${plan.package}@${plan.toVersion}`, {
      registry: plan.registry ?? null,
      installArgs: Array.isArray(plan.installArgs) ? plan.installArgs : [],
      logFile: plan.logFile,
      timeoutMs: (timeouts.installSeconds ?? 900) * 1000,
      env: process.env,
    })
    if (install.code !== 0) {
      const reason = install.timedOut ? 'npm install timed out' : `npm install exited with code ${install.code}`
      say(reason)
      state({ phase: 'failed', error: reason })
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
  say(`${plan.toVersion} is on disk`)
  state({ phase: 'installed', installedVersion: installed })

  if (plan.restart !== true) {
    state({ phase: 'deferred', error: null, detail: 'installed; a restart is needed to take effect' })
    say('restart disabled by configuration — the new version takes effect on the next start')
    return
  }

  state({ phase: 'stopping' })
  const stopped = await stopHost(plan, say)
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
