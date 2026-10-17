/**
 * Version arithmetic and release-channel resolution for the harness package.
 *
 * A deliberate subset of semver — enough to order `0.1.0-rc.6 < 0.2.0-rc.2`
 * and `rc.9 < rc.10` — implemented here rather than taken from a dependency so
 * the plugin keeps working when the harness package tree is the thing being
 * replaced under it. Build metadata is ignored; a release outranks every
 * prerelease of the same core.
 * @module dsh-auto-update/version
 */

/** `major.minor.patch[-prerelease][+build]`, with an optional leading `v`. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a version string.
 * @param {string} value - the version, e.g. `0.2.0-rc.2`.
 * @returns {{core: number[], pre: string[], raw: string} | null} the parsed
 *   parts, or null when the string is not a plain semver version.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER.exec(value.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
    raw: value.trim(),
  }
}

/**
 * Semver precedence between two versions.
 * @param {string} a - left-hand version.
 * @param {string} b - right-hand version.
 * @returns {number | null} `-1`/`0`/`1` like a comparator, or null when either
 *   side cannot be ordered — callers must not read null as "equal".
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0
    // A release outranks any prerelease of the same core.
    return left.pre.length === 0 ? 1 : -1
  }
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1
    if (nx !== ny) return nx ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

/**
 * Whether `to` is strictly newer than `from`.
 * Undecidable input answers false: without a direction we cannot promise an
 * "update" is not a downgrade.
 * @param {string | null | undefined} from - installed version.
 * @param {string | null | undefined} to - candidate version.
 * @returns {boolean} true only for a confirmed forward move.
 */
export function isUpgrade(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false
  const cmp = compareVersions(to, from)
  return cmp !== null && cmp > 0
}

/**
 * Fold the names people actually type onto the three channels this feature
 * decides with.
 *
 * `latest` is not a channel — it is the dist-tag `stable` reads — but the panel
 * and the config row both invite someone to say it, and a name that means "the
 * ordinary release" should not be rejected for being the tag's own spelling.
 * @param {unknown} value - a channel name as typed.
 * @returns {string | null} `stable`, `next`, `alpha`, or null when unknown.
 */
export function normalizeChannel(value) {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'stable':
    case 'latest':
    case 'release':
      return 'stable'
    case 'next':
    case 'beta':
    case 'preview':
      return 'next'
    case 'alpha':
    case 'canary':
      return 'alpha'
    default:
      return null
  }
}

/**
 * The npm dist-tags a channel is willing to receive, widest last.
 *
 * A channel is a SET, not a tag: someone on `next` has not stopped accepting
 * releases, so the answer is the newest build across `{latest, next}`. The
 * tag names are the harness package's own — `@deepseek-ai/dsh` publishes
 * `latest`, `next` and `alpha`.
 * @param {string} channel - `stable`, `next` or `alpha` (aliases accepted).
 * @returns {string[]} the dist-tags to consider.
 */
export function channelTags(channel) {
  switch (normalizeChannel(channel) ?? 'stable') {
    case 'alpha':
      return ['latest', 'next', 'alpha']
    case 'next':
      return ['latest', 'next']
    default:
      return ['latest']
  }
}

/**
 * The newest version a channel offers, from a packument's dist-tags.
 * @param {Record<string, string> | undefined} distTags - the packument's `dist-tags`.
 * @param {string} channel - the configured channel.
 * @returns {{version: string, tag: string} | null} the winner, or null when the
 *   registry carries none of the channel's tags.
 */
export function channelVersion(distTags, channel) {
  if (distTags === null || typeof distTags !== 'object') return null
  let best = null
  for (const tag of channelTags(channel)) {
    const version = distTags[tag]
    if (typeof version !== 'string' || parseVersion(version) === null) continue
    if (best === null || isUpgrade(best.version, version)) best = { version, tag }
  }
  return best
}

/**
 * How long ago a version was published, in minutes.
 * @param {Record<string, string> | undefined} time - a packument's `time` map.
 * @param {string} version - the version to look up.
 * @param {number} [now] - reference timestamp in ms, injectable for tests.
 * @returns {number | null} age in minutes, or null when the registry does not say.
 */
export function releaseAgeMinutes(time, version, now = Date.now()) {
  const published = time === null || typeof time !== 'object' ? undefined : time[version]
  if (typeof published !== 'string') return null
  const at = Date.parse(published)
  if (!Number.isFinite(at)) return null
  return (now - at) / 60000
}
