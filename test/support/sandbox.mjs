/**
 * A throwaway harness installation and package manager, for tests.
 *
 * The interesting behaviour of this feature — install, stop, restart, verify,
 * roll back — only exists against a real process tree and a real port. These
 * fixtures build the smallest one that still exercises every step: a fake npm
 * that writes package manifests, and a fake harness that serves the same two
 * routes the real plugin does.
 * @module dsh-auto-update/test-support
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOKEN_HEADER } from '../../lib/protocol.js'

/** This repository's root, derived from this file's location (`test/support/…`). */
export const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** The asar writer, as a URL a stub script generated elsewhere can import. */
const ASAR_URL = new URL('./asar.mjs', import.meta.url).href

/**
 * Ask the OS for a free loopback port.
 * @returns {Promise<number>} a port nothing is listening on.
 */
export function freePort() {
  return new Promise((settle, fail) => {
    const probe = createServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => settle(port))
    })
  })
}

/**
 * Write the fake npm into a sandbox.
 *
 * npm is driven as an executable, so the fixture has to be one: a Node script
 * plus the shim that a Windows shell can start — the same shape the real npm
 * has on this platform, which is the thing `spawnNpm` exists to handle.
 * @param {string} binDir - where to write the shim.
 * @param {string} root - the global root the fake npm reports and installs into.
 * @returns {{file: string, viaShell: boolean}} the npm invocation to record in a plan.
 */
export function writeFakeNpm(binDir, root) {
  mkdirSync(binDir, { recursive: true })
  const script = join(binDir, 'fake-npm.mjs')
  writeFileSync(script, FAKE_NPM_SOURCE, 'utf8')
  if (process.platform === 'win32') {
    const shim = join(binDir, 'npm.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8')
    return { file: shim, viaShell: true }
  }
  const shim = join(binDir, 'npm')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  return { file: shim, viaShell: false }
}

/**
 * Install one version of the fake harness into a fake global root.
 * @param {string} root - the fake global root.
 * @param {string} name - the package name.
 * @param {string} version - the version to write.
 * @returns {string} the package directory.
 */
export function installFixtureHarness(root, name, version) {
  const dir = join(root, ...name.split('/'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version, type: 'module', bin: { dsh: 'lib/bin.js' } }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'lib', 'bin.js'), FAKE_HARNESS_SOURCE, 'utf8')
  return dir
}

/**
 * Read a fixture harness's version.
 * @param {string} root - the fake global root.
 * @param {string} name - the package name.
 * @returns {string | null} the version on disk.
 */
export function fixtureVersion(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, ...name.split('/'), 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/** Remove a directory tree without failing on a locked file. */
export function clean(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* a leftover temp directory is not a test failure */
  }
}

/** Wait until a predicate holds. */
export async function until(predicate, timeoutMs = 20000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((settle) => setTimeout(settle, stepMs))
  }
  return false
}

/** Whether a file exists. */
export function exists(path) {
  return existsSync(path)
}

/**
 * Write a minimal `dsh-desktop` project, for the desktop-sync integration test.
 * @param {string} parent - the directory to create it inside.
 * @param {{version?: string}} [shape] - the version it starts at.
 * @returns {{dir: string, zipPath: string}} the project paths.
 */
