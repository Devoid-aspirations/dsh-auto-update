/**
 * Configuration: defaults, normalization and the small set of derived facts
 * the rest of the feature reads.
 *
 * The defaults describe the behaviour the feature is FOR — unattended
 * updates — without being reckless: a release has to be published for a
 * while before it is eligible, an update waits for an idle harness, and a
 * failed attempt backs off instead of looping.
 * @module dsh-auto-update/config
 */

import { basename } from 'node:path'
import { HARNESS_PACKAGE } from './npm.js'

/** Channels this feature understands, mapped onto the package's npm dist-tags. */
export const CHANNELS = ['stable', 'next', 'alpha']

/** How the update is applied once a newer version is detected. */
export const APPLY_POLICIES = ['immediate', 'idle']

/** What to do about the profile's own plugins after a harness update. */
/**
 * What the profile-plugin report may do. `apply` used to be listed here and in
 * the README, but nothing ever implemented installing a profile's plugin
 * updates — it behaved exactly like `notify`. It is gone rather than silently
 * accepted: a config that still says `apply` now degrades to `notify`, which is
 * what it was doing all along, and `applyFeature` says so in the log.
 */
export const PROFILE_PLUGIN_MODES = ['off', 'notify']

/**
 * How a release that removes packages the profile's client plugins depend on
 * is treated: `block` withholds it (the unattended default), `warn` applies it
 * anyway and says so, `off` skips the check entirely.
 */
export const COMPATIBILITY_GATES = ['block', 'warn', 'off']

/**
 * Desktop-wrapper sync: `off` ignores it, `version` mirrors the version in the
 * project manifest, `package` also rebuilds the distributable.
 */
export const DESKTOP_SYNC_MODES = ['off', 'version', 'package']

/**
 * The desktop sync's defaults, kept nested because they are one decision with
 * several knobs, and nobody sets `zipName` on its own.
 * @returns {object} a fresh desktop block.
 */
export function desktopDefaults() {
  return {
    /** `off` | `version` (manifest only) | `package` (manifest + rebuild + zip). */
    mode: 'package',
    /** The dsh-desktop project; null looks for it beside this plugin. */
    projectDir: null,
    /** Rebuild the distributable zip after a successful rebuild. */
    refreshZip: true,
    /** The zip's file name inside the project's build output directory. */
    zipName: 'DSH-Desktop-绿色版.zip',
    /**
     * The packaged folder to sync, when a project has more than one. Null picks
     * the newest payload, which is what a normal single-output build produces.
     */
    zipSource: null,
    /** Override the build step, as an argv array; null runs `npm run dist:dir`. */
    buildCommand: null,
    /** One build's ceiling, in minutes. */
    timeoutMinutes: 30,
  }
}

/**
 * Every knob, with the value used when the profile says nothing.
 * @returns {object} a fresh defaults object.
 */
export function defaults() {
  return {
    /** Master switch: off installs nothing and only reports. */
    enabled: true,
    /** The package to keep current. */
    package: HARNESS_PACKAGE,
    /** `stable` follows `latest`; `next`/`alpha` widen the accepted set. */
    channel: 'stable',
    /** How often the registry is asked, in minutes. */
    checkIntervalMinutes: 30,
    /** How long after boot the first check runs, in seconds. */
    startupCheckDelaySeconds: 120,
    /** Apply a detected update without asking a human. */
    autoApply: true,
    /** `idle` waits for a quiet moment; `immediate` applies on detection. */
    applyPolicy: 'idle',
    /** A harness is idle when nothing has been written for this long. */
    idleSeconds: 90,
    /** Apply anyway after this long, in minutes, even if never idle. */
    maxDeferMinutes: 180,
    /** Ignore releases younger than this, in minutes (0 disables the wait). */
    minReleaseAgeMinutes: 60,
    /** Refuse to move off this exact version; null means "follow the channel". */
    holdVersion: null,
    /** Restart the harness after installing so the new version actually runs. */
    restart: true,
    /**
     * `auto` lets a supervising shell own the restart when one is detected
     * (the DSH Desktop app restarts its own child); `respawn` always relaunches
     * the harness itself; `exit-only` never does.
     */
    restartMode: 'auto',
    /** How long a replacement harness gets to answer before rollback, in seconds. */
    healthTimeoutSeconds: 150,
    /** Reinstall the previous version when the new one will not come up. */
    rollbackOnFailure: true,
    /** Attempts allowed for one target version before the feature backs off. */
    maxAttemptsPerTarget: 2,
    /** How long to stop trying after the attempts are used up, in minutes. */
    failureCooldownMinutes: 360,
    /** `off` | `notify` (report stale profile plugins). */
    profilePlugins: 'notify',
    /**
     * `block` withholds a release that removes packages the profile's client
     * plugins hard-require, `warn` applies it anyway, `off` skips the check.
     * The default is the one that cannot break a working GUI unattended.
     */
    compatibilityGate: 'block',
    /** Keeping the packaged desktop wrapper in step with the harness. */
    desktop: desktopDefaults(),
    /** Registry override; null reads npm's configured registry. */
    registry: null,
    /** npm executable override; null probes the Node directory then PATH. */
    npmBin: null,
    /** Extra arguments appended to `npm install -g`. */
    installArgs: [],
    /** Keep this many finished operations in the state file. */
    historyLimit: 20,
  }
}

