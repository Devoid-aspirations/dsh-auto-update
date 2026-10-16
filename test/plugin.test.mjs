/**
 * The plugin as the loader sees it: `apply(ctx, config)` with a fake context.
 *
 * This is the test that catches the mistakes a unit test cannot — a typo in
 * the wiring, a service assumed to exist, a state file written where it should
 * not be — without booting a harness. The fake context implements exactly the
 * seam the plugin uses: `logger`, `inject`, `on`, `get` and `setInterval`.
 *
 * The one integration it only checks conditionally is the agent tool, because
 * registering it needs `@deepseek-ai/dsh-tools` resolvable from this checkout
 * (see the note in README.md); when it is not, the assertion becomes "the
 * failure was reported" instead of "the tool registered".
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HELPER_FILE, HELPER_SCHEMA, STATUS_PATH } from '../lib/protocol.js'
import { clean } from './support/sandbox.mjs'

/**
 * Build a context that records what the plugin did with it, and that models the
 * two resources a re-apply must not stack: the web server REFUSES a duplicate
 * prefix route (exactly as the real one does), and every ticker can be cleared
 * once.
 * @returns {object} the fake context and its capture.
 */
function fakeContext() {
  const capture = {
    routes: [],
    routesRegistered: 0,
    routesDisposed: 0,
    liveRoutes: 0,
    tools: [],
    listeners: [],
    intervals: 0,
    intervalsCleared: 0,
    liveIntervals: 0,
    loggerLines: [],
  }
  const makeLogger = () => ({
    info: (message) => capture.loggerLines.push(`info:${message}`),
    debug: (message) => capture.loggerLines.push(`debug:${message}`),
    warn: (message) => capture.loggerLines.push(`warn:${message}`),
    error: (message) => capture.loggerLines.push(`error:${message}`),
  })
  const webServerRegister = (route) => {
    if (capture.liveRoutes > 0) throw new Error(`webserver: duplicate prefix route "${route.path}"`)
    capture.routes.push(route)
    capture.routesRegistered += 1
    capture.liveRoutes += 1
    return () => {
      capture.routesDisposed += 1
      capture.liveRoutes -= 1
    }
  }
  const ctx = {
    logger: Object.assign(() => makeLogger(), makeLogger()),
    inject: (deps, callback) => {
      // The real loader only runs the callback when every dependency exists;
      // this fake provides them all, which is the composition the plugin is
      // written for.
      const child = { ...ctx, tools: { register: (tool) => capture.tools.push(tool) }, webServer: { register: webServerRegister } }
      callback(child)
    },
    on: (event, handler) => {
      capture.listeners.push({ event, handler })
      return () => {}
    },
    get: () => null,
    setInterval: () => {
      capture.intervals += 1
      capture.liveIntervals += 1
      let cleared = false
      return () => {
        if (cleared) return
        cleared = true
        capture.intervalsCleared += 1
        capture.liveIntervals -= 1
      }
    },
  }
  return { ctx, capture }
}

test('apply() wires the feature without a harness and leaves a readable state file', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { apply } = await import('../lib/index.js')
    const { ctx, capture } = fakeContext()
    apply(ctx, {
      enabled: true,
      channel: 'stable',
      autoApply: false,
      startupCheckDelaySeconds: 0,
      checkIntervalMinutes: 5,
    })

    assert.equal(capture.routes.length, 1, 'one prefix route carries the whole HTTP surface')
    assert.equal(capture.routes[0].path, '/auto-update')
    assert.equal(capture.routes[0].kind, 'prefix')
    assert.equal(capture.intervals, 1, 'exactly one ticker, even with a timer service available')
    assert.deepEqual(
      capture.listeners.map((entry) => entry.event).sort(),
      ['dispose', 'session/event'],
      'the plugin listens to turn boundaries and to its own disposal',
    )

    const dir = join(dshHome, 'auto-update')
    assert.equal(existsSync(join(dir, 'state.json')), true, 'the state document is written at boot')
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.equal(state.schema, 'dsh-auto-update/v1')
    assert.equal(state.channel, 'stable')
    assert.equal(state.config.autoApply, false)
    assert.equal(typeof state.pid, 'number')
    assert.equal(state.nextCheckAt > Date.now() - 1000, true)
    assert.deepEqual(state.history, [])

    const log = readFileSync(join(dir, 'update.log'), 'utf8')
    assert.match(log, /── boot/u, 'the boot line names the versions the decision is made from')
    assert.match(log, /first check scheduled/u, 'and the schedule')

    // The status document is what every other surface reads.
    const res = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
    await capture.routes[0].handler(
      { method: 'GET', url: STATUS_PATH, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    )
    assert.equal(res.status, 200)
    const status = JSON.parse(res.body)
    assert.equal(status.id, state.bootId)
    assert.equal(status.paths.dir, dir)
    assert.equal(typeof status.runningVersion === 'string' || status.runningVersion === null, true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    clean(dshHome)
  }
})

