/**
 * Relaunching and probing the harness: the invocation to replay, the
 * platform-correct way to start it detached, and the liveness checks that
 * decide whether a replacement actually came up.
 *
 * Shared by the plugin (which decides) and the detached helper (which acts),
 * so the process that installs a version and the process that judges it agree
 * on what "the harness is running" means.
 * @module dsh-auto-update/restart
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { isAbsolute, resolve, dirname } from 'node:path'

/**
 * The real Node executable for spawning children.
 * `process.argv0` carries the true binary on platforms where `execPath` is a
 * linker shim, so it wins whenever it is an existing absolute path.
 * @param {string} [argv0] - `process.argv0`.
 * @param {string} [execPath] - `process.execPath`.
 * @param {(path: string) => boolean} [exists] - existence probe, for tests.
 * @returns {string} the executable to spawn.
 */
export function nodeExecutable(argv0 = process.argv0, execPath = process.execPath, exists = existsSync) {
  if (typeof argv0 === 'string' && argv0 !== '' && isAbsolute(argv0) && exists(argv0)) return argv0
  return execPath
}

/**
 * The argv that re-invokes the CLI which started this process.
 *
 * Reading it off `process.argv` is the only way to be right for every launch
 * shape — a global bin, a local install, or a source checkout run through a
 * loader — because that is the command that is demonstrably working.
 * @param {object} [proc] - a process-like object, injectable for tests.
 * @returns {{file: string, args: string[], cwd: string, viaShell: boolean}} the invocation.
 */
export function launchFromProcess(proc = process) {
  const entry = Array.isArray(proc.argv) ? proc.argv[1] : undefined
  const execArgv = Array.isArray(proc.execArgv) ? proc.execArgv : []
  if (typeof entry === 'string' && /[\\/](?:bin\.(?:js|ts)|dsh)$/iu.test(entry)) {
    const absolute = resolve(entry)
    return {
      file: nodeExecutable(proc.argv0, proc.execPath),
      args: [...execArgv, absolute, ...proc.argv.slice(2)],
      cwd: dirname(absolute),
      viaShell: false,
    }
  }
  return {
    file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: Array.isArray(proc.argv) ? proc.argv.slice(2) : [],
    cwd: typeof proc.cwd === 'function' ? proc.cwd() : process.cwd(),
    viaShell: process.platform === 'win32',
  }
}

/**
 * Platform-correct spawn invocation for the replacement harness.
 *
 * On Windows a `detached` spawn maps to DETACHED_PROCESS: the new host gets no
 * console, and every console child it later spawns (the sandbox tool runners,
 * for one) pops a visible window of its own. Wrapping the launch in a hidden
 * PowerShell gives the host a console that is merely invisible, which its
 * children then inherit. POSIX keeps the plain detached spawn.
 * @param {{file: string, args: string[], viaShell: boolean}} launch - the invocation.
 * @param {NodeJS.Platform} [platform] - target platform.
 * @returns {{file: string, args: string[], viaShell: boolean, detached: boolean}} what to spawn.
 */
export function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  }
  const quote = (part) => `'${String(part).replace(/'/gu, "''")}'`
  // Name the cmd shim explicitly: invoking a bare name lets PowerShell prefer
  // the `.ps1` beside it, which a Restricted execution policy refuses.
  const file = launch.viaShell && !/\.(?:cmd|bat)$/iu.test(launch.file) ? `${launch.file}.cmd` : launch.file
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', [`& ${quote(file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  }
}

/**
 * Start a command detached, so it outlives the process that starts it.
 * @param {{file: string, args: string[], detached?: boolean}} spawnSpec - what to start.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, out?: number, err?: number, onError?: (error: Error) => void, onExit?: (code: number | null) => void}} [options]
 *   - spawn options; `out`/`err` are file descriptors for the child's stdio.
 * @returns {{pid: number | null, child: import('node:child_process').ChildProcess | null, error: Error | null}} the started child.
 */
