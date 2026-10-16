/**
 * The detection verdict.
 *
 * Every case here is a decision the feature has to get right for a different
 * reason: installing a fresh release too eagerly is a supply-chain risk,
 * installing over a newer local version is a downgrade, and reporting "up to
 * date" when the registry could not be reached is a lie that outlives the
 * outage.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkForUpdate } from '../lib/check.js'
import { defaults } from '../lib/config.js'

const PACKAGE = '@deepseek-ai/dsh'
const NOW = Date.parse('2026-02-04T12:00:00Z')

/**
 * A registry whose packument the test controls.
 * @param {object} doc - the packument to serve.
 * @returns {typeof fetch} a fetch stand-in.
 */
function registryServing(doc) {
  return async (url) => {
    if (doc === null) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    assert.match(String(url), /%40deepseek-ai%2Fdsh/u, 'the packument is fetched for the configured package')
    return {
      ok: true,
      status: 200,
      json: async () => doc,
    }
  }
}

/**
 * A published-ages packument.
 * @param {{latest?: string, next?: string, alpha?: string, publishedMinutesAgo?: number}} shape - the tags.
 * @returns {object} the packument.
 */
function packument(shape) {
  const tags = {}
  if (shape.latest !== undefined) tags.latest = shape.latest
  if (shape.next !== undefined) tags.next = shape.next
  if (shape.alpha !== undefined) tags.alpha = shape.alpha
  const minutes = shape.publishedMinutesAgo ?? 24 * 60
  const time = {}
  for (const version of Object.values(tags)) {
    time[version] = new Date(NOW - minutes * 60 * 1000).toISOString()
  }
  const versions = {}
  if (shape.dependencies !== undefined && shape.latest !== undefined) {
    versions[shape.latest] = { name: PACKAGE, version: shape.latest, dependencies: shape.dependencies }
  }
  return { name: PACKAGE, 'dist-tags': tags, time, versions }
}

/**
 * Run the check against a fake registry.
 * @param {object} args - the check inputs.
 * @returns {Promise<object>} the verdict.
 */
function run(args) {
  const current = 'current' in args ? args.current : '0.1.0-rc.6'
  const onDisk = 'onDisk' in args ? args.onDisk : current
  return checkForUpdate({
    config: { ...defaults(), ...(args.config ?? {}) },
    current,
    onDisk,
    registry: 'https://registry.npmjs.org',
    fetchImpl: registryServing(args.doc ?? null),
    now: NOW,
    attempts: args.attempts ?? null,
    runningPackages: args.runningPackages ?? null,
  })
}

test('a newer release on the channel is an update', async () => {
  const result = await run({ doc: packument({ latest: '0.2.0-rc.2' }) })
  assert.equal(result.ok, true)
  assert.equal(result.updateAvailable, true)
  assert.equal(result.decision, 'update')
  assert.equal(result.candidate.version, '0.2.0-rc.2')
  assert.equal(result.candidate.tag, 'latest')
  assert.match(result.reason, /0\.2\.0-rc\.2 is available/u)
})

test('the running version is the newest release', async () => {
  const result = await run({ doc: packument({ latest: '0.1.0-rc.6' }) })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'up-to-date')
})

test('a release younger than the wait window is held back, with a countdown', async () => {
  const result = await run({
    config: { minReleaseAgeMinutes: 60 },
    doc: packument({ latest: '0.2.0-rc.2', publishedMinutesAgo: 12 }),
  })
  assert.equal(result.updateAvailable, false, 'a fresh release is not installed yet')
  assert.equal(result.decision, 'too-fresh')
  assert.equal(result.eligibleInMinutes, 48)
  assert.equal(result.candidate.version, '0.2.0-rc.2', 'the candidate is still reported, so the UI can show it')
})

test('the wait window can be switched off', async () => {
  const result = await run({
    config: { minReleaseAgeMinutes: 0 },
    doc: packument({ latest: '0.2.0-rc.2', publishedMinutesAgo: 1 }),
  })
  assert.equal(result.updateAvailable, true)
})

test('an installed version newer than the channel is never walked backwards', async () => {
  const result = await run({ current: '0.3.0', doc: packument({ latest: '0.2.0-rc.2' }) })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'ahead-of-channel')
})

test('a version hold stops the feature without stopping the reporting', async () => {
  const result = await run({ config: { holdVersion: '0.1.0-rc.6' }, doc: packument({ latest: '0.2.0-rc.2' }) })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'held')
})

test('an unreachable registry is reported as such, not as up to date', async () => {
  const result = await run({ doc: null })
  assert.equal(result.ok, false)
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'registry-unreachable')
  assert.match(String(result.error), /ENOTFOUND/u)
})

test('a failed target backs off instead of looping', async () => {
  const result = await run({
    doc: packument({ latest: '0.2.0-rc.2' }),
    attempts: { version: '0.2.0-rc.2', count: 2, blockedUntil: NOW + 30 * 60 * 1000 },
  })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'cooldown')
  assert.equal(result.eligibleInMinutes, 30)
})

test('an unknown installed version cannot be proven forward', async () => {
  const result = await run({ current: null, onDisk: null, doc: packument({ latest: '0.2.0-rc.2' }) })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.decision, 'unknown-installed-version')
})

test('the alpha channel accepts what the narrower channels accept, and more', async () => {
  const doc = packument({ latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' })
  const stable = await run({ doc, config: { channel: 'stable' } })
  const alpha = await run({ doc, config: { channel: 'alpha' } })
  assert.equal(stable.candidate.version, '0.2.0-rc.2')
  assert.equal(alpha.candidate.version, '0.2.1-alpha.1')
  assert.match(alpha.reason, /alpha channel/u)
})

test('the disk version is what an update is measured against', async () => {
  const result = await run({ current: '0.1.0-rc.6', onDisk: '0.1.0-rc.7', doc: packument({ latest: '0.2.0-rc.2' }) })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.current, '0.1.0-rc.6')
  assert.equal(result.onDisk, '0.1.0-rc.7')
})

test('the candidate reports which packages the target release stops shipping', async () => {
  const doc = packument({
    latest: '0.2.0-rc.2',
    dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2', '@deepseek-ai/dsh-client-store': '0.2.0-rc.2', 'js-yaml': '^4' },
  })
  const running = new Set(['dsh-base', 'dsh-client-runtime', 'dsh-client-store', 'dsh-web-app'])

  const withBaseline = await run({ doc, runningPackages: running })
  assert.deepEqual(withBaseline.removedPackages, ['dsh-client-runtime', 'dsh-web-app'], 'what the target no longer lists is what the gate has to worry about')

  const withoutBaseline = await run({ doc })
  assert.deepEqual(withoutBaseline.removedPackages, [], 'with nothing to compare against, the answer is empty rather than a guess')
})
