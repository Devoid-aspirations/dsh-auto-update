/**
 * The end-to-end transaction, run against a throwaway installation.
 *
 * This is the test that matters: it starts a real host process on a real
 * port, hands the helper a real plan, and then checks that the version on
 * disk, the process serving the port, and the verdict in `helper.json` all
 * agree — once for a successful update and once for a release that refuses to
 * boot, where the only correct ending is the old version back in place.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HELPER_FILE, PLAN_SCHEMA, SHUTDOWN_PATH, STATUS_PATH } from '../lib/protocol.js'
import { inspectZip, readPackagedVersion } from '../lib/desktop.js'
import {
  PROJECT_ROOT,
  clean,
  fixtureVersion,
  freePort,
  installFixtureHarness,
  until,
  writeDesktopBuildStub,
  writeDesktopProject,
  writeFakeNpm,
} from './support/sandbox.mjs'

/** The package under test, and a plausible pair of harness releases. */
const PACKAGE = '@deepseek-ai/dsh'
const FROM = '0.1.0-rc.6'
const TO = '0.2.0-rc.2'
const HELPER = join(PROJECT_ROOT, 'lib', 'update-helper.mjs')

/**
 * Read the tail of a captured stream.
 * @param {string} file - the capture file.
 * @param {number} [bytes] - how much of the end to keep.
 * @returns {string} the tail.
 */
function readTail(file, bytes = 2000) {
  try {
    return readFileSync(file, 'utf8').slice(-bytes)
  } catch {
    return ''
  }
}

/**
 * Build the sandbox: a fake global root holding the current version, a fake
 * npm, a running "harness", and a written plan.
 * @param {{failNewVersion?: boolean, npmFails?: boolean, desktop?: boolean, noVersion?: boolean, strictShutdown?: boolean}} [options] - which way to break the world.
 * @returns {Promise<object>} the sandbox handle.
 */