export function spawnDetached(spawnSpec, options = {}) {
  const { cwd = process.cwd(), env = process.env, out = 'ignore', err = 'ignore', onError, onExit } = options
  try {
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd,
      env,
      detached: spawnSpec.detached !== false,
      stdio: ['ignore', out, err],
      shell: false,
      windowsHide: true,
    })
    // spawn reports an unexecutable file asynchronously; without a listener
    // that failure is exactly as silent as the bug being prevented.
    child.on('error', (error) => {
      if (typeof onError === 'function') onError(error)
    })
    if (typeof onExit === 'function') child.on('exit', (code) => onExit(code))
    child.unref()
    return { pid: child.pid ?? null, child, error: null }
  } catch (error) {
    return { pid: null, child: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Whether something accepts a TCP connection on a loopback port.
 *
 * Checked by connecting rather than by binding: a bind test would itself hold
 * the port for the moment the replacement needs it.
 * @param {{port: number, host?: string, timeoutMs?: number}} options - the probe.
 * @returns {Promise<boolean>} true when the port answers.
 */
export function portListening(options) {
  const { port, host = '127.0.0.1', timeoutMs = 600 } = options
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return Promise.resolve(false)
  return new Promise((settle) => {
    const probe = net.connect({ host, port })
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      probe.destroy()
      settle(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(timeoutMs, () => finish(false))
  })
}

/**
 * Wait until a port stops answering.
 * @param {{port: number, host?: string, timeoutMs?: number}} options - the wait.
 * @returns {Promise<boolean>} true when the port is free, false on timeout.
 */
export async function waitForPortFree(options) {
  const { timeoutMs = 30000 } = options
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (!(await portListening(options))) return true
    await sleep(250)
  }
  return !(await portListening(options))
}

/**
 * Wait until a port starts answering.
 * @param {{port: number, host?: string, timeoutMs?: number}} options - the wait.
 * @returns {Promise<boolean>} true when the port came up.
 */
export async function waitForPortUp(options) {
  const { timeoutMs = 30000 } = options
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await portListening(options)) return true
    await sleep(300)
  }
  return portListening(options)
}

/**
 * Check whether a process supervisor owns this host's lifetime.
 *
 * Two cases matter. `DSH_WEB_MODE=desktop` is set by the DSH Desktop shell,
 * which restarts its own `dsh web` child when that child exits — killing it
 * ourselves and letting the shell respawn is strictly safer than racing the
 * shell for the port. A systemd unit (or a cgroup-killing manager alike) is
 * detected by the same two signals the market uses: the marker variables are
 * INHERITED, so ownership additionally requires that our parent is the
 * manager itself.
 * @param {NodeJS.ProcessEnv} [env] - environment.
 * @param {number} [ppid] - parent pid.
 * @param {(pid: number) => string | null} [parentComm] - reader for the parent's command name.
 * @returns {string | null} the supervisor's name, or null when unsupervised.
 */
export function detectedSupervisor(env = process.env, ppid = process.ppid, parentComm = readParentComm) {
  if ((env.DSH_WEB_MODE ?? '') !== '') return 'desktop-shell'
  const set = (name) => (env[name] ?? '') !== ''
  if (!set('INVOCATION_ID') && !set('JOURNAL_STREAM') && !set('pm_id')) return null
  if (ppid === 1 || parentComm(ppid) === 'systemd') return 'systemd'
  if (set('pm_id')) return 'pm2'
  return null
}

/**
 * The command name of a pid, where the platform exposes it.
 * @param {number} pid - the process id.
 * @returns {string | null} the name, or null when it cannot be read.
 */
function readParentComm(pid) {
  try {
    // Linux only: exactly as wide as systemd itself. Everywhere else the
    // marker variables alone decide.
    return String(readFileSync(`/proc/${pid}/comm`, 'utf8')).trim()
  } catch {
    return null
  }
}

/**
 * How the restart should happen, resolved from configuration and facts.
 * @param {object} config - the effective configuration.
 * @param {string | null} supervisor - the detected supervisor.
 * @returns {'exit-only' | 'respawn'} the resolved mode.
 */
export function resolveRestartMode(config, supervisor) {
  if (config.restartMode === 'exit-only') return 'exit-only'
  if (config.restartMode === 'respawn') return 'respawn'
  return supervisor === null ? 'respawn' : 'exit-only'
}

/**
 * Ask the harness whether it is up, and which version it reports.
 * @param {{url: string, path?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} options - the check.
 * @returns {Promise<{ok: boolean, status: number | null, running: string | null, bootId: string | null, error: string | null}>} the answer.
 */
export async function healthCheck(options) {
  const { url, path = '/', timeoutMs = 4000, fetchImpl = globalThis.fetch } = options
  const target = `${String(url).replace(/\/+$/u, '')}${path}`
  try {
    const response = await fetchImpl(target, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, status: response.status, running: null, bootId: null, error: `HTTP ${response.status}` }
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return {
      ok: true,
      status: response.status,
      running: body !== null && typeof body.running === 'string' ? body.running : null,
      bootId: body !== null && typeof body.bootId === 'string' ? body.bootId : null,
      error: null,
    }
  } catch (error) {
    return { ok: false, status: null, running: null, bootId: null, error: String(error?.message ?? error) }
  }
}

/**
 * Sleep.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
export function sleep(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}