/**
 * Coerce one value against a closed set.
 * @param {unknown} value - the candidate.
 * @param {readonly string[]} allowed - permitted values.
 * @param {string} fallback - value to use when the candidate is not allowed.
 * @returns {string} the chosen value.
 */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Coerce a duration-like number.
 * @param {unknown} value - the candidate.
 * @param {number} fallback - default.
 * @param {{min?: number, max?: number}} [bounds] - inclusive limits.
 * @returns {number} the number in range.
 */
function number(value, fallback, bounds = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = bounds
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * Whether a configured value is a bare file or folder NAME.
 *
 * The desktop knobs that are names (`zipName`, `zipSource`) get joined onto a
 * directory, so a value carrying a separator, a volume, an absolute root or a
 * traversal segment can escape that directory — and `zipName` is a write target,
 * so escaping it means writing an archive wherever the config says. A name may
 * not be empty, may not be `.`/`..`, and may not carry a character Windows
 * refuses in a file name.
 * @param {string} value - the configured value.
 * @returns {boolean} true when it is a single, safe name.
 */
function isBareName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || name === '.' || name === '..' || name.length > 128) return false
  if (name !== basename(name)) return false
  return !/[\u0000-\u001f<>:"/\\|?*]/u.test(name)
}

/**
 * Merge user configuration over the defaults, dropping anything unusable.
 *
 * A config typo must degrade to the default rather than to a broken feature:
 * this runs at boot, where an exception takes the whole profile down.
 * @param {object | null | undefined} input - the row's `config` object.
 * @returns {object} the effective configuration.
 */
