/**
 * dsh-auto-update — unattended self-update for DeepSeek Harness.
 *
 * The plugin does three things and refuses to do a fourth:
 *
 *   1. **detects** a newer `@deepseek-ai/dsh` on the configured release
 *      channel, on a timer, without asking anyone;
 *   2. **waits** for a quiet moment — an update restarts the process, so it
 *      happens between turns, with a deadline so "wait for idle" can never
 *      become "never update";
 *   3. **applies** it through a detached helper that installs, verifies,
 *      restarts and rolls back on a boot that never comes.
 *
 * What it will not do is install over something it does not own: the running
 * harness must be a global npm install of the expected package, or the whole
 * feature degrades to reporting.
 * @module dsh-auto-update
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { openSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkForUpdate } from './check.js'
import {
  applyCompatibilityGate,
  collectClientReferences,
  missingFromTarget,
  runningPackageSet,
  scanClientPlugins,
  splitFindings,
} from './compat.js'
import { installAllowed, normalizeConfig } from './config.js'
import { createIdleTracker } from './idle.js'
import { checkProfilePlugins } from './market.js'
import {
  globalRoot,
  installedGlobalVersion,
  isInsideGlobalRoot,
  looksLikeSourceCheckout,
  resolveNpm,
  runNpm,
  runningHarnessDir,
  versionAt,
} from './npm.js'
import { findDesktopProject, planDesktopSync, resolveOutputRoot, syncDesktop } from './desktop.js'
import {
  STATE_SCHEMA,
  acquireLock,
  appendLog,
  closeQuietly,
  ensureDir,
  featureDir,
  logPath,
  planPath,
  processAlive,
  prunePlans,
  readJson,
  readLogTail,
  releaseLock,
  resolveDshHome,
  rotateLog,
  stamp,
  statePath,
  writeJsonAtomic,
} from './paths.js'
import { HELPER_FILE, HELPER_SCHEMA, PLAN_SCHEMA, SHUTDOWN_PATH } from './protocol.js'
import { DEFAULT_REGISTRY, fetchTaggedVersion, normalizeRegistry, registryFromNpmConfig } from './registry.js'
import { detectedSupervisor, launchFromProcess, resolveRestartMode, spawnDetached } from './restart.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { isUpgrade, normalizeChannel } from './version.js'

/** The plugin's own version, read from its manifest. */
function ownVersion() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Where this plugin's own files live — the helper is spawned from here. */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The process-global handle of the live instance.
 *
 * A profile patch-layer edit re-applies this plugin INSIDE THE SAME PROCESS —
 * the loader watches those files — and without this guard the previous fiber
 * keeps its HTTP route and its ticker while a second instance starts beside it.
 * The field symptom was exactly that: `webserver: duplicate prefix route
 * "/auto-update"`, a status endpoint still answering from the retired closure,
 * and a config change that never took effect until the next restart.
 *
 * Keyed on `Symbol.for`, so a reloaded module shares the slot with the instance
 * it is replacing.
 */
const INSTANCE_KEY = Symbol.for('dsh-auto-update.instance')

/** How often the idle watcher and the state reconciler run, in ms. */
const TICK_MS = 20 * 1000

/** Helper phases that mean a run is still in flight. */
const LIVE_PHASES = new Set(['starting', 'installing', 'installed', 'stopping', 'verifying', 'desktop-syncing', 'rolling-back'])

/** Helper phases that mean the run has settled. */
const SETTLED_PHASES = new Set(['succeeded', 'deferred', 'rolled-back', 'failed'])

/** Plugin name, as the loader reports it. */
export const name = 'auto-update'

/**
 * Applied with no required services: every integration (`tools`, `webServer`)
 * is optional, so a headless or stripped-down profile still gets detection
 * and unattended updates instead of a plugin that refused to load.
 */
export const inject = []

/**
 * The plugin entry.
 *
 * Wrapped so that a failure to initialize degrades to "auto-update is
 * unavailable" instead of failing the fiber — this plugin is an optional
 * feature of a profile, and it must never be the reason a harness cannot
 * start. Whatever it managed to register before the failure is disposed with
 * the plugin like everything else.
 * @param {object} ctx - the plugin context.
 * @param {object} [rawConfig] - the `config` object from this plugin's patch row.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  try {
    // Retire the instance this one replaces, before doing anything of our own:
    // it still owns the HTTP route and a ticker, and both must come back before
    // the replacement can claim them.
    const previous = globalThis[INSTANCE_KEY]
    if (previous !== undefined && typeof previous.disposeInstance === 'function') {
      try {
        previous.disposeInstance('replaced by a re-apply')
      } catch {
        /* a half-dead predecessor must not stop the replacement */
      }
    }
    const instance = applyFeature(ctx, rawConfig)
    if (instance !== undefined && instance !== null) globalThis[INSTANCE_KEY] = instance
  } catch (error) {
    const detail = String(error?.stack ?? error?.message ?? error)
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('auto-update') : null
      if (logger !== null && typeof logger.error === 'function') logger.error(`could not start the auto-update feature: ${detail}`)
    } catch {
      /* reporting the failure must not be the second failure */
    }
  }
}

/**
 * Wire the feature: boot facts, state, scheduler, HTTP surface and tool.
 * @param {object} ctx - the plugin context.
 * @param {object} [rawConfig] - the `config` object from this plugin's patch row.
 * @returns {void}
 */
