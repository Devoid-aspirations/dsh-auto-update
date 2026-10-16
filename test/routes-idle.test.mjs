/**
 * Idle detection and the HTTP surface — the two places where a mistake is
 * felt immediately: an update that interrupts a turn, or a process-control
 * route that anything on the machine can reach.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createIdleTracker, newestMtime } from '../lib/idle.js'
import { BASE_PATH, SHUTDOWN_PATH, STATUS_PATH, TOKEN_HEADER } from '../lib/protocol.js'
import { loopbackAuthority, registerRoutes, trustedRequest } from '../lib/routes.js'
import { clean } from './support/sandbox.mjs'

/**
 * A fake request.
 * @param {object} shape - the parts the guard reads.
 * @returns {object} the request stand-in.
 */
function request(shape = {}) {
  return {
    method: shape.method ?? 'GET',
    url: shape.url ?? '/',
    headers: shape.headers ?? { host: '127.0.0.1:3080' },
    socket: { remoteAddress: shape.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (shape.body !== undefined) yield Buffer.from(shape.body)
    },
  }
}

/**
 * A fake response that records what the handler wrote.
 * @returns {object} the response stand-in plus a reader.
 */
function response() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body ?? ''
    },
  }
}

/**
 * A context that captures the registered route.
 * @returns {{ctx: object, handler: () => Function}} the capture.
 */
function routeCapture() {
  let handler = null
  const ctx = {
    webServer: {
      register(route) {
        handler = route.handler
        return () => {
          handler = null
        }
      },
    },
  }
  return { ctx, handler: () => handler }
}

test('loopback authorities are exactly the loopback names', () => {
  assert.equal(loopbackAuthority('127.0.0.1:3080'), true)
  assert.equal(loopbackAuthority('localhost:3080'), true)
  assert.equal(loopbackAuthority('[::1]:3080'), true)
  assert.equal(loopbackAuthority('evil.example.com'), false)
  assert.equal(loopbackAuthority('127.0.0.1.evil.example.com'), false)
  assert.equal(loopbackAuthority(undefined), false)
})

