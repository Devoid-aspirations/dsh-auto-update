/**
 * Boot the plugin twice against the SAME settled helper record and report what
 * each boot did.
 *
 * This file is executed by `test/plugin.test.mjs` through a child process whose
 * `argv[1]` points into a synthetic `@deepseek-ai/dsh` installation built in a
 * temp directory. That indirection is the whole point: the plugin reads the
 * running harness version off `runningHarnessDir()` → `process.argv[1]`, so a
 * plain `node --test` run has nothing to compare the helper's target against
 * and the supersede rule never fires.
 *
 * The record written here is the shape a real incident leaves behind — the
 * helper installed the version that is running now, but its verification window
 * expired and it recorded a failure. `helper.json` is frozen at that point, so
 * every later boot re-reads the identical document.
 *
 * The measurement goes to stdout as a single JSON line.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HELPER_FILE, HELPER_SCHEMA, STATUS_PATH } from '../../lib/protocol.js'

const harnessRoot = process.env.DSH_AUTO_UPDATE_HARNESS
const dshHome = process.env.DSH_HOME

// Stand in for the running harness: the plugin derives both the running version
// and whether it is a global install from this entry path. A real `helper.json`
// carries a real target (for example `0.2.0-rc.2`), so replaying one needs the
// same version here or the rules that compare against the running version never
// fire.
const harnessDir = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(harnessDir, 'lib'), { recursive: true })
const harnessVersion = process.env.DSH_AUTO_UPDATE_HARNESS_VERSION ?? '9.9.9'
writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: harnessVersion }))

// `process.argv[1]` is a native path in a real boot (and `runningHarnessDir`
// resolves it as one), so pass the path rather than a file:// URL.
// `DSH_AUTO_UPDATE_PLUGIN` lets the harness point at another checkout of the
// plugin (used to measure the same scenario against an older revision); it
// defaults to this repository.
const pluginRoot = process.env.DSH_AUTO_UPDATE_PLUGIN ?? fileURLToPath(new URL('../../', import.meta.url))
const entry = join(harnessDir, 'lib', 'bin.js')
const { apply } = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)

/**
 * A fake context that records the prefix routes the plugin registers, so the
 * status read the real panel performs can be replayed against the same handler
 * the plugin would serve it from.
 * @returns {{ctx: object, capture: {routes: object[]}}} the context and its capture.
 */
const contextWithRoutes = () => {
  const capture = { routes: [] }
  const ctx = {
    logger: Object.assign(() => ({ info() {}, debug() {}, warn() {}, error() {} }), {
      info() {},
      debug() {},
      warn() {},
      error() {},
    }),
    inject: (deps, callback) => callback({ ...ctx, webServer: { register: (route) => (capture.routes.push(route), () => {}) } }),
    on: () => () => {},
    get: () => null,
    setInterval: () => () => {},
  }
  return { ctx, capture }
}

const config = { enabled: true, channel: 'stable', autoApply: false, startupCheckDelaySeconds: 0, checkIntervalMinutes: 5 }

/**
 * Boot the plugin once with argv[1] pointing at the synthetic harness.
 * @returns {void}
 */
const boot = () => {
  const argv = process.argv
  process.argv = [argv[0], entry]
  try {
    apply(contextWithRoutes().ctx, config)
  } finally {
    process.argv = argv
  }
}

const dir = join(dshHome, 'auto-update')
boot()
const running = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).runningVersion

// `DSH_AUTO_UPDATE_REAL_HELPER=1` replays a `helper.json` that is already in
// DSH_HOME (a record a real incident left behind) instead of writing the
// synthetic one below — the two differ in the ways that matter: a real record
// has an old pid that is no longer running, and may predate the `id` field.
if (process.env.DSH_AUTO_UPDATE_REAL_HELPER !== '1') {
  writeFileSync(
    join(dir, HELPER_FILE),
    JSON.stringify({
      schema: HELPER_SCHEMA,
      id: 'frozen-record',
      pid: 999999999,
      phase: 'failed',
      target: running,
      from: '0.0.1',
      error: `no healthy ${running} within 90s`,
      startedAt: 1,
      updatedAt: 2,
      trigger: 'auto',
    }),
  )
}

const supersedeLines = () => (readFileSync(join(dir, 'update.log'), 'utf8').match(/is superseded/gu) ?? []).length
boot()
const afterFirst = supersedeLines()

// Every tick runs `reconcile()` against the SAME frozen `helper.json`, so a
// boot is a faithful stand-in for the next tick. `DSH_AUTO_UPDATE_EXERCISE_STATUS=1`
// asks that the status read the panel performs between two ticks be replayed in
// between, because the status handler reads the helper file too.
if (process.env.DSH_AUTO_UPDATE_EXERCISE_STATUS === '1') {
  const { ctx, capture } = contextWithRoutes()
  apply(ctx, config)
  const route = capture.routes[0]
  const target = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  route.handler(
    { method: 'GET', url: STATUS_PATH, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    target,
  )
}

boot()
const afterSecond = supersedeLines()

// The id the plugin accounts a record under: its own `id` when it has one, and
// the `startedAt`/`target` pair when it predates that field.
const record = JSON.parse(readFileSync(join(dir, HELPER_FILE), 'utf8'))
const recordId = record.id ?? `${record.startedAt}-${record.target}`
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
process.stdout.write(
  `${JSON.stringify({
    runningVersion: running,
    boots: 2,
    afterFirst,
    afterSecond,
    total: afterSecond,
    // What the SECOND boot (the next tick) added. It is 0 once the record is
    // settled, whatever this process started from — a log that already carries
    // a line from an earlier process does not make this process announce it.
    delta: afterSecond - afterFirst,
    statusExercised: process.env.DSH_AUTO_UPDATE_EXERCISE_STATUS === '1',
    rows: state.history.filter((row) => row.id === recordId).length,
    settled: state.helper?.settled ?? null,
    supersededBy: state.helper?.supersededBy ?? null,
  })}\n`,
)