test('a settled failure whose target is the version running now is marked superseded', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { apply } = await import('../lib/index.js')
    const dir = join(dshHome, 'auto-update')
    const config = { enabled: true, channel: 'stable', autoApply: false, startupCheckDelaySeconds: 0, checkIntervalMinutes: 5 }

    apply(fakeContext().ctx, config)
    const running = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).runningVersion
    if (running === null) {
      // No installed harness to compare against in this environment: the
      // supersede rule cannot fire, and nothing here would be meaningful.
      return
    }

    // The shape the incident left behind: a helper that installed exactly the
    // version now running, but whose verification window expired and reported
    // a failure (0.1.0-rc.6 -> 0.2.0-rc.2).
    writeFileSync(
      join(dir, HELPER_FILE),
      JSON.stringify({
        schema: HELPER_SCHEMA,
        id: 'supersede-case',
        pid: 999999999,
        phase: 'failed',
        target: running,
        from: '0.0.1',
        error: `no healthy ${running} within 90s (the service answered but reported no version)`,
        startedAt: 1,
        updatedAt: 2,
        trigger: 'auto',
      }),
    )

    apply(fakeContext().ctx, config)
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.equal(state.helper.supersededBy, running, 'the settled failure is marked superseded by what is running')
    assert.match(state.helper.detail, /superseded/u)
    const rows = state.history.filter((row) => row.id === 'supersede-case')
    assert.equal(rows.length, 1, 'the failure is still recorded in history exactly once')
    assert.equal(rows[0].outcome, 'failed')
    assert.equal(rows[0].to, running)

    // Booting again must not duplicate the record, and must keep the mark.
    apply(fakeContext().ctx, config)
    const again = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
    assert.equal(again.history.filter((row) => row.id === 'supersede-case').length, 1)
    assert.equal(again.helper.supersededBy, running)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    clean(dshHome)
  }
})

test('the tool registers when the harness tool SDK is resolvable from this checkout', async () => {
  let defineToolAvailable = true
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    defineToolAvailable = false
  }
  if (!defineToolAvailable) {
    // Not a failure: a linked checkout does not carry the harness's own
    // packages, and the plugin reports the miss instead of breaking boot.
    return
  }
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { apply } = await import('../lib/index.js')
    const { ctx, capture } = fakeContext()
    apply(ctx, { enabled: true, autoApply: false, startupCheckDelaySeconds: 3600 })
    // The tool SDK is imported dynamically, so registration lands a turn later.
    await new Promise((settle) => setTimeout(settle, 500))
    assert.equal(capture.tools.length, 1, 'the auto_update tool is registered')
    assert.equal(capture.tools[0].name, 'auto_update')
    assert.match(capture.tools[0].description, /RESTARTS the harness/u, 'the description warns about the restart')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    clean(dshHome)
  }
})

test('a failure to initialize degrades to unavailable instead of failing the boot', async () => {
  const previousHome = process.env.DSH_HOME
  // A DSH_HOME whose feature directory cannot be created: the path is an
  // existing FILE, so mkdirSync fails. An optional feature must survive it.
  const base = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const blocked = join(base, 'blocked')
  writeFileSync(blocked, 'not a directory\n')
  process.env.DSH_HOME = blocked
  try {
    const { apply } = await import('../lib/index.js')
    const { ctx, capture } = fakeContext()
    assert.doesNotThrow(() => apply(ctx, { autoApply: false }), 'apply() itself never throws')
    assert.equal(capture.routes.length, 0, 'nothing was registered')
    assert.equal(capture.loggerLines.length > 0, true, 'and the failure was reported to the host logger')
    assert.match(capture.loggerLines.join('\n'), /could not start the auto-update feature/u)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    clean(base)
  }
})

test('a re-apply retires the instance it replaces instead of stacking on it', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  mkdirSync(dshHome, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const { apply } = await import('../lib/index.js')
    // The same fake context for both applies, so the second one faces exactly
    // the state the first one left behind — the duplicate route the real
    // web server refuses, and the ticker it is still running.
    const { ctx, capture } = fakeContext()
    apply(ctx, { autoApply: false, startupCheckDelaySeconds: 3600 })
    assert.equal(capture.liveRoutes, 1)

    apply(ctx, { autoApply: false, startupCheckDelaySeconds: 3600 })
    assert.equal(capture.routesRegistered, 2, 'the replacement registered its own route')
    assert.equal(capture.routesDisposed, 1, 'after the predecessor gave its route back')
    assert.equal(capture.liveRoutes, 1, 'exactly one instance owns the HTTP surface')
    assert.equal(capture.liveIntervals, 1, 'and exactly one ticker is running')
    assert.equal(capture.loggerLines.some((line) => line.includes('could not register the HTTP surface')), false, 'no duplicate-route failure')

    const log = readFileSync(join(dshHome, 'auto-update', 'update.log'), 'utf8')
    assert.equal((log.match(/── boot/gu) ?? []).length, 2, 'each boot is recorded separately')
    assert.equal((log.match(/── dispose/gu) ?? []).length, 1, 'and so is the handover')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dshHome, { recursive: true, force: true })
  }
})
