/**
 * The detection pipeline: what version is installed, what the channel offers,
 * and whether those two facts mean "install something".
 *
 * The decision is returned as data, never acted on here — the scheduler, the
 * HTTP surface and the agent tool all read the same verdict, so a manual check
 * and an automatic one can never disagree about what is available.
 * @module dsh-auto-update/check
 */

import { channelVersion, isUpgrade, releaseAgeMinutes } from './version.js'
import { removedPackages, targetPackageSet } from './compat.js'
import { DEFAULT_REGISTRY, fetchPackument, normalizeRegistry } from './registry.js'

/**
 * @typedef {object} CheckResult
 * @property {boolean} ok - whether the registry answered.
 * @property {string | null} error - why it did not, when it did not.
 * @property {number} checkedAt - epoch ms of the check.
 * @property {string} registry - the registry that was asked.
 * @property {string} channel - the channel that was followed.
 * @property {string | null} current - the version currently running.
 * @property {string | null} onDisk - the version on disk (installed).
 * @property {{version: string, tag: string, publishedAt: string | null, ageMinutes: number | null} | null} candidate
 * @property {boolean} updateAvailable - a newer, eligible version exists.
 * @property {string} decision - a stable machine-readable verdict.
 * @property {string} reason - the verdict in words, for the UI and the log.
 * @property {number} eligibleInMinutes - minutes until a too-fresh release matures (0 when not waiting).
 */

/**
 * Compare the installed harness against the newest version its channel offers.
 *
 * Every early return carries a `decision` the UI can render and the operator
 * can search for, because "no update" has several distinct causes and a
 * version banner that conflates them cannot be trusted.
 * @param {object} args - the inputs.
 * @param {object} args.config - the effective configuration.
 * @param {string | null} args.current - the version running right now.
 * @param {string | null} args.onDisk - the version installed on disk.
 * @param {string} [args.registry] - registry base override.
 * @param {typeof fetch} [args.fetchImpl] - fetch implementation, for tests.
 * @param {number} [args.now] - reference time in ms, for tests.
 * @param {{version: string, count: number, blockedUntil: number | null} | null} [args.attempts]
 *   - what previous attempts at one target did.
 * @returns {Promise<CheckResult>} the verdict.
 */
export async function checkForUpdate(args) {
  const {
    config,
    current,
    onDisk,
    registry = config.registry ?? DEFAULT_REGISTRY,
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    attempts = null,
    runningPackages = null,
  } = args
  const base = normalizeRegistry(registry) ?? DEFAULT_REGISTRY
  /** @type {CheckResult} */
  const result = {
    ok: false,
    error: null,
    checkedAt: now,
    registry: base,
    channel: config.channel,
    current,
    onDisk,
    candidate: null,
    updateAvailable: false,
    decision: 'unknown',
    reason: '',
    eligibleInMinutes: 0,
    removedPackages: [],
  }

  let packument
  try {
    packument = await fetchPackument(config.package, { registry: base, fetchImpl })
  } catch (error) {
    result.decision = 'registry-unreachable'
    result.error = String(error?.message ?? error)
    result.reason = `registry unreachable: ${result.error}`
    return result
  }
  result.ok = true

  const distTags = packument['dist-tags']
  const times = packument.time
  const winner = channelVersion(distTags, config.channel)
  if (winner === null) {
    result.decision = 'channel-empty'
    result.reason = `the ${config.channel} channel has no published release`
    return result
  }

  const publishedAt = times?.[winner.version] ?? null
  const ageMinutes = releaseAgeMinutes(times, winner.version, now)
  result.candidate = { version: winner.version, tag: winner.tag, publishedAt, ageMinutes }

  // What this target would stop shipping, relative to what is running: the
  // input the compatibility gate needs, computed from the packument already in
  // hand rather than from a second registry round trip.
  if (runningPackages instanceof Set && runningPackages.size > 0) {
    const target = targetPackageSet(packument.versions?.[winner.version]?.dependencies)
    result.removedPackages = target.size === 0 ? [] : removedPackages(runningPackages, target)
  }

  const installed = onDisk ?? current
  if (typeof installed !== 'string' || installed === '') {
    result.decision = 'unknown-installed-version'
    result.reason = 'the installed harness version could not be read, so no update can be proven to be forward'
    return result
  }

  if (config.holdVersion !== null) {
    result.decision = 'held'
    result.reason = `held at ${config.holdVersion} by configuration`
    return result
  }

  if (!isUpgrade(installed, winner.version)) {
    if (installed === winner.version) {
      result.decision = 'up-to-date'
      result.reason = `running the newest ${config.channel} release (${installed})`
      return result
    }
    // Installed is newer than the channel: never walk backwards automatically.
    result.decision = 'ahead-of-channel'
    result.reason = `installed ${installed} is newer than the ${config.channel} release ${winner.version}`
    return result
  }

  if (config.minReleaseAgeMinutes > 0 && ageMinutes !== null && ageMinutes < config.minReleaseAgeMinutes) {
    result.decision = 'too-fresh'
    result.eligibleInMinutes = Math.ceil(config.minReleaseAgeMinutes - ageMinutes)
    result.reason = `${winner.version} was published ${Math.max(0, Math.round(ageMinutes))} min ago; waiting ${result.eligibleInMinutes} more min before installing`
    return result
  }

  if (attempts !== null && attempts.count >= config.maxAttemptsPerTarget && attempts.blockedUntil !== null && attempts.blockedUntil > now) {
    result.decision = 'cooldown'
    result.eligibleInMinutes = Math.ceil((attempts.blockedUntil - now) / 60000)
    result.reason = `${winner.version} failed ${attempts.count} time(s); holding off for ${result.eligibleInMinutes} more min`
    return result
  }

  result.updateAvailable = true
  result.decision = 'update'
  result.reason = `${winner.version} is available (running ${installed}, ${config.channel} channel${ageMinutes === null ? '' : `, published ${Math.round(ageMinutes)} min ago`})`
  return result
}
