/**
 * Restart the harness gracefully, instead of killing it.
 *
 * `taskkill /F` (and Node's `process.kill(pid, 'SIGTERM')` on Windows, which is
 * TerminateProcess) gives the process no chance to dispose its tree or flush
 * session transcripts. The market plugin owns the graceful path: it closes the
 * composition, then a detached helper brings a replacement up — which is also
 * how a freshly installed plugin build gets loaded without anyone relaunching
 * by hand.
 *
 * The delay exists so the caller's own last output can reach the browser before
 * its process goes away; it defaults to 8 seconds.
 *
 * Usage:
 *   node scripts/restart-harness.mjs [delaySeconds] [port]
 */

const delaySeconds = Number(process.argv[2] ?? 8)
const PORT = Number(process.argv[3] ?? 3080)
const base = `http://127.0.0.1:${PORT}`

/**
 * Read a JSON endpoint on the local harness.
 * @param {string} path - the path to fetch.
 * @returns {Promise<{status: number, body: any}>} the answer.
 */
async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { accept: 'application/json', host: `127.0.0.1:${PORT}`, origin: base },
    signal: AbortSignal.timeout(8000),
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

const capabilities = await get('/dsh-market/api/v1/capabilities')
process.stdout.write(`capabilities: HTTP ${capabilities.status} restart=${JSON.stringify(capabilities.body?.restart ?? null)}\n`)
if (capabilities.body?.restart?.supported !== true) {
  process.stderr.write('the market does not own a restart here (a supervisor or a debugger does) — stop the process yourself instead\n')
  process.exit(2)
}

if (delaySeconds > 0) {
  process.stdout.write(`restarting in ${delaySeconds}s (giving the caller time to finish its reply)…\n`)
  await new Promise((settle) => setTimeout(settle, delaySeconds * 1000))
}

try {
  const response = await fetch(`${base}/dsh-market/api/v1/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', host: `127.0.0.1:${PORT}`, origin: base },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  process.stdout.write(`restart: HTTP ${response.status} ${text.slice(0, 300)}\n`)
} catch (error) {
  // The connection dropping IS the restart, in the common case.
  process.stdout.write(`restart request ended: ${String(error?.message ?? error)}\n`)
}