async function setup(options = {}) {
  const { failNewVersion = false, npmFails = false, desktop = false, noVersion = false, strictShutdown = false } = options
  const base = mkdtempSync(join(tmpdir(), 'dsh-auto-update-'))
  const root = join(base, 'npmroot')
  const dir = join(base, 'auto-update')
  const binDir = join(base, 'bin')
  mkdirSync(root, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const npm = writeFakeNpm(binDir, root)
  const harnessDir = installFixtureHarness(root, PACKAGE, FROM)
  const desktopProject = desktop ? writeDesktopProject(base) : null
  const port = await freePort()
  const npmLog = join(base, 'npm.log')
  const env = {
    ...process.env,
    FAKE_NPM_ROOT: root,
    FAKE_NPM_LOG: npmLog,
    FAKE_PORT: String(port),
    FAKE_TOKEN: 'test-token',
    ...(failNewVersion ? { FAKE_FAIL_VERSION: TO } : {}),
    ...(npmFails ? { FAKE_NPM_FAIL: '1' } : {}),
    ...(noVersion ? { FAKE_NO_VERSION: '1' } : {}),
    ...(strictShutdown ? { FAKE_SHUTDOWN_STRICT: '1' } : {}),
  }

  const host = spawn(process.execPath, [join(harnessDir, 'lib', 'bin.js')], { env, stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const up = await until(async () => {
    try {
      const response = await fetch(`${url}${STATUS_PATH}`)
      return response.ok
    } catch {
      return false
    }
  })
  assert.equal(up, true, 'the fixture harness should be serving before the helper starts')
  const status = await (await fetch(`${url}${STATUS_PATH}`)).json()

  const plan = {
    id: `test-${TO}`,
    schema: PLAN_SCHEMA,
    createdAt: Date.now(),
    trigger: 'test',
    package: PACKAGE,
    fromVersion: FROM,
    toVersion: TO,
    registry: 'https://registry.npmjs.org',
    npm: { file: npm.file, viaShell: npm.viaShell, source: 'test' },
    dir,
    logFile: join(dir, 'update.log'),
    pid: host.pid,
    bootId: status.bootId,
    port,
    url,
    shutdownUrl: `${url}${SHUTDOWN_PATH}`,
    token: 'test-token',
    restart: true,
    restartMode: 'respawn',
    supervisor: null,
    rollback: true,
    launch: { file: process.execPath, args: [join(harnessDir, 'lib', 'bin.js')], cwd: harnessDir, viaShell: false },
    timeouts: { installSeconds: 60, healthSeconds: 20, stopGraceSeconds: 15, portFreeSeconds: 15, settleSeconds: 1 },
    ...(desktopProject === null
      ? {}
      : {
          desktop: {
            mode: 'package',
            projectDir: desktopProject.dir,
            // A stub instead of electron-builder: the transaction around the
            // build is what is under test, not the packager.
            buildCommand: writeDesktopBuildStub(desktopProject.dir),
            refreshZip: true,
            zipName: 'DSH-Desktop-绿色版.zip',
            timeoutMinutes: 2,
          },
        }),
  }
  const planFile = join(base, 'plan.json')
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  /** Run the helper to completion, capturing its output through files. */
  const helperOut = join(base, 'helper.stdout.log')
  const helperErr = join(base, 'helper.stderr.log')
  const runHelper = () => new Promise((settle) => {
    const helper = spawn(process.execPath, [HELPER, planFile], {
      env,
      // Files, not pipes: a confined harness process cannot create the pipes
      // `stdio: 'pipe'` needs, and this suite has to run inside one.
      stdio: ['ignore', openSync(helperOut, 'a'), openSync(helperErr, 'a')],
    })
    helper.on('close', (code) => settle({ code, output: `${readTail(helperOut)}\n${readTail(helperErr)}` }))
  })

  /** Kill whatever is serving the sandbox port, so the test leaks no process. */
  const teardown = async () => {
    try {
      const response = await fetch(`${url}${STATUS_PATH}`)
      if (response.ok) {
        const body = await response.json()
        const pid = Number(String(body.bootId ?? '').split('-')[0])
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* nothing listening */
    }
    try {
      host.kill()
    } catch {
      /* already gone */
    }
    clean(base)
  }

  const helperState = () => {
    try {
      return JSON.parse(readFileSync(join(dir, HELPER_FILE), 'utf8'))
    } catch {
      return null
    }
  }
  const readLog = () => {
    try {
      return readFileSync(join(dir, 'update.log'), 'utf8')
    } catch {
      return ''
    }
  }
  const readNpmLog = () => {
    try {
      return readFileSync(npmLog, 'utf8')
    } catch {
      return ''
    }
  }
  const servingVersion = async () => {
    try {
      const response = await fetch(`${url}${STATUS_PATH}`)
      if (!response.ok) return null
      const body = await response.json()
      return { running: body.running, bootId: body.bootId }
    } catch {
      return null
    }
  }

  return { base, root, dir, port, url, plan, host, runHelper, teardown, helperState, readLog, readNpmLog, servingVersion, desktopProject, currentBoot: status.bootId }
}

test('a successful update also brings the packaged desktop wrapper in step', async (t) => {
  const box = await setup({ desktop: true })
  t.after(box.teardown)

  const { code } = await box.runHelper()
  assert.equal(code, 0)

  const state = box.helperState()
  assert.equal(state.phase, 'succeeded', 'the desktop step never changes the harness verdict')
  assert.equal(state.desktop?.status, 'packaged', `desktop sync (log: ${box.readLog().slice(-900)})`)
  assert.equal(state.desktop?.harnessVersion, TO)

  const projectManifest = JSON.parse(readFileSync(join(box.desktopProject.dir, 'package.json'), 'utf8'))
  assert.equal(projectManifest.version, TO, 'the project manifest follows the harness version')
  const packaged = readPackagedVersion(box.desktopProject.dir, { manifest: projectManifest })
  assert.equal(packaged.version, TO, 'and so does the packaged artifact, read out of the archive the build wrote')
  assert.equal(packaged.layout, 'asar', 'the default electron-builder layout is the one verified')
  assert.equal(packaged.folder, 'win-unpacked')
  assert.equal(state.desktop?.payload, 'win-unpacked', 'and the state records which payload it judged')
  assert.equal(existsSync(box.desktopProject.zipPath), true, 'the distributable zip was refreshed')
  assert.equal(inspectZip(box.desktopProject.zipPath).valid, true, 'and it is a complete archive')

  const log = box.readLog()
  assert.match(log, /desktop sync \(package\) → 0\.2\.0-rc\.2/u)
  assert.match(log, /desktop sync: packaged/u)
})

test('a newer release is installed, the harness is replaced, and the new version is verified', async (t) => {
  const box = await setup()
  t.after(box.teardown)

  const { code } = await box.runHelper()
  assert.equal(code, 0, 'the helper exits cleanly')

  const npmLog = box.readNpmLog()
  assert.match(npmLog, /install -g @deepseek-ai\/dsh@0\.2\.0-rc\.2/u, 'npm is asked for the target version')
  assert.equal(fixtureVersion(box.root, PACKAGE), TO, 'the target version is on disk')
  assert.equal(box.host.exitCode !== null, true, 'the original host process is gone')

  const state = box.helperState()
  assert.equal(state.phase, 'succeeded', `helper phase (log: ${box.readLog().slice(-800)})`)
  assert.equal(state.verified, true, 'the replacement answered with the new version')

  const serving = await box.servingVersion()
  assert.equal(serving?.running, TO, 'the process serving the port reports the new version')
  assert.notEqual(serving?.bootId, box.currentBoot, 'and it is a different boot')
})

test('a release that will not boot is rolled back to the working version', async (t) => {
  const box = await setup({ failNewVersion: true })
  t.after(box.teardown)

  const { code } = await box.runHelper()
  assert.equal(code, 0, 'the helper still exits cleanly')

  const npmLog = box.readNpmLog()
  assert.match(npmLog, /install -g @deepseek-ai\/dsh@0\.2\.0-rc\.2/u, 'the new version was attempted')
  assert.match(npmLog, /install -g @deepseek-ai\/dsh@0\.1\.0-rc\.6/u, 'and then rolled back')
  assert.equal(fixtureVersion(box.root, PACKAGE), FROM, 'the working version is back on disk')

  const state = box.helperState()
  assert.equal(state.phase, 'rolled-back', `helper phase (log: ${box.readLog().slice(-800)})`)

  const serving = await box.servingVersion()
  assert.equal(serving?.running, FROM, 'the old version is serving again')
})

test('a failed install changes nothing and never stops the running harness', async (t) => {
  const box = await setup({ npmFails: true })
  t.after(box.teardown)

  await box.runHelper()

  assert.equal(fixtureVersion(box.root, PACKAGE), FROM, 'the installation is untouched')
  assert.equal(box.host.exitCode, null, 'the running harness was never asked to stop')

  const state = box.helperState()
  assert.equal(state.phase, 'failed', 'the failure is recorded')
  assert.match(String(state.error ?? ''), /npm install exited with code 1/u, 'with npm as the stated cause')

  const serving = await box.servingVersion()
  assert.equal(serving?.running, FROM, 'the original process is still serving')
})

test('a replacement that is up but cannot name its version is kept, not rolled back', async (t) => {
  // The historic failure: the new release was installed, running, and serving —
  // but between its restarts its own status route answered without a version,
  // and the helper read that as "not healthy" and reinstalled the old release.
  const box = await setup({ noVersion: true })
  t.after(box.teardown)

  const { code } = await box.runHelper()
  assert.equal(code, 0)

  const state = box.helperState()
  assert.equal(state.phase, 'succeeded', `helper phase (log: ${box.readLog().slice(-800)})`)
  assert.equal(state.verified, false, 'the record is honest: the version could not be confirmed')
  assert.match(box.readLog(), /accepting the replacement as up but unverified/u)
  assert.match(box.readLog(), /no version/u)

  assert.equal(fixtureVersion(box.root, PACKAGE), TO, 'the new version stays installed')
  assert.equal(box.readNpmLog().includes(`install -g ${PACKAGE}@${FROM}`), false, 'the old release was never reinstalled')

  const serving = await box.servingVersion()
  assert.notEqual(serving, null, 'something is serving the port')
  assert.notEqual(serving?.bootId, box.currentBoot, 'and it is a different boot')
})

test('the harness is asked to stop through the route it actually guards', async (t) => {
  // The plugin's shutdown route only accepts a same-origin mutation carrying the
  // launch token. Without the Origin header the request answered 403, the helper
  // fell back to SIGTERM (a hard kill on Windows, with no chance to flush a
  // session), and the log blamed a missing route.
  const box = await setup({ strictShutdown: true })
  t.after(box.teardown)

  const { code } = await box.runHelper()
  assert.equal(code, 0)

  const log = box.readLog()
  assert.match(log, /shutdown accepted by the harness \(HTTP 202\)/u, `the guarded route accepted the request (log: ${log.slice(-800)})`)
  assert.doesNotMatch(log, /falling back to SIGTERM/u, 'so no hard kill was needed')
  assert.doesNotMatch(log, /shutdown request refused/u)

  assert.equal(box.helperState().phase, 'succeeded')
  assert.equal(box.host.exitCode !== null, true, 'the original host exited on its own')
})
