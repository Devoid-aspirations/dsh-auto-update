/**
 * The HTTP surface: a JSON status document, a build-free dashboard, and two
 * process-control routes (start an update, stop the host) with the guards a
 * process-control route needs.
 *
 * Everything is served under one `prefix` registration, so the feature adds
 * exactly one route pattern to the web server and cannot collide with another
 * plugin's paths.
 * @module dsh-auto-update/routes
 */

import { APPLY_PATH, BASE_PATH, CHANNEL_PATH, CHECK_PATH, DESKTOP_PATH, LOG_PATH, SHUTDOWN_PATH, STATUS_PATH, TOKEN_HEADER } from './protocol.js'
import { renderDashboard } from './dashboard.js'

/** The largest request body any of these routes accepts. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Whether an authority string names this machine's loopback interface.
 *
 * A loopback PEER is not enough on its own — a DNS-rebinding page reaches
 * 127.0.0.1 through a name it controls — so `Host` has to name a loopback
 * authority too, which is the one part of the request an attacker cannot forge.
 * @param {string | undefined} authority - the `Host` header value.
 * @returns {boolean} true for `127.0.0.1`, `localhost` or `[::1]`, with or without a port.
 */
export function loopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return false
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
  const name = host.replace(/^\[|\]$/gu, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0.0.0.0' || name === '::ffff:127.0.0.1'
}

/**
 * Whether a request came from this host on loopback.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {{requireOrigin?: boolean}} [options] - `requireOrigin` for mutations.
 * @returns {boolean} true when the request may be trusted.
 */
export function trustedRequest(req, options = {}) {
  const { requireOrigin = false } = options
  const address = req.socket?.remoteAddress ?? ''
  const loopbackPeer = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopbackPeer) return false
  // Any forwarding trace means the loopback peer is a proxy, not the user.
  if (req.headers.forwarded !== undefined || req.headers['x-forwarded-for'] !== undefined || req.headers['x-real-ip'] !== undefined) return false
  if (!loopbackAuthority(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {unknown} body - the JSON body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = `${JSON.stringify(body, null, 2)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Send a plain-text response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {string} body - the text.
 * @returns {void}
 */
function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Read and parse a small JSON body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>} the parsed body, or an empty object.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Register the feature's routes on the web server.
 * @param {object} ctx - the plugin context carrying `webServer`.
 * @param {object} api - the host-side operations the routes expose.
 * @param {() => object} api.status - the current status document.
 * @param {(options: object) => Promise<object>} api.check - force a registry check.
 * @param {(value: unknown) => {channel: string, changed: boolean}} api.setChannel - switch the release channel.
 * @param {(options: object) => Promise<object>} api.apply - start an update.
 * @param {(lines: number) => string} api.logTail - the log tail.
 * @param {(token: string) => boolean} api.requestShutdown - verify a helper's one-shot token.
 * @param {() => void} api.stop - actually stop this harness, called only after `requestShutdown` accepts.
 * @returns {() => void} the disposer.
 */
export function registerRoutes(ctx, api) {
  const handler = async (req, res) => {
    let pathname = '/'
    let search = new URLSearchParams()
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      pathname = url.pathname.replace(/\/+$/u, '') || '/'
      search = url.searchParams
    } catch {
      sendJson(res, 400, { error: 'bad request url' })
      return
    }
    const method = req.method ?? 'GET'
    const loopback = trustedRequest(req, { requireOrigin: method !== 'GET' })
    if (!loopback) {
      sendJson(res, 403, { error: 'this endpoint is loopback-only and same-origin' })
      return
    }

    try {
      if (pathname === BASE_PATH || pathname === `${BASE_PATH}/`) {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        return sendText(res, 200, renderDashboard(api.status()), 'text/html; charset=utf-8')
      }
      if (pathname === STATUS_PATH) {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        return sendJson(res, 200, api.status())
      }
      if (pathname === LOG_PATH) {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        const lines = Math.min(2000, Math.max(1, Number(search.get('lines') ?? 200) || 200))
        const text = api.logTail(lines)
        if ((search.get('format') ?? 'text') === 'json') return sendJson(res, 200, { lines: text.split(/\r?\n/u).filter((line) => line !== '') })
        return sendText(res, 200, text)
      }
      if (pathname === CHECK_PATH) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const result = await api.check({ trigger: 'api', force: body.force !== false })
        return sendJson(res, 200, result)
      }
      if (pathname === CHANNEL_PATH) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        // The next tick (≤ 20 s) re-checks; this response carries the channel
        // that is now in force, which is what the panel needs to redraw.
        const result = api.setChannel(body.channel)
        return sendJson(res, 200, result)
      }
      if (pathname === APPLY_PATH) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const result = await api.apply({ trigger: 'api', force: true, version: typeof body.version === 'string' ? body.version : null })
        return sendJson(res, result.started === true ? 202 : 409, result)
      }
      if (pathname === DESKTOP_PATH) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const result = await api.desktop({ trigger: 'api' })
        // A sync that ran and reported is a success of the endpoint even when
        // the build it drove failed: the failure is in the body, and the panel
        // needs the status document either way.
        return sendJson(res, 200, result)
      }
      if (pathname === SHUTDOWN_PATH) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const token = req.headers[TOKEN_HEADER]
        if (typeof token !== 'string' || !api.requestShutdown(token)) {
          sendJson(res, 403, { error: 'bad or stale shutdown token' })
          return
        }
        sendJson(res, 202, { stopping: true, pid: process.pid })
        // Let the response flush before the tree starts disposing: the helper
        // is waiting on this answer, not on our exit.
        setTimeout(() => {
          try {
            api.stop()
          } catch {
            process.exit(0)
          }
        }, 300)
        return
      }
      return sendJson(res, 404, { error: `no route for ${pathname}` })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: BASE_PATH, handler })
}