function applyFeature(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const dir = ensureDir(featureDir())
  const logFile = logPath(dir)
  const stateFile = statePath(dir)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('auto-update') : null
  const say = (message) => {
    appendLog(logFile, message)
    if (logger !== null && typeof logger.debug === 'function') logger.debug(String(message))
  }
  if (rawConfig !== null && typeof rawConfig === 'object' && rawConfig.profilePlugins === 'apply') {
    // `apply` was documented but never implemented; say it out loud instead of
    // letting a config that asks for it read as if plugin updates were handled.
    say('config: profilePlugins `apply` was never implemented — reporting profile plugin updates only')
  }

  /* ── boot facts ─────────────────────────────────────────────────────── */
  const bootId = `${process.pid}-${Date.now()}`
  const npm = resolveNpm({ npmBin: config.npmBin })
  const harnessDir = runningHarnessDir()
  const runningVersion = harnessDir === null ? null : versionAt(harnessDir, config.package)
  const supervisor = detectedSupervisor()
  const restartMode = resolveRestartMode(config, supervisor)
  const launch = launchFromProcess()
  const dshHome = resolveDshHome()
  // The status document refreshes every tick, but the sessions tree it reads is
  // a bounded walk of up to 4000 entries: the cache keeps a quiet harness from
  // paying for that walk every 20 seconds — the apply decision reads fresh.
  const idle = createIdleTracker({ sessionsDir: join(dshHome, 'sessions'), fileCacheMs: 30_000 })
  let shutdownToken = null

  /**
   * The port this harness serves on, for the helper's probes and restart.
   * The web server knows it; argv is the fallback for profiles without one.
   * @returns {number} the port.
   */
  const resolvePort = () => {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : null
    const fromServer = server !== null && server !== undefined && Number.isInteger(server.port) ? server.port : null
    if (fromServer !== null && fromServer > 0) return fromServer
    const index = process.argv.indexOf('--port')
    const fromArgs = index >= 0 ? Number(process.argv[index + 1]) : NaN
    if (Number.isInteger(fromArgs) && fromArgs > 0) return fromArgs
    return 3080
  }
  let port = null

  /** Facts derived from the machine, filled in asynchronously at boot. */
  const facts = {
    harnessDir,
    globalInstall: null,
    globalRootPath: null,
    registry: normalizeRegistry(config.registry ?? process.env.npm_config_registry) ?? null,
    managedReason: null,
    /** The `@deepseek-ai/*` packages the running harness ships (the gate's baseline). */
    runningPackages: null,
  }

  /* ── persisted state ────────────────────────────────────────────────── */
  const previousState = readJson(stateFile, null)
  // The channel has two sources of truth: the profile row (the operator's) and
  // the panel (the user's click). A click has to outlive the restart it did not
  // cause, but it must NOT outlive an edit to the profile row — `configuredChannel`
  // is that row's value, so a change there retires the earlier click instead of
  // being silently overridden by it.
  const configuredChannel = config.channel
  const savedChannelOverride = normalizeChannel(previousState?.channelOverride)
  const operatorChangedChannel = typeof previousState?.configuredChannel === 'string'
    && previousState.configuredChannel !== configuredChannel
  const channelOverride = operatorChangedChannel ? null : savedChannelOverride
  const channel = channelOverride ?? configuredChannel
  const state = {
    schema: STATE_SCHEMA,
    bootId,
    pluginVersion: ownVersion(),
    package: config.package,
    pid: process.pid,
    updatedAt: Date.now(),
    runningVersion,
    installedVersion: runningVersion,
    installDir: harnessDir,
    globalRoot: null,
    globalInstall: null,
    managedReason: null,
    npm: { file: npm.file, viaShell: npm.viaShell, source: npm.source },
    node: process.execPath,
    channel,
    channelOverride,
    configuredChannel,
    registry: facts.registry ?? DEFAULT_REGISTRY,
    supervisor,
    restartMode,
    config: { ...config, package: config.package },
    check: previousState?.check ?? null,
    // The helper's own record does not survive the restart it triggered, but the
    // verdict the plugin reached about it does — and the panel reads that verdict
    // from here. Reconciling again on every boot would re-announce a run that
    // finished days ago (`helper.json` is frozen when the helper exits), so the
    // settled record has to come back with the state.
    helper: previousState?.helper ?? null,
    operation: null,
    attempts: previousState?.attempts ?? {},
    deferral: null,
    profilePlugins: previousState?.profilePlugins ?? null,
    history: Array.isArray(previousState?.history) ? previousState.history : [],
    nextCheckAt: null,
    idle: null,
  }

  /**
   * Merge the detached helper's progress file into our state.
   * @returns {object | null} the helper record, when one exists.
   */
  const readHelper = () => {
    const helper = readJson(join(dir, HELPER_FILE), null)
    if (helper === null || helper.schema !== HELPER_SCHEMA) return null
    return helper
  }

  /**
   * Record one finished operation in the bounded history.
   * @param {object} entry - the row to add.
   * @returns {void}
   */
  const pushHistory = (entry) => {
    const id = entry.id ?? `${entry.at}-${entry.to}`
    if (state.history.some((row) => row.id === id)) return
    state.history.push({ id, ...entry })
    while (state.history.length > config.historyLimit) state.history.shift()
  }

  /**
   * Reconcile whatever the previous process left behind.
   *
   * Three shapes matter. A helper still running is left alone. A helper that
   * finished while we were down is recorded once, from its own file. A helper
   * that is gone without a verdict is a failed run, and saying so is the only
   * way the next attempt can be reasoned about at all.
   * @returns {void}
   */
  const reconcile = () => {
    const helper = readHelper()
    if (helper === null) return
    const phase = typeof helper.phase === 'string' ? helper.phase : 'unknown'
    const alive = processAlive(helper.pid)
    const confirmed = phase !== 'succeeded' && runningVersion !== null && helper.target === runningVersion && LIVE_PHASES.has(phase)

    if (confirmed) {
      pushHistory({
        id: helper.id ?? `${helper.startedAt}-${helper.target}`,
        at: Date.now(),
        from: helper.from ?? null,
        to: helper.target,
        outcome: 'succeeded',
        detail: 'confirmed on boot after the restart',
        trigger: helper.trigger ?? 'auto',
      })
      state.helper = { ...helper, phase: 'succeeded', settled: true, detail: 'confirmed on boot' }
      state.operation = { id: helper.id ?? null, phase: 'succeeded', target: helper.target, from: helper.from ?? null, finishedAt: Date.now() }
      state.deferral = null
      say(`reconciled: ${helper.target} is running — recording the update as succeeded`)
    } else if (SETTLED_PHASES.has(phase)) {
      const outcome = phase === 'deferred' ? 'deferred' : phase
      const recordId = helper.id ?? `${helper.startedAt}-${helper.target}`
      // Reconciling the same helper record twice is never meaningful: the file
      // it is read from is frozen by the detached helper when it exits, so it
      // describes the same finished run forever. `helper.json` outlives the
      // process (and `state.helper` does not survive a boot), so the record's
      // presence in history — not the previous tick's memory — is the durable
      // evidence that this run has already been accounted for.
      const alreadyReconciled = state.history.some((row) => row.id === recordId)
      if (!alreadyReconciled) {
        pushHistory({
          id: recordId,
          at: helper.updatedAt ?? Date.now(),
          from: helper.from ?? null,
          to: helper.target,
          outcome,
          detail: helper.detail ?? helper.error ?? null,
          trigger: helper.trigger ?? 'auto',
        })
        if (outcome === 'failed' || outcome === 'rolled-back') noteFailure(helper.target)
      }
      // A failed or rolled-back run whose target is the version running now did
      // not really lose: the install landed and that version did come up (the
      // user may simply have restarted by hand), so it was the verification
      // window that expired — the failure mode 0.1.3 fixed. The verdict stays in
      // history, but the record is marked superseded so the panel stops showing
      // a settled failure as if it were the current state.
      //
      // This branch previously re-derived that verdict on EVERY tick, because
      // the guard above reads `helper.json` — a file the detached helper froze
      // when it exited, so the record it describes never changes. The tick runs
      // every 20s, so a machine carrying one stale failed record wrote the line
      // below ~4300 times a day and rewrote `state.json` just as often. Once the
      // record is settled in state, leave the stored verdict alone: the tick
      // calls this every 20s, and the verdict was decided the first time.
      if (alreadyReconciled && state.helper?.settled === true) {
        state.helper = { ...helper, ...state.helper }
      } else {
        const superseded =
          runningVersion !== null && helper.target === runningVersion && (outcome === 'failed' || outcome === 'rolled-back')
        state.helper = superseded
          ? {
              ...helper,
              settled: true,
              supersededBy: runningVersion,
              detail: `superseded: ${runningVersion} is running now (the run reported ${outcome})`,
            }
          : { ...helper, settled: true }
        if (superseded) say(`reconciled: ${runningVersion} is running — the earlier ${outcome} verdict for ${helper.target} is superseded`)
      }
      if (phase !== 'deferred') state.deferral = null
    } else if (!alive) {
      const detail = `the update helper for ${helper.target} exited without a verdict`
      say(detail)
      pushHistory({
        id: helper.id ?? `${helper.startedAt}-${helper.target}`,
        at: Date.now(),
        from: helper.from ?? null,
        to: helper.target,
        outcome: 'failed',
        detail,
        trigger: helper.trigger ?? 'auto',
      })
      noteFailure(helper.target)
      state.helper = { ...helper, phase: 'failed', settled: true, detail }
    } else {
      state.helper = helper
    }
    // The lock exists to stop a second helper from starting while one is
    // working; it is released the moment no live helper owns it.
    const live = state.helper !== null && LIVE_PHASES.has(state.helper.phase ?? '') && processAlive(state.helper.pid)
    if (!live) releaseLock(dir)
    // Boot is the one moment nothing can be mid-run, so it is where the plan
    // files of finished updates are cleared out.
    const pruned = prunePlans(dir)
    if (pruned.length > 0) say(`pruned ${pruned.length} finished plan file(s)`)
  }

  /**
   * Count one failed attempt at a target, and arm the cooldown once the
   * attempts are used up. Without this a broken release would be reinstalled
   * on every boot.
   * @param {string} target - the version that failed.
   * @returns {void}
   */
  const noteFailure = (target) => {
    if (typeof target !== 'string' || target === '') return
    const entry = state.attempts[target] ?? { count: 0, lastAt: 0, blockedUntil: null }
    entry.count += 1
    entry.lastAt = Date.now()
    if (entry.count >= config.maxAttemptsPerTarget) {
      entry.blockedUntil = Date.now() + config.failureCooldownMinutes * 60 * 1000
    }
    state.attempts[target] = entry
    say(`attempt ${entry.count} at ${target} failed; ${entry.blockedUntil === null ? 'will retry' : `holding off until ${new Date(entry.blockedUntil).toISOString()}`}`)
  }

  /** Write the state document, atomically and without churn. */
  let lastWritten = 0
  const persist = (force = false) => {
    const at = Date.now()
    if (!force && at - lastWritten < 5000) return
    lastWritten = at
    state.updatedAt = at
    writeJsonAtomic(stateFile, state)
  }

  /**
   * Resolve the registry and the install facts once, in the background.
   * @returns {Promise<void>} resolves once the facts are known.
   */
  const resolveFacts = async () => {
    if (facts.registry === null) {
      facts.registry = await registryFromNpmConfig({ run: (args) => runNpm(npm, args, { timeoutMs: 20000 }) })
      state.registry = facts.registry
    }
    if (facts.globalRootPath === null) {
      facts.globalRootPath = await globalRoot(npm)
      state.globalRoot = facts.globalRootPath
    }
    const installed = await installedGlobalVersion(npm, config.package)
    if (installed !== null) state.installedVersion = installed
    if (facts.runningPackages === null) {
      facts.runningPackages = runningPackageSet(facts.harnessDir)
      state.runningPackages = facts.runningPackages.size
    }
    if (facts.harnessDir === null || facts.globalRootPath === null) {
      facts.globalInstall = false
      facts.managedReason = 'the running harness installation could not be located, so an install cannot be proven to replace it'
    } else if (looksLikeSourceCheckout(facts.harnessDir) || !isInsideGlobalRoot(facts.harnessDir, facts.globalRootPath)) {
      facts.globalInstall = false
      facts.managedReason = `the running harness is not a global npm install (${facts.harnessDir})`
    } else {
      facts.globalInstall = true
      facts.managedReason = null
    }
    state.globalInstall = facts.globalInstall
    state.managedReason = facts.managedReason
  }

  /* ── the profile's own client plugins ──────────────────────────────── */
  /**
   * Locate this profile's directory, so the compatibility gate can read what
   * its installed plugins actually declare.
   *
   * Two signals, in order: the loader's `profileContext` names the profile,
   * and failing that the profile whose manifest lists THIS plugin is — by
   * construction — the one we are running inside.
   * @returns {string | null} the absolute profile directory.
   */
  const resolveProfileDir = () => {
    const named = typeof ctx.get === 'function' ? ctx.get('profileContext')?.name : null
    const candidates = []
    if (typeof named === 'string' && named !== '') candidates.push(join(dshHome, 'profiles', named))
    try {
      for (const entry of readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(dshHome, 'profiles', entry.name))
      }
    } catch {
      /* no profiles directory to scan */
    }
    for (const dir of candidates) {
      const manifest = readJson(join(dir, 'package.json'), null)
      if (manifest !== null && manifest.dependencies?.['dsh-auto-update'] !== undefined) return dir
    }
    return null
  }

  const profileDir = resolveProfileDir()
  const profileModulesDir = profileDir === null ? null : join(profileDir, 'node_modules')

  /**
   * The directory this plugin was INSTALLED FROM.
   *
   * A `file:` dependency installs a copy into the profile, so the plugin's own
   * directory is `<profile>/node_modules/dsh-auto-update` — and the desktop
   * project it should sync (its sibling in the checkout) is nowhere near it.
   * The profile manifest still remembers the source path, which is what makes
   * sibling auto-detection work for an installed plugin rather than only for a
   * `link:`ed one.
   * @returns {string | null} the absolute source directory, or null.
   */
  const resolveSourceDir = () => {
    if (profileDir === null) return null
    const manifest = readJson(join(profileDir, 'package.json'), null)
    const spec = manifest?.dependencies?.['dsh-auto-update']
    if (typeof spec !== 'string') return null
    const match = /^(?:file|link):(.+)$/u.exec(spec)
    if (match === null) return null
    return resolve(match[1])
  }
  const desktopSourceDir = resolveSourceDir()
  /** The resolved desktop project, refreshed by the inspection below. */
  let desktopProjectDir = null
  /** Cached compatibility verdict, keyed by the target version it was computed for. */
  let compatCache = { target: null, at: 0, value: null }

  /**
   * Ask whether the profile's client plugins survive the target release.
   * @param {object} check - the check result, carrying `removedPackages`.
   * @returns {Promise<object>} the verdict consumed by the gate.
   */
  const evaluateCompatibility = async (check) => {
    const target = check.candidate?.version ?? null
    const empty = { ok: true, blocking: [], warning: [], scanned: 0, unreadable: 0, removed: [], target }
    if (profileDir === null || profileModulesDir === null || target === null) return empty
    if (compatCache.target === target && Date.now() - compatCache.at < 30 * 60 * 1000) return compatCache.value
    const manifest = readJson(join(profileDir, 'package.json'), null)
    const names = Object.keys(manifest?.dependencies ?? {})
    let value
    try {
      // Ask the registry about the handful of packages the plugins actually
      // mention, instead of diffing the installed tree against the target's
      // dependency map (which lists direct dependencies only, so every
      // transitively shipped package looked removed).
      const references = collectClientReferences({ modulesDir: profileModulesDir, names })
      const removed = await missingFromTarget(references.refs, async (name) => {
        const version = await fetchTaggedVersion(`@deepseek-ai/${name}`, target, {
          registry: facts.registry ?? DEFAULT_REGISTRY,
        })
        return version !== null
      })
      if (removed.length === 0) {
        value = { ...empty, scanned: references.scanned, unreadable: references.unreadable }
      } else {
        const scan = scanClientPlugins({ modulesDir: profileModulesDir, names, removed })
        value = { ...splitFindings(scan), scanned: scan.scanned, unreadable: scan.unreadable, removed, target }
      }
    } catch (error) {
      say(`compatibility scan failed: ${String(error?.message ?? error)}`)
      value = { ...empty, error: String(error?.message ?? error) }
    }
    compatCache = { target, at: Date.now(), value }
    return value
  }

  /* ── detection ──────────────────────────────────────────────────────── */
  let checking = false

  /**
   * Run one registry check and decide what it means.
   * @param {{trigger?: string, force?: boolean}} [options] - why the check ran.
   * @returns {Promise<object>} the check portion of the state.
   */
  const runCheck = async (options = {}) => {
    const { trigger = 'timer' } = options
    if (checking) return { ok: false, error: 'a check is already running', decision: 'busy' }
    checking = true
    try {
      await resolveFacts()
      const attempts = (() => {
        const entry = Object.entries(state.attempts).sort((a, b) => (b[1]?.lastAt ?? 0) - (a[1]?.lastAt ?? 0))[0]
        if (entry === undefined) return null
        return { version: entry[0], count: entry[1]?.count ?? 0, blockedUntil: entry[1]?.blockedUntil ?? null }
      })()
      const result = await checkForUpdate({
        config,
        current: runningVersion,
        onDisk: state.installedVersion,
        registry: facts.registry ?? DEFAULT_REGISTRY,
        attempts,
        runningPackages: facts.runningPackages,
      })
      // Ask the profile's own client plugins whether they survive this release
      // BEFORE anything is scheduled to install it: the failure this prevents
      // is a GUI that loads nothing after a successful-looking update.
      if (result.updateAvailable) {
        const compat = await evaluateCompatibility(result)
        Object.assign(result, applyCompatibilityGate(result, compat, config))
        result.removedPackages = Array.isArray(compat.removed) ? compat.removed : []
        if (compat.ok === false && config.compatibilityGate === 'block') {
          say(`withholding ${result.candidate?.version ?? '?'}: ${compat.blocking.length} profile plugin(s) hard-require packages it removes (${compat.removed.join(', ')})`)
        }
      }
      state.check = { ...result, trigger }
      state.nextCheckAt = Date.now() + config.checkIntervalMinutes * 60 * 1000
      say(`check (${trigger}): ${result.decision} — ${result.reason}`)
      if (result.updateAvailable) {
        if (state.deferral === null) {
          state.deferral = {
            detectedAt: Date.now(),
            deadline: Date.now() + config.maxDeferMinutes * 60 * 1000,
            reason: 'waiting for an idle window',
            target: result.candidate?.version ?? null,
          }
          say(`update to ${result.candidate?.version ?? '?'} detected; deferring until the harness is idle (deadline ${new Date(state.deferral.deadline).toISOString()})`)
        }
      } else {
        state.deferral = null
      }
      persist(true)
      return state.check
    } catch (error) {
      const message = String(error?.message ?? error)
      state.check = { ...(state.check ?? {}), ok: false, error: message, decision: 'check-failed', reason: message, at: Date.now() }
      say(`check failed: ${message}`)
      return state.check
    } finally {
      checking = false
      persist(true)
    }
  }

  /* ── applying ───────────────────────────────────────────────────────── */
  /**
   * Build the plan the detached helper runs from.
   * @param {{target: string, trigger: string}} options - the target and why.
   * @returns {object} the plan.
   */
  const buildPlan = ({ target, trigger }) => {
    const id = `${stamp()}-${target}`
    const token = randomBytes(16).toString('hex')
    shutdownToken = token
    return {
      id,
      schema: PLAN_SCHEMA,
      createdAt: Date.now(),
      trigger,
      package: config.package,
      fromVersion: state.installedVersion ?? runningVersion,
      toVersion: target,
      registry: facts.registry ?? DEFAULT_REGISTRY,
      npm: { file: npm.file, viaShell: npm.viaShell, source: npm.source },
      dir,
      logFile,
      pid: process.pid,
      bootId,
      port,
      url: `http://127.0.0.1:${port}`,
      shutdownUrl: `http://127.0.0.1:${port}${SHUTDOWN_PATH}`,
      token,
      restart: config.restart,
      restartMode,
      supervisor,
      rollback: config.rollbackOnFailure,
      installArgs: config.installArgs,
      // The resolved project travels in the plan, so the detached helper does
      // not have to rediscover what the host already found.
      desktop: config.desktop === null || config.desktop === undefined
        ? null
        : { ...config.desktop, projectDir: desktopProjectDir ?? config.desktop.projectDir, sourceDir: desktopSourceDir },
      launch,
      timeouts: {
        installSeconds: 900,
        healthSeconds: config.healthTimeoutSeconds,
        stopGraceSeconds: 30,
        portFreeSeconds: 30,
        settleSeconds: 8,
      },
    }
  }

  /**
   * Start an update, or explain why it did not start.
   *
   * The helper is spawned detached and never awaited: it has to outlive this
   * process, because this process is the thing being replaced.
   * @param {{trigger?: string, force?: boolean, version?: string | null}} [options] - the request.
   * @returns {Promise<object>} the outcome.
   */
  const runApply = async (options = {}) => {
    const { trigger = 'auto', force = false, version = null } = options
    await resolveFacts()
    const target = version ?? state.check?.candidate?.version ?? null
    const verdict = installAllowed(config, { managed: facts.globalInstall !== true })
    if (!force && !verdict.allowed) return { started: false, reason: verdict.reason ?? 'not allowed' }
    if (facts.globalInstall !== true) return { started: false, reason: facts.managedReason ?? 'the running harness is not a global npm install' }
    if (target === null) return { started: false, reason: 'no candidate version to install' }

    // The compatibility gate is deliberately NOT bypassable by `force`: a
    // forced start would be a person clicking through a warning they have not
    // read, and the release that trips it is the one that breaks the GUI they
    // are clicking in. The documented way through is `compatibilityGate: warn`.
    const check = state.check ?? null
    if (check?.blocked === true && check.candidate?.version === target && config.compatibilityGate === 'block') {
      return {
        started: false,
        reason: `withheld: ${check.blockReason ?? 'the profile plugins are not compatible with this release'}`,
        hint: 'set compatibilityGate: warn to apply it anyway, after updating the affected plugins',
        incompatible: check.compatibility?.blocking ?? [],
      }
    }
    if (!isUpgrade(state.installedVersion ?? runningVersion, target)) {
      return { started: false, reason: `${target} is not newer than the installed ${state.installedVersion ?? runningVersion}` }
    }
    const lock = acquireLock(dir, { kind: 'update' })
    if (!lock.ok) return { started: false, reason: lock.reason === 'busy' ? `an update is already running (pid ${lock.holder?.pid ?? '?'})` : 'the update lock could not be taken' }
    if (port === null) port = resolvePort()

    const plan = buildPlan({ target, trigger })
    const file = planPath(dir, plan.id)
    if (!writeJsonAtomic(file, plan)) {
      releaseLock(dir)
      return { started: false, reason: `could not write the plan to ${file}` }
    }
    const helperPath = join(PLUGIN_DIR, 'lib', 'update-helper.mjs')
    // The helper's own stdout/stderr are captured beside the shared log: when
    // it dies before writing anything, that file is the only evidence.
    let out = 'ignore'
    let err = 'ignore'
    try {
      out = openSync(join(dir, 'helper.out.log'), 'a')
      err = openSync(join(dir, 'helper.err.log'), 'a')
    } catch {
      /* no capture is better than no helper */
    }
    const started = spawnDetached(
      { file: process.execPath, args: [helperPath, file], detached: true },
      { cwd: PLUGIN_DIR, env: process.env, out, err },
    )
    if (started.error !== null || started.pid === null) {
      closeQuietly(out)
      closeQuietly(err)
      releaseLock(dir)
      return { started: false, reason: `could not start the update helper: ${started.error?.message ?? 'unknown error'}` }
    }
    // The helper owns duplicates of both descriptors from here on.
    closeQuietly(out)
    closeQuietly(err)
    const entry = state.attempts[target] ?? { count: 0, lastAt: 0, blockedUntil: null }
    entry.count += 1
    entry.lastAt = Date.now()
    state.attempts[target] = entry
    state.operation = { id: plan.id, phase: 'pending', target, from: plan.fromVersion, startedAt: Date.now(), trigger, helperPid: started.pid }
    state.helper = { id: plan.id, schema: HELPER_SCHEMA, phase: 'starting', pid: started.pid, target, from: plan.fromVersion, trigger, startedAt: Date.now(), updatedAt: Date.now() }
    state.deferral = null
    say(`update to ${target} started (helper pid ${started.pid}, plan ${file}, trigger ${trigger})`)
    persist(true)
    return { started: true, target, plan: file, helperPid: started.pid, restartMode, supervisor }
  }

  /**
   * Whether an update may run right now.
   * @returns {{ok: boolean, reason: string}} the verdict.
   */
  const idleVerdict = () => {
    if (config.applyPolicy === 'immediate') return { ok: true, reason: 'immediate policy' }
    const deadline = state.deferral?.deadline ?? null
    if (deadline !== null && Date.now() >= deadline) return { ok: true, reason: 'the deferral deadline passed' }
    if (idle.isIdle(config.idleSeconds)) return { ok: true, reason: `idle for ${config.idleSeconds}s` }
    return { ok: false, reason: state.deferral === null ? 'the harness is busy' : 'still waiting for an idle window' }
  }

  /* ── desktop wrapper ───────────────────────────────────────────────── */
  const DESKTOP_KEY = 'desktop'
  let desktopRunning = false
  let nextDesktopInspectAt = 0

  /**
   * Inspect the desktop project and record what a sync would do.
   *
   * Refreshed at a slower cadence than the tick, because it only changes when
   * someone edits the project or a sync runs. The verdict needs the packaged
   * payload — the version it names AND the files it holds — not just the two
   * manifests, because a bundle built before the shell was last edited names the
   * current version while shipping old code. Having it in the state is what lets
   * the panel say "the distributable is still 1.0.0" long before any harness
   * update is in play.
   * @param {boolean} [force] - ignore the cadence.
   * @returns {void}
   */
  const refreshDesktopInspection = (force = false) => {
    if (!force && Date.now() < nextDesktopInspectAt) return
    nextDesktopInspectAt = Date.now() + 60 * 1000
    const mode = config.desktop?.mode ?? 'off'
    try {
      const project = findDesktopProject(config.desktop?.projectDir ?? null, PLUGIN_DIR, desktopSourceDir)
      desktopProjectDir = project?.dir ?? null
      // The output directory is the project's to choose (`build.directories.output`).
      const outputRoot = project === null ? null : resolveOutputRoot(project.dir, project.manifest)
      const zipPath = outputRoot === null ? null : join(outputRoot, config.desktop?.zipName ?? 'DSH-Desktop-绿色版.zip')
      const plan = planDesktopSync({
        project,
        mode,
        harnessVersion: state.installedVersion ?? runningVersion,
        zipPath,
        zipSource: config.desktop?.zipSource ?? null,
        zipExpected: config.desktop?.refreshZip ?? true,
      })
      state[DESKTOP_KEY] = {
        mode,
        projectDir: project?.dir ?? null,
        projectVersion: plan.projectVersion,
        packagedVersion: plan.packagedVersion,
        packagedAt: plan.packagedAt,
        payload: plan.payload,
        payloadLayout: plan.payloadLayout,
        drift: plan.drift,
        zip: plan.zip,
        action: plan.action,
        reason: plan.reason,
        stale: plan.stalePackage || (plan.action !== 'up-to-date' && plan.action !== 'off' && plan.action !== 'no-project'),
        at: Date.now(),
      }
    } catch (error) {
      state[DESKTOP_KEY] = { mode, projectDir: null, action: 'error', reason: String(error?.message ?? error), at: Date.now() }
    }
  }

  /**
   * Run the desktop sync now, from this process.
   *
   * The update path runs it inside the detached helper (so it survives the
   * restart); this entry point is for "sync it right now" without waiting for
   * a harness release — the same module, so the two cannot drift.
   * @param {{trigger?: string}} [options] - why it ran.
   * @returns {Promise<object>} the sync outcome.
   */
  const runDesktopSync = async (options = {}) => {
    const { trigger = 'api' } = options
    if (desktopRunning) return { status: 'busy', detail: 'a desktop sync is already running' }
    const mode = config.desktop?.mode ?? 'off'
    const version = state.installedVersion ?? runningVersion
    if (mode === 'off') return { status: 'skipped', detail: 'desktop sync is disabled' }
    if (version === null) return { status: 'skipped', detail: 'the installed harness version is unknown' }
    desktopRunning = true
    say(`desktop sync (${mode}, ${trigger}) → ${version}`)
    try {
      const result = await syncDesktop({
        projectDir: config.desktop?.projectDir ?? null,
        pluginDir: PLUGIN_DIR,
        sourceDir: desktopSourceDir,
        mode,
        harnessVersion: version,
        logFile,
        buildCommand: config.desktop?.buildCommand ?? null,
        refreshZipArtifact: config.desktop?.refreshZip !== false,
        zipName: config.desktop?.zipName ?? 'DSH-Desktop-绿色版.zip',
        zipSource: config.desktop?.zipSource ?? null,
        timeoutMs: (config.desktop?.timeoutMinutes ?? 30) * 60 * 1000,
      })
      state.desktopSync = result
      say(`desktop sync: ${result.status}${result.error === null || result.error === undefined ? '' : ` — ${result.error}`} (${result.detail})`)
      refreshDesktopInspection(true)
      persist(true)
      return result
    } finally {
      desktopRunning = false
    }
  }

  /* ── periodic work ──────────────────────────────────────────────────── */
  const tick = async () => {
    try {
      // `reconcile()` already folds `helper.json` into `state.helper` and marks
      // the record it settled. Re-reading the file here would overwrite that
      // verdict with the raw, unsettled record — the file is frozen by the
      // detached helper when it exits, so it describes the same run forever.
      reconcile()
      state.idle = idle.describe()
      if (state.nextCheckAt === null || Date.now() >= state.nextCheckAt) {
        await runCheck({ trigger: 'timer' })
      }
      if (state.check?.updateAvailable === true && config.autoApply) {
        if (state.check.blocked === true) {
          // A withheld release is not "nothing to do": say so once per check
          // cycle, so an operator reading the log learns why the version they
          // can see in the panel is not being installed.
          if (state.deferral !== null && state.deferral.reason !== state.check.blockReason) {
            state.deferral.reason = `withheld: ${state.check.blockReason ?? 'incompatible with installed plugins'}`
            say(`still withholding ${state.check.candidate?.version ?? '?'}: ${state.check.blockReason ?? ''}`)
          }
        } else if (state.helper !== null && state.helper.settled !== true && LIVE_PHASES.has(state.helper.phase ?? '')) {
          // A run is in flight; nothing to do but keep the state fresh.
        } else {
          const verdict = idleVerdict()
          if (verdict.ok) {
            say(`applying ${state.check.candidate?.version ?? '?'}: ${verdict.reason}`)
            await runApply({ trigger: 'auto', version: state.check.candidate?.version ?? null })
          } else if (state.deferral !== null) {
            state.deferral.reason = verdict.reason
          }
        }
      }
      if (config.profilePlugins !== 'off') await refreshProfilePlugins()
      refreshDesktopInspection()
      if (state.helper?.desktop !== undefined && state.helper?.desktop !== null && state.desktopSync === undefined) {
        // The detached helper did the sync; adopt its record so the panel keeps
        // showing it after the restart that helper performed.
        state.desktopSync = state.helper.desktop
      }
      persist()
    } catch (error) {
      say(`tick failed: ${String(error?.stack ?? error)}`)
    }
  }

  /** Ask the market (when installed) how many plugins also have updates. */
  let nextPluginCheckAt = 0
  const refreshProfilePlugins = async () => {
    if (Date.now() < nextPluginCheckAt) return
    nextPluginCheckAt = Date.now() + 30 * 60 * 1000
    if (port === null) port = resolvePort()
    const summary = await checkProfilePlugins({ port })
    if (summary !== null) state.profilePlugins = { ...summary, at: Date.now() }
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */
  const api = {
    status: () => {
      // Only a LIVE helper needs reading back: its file is how the detached
      // process reports progress that our in-memory copy has not seen yet.
      // Once the record has settled, re-reading it is not a refresh — the
      // detached helper freezes the file when it exits, so the file keeps
      // describing the same finished run, and copying it over `state.helper`
      // silently drops the verdict `reconcile()` stored there (the panel polls
      // this endpoint, so the drop happened between ticks and made the next
      // tick reconcile — and re-announce — the same record forever).
      if (state.helper?.settled !== true) state.helper = readHelper() ?? state.helper
      state.runningVersion = runningVersion
      return { ...state, id: bootId, paths: { state: stateFile, log: logFile, dir } }
    },
    check: async (options) => {
      const check = await runCheck(options)
      return { ...api.status(), check }
    },
    /**
     * Change the release channel at runtime.
     *
     * This is a decision change, not a preference: the verdict the old channel
     * produced (and any idle deferral queued for its candidate) describes a
     * build the new channel may not even offer, so both are dropped and the next
     * tick — within twenty seconds — asks again. Carrying them over is how a
     * `next` build someone had just queued would still be installed after they
     * switched back to stable.
     * @param {unknown} value - `stable`/`latest`, `next`, `alpha` (aliases accepted).
     * @returns {{channel: string, changed: boolean}} the channel now in force.
     */
    setChannel: (value) => {
      const next = normalizeChannel(value)
      if (next === null) throw new Error(`unknown channel: ${String(value)}`)
      if (next === state.channel) return { channel: state.channel, changed: false }
      const from = state.channel
      state.channel = next
      state.channelOverride = next === state.configuredChannel ? null : next
      state.check = null
      state.deferral = null
      state.nextCheckAt = Date.now()
      say(`channel ${from} → ${next} (chosen in the panel)`)
      persist(true)
      return { channel: next, changed: true }
    },
    apply: async (options) => {
      const result = await runApply(options)
      return { ...result, status: api.status() }
    },
    logTail: (lines) => readLogTail(logFile, lines).join('\n'),
    desktop: async (options) => {
      const result = await runDesktopSync(options)
      return { result, status: api.status() }
    },
    requestShutdown: (token) => {
      if (shutdownToken === null || typeof token !== 'string') return false
      const expected = Buffer.from(shutdownToken)
      const given = Buffer.from(token)
      if (expected.length !== given.length) return false
      if (!timingSafeEqual(expected, given)) return false
      shutdownToken = null
      say('a verified helper asked this harness to stop for an update')
      return true
    },
    /**
     * Stop this harness for real. The profile launcher owns the graceful path
     * (`SIGTERM` disposes the tree and flushes sessions) and any supervising
     * shell restarts the process afterwards.
     */
    stop: () => {
      try {
        process.kill(process.pid, 'SIGTERM')
      } catch {
        process.exit(0)
      }
    },
  }

  try {
    port = resolvePort()
    rotateLog(logFile)
    appendLog(logFile, `── boot ${bootId}: plugin ${state.pluginVersion}, harness ${runningVersion ?? 'unknown'}, pid ${process.pid}, port ${port}, supervisor ${supervisor ?? 'none'}, restart ${restartMode}`)
  } catch {
    /* a boot line that cannot be written must not stop the plugin */
  }

  /**
   * Which integration surfaces this composition actually got. Worth recording:
   * "the plugin loaded" and "the plugin can be reached" are different claims,
   * and only the second one means the feature is working.
   * @param {string} surface - the surface name.
   * @param {string | null} [error] - why it is missing, when it is.
   * @returns {void}
   */
  const noteSurface = (surface, error = null) => {
    state.surfaces = { ...(state.surfaces ?? {}), [surface]: error === null ? true : `failed: ${error}` }
    persist(true)
  }

  /** Disposers this instance owns, so a takeover can unwind exactly its own work. */
  const owned = { routes: null, turnEvents: null }
  ctx.inject(['webServer'], (routeCtx) => {
    try {
      owned.routes = registerRoutes(routeCtx, api)
      noteSurface('http')
    } catch (error) {
      noteSurface('http', String(error?.message ?? error))
      say(`could not register the HTTP surface: ${String(error?.message ?? error)}`)
    }
  })
  ctx.inject(['tools'], (toolCtx) => {
    registerTools(toolCtx, api)
      .then(() => noteSurface('tool'))
      .catch((error) => {
        noteSurface('tool', String(error?.message ?? error))
        say(`could not register the auto_update tool: ${String(error?.message ?? error)}`)
      })
  })

  // Turn boundaries are the exact idle signal; the file-activity heuristic in
  // the tracker covers the profiles where this bus is not mounted.
  try {
    owned.turnEvents = ctx.on('session/event', (session, event) => {
      if (event === null || typeof event !== 'object') return
      const sessionId = typeof session?.id === 'string' ? session.id : undefined
      if (event.type === 'turn/start') idle.noteTurnStart(sessionId)
      else if (event.type === 'turn/end') idle.noteTurnEnd(sessionId)
    })
  } catch (error) {
    say(`could not subscribe to turn events: ${String(error?.message ?? error)}`)
  }

  reconcile()
  const startupDelay = config.startupCheckDelaySeconds * 1000
  state.nextCheckAt = Date.now() + startupDelay
  // Write once at the end of boot, so the state file is complete the moment
  // anything can read it.
  persist(true)
  say(`first check scheduled in ${config.startupCheckDelaySeconds}s; then every ${config.checkIntervalMinutes} min`)

  /**
   * The fallback ticker: a plain interval, cleared on disposal.
   *
   * Deliberately NOT `ctx.setInterval` — that property is the timer service's
   * mixin, and reaching for it without declaring `timer` in `inject` throws
   * `cannot get property "timer" without inject`, which takes the plugin and
   * the profile boot down with it. This path exists precisely for compositions
   * where the timer service cannot be injected.
   * @returns {() => void} the disposer.
   */
  const startFallbackTimer = () => {
    const handle = setInterval(() => void tick(), TICK_MS)
    if (typeof handle.unref === 'function') handle.unref()
    return () => clearInterval(handle)
  }

  /** The timer service's lifecycle-aware variant, used when it is injectable. */
  const startServiceTimer = (timerCtx) => {
    const dispose = timerCtx.setInterval(() => void tick(), TICK_MS)
    return () => {
      try {
        dispose()
      } catch {
        /* disposal is best-effort */
      }
    }
  }

  let stop = null
  // Prefer the harness timer service, whose timers are disposed with the tree.
  // The injection callback runs synchronously when the service is already
  // there; otherwise the fallback takes over and the callback stands down, so
  // there is never more than one ticker.
  ctx.inject(['timer'], (timerCtx) => {
    if (stop !== null) return
    stop = startServiceTimer(timerCtx)
  })
  if (stop === null) stop = startFallbackTimer()

  // A first check that runs soon after boot, without waiting for a timer tick.
  const bootstrap = setTimeout(() => void tick(), Math.min(startupDelay, TICK_MS))
  if (typeof bootstrap.unref === 'function') bootstrap.unref()

  /**
   * Unwind this instance: stop the ticker, drop the listeners and give the
   * HTTP route back.
   *
   * `takeover` is the reason this is a named function rather than inline in the
   * dispose hook: a re-apply has to be able to retire the instance it replaces
   * IMMEDIATELY, or the replacement cannot register its own route.
   * @param {string} reason - why this instance is going away, for the log.
   * @returns {void}
   */
  let retired = false
  const disposeInstance = (reason) => {
    if (retired) return
    retired = true
    try {
      clearTimeout(bootstrap)
    } catch {
      /* nothing to clear */
    }
    try {
      stop?.()
    } catch {
      /* disposal is best-effort */
    }
    try {
      owned.turnEvents?.()
    } catch {
      /* disposal is best-effort */
    }
    try {
      owned.routes?.()
    } catch {
      /* a route the server already dropped is not an error */
    }
    if (globalThis[INSTANCE_KEY]?.bootId === bootId) delete globalThis[INSTANCE_KEY]
    appendLog(logFile, `── dispose ${bootId}${reason === '' ? '' : ` (${reason})`}`)
  }

  ctx.on('dispose', () => disposeInstance(''))

  return { bootId, disposeInstance }
}
