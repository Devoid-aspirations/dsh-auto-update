/**
 * Verify the installed plugin inside a real harness, without touching the
 * running one.
 *
 * A second `dsh web` instance is started on another port from the SAME web
 * profile, with an overlay that disables `autoApply` — so the plugin really
 * loads and really answers, but can never install anything while the check is
 * taking place. Then the composed profile tree, the status endpoint, the
 * dashboard and a forced registry check are all exercised, and the instance is
 * stopped again.
 *
 * Written in Node rather than PowerShell because every path here contains
 * non-ASCII characters and PowerShell's script reading and `Start-Process`
 * argument marshalling both mangle them.
 *
 * Usage: node scripts/verify-in-harness.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

import { PLUGIN_DIR, DSH_HOME, PROFILE_NAME, resolveDshBin, resolvePnpm, toSpecPath } from './_env.mjs'

const DSH_BIN = resolveDshBin()
const PORT = 3099
const VERIFY_DIR = join(PLUGIN_DIR, '.verify')
const OVERLAY = join(tmpdir(), 'dsh-auto-update-overlay.yml')

mkdirSync(VERIFY_DIR, { recursive: true })
copyFileSync(join(PLUGIN_DIR, 'scripts', 'safe-overlay.yml'), OVERLAY)
const say = (line) => process.stdout.write(`${line}\n`)

/** Run a command with its output captured through files, never pipes. */
function runCaptured(command, args, tag, options = {}) {
  const out = join(VERIFY_DIR, `${tag}.log`)
  rmSync(out, { force: true })
  const fd = openSync(out, 'a')
  const result = spawnSync(command, args, { stdio: ['ignore', fd, fd], windowsHide: true, shell: false, ...options })
  return { status: result.status, output: existsSync(out) ? readFileSync(out, 'utf8') : '' }
}

say('== 0. refresh the profile copy of the plugin ==')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)
// A `file:` dependency is a COPY materialized once: pnpm will not re-read the
// source directory while the version string is unchanged, so the copy has to
// be removed before re-adding it. (A `link:` dependency would track the source
// live, at the cost of the profile depending on this checkout staying put.)
rmSync(join(PROFILE_DIR, 'node_modules', 'dsh-auto-update'), { recursive: true, force: true })
const pnpmBin = resolvePnpm()
if (pnpmBin === null) {
  say('pnpm not found: set DSH_AUTO_UPDATE_PNPM or install pnpm, then re-run.')
  process.exit(1)
}
const install = runCaptured(
  pnpmBin,
  ['add', `file:${toSpecPath(PLUGIN_DIR)}`],
  'pnpm-add',
  'pnpm-add',
  // `shell: true` is what starts a Windows `.cmd` shim; the line is a fixed
  // literal (no interpolated user input), and Node's DEP0190 warning about it
  // is silenced by running this script with --no-deprecation.
  { cwd: PROFILE_DIR, shell: true },
)
say(`pnpm add exit ${install.status}`)
const installedIndex = join(PROFILE_DIR, 'node_modules', 'dsh-auto-update', 'lib', 'index.js')
const installedSource = existsSync(installedIndex) ? readFileSync(installedIndex, 'utf8') : ''
say(`installed copy is current: ${installedSource.includes('startFallbackTimer')}`)
if (!installedSource.includes('startFallbackTimer')) {
  say('   (the profile copy is stale — the verification below would test old code)')
  process.exit(3)
}

/** Probe a loopback port the way the plugin's helper does. */
function portListening(port, timeoutMs = 500) {
  return new Promise((settle) => {
    const probe = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      probe.destroy()
      settle(value)
    }
    probe.on('connect', () => done(true))
    probe.on('error', () => done(false))
    probe.setTimeout(timeoutMs, () => done(false))
  })
}

say('== 1. composed profile tree ==')
const dump = runCaptured(process.execPath, [DSH_BIN, '--profile', PROFILE_NAME, '--dump-config'], 'composed-tree')
const rows = dump.output.split(/\r?\n/u).filter((line) => /auto-update|name: dsh-auto-update/u.test(line))
say(`dump exit ${dump.status}; rows mentioning auto-update: ${rows.length}`)
for (const row of rows.slice(0, 6)) say(`   ${row.trim()}`)
if (rows.length === 0) {
  const nearby = dump.output.split(/\r?\n/u).findIndex((line) => line.includes('# == dshmarket'))
  say(`   (no auto-update row; dshmarket section starts at line ${nearby})`)
}

say('== 2. boot a second instance on 3099 ==')
const outLog = join(VERIFY_DIR, 'instance.out.log')
const errLog = join(VERIFY_DIR, 'instance.err.log')
rmSync(outLog, { force: true })
rmSync(errLog, { force: true })
// `--profile-config` boots with the profile's REAL configuration instead of
// the safe overlay: the point is to test exactly what the next restart of the
// live harness will run.
const useProfileConfig = process.argv.includes('--profile-config')
const instanceArgs = [DSH_BIN, 'web']
if (!useProfileConfig) instanceArgs.push('--patch', OVERLAY)
instanceArgs.push('--host', '127.0.0.1', '--port', String(PORT))
say(`configuration: ${useProfileConfig ? 'the profile as-is' : 'safe overlay'}`)
const child = spawn(process.execPath, instanceArgs, {
  stdio: ['ignore', openSync(outLog, 'a'), openSync(errLog, 'a')],
  windowsHide: true,
  env: { ...process.env, DSH_AUTO_UPDATE_VERIFY: '1' },
})
say(`instance pid ${child.pid}`)