export function normalizeConfig(input) {
  const base = defaults()
  if (input === null || typeof input !== 'object') return base
  const raw = input
  const config = { ...base }
  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
  if (typeof raw.package === 'string' && raw.package.trim() !== '') config.package = raw.package.trim()
  config.channel = oneOf(raw.channel, CHANNELS, base.channel)
  config.checkIntervalMinutes = number(raw.checkIntervalMinutes, base.checkIntervalMinutes, { min: 1, max: 10080 })
  config.startupCheckDelaySeconds = number(raw.startupCheckDelaySeconds, base.startupCheckDelaySeconds, { min: 0, max: 3600 })
  if (typeof raw.autoApply === 'boolean') config.autoApply = raw.autoApply
  config.applyPolicy = oneOf(raw.applyPolicy, APPLY_POLICIES, base.applyPolicy)
  config.idleSeconds = number(raw.idleSeconds, base.idleSeconds, { min: 10, max: 86400 })
  config.maxDeferMinutes = number(raw.maxDeferMinutes, base.maxDeferMinutes, { min: 0, max: 10080 })
  config.minReleaseAgeMinutes = number(raw.minReleaseAgeMinutes, base.minReleaseAgeMinutes, { min: 0, max: 10080 })
  if (typeof raw.holdVersion === 'string' && raw.holdVersion.trim() !== '') config.holdVersion = raw.holdVersion.trim()
  if (typeof raw.restart === 'boolean') config.restart = raw.restart
  config.restartMode = oneOf(raw.restartMode, ['auto', 'respawn', 'exit-only'], base.restartMode)
  config.healthTimeoutSeconds = number(raw.healthTimeoutSeconds, base.healthTimeoutSeconds, { min: 20, max: 1800 })
  if (typeof raw.rollbackOnFailure === 'boolean') config.rollbackOnFailure = raw.rollbackOnFailure
  config.maxAttemptsPerTarget = number(raw.maxAttemptsPerTarget, base.maxAttemptsPerTarget, { min: 1, max: 10 })
  config.failureCooldownMinutes = number(raw.failureCooldownMinutes, base.failureCooldownMinutes, { min: 1, max: 43200 })
  config.profilePlugins = oneOf(raw.profilePlugins, PROFILE_PLUGIN_MODES, base.profilePlugins)
  config.compatibilityGate = oneOf(raw.compatibilityGate, COMPATIBILITY_GATES, base.compatibilityGate)
  const rawDesktop = raw.desktop !== null && typeof raw.desktop === 'object' ? raw.desktop : {}
  const desktop = desktopDefaults()
  desktop.mode = oneOf(rawDesktop.mode, DESKTOP_SYNC_MODES, desktop.mode)
  if (typeof rawDesktop.projectDir === 'string' && rawDesktop.projectDir.trim() !== '') desktop.projectDir = rawDesktop.projectDir.trim()
  if (typeof rawDesktop.refreshZip === 'boolean') desktop.refreshZip = rawDesktop.refreshZip
  // Both of these are joined onto a directory, so a bare NAME is required: a
  // value carrying a separator or a traversal segment (`..\..\x.zip`) would
  // write outside the project, and an ignored value is safer than a bad one.
  if (typeof rawDesktop.zipName === 'string' && isBareName(rawDesktop.zipName)) desktop.zipName = rawDesktop.zipName.trim()
  if (typeof rawDesktop.zipSource === 'string' && isBareName(rawDesktop.zipSource)) desktop.zipSource = rawDesktop.zipSource.trim()
  if (Array.isArray(rawDesktop.buildCommand)) {
    const argv = rawDesktop.buildCommand.filter((item) => typeof item === 'string' && item !== '')
    if (argv.length > 0) desktop.buildCommand = argv
  }
  desktop.timeoutMinutes = number(rawDesktop.timeoutMinutes, desktop.timeoutMinutes, { min: 1, max: 240 })
  config.desktop = desktop
  if (typeof raw.registry === 'string' && raw.registry.trim() !== '') config.registry = raw.registry.trim()
  if (typeof raw.npmBin === 'string' && raw.npmBin.trim() !== '') config.npmBin = raw.npmBin.trim()
  /**
   * Extra arguments appended to `npm install -g`, so an operator can point the
   * install at a mirror or pin an npm behaviour without a config key for it.
   */
  if (Array.isArray(raw.installArgs)) {
    config.installArgs = raw.installArgs
      .filter((item) => typeof item === 'string' && item.trim() !== '' && item.length <= 200 && !/[\r\n\u0000]/u.test(item))
      .map((item) => item.trim())
      .slice(0, 16)
  }
  config.historyLimit = number(raw.historyLimit, base.historyLimit, { min: 1, max: 200 })
  return config
}

/**
 * Whether the feature may install anything at all, and why not when it may not.
 * Kept in one place so the status surface, the tool and the scheduler cannot
 * disagree about whether the machine is armed.
 * @param {object} config - the effective configuration.
 * @param {{globalInstall?: boolean, managedReason?: string | null}} [facts] - derived facts about the host.
 * @returns {{allowed: boolean, reason: string | null}} the verdict.
 */
export function installAllowed(config, facts = {}) {
  if (config.enabled !== true) return { allowed: false, reason: 'the feature is disabled' }
  if (config.autoApply !== true) return { allowed: false, reason: 'autoApply is off for this profile' }
  if (config.holdVersion !== null) return { allowed: false, reason: `held at ${config.holdVersion}` }
  if (facts.globalInstall !== true) return { allowed: false, reason: facts.managedReason ?? 'the running harness is not a global npm install' }
  return { allowed: true, reason: null }
}
