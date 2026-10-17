/**
 * What the registry client promises the update check.
 *
 * These are the parts a unit test can hold: the request the client builds, the
 * two ways a metadata answer can be unusable, and the fact that a tagged
 * version lookup never throws (an unpublished tag is the ordinary case).
 *
 * The proxy half is deliberately thin here: this checkout has no `undici`, so
 * the module resolves no proxy client and every case below runs the plain
 * path. The pairing rule that a borrowed `ProxyAgent` must be used with the
 * `fetch` from the same `undici` is verified against the installed copy, which
 * does have one.
 * @module dsh-auto-update/test-registry
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_REGISTRY, fetchPackument, fetchTaggedVersion } from '../lib/registry.js'

/**
 * A fetch double that records what it was asked for.
 * @param {(url: string, init: object) => Promise<object>} answer - the reply.
 * @returns {{impl: typeof fetch, calls: {url: string, init: object}[]}} the double.
 */
function recorder(answer) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return answer(url, init)
  }
  return { impl, calls }
}

/** @param {object} doc @param {number} [status] @returns {object} a Response stand-in. */
function response(doc, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => doc }
}

test('the packument request targets the scoped package and asks for JSON', async () => {
  const { impl, calls } = recorder(async () => response({ 'dist-tags': { latest: '1.2.3' } }))
  const doc = await fetchPackument('@deepseek-ai/dsh', { fetchImpl: impl })

  assert.equal(doc['dist-tags'].latest, '1.2.3')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_REGISTRY}/%40deepseek-ai%2Fdsh`)
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.headers['user-agent'], 'dsh-auto-update')
  assert.equal('dispatcher' in calls[0].init, false)
})

test('a non-OK answer is an error that names the status and the URL', async () => {
  const { impl } = recorder(async () => response({}, 404))

  await assert.rejects(
    fetchPackument('@deepseek-ai/dsh', { fetchImpl: impl }),
    (error) => /registry answered HTTP 404 for https:\/\/registry\.npmjs\.org\/%40deepseek-ai%2Fdsh/u.test(error.message),
  )
})

test('a packument that is not an object is an error rather than a silent null', async () => {
  const { impl } = recorder(async () => response(null))

  await assert.rejects(fetchPackument('@deepseek-ai/dsh', { fetchImpl: impl }), /non-object packument for @deepseek-ai\/dsh/u)
})

test('a tagged version comes back as the version string', async () => {
  const { impl, calls } = recorder(async () => response({ version: '0.2.1-rc.2' }))
  const version = await fetchTaggedVersion('@deepseek-ai/dsh', 'next', { fetchImpl: impl })

  assert.equal(version, '0.2.1-rc.2')
  assert.equal(calls[0].url, `${DEFAULT_REGISTRY}/%40deepseek-ai%2Fdsh/next`)
})

test('an unpublished tag reads as null, not as a failure', async () => {
  const missing = recorder(async () => response({}, 404))
  assert.equal(await fetchTaggedVersion('@deepseek-ai/dsh', 'canary', { fetchImpl: missing.impl }), null)

  const broken = recorder(async () => {
    throw new Error('fetch failed')
  })
  assert.equal(await fetchTaggedVersion('@deepseek-ai/dsh', 'canary', { fetchImpl: broken.impl }), null)

  const empty = recorder(async () => response({ version: 7 }))
  assert.equal(await fetchTaggedVersion('@deepseek-ai/dsh', 'canary', { fetchImpl: empty.impl }), null)
})

test('a fetch failure reaches the caller of fetchPackument instead of being swallowed', async () => {
  const { impl } = recorder(async () => {
    throw new Error('UND_ERR_INVALID_ARG: invalid onRequestStart method')
  })

  await assert.rejects(
    fetchPackument('@deepseek-ai/dsh', { fetchImpl: impl }),
    /invalid onRequestStart method/u,
  )
})