const base = `http://127.0.0.1:${PORT}`
let status = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((settle) => setTimeout(settle, 2000))
  try {
    const response = await fetch(`${base}/auto-update/api/v1/status`, { signal: AbortSignal.timeout(4000) })
    if (response.ok) {
      status = await response.json()
      break
    }
  } catch {
    /* not up yet */
  }
}

if (status === null) {
  say('STATUS ENDPOINT: no answer')
  say(`--- instance stderr tail ---\n${existsSync(errLog) ? readFileSync(errLog, 'utf8').slice(-2500) : '(none)'}`)
} else {
  say('STATUS ENDPOINT: ok')
  say(`   running=${status.runningVersion} installed=${status.installedVersion} channel=${status.channel}`)
  say(`   globalInstall=${status.globalInstall} managedReason=${status.managedReason ?? '—'}`)
  say(`   supervisor=${status.supervisor ?? 'none'} restartMode=${status.restartMode}`)
  say(`   surfaces=${JSON.stringify(status.surfaces ?? null)}`)
  say(`   installDir=${status.installDir}`)
  say(`   globalRoot=${status.globalRoot}`)
  say(`   config.autoApply=${status.config?.autoApply} checkInterval=${status.config?.checkIntervalMinutes}`)
  say(`   config.compatibilityGate=${status.config?.compatibilityGate} config.desktop.mode=${status.config?.desktop?.mode}`)
  say(`   desktop inspection=${JSON.stringify(status.desktop ?? null)}`)
  say(`   desktop sync last=${JSON.stringify(status.desktopSync ?? null)}`)
}

say('== 3. dashboard ==')
try {
  const page = await fetch(`${base}/auto-update/`, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  say(`dashboard HTTP ${page.status}, ${html.length} bytes, title present: ${html.includes('DSH 自动更新')}`)
} catch (error) {
  say(`dashboard failed: ${String(error?.message ?? error)}`)
}

say('== 4. forced check (autoApply off, nothing can be installed) ==')
try {
  const response = await fetch(`${base}/auto-update/api/v1/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, host: `127.0.0.1:${PORT}` },
    body: '{}',
    signal: AbortSignal.timeout(40000),
  })
  const body = await response.json()
  say(`check HTTP ${response.status}: decision=${body.check?.decision} reason=${body.check?.reason}`)
} catch (error) {
  say(`check failed: ${String(error?.message ?? error)}`)
}

say('== 4b. status after the check (install facts resolved) ==')
try {
  const response = await fetch(`${base}/auto-update/api/v1/status`, { signal: AbortSignal.timeout(5000) })
  const after = await response.json()
  say(`   globalInstall=${after.globalInstall} managedReason=${after.managedReason ?? '—'}`)
  say(`   globalRoot=${after.globalRoot}`)
  say(`   npm=${JSON.stringify(after.npm ?? null)}`)
  say(`   deferral=${JSON.stringify(after.deferral ?? null)}`)
} catch (error) {
  say(`   failed: ${String(error?.message ?? error)}`)
}

say('== 4c. wait for the first tick (the desktop inspection lands there) ==')
try {
  let inspected = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${base}/auto-update/api/v1/status`, { signal: AbortSignal.timeout(5000) })
    const body = await response.json()
    if (body.desktop !== null && body.desktop !== undefined) {
      inspected = body
      break
    }
    await new Promise((settle) => setTimeout(settle, 3000))
  }
  if (inspected === null) say('   desktop inspection did not appear within 60s')
  else {
    say(`   desktop=${JSON.stringify(inspected.desktop)}`)
    say(`   desktopSync=${JSON.stringify(inspected.desktopSync ?? null)}`)
  }
} catch (error) {
  say(`   failed: ${String(error?.message ?? error)}`)
}

say('== 4d. the on-demand desktop sync endpoint ==')
// Safe by construction: when the project is already in step this is a no-op, and
// when it is not, the profile config decides whether it rebuilds.
try {
  const response = await fetch(`${base}/auto-update/api/v1/desktop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, host: `127.0.0.1:${PORT}` },
    body: '{}',
    signal: AbortSignal.timeout(240000),
  })
  const body = await response.json()
  const sync = body.result ?? {}
  say(`desktop sync HTTP ${response.status}: status=${sync.status} project=${sync.projectVersion} packaged=${sync.packagedVersion}`)
  say(`   detail=${sync.detail ?? ''}${sync.error === null || sync.error === undefined ? '' : ` error=${sync.error}`}`)
} catch (error) {
  say(`   failed: ${String(error?.message ?? error)}`)
}

say('== 5. plugin log tail ==')
try {
  const log = readFileSync(join(DSH_HOME, 'auto-update', 'update.log'), 'utf8')
  for (const line of log.split(/\r?\n/u).filter((line) => line !== '').slice(-14)) say(`   ${line}`)
} catch (error) {
  say(`   log unreadable: ${String(error?.message ?? error)}`)
}

say('== 6. stop the instance ==')
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise((settle) => setTimeout(settle, 2500))
say(`port ${PORT} still listening: ${await portListening(PORT)}`)
writeFileSync(join(VERIFY_DIR, 'done.txt'), `${new Date().toISOString()}\n`, 'utf8')