test('a request is trusted only when the peer, the Host and the Origin agree', () => {
  const base = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }
  assert.equal(trustedRequest(request(base), { requireOrigin: true }), true)
  assert.equal(trustedRequest(request({ ...base, remoteAddress: '10.0.0.5' }), { requireOrigin: true }), false, 'a remote peer is never trusted')
  assert.equal(trustedRequest(request({ ...base, headers: { host: 'evil.example.com', origin: 'http://evil.example.com' } }), { requireOrigin: true }), false, 'rebinding is refused even from loopback')
  assert.equal(trustedRequest(request({ ...base, headers: { ...base.headers, 'x-forwarded-for': '1.2.3.4' } }), { requireOrigin: true }), false, 'a proxied request is not the user')
  assert.equal(trustedRequest(request({ ...base, headers: { host: '127.0.0.1:3080' } }), { requireOrigin: true }), false, 'a mutation without an Origin is refused')
  assert.equal(trustedRequest(request({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://evil.example.com' } }), { requireOrigin: true }), false, 'a cross-origin mutation is refused')
  assert.equal(trustedRequest(request({ ...base, headers: { host: '127.0.0.1:3080' } }), {}), true, 'a read may omit Origin')
})

test('the routes answer the API and refuse what they must', async () => {
  const { ctx, handler } = routeCapture()
  const calls = { check: 0, apply: 0, stopped: 0, shutdownToken: null }
  const state = { runningVersion: '0.1.0-rc.6', check: { decision: 'update', latest: { version: '0.2.0-rc.2' } } }
  registerRoutes(ctx, {
    status: () => state,
    check: async () => {
      calls.check += 1
      return state.check
    },
    apply: async () => {
      calls.apply += 1
      return { started: true, target: '0.2.0-rc.2' }
    },
    logTail: () => 'line one\nline two',
    requestShutdown: (token) => {
      calls.shutdownToken = token
      return token === 'good-token'
    },
    stop: () => {
      calls.stopped += 1
    },
  })
  const route = handler()
  assert.equal(typeof route, 'function', 'one prefix route carries the whole feature')

  const statusRes = response()
  await route(request({ url: STATUS_PATH }), statusRes)
  assert.equal(statusRes.state.status, 200)
  assert.equal(JSON.parse(statusRes.state.body).runningVersion, '0.1.0-rc.6')

  const dashboard = response()
  await route(request({ url: `${BASE_PATH}/` }), dashboard)
  assert.equal(dashboard.state.status, 200)
  assert.match(dashboard.state.headers['content-type'], /text\/html/u)
  assert.match(dashboard.state.body, /DSH 自动更新/u)

  const log = response()
  await route(request({ url: `${BASE_PATH}/api/v1/log?lines=5` }), log)
  assert.equal(log.state.body, 'line one\nline two')

  const check = response()
  await route(request({ url: `${BASE_PATH}/api/v1/check`, method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), check)
  assert.equal(check.state.status, 200)
  assert.equal(calls.check, 1)

  const forbidden = response()
  await route(request({ url: `${BASE_PATH}/api/v1/apply`, method: 'POST', headers: { host: '127.0.0.1:3080' } }), forbidden)
  assert.equal(forbidden.state.status, 403, 'a mutation without a same-origin Origin is refused')
  assert.equal(calls.apply, 0)

  const applied = response()
  await route(request({ url: `${BASE_PATH}/api/v1/apply`, method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), applied)
  assert.equal(applied.state.status, 202)
  assert.equal(calls.apply, 1)

  const badToken = response()
  await route(request({ url: SHUTDOWN_PATH, method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', [TOKEN_HEADER]: 'nope' } }), badToken)
  assert.equal(badToken.state.status, 403)
  assert.equal(calls.stopped, 0)

  const goodToken = response()
  await route(request({ url: SHUTDOWN_PATH, method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', [TOKEN_HEADER]: 'good-token' } }), goodToken)
  assert.equal(goodToken.state.status, 202)
  assert.equal(calls.shutdownToken, 'good-token')
  await new Promise((settle) => setTimeout(settle, 400))
  assert.equal(calls.stopped, 1, 'a verified helper stops the harness through the injected callback')

  const missing = response()
  await route(request({ url: `${BASE_PATH}/api/v1/nothing` }), missing)
  assert.equal(missing.state.status, 404)
})

test('idle means no turn is open and nothing has been written for a while', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-idle-'))
  const sessions = join(dir, 'sessions')
  const project = join(sessions, 'project-a')
  mkdirSync(project, { recursive: true })
  const transcript = join(project, 'session-1.jsonl')
  writeFileSync(transcript, '{}\n')

  // A controllable clock: "quiet for 90 seconds" is a claim about time, and
  // the only honest way to test it is to move time.
  let clock = Date.now()
  const tracker = createIdleTracker({ sessionsDir: sessions, fileCacheMs: 0, now: () => clock })
  const advance = (seconds) => {
    clock += seconds * 1000
  }

  assert.equal(tracker.isIdle(0), true, 'nothing is open and the window is zero')

  // Age the transcript out first, so what follows measures the turn signal.
  const longAgo = Date.now() - 60 * 60 * 1000
  utimesSync(transcript, new Date(longAgo), new Date(longAgo))

  tracker.noteTurnStart('session-1')
  assert.equal(tracker.isIdle(0), false, 'an open turn is never idle')
  assert.equal(tracker.describe().openTurns, 1)

  tracker.noteTurnEnd('session-1')
  advance(30)
  assert.equal(tracker.isIdle(90), false, 'a turn that just ended is still too recent')
  advance(61)
  assert.equal(tracker.isIdle(90), true, 'once the window has passed, the harness is idle')

  writeFileSync(transcript, '{}\n')
  assert.equal(tracker.isIdle(300), false, 'a fresh transcript write is activity, turn event or not')

  const longAgoAgain = Date.now() - 10 * 60 * 1000
  utimesSync(transcript, new Date(longAgoAgain), new Date(longAgoAgain))
  assert.equal(tracker.isIdle(60), true, 'an old transcript is quiet again')

  tracker.noteTurnStart('session-2')
  advance(7 * 60 * 60)
  assert.equal(tracker.dropStaleTurns(), 1, 'a turn that never ended is eventually forgotten')
  assert.equal(tracker.isIdle(90), true, 'and stops blocking updates forever')
  clean(dir)
})

test('the newest mtime scan is bounded and tolerant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mtime-'))
  writeFileSync(join(dir, 'a.jsonl'), 'x')
  const at = newestMtime(dir)
  assert.equal(typeof at, 'number')
  assert.equal(newestMtime(join(dir, 'missing')), null)
  clean(dir)
})

test('the apply decision reads the transcripts fresh while the status document may reuse a cached answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-idle-cache-'))
  const sessions = join(dir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const transcript = join(sessions, 'session-1.jsonl')
  const longAgo = Date.now() - 60 * 60 * 1000
  writeFileSync(transcript, '{}\n')
  utimesSync(transcript, new Date(longAgo), new Date(longAgo))

  // The status document is refreshed on every tick, and walking the sessions
  // tree that often is pure cost — so it may reuse a cached answer. The
  // decision to install, stop and restart the harness may not: a cached "quiet"
  // would restart the harness under a turn that had just started writing.
  let clock = Date.now()
  const tracker = createIdleTracker({ sessionsDir: sessions, fileCacheMs: 60 * 60 * 1000, now: () => clock })
  assert.equal(tracker.isIdle(60), true, 'an hour-old transcript is quiet')

  clock += 1000
  const cached = tracker.describe().lastFileActivityMs
  assert.equal(cached !== null && cached > 60 * 60 * 1000, true, 'the status document serves the cached age without walking the tree')

  writeFileSync(transcript, '{}\n')
  clock += 1000
  assert.equal(tracker.isIdle(60), false, 'a write the cache has not seen still blocks the update')
  clean(dir)
})
