/**
 * Read-only integration with the plugin market, when one is installed.
 *
 * The harness and the profile's plugins move on separate release trains: this
 * feature owns the harness, and the market owns the plugins. Neither should
 * silently do the other's job, but a harness update that leaves a dozen
 * plugins behind is worth SAYING — so this asks the market's public update API
 * for a count and nothing more.
 *
 * @module dsh-auto-update/market
 */

/** The market's public, versioned update API (see its UPDATE-API-V1.md). */
const SUMMARY_PATH = '/dsh-market/api/v1/updates/summary'

/**
 * Ask the local market how many installed plugins can be updated.
 *
 * Failure is ordinary and silent: the market is optional, it may be an older
 * version without this endpoint, and a profile without it is not a problem
 * this feature exists to report.
 * @param {{port: number, timeoutMs?: number}} options - where the harness serves.
 * @returns {Promise<{checked: number, updatable: number, packages: object[]} | null>}
 *   the counts, or null when the market cannot answer.
 */
export async function checkProfilePlugins(options) {
  const { port, timeoutMs = 6000 } = options
  if (!Number.isInteger(port) || port <= 0) return null
  const origin = `http://127.0.0.1:${port}`
  const headers = { accept: 'application/json', host: `127.0.0.1:${port}`, origin }
  try {
    const summary = await fetchJson(`${origin}${SUMMARY_PATH}`, { headers, timeoutMs })
    if (summary === null) return null
    return {
      checked: Number(summary.checked ?? 0) || 0,
      updatable: Number(summary.updatable ?? 0) || 0,
      packages: Array.isArray(summary.packages) ? summary.packages.slice(0, 20) : [],
    }
  } catch {
    return null
  }
}

/**
 * Fetch and parse a JSON document.
 * @param {string} url - the URL.
 * @param {{headers?: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch}} options - the request.
 * @returns {Promise<object | null>} the parsed body, or null for a non-JSON answer.
 */
async function fetchJson(url, options) {
  const { headers = {}, timeoutMs = 6000, fetchImpl = globalThis.fetch } = options
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}
