/**
 * Version ordering and release-channel resolution.
 *
 * The cases here are the ones the harness actually publishes: an `rc` line
 * moving forward (`0.1.0-rc.6` → `0.2.0-rc.2`), a prerelease counter crossing
 * ten, and a `latest` tag that points at a prerelease while `alpha` points
 * further ahead.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { channelTags, channelVersion, compareVersions, isUpgrade, parseVersion, releaseAgeMinutes } from '../lib/version.js'

test('semver precedence follows the spec, not the string order', () => {
  assert.equal(compareVersions('0.2.0-rc.2', '0.1.0-rc.6'), 1, 'a later minor wins')
  assert.equal(compareVersions('0.1.0-rc.10', '0.1.0-rc.9'), 1, 'numeric prerelease identifiers compare as numbers')
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.9'), 1, 'a release outranks its own prereleases')
  assert.equal(compareVersions('0.1.0+build.2', '0.1.0+build.1'), 0, 'build metadata is ignored')
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('nightly', '1.0.0'), null, 'an unorderable input is null, never zero')
  assert.equal(compareVersions('1.0.0', undefined), null)
})

test('parseVersion accepts the shapes npm publishes and rejects the rest', () => {
  assert.deepEqual(parseVersion('v1.2.3-rc.1')?.core, [1, 2, 3])
  assert.deepEqual(parseVersion('1.2.3-rc.1')?.pre, ['rc', '1'])
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion(''), null)
})

test('isUpgrade only reports confirmed forward moves', () => {
  assert.equal(isUpgrade('0.1.0-rc.6', '0.2.0-rc.2'), true)
  assert.equal(isUpgrade('0.2.0-rc.2', '0.1.0-rc.6'), false, 'a downgrade is not an upgrade')
  assert.equal(isUpgrade('0.2.0-rc.2', '0.2.0-rc.2'), false)
  assert.equal(isUpgrade(null, '0.2.0'), false)
  assert.equal(isUpgrade('0.1.0', 'not-a-version'), false)
})

test('a channel is a set of dist-tags, widest last', () => {
  assert.deepEqual(channelTags('stable'), ['latest'])
  assert.deepEqual(channelTags('next'), ['latest', 'next'])
  assert.deepEqual(channelTags('alpha'), ['latest', 'next', 'alpha'])
  assert.deepEqual(channelTags('nonsense'), ['latest'], 'an unknown channel degrades to stable')
})

test('the channel candidate is the newest release the channel accepts', () => {
  const tags = { latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' }
  assert.deepEqual(channelVersion(tags, 'stable'), { version: '0.2.0-rc.2', tag: 'latest' })
  assert.deepEqual(channelVersion(tags, 'next'), { version: '0.2.0-rc.2', tag: 'latest' }, 'when two tags agree, the narrower one is the honest answer')
  assert.deepEqual(channelVersion(tags, 'alpha'), { version: '0.2.1-alpha.1', tag: 'alpha' }, 'alpha accepts everything the narrower channels do, plus its own')
  assert.deepEqual(channelVersion({ latest: '0.2.0-rc.2', next: '0.2.1-rc.1' }, 'next'), { version: '0.2.1-rc.1', tag: 'next' })
  assert.equal(channelVersion({}, 'stable'), null)
  assert.equal(channelVersion({ latest: 'soon' }, 'stable'), null, 'an unparseable tag is not a candidate')
})

test('release age comes from the registry time map, and is null when it cannot', () => {
  const now = Date.parse('2026-02-04T12:00:00Z')
  const time = { '0.2.0-rc.2': '2026-02-04T11:00:00Z' }
  assert.equal(releaseAgeMinutes(time, '0.2.0-rc.2', now), 60)
  assert.equal(releaseAgeMinutes(time, '9.9.9', now), null)
  assert.equal(releaseAgeMinutes(undefined, '0.2.0-rc.2', now), null)
})