export function writeDesktopProject(parent, shape = {}) {
  const { version = '1.0.0' } = shape
  const dir = join(parent, 'dsh-desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    // The product name is deliberately NOT the real app's: the sync probes for a
    // running `<productName>.exe` before it touches the payload, and a sandbox
    // that shares the name would be skipped whenever the developer happens to
    // have the real app open.
    `{\n  "name": "dsh-desktop",\n  "productName": "DSH Desktop Test",\n  "version": "${version}",\n  "main": "main.js",\n  "build": { "files": ["main.js"] }\n}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'main.js'), '// shell\n', 'utf8')
  return { dir, zipPath: join(dir, 'dist', 'DSH-Desktop-绿色版.zip') }
}

/**
 * Write a build stub that produces the packaged payload the real build would,
 * so the transaction's artifact verification has something real to read.
 *
 * It writes the DEFAULT `electron-builder --win dir` layout —
 * `dist/win-unpacked/resources/app.asar`, packed, under a folder named after the
 * TARGET rather than `productName` — because that is the layout the artifact
 * check used to be blind to (fixed 2026-10-15): a stub that wrote the folder the
 * plugin wrongly expected would keep agreeing with the code.
 * @param {string} projectDir - the desktop project.
 * @returns {string[]} the argv to run it.
 */
export function writeDesktopBuildStub(projectDir) {
  const script = join(projectDir, 'stub-build.mjs')
  writeFileSync(
    script,
    `import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAsar } from ${JSON.stringify(ASAR_URL)}
// fileURLToPath, not new URL(...).pathname: on Linux the pathname's leading
// slash is the filesystem root and must survive. Stripping it unconditionally
// made this relative, so the stub failed to find its own package.json.
const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const shipped = [{ path: 'package.json', content: JSON.stringify({ name: manifest.name, productName: manifest.productName, version: manifest.version }, null, 2) }]
// The shell itself, byte for byte: the artifact check compares what was packaged
// with what the project holds, so a stub that skipped this would pass a check the
// real build has to pass.
for (const entry of manifest.build.files) {
  if (typeof entry === 'string' && !entry.includes('*')) shipped.push({ path: entry, content: readFileSync(join(root, entry), 'utf8') })
}
const resources = join(root, 'dist', 'win-unpacked', 'resources')
mkdirSync(resources, { recursive: true })
writeAsar(join(resources, 'app.asar'), shipped)
process.stdout.write('stub build wrote ' + manifest.version + '\\n')
`,
    'utf8',
  )
  return [process.execPath, script]
}

/**
 * The fake npm: answers the two questions the feature asks a package manager
 * (`root -g`, `config get registry`) and performs one global install by
 * writing the manifest the installer would have written.
 */
const FAKE_NPM_SOURCE = `import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.FAKE_NPM_ROOT
const log = process.env.FAKE_NPM_LOG
const args = process.argv.slice(2)
const note = (line) => { if (log) appendFileSync(log, line + '\\n') }
note('npm ' + args.join(' '))

if (args[0] === 'root') { process.stdout.write(root + '\\n'); process.exit(0) }
if (args[0] === 'config') { process.stdout.write((process.env.FAKE_NPM_REGISTRY ?? 'https://registry.npmjs.org') + '\\n'); process.exit(0) }
if (args[0] === 'install') {
  if (process.env.FAKE_NPM_FAIL === '1') { process.stderr.write('E404 fake npm refuses\\n'); process.exit(1) }
  const spec = args.find((arg) => !arg.startsWith('-') && arg !== 'install' && arg !== '-g')
  const at = spec.lastIndexOf('@')
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  const dir = join(root, ...name.split('/'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  let bin = 'lib/bin.js'
  try { bin = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin?.dsh ?? bin } catch {}
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', bin: { dsh: bin } }, null, 2))
  note('installed ' + name + '@' + version)
  process.exit(0)
}
process.stderr.write('fake npm: unsupported command ' + args.join(' ') + '\\n')
process.exit(2)
`

/**
 * The fake harness: reports its own version and boot id on the status route,
 * and exits when the helper asks it to.
 *
 * Two environment switches model the situations this feature has to survive:
 * `FAKE_NO_VERSION=1` answers the status route without naming a version (the
 * boot that is up while its own plugin cannot report — the state that once got
 * a healthy update rolled back), and `FAKE_SHUTDOWN_STRICT=1` guards the
 * shutdown route the way the plugin's own routes do, refusing anything without
 * the launch token and a same-origin `Origin`.
 */
const FAKE_HARNESS_SOURCE = `import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
const port = Number(process.env.FAKE_PORT)
const bootId = process.pid + '-' + Date.now()

if (process.env.FAKE_READY_FILE) {
  try { writeFileSync(process.env.FAKE_READY_FILE, String(port)) } catch {}
}
if (process.env.FAKE_FAIL_VERSION && version === process.env.FAKE_FAIL_VERSION) {
  process.stderr.write('fake harness ' + version + ' refuses to boot\\n')
  process.exit(3)
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/auto-update/api/v1/status')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(process.env.FAKE_NO_VERSION === '1' ? { ok: true, bootId } : { running: version, bootId, ok: true }))
    return
  }
  if (req.url.startsWith('/auto-update/api/v1/internal/shutdown')) {
    if (process.env.FAKE_SHUTDOWN_STRICT === '1') {
      const token = req.headers['${TOKEN_HEADER}']
      const origin = req.headers.origin
      if (token !== process.env.FAKE_TOKEN || origin !== 'http://127.0.0.1:' + port) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'refused', token: token ?? null, origin: origin ?? null }))
        return
      }
    }
    res.writeHead(202, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ stopping: true }))
    setTimeout(() => process.exit(0), 120)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
server.listen(port, '127.0.0.1')

process.on('SIGTERM', () => process.exit(0))
`
