/**
 * The npm registry client the update check reads.
 *
 * Only the registry metadata endpoints are used — `/«pkg»` for the packument
 * and `/«pkg»/«tag»` for one dist-tag — because those are the two answers the
 * decision needs: which version the channel points at, and when it was
 * published.
 * @module dsh-auto-update/registry
 */

/** The official registry, used when nothing else says otherwise. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * Environment variables that mean "this machine reaches the network through a
 * proxy", most specific first. Node's global `fetch` honours none of them.
 */
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

/**
 * The proxy URL in force, if any.
 * @param {NodeJS.ProcessEnv} [env] - environment, injectable for tests.
 * @returns {string | null} the proxy URL.
 */
export function proxyFromEnv(env = process.env) {
  for (const name of PROXY_ENV) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * A dispatcher that routes requests through the machine's proxy.
 *
 * `undici` is resolved lazily and its absence is not fatal: without a proxy
 * nothing needs it, and behind a proxy the check degrades to a direct request
 * (which is exactly what every other Node program does) instead of failing.
 *
 * When undici *is* resolvable, its `fetch` comes along with the agent. Handing
 * a `ProxyAgent` from one undici to another undici's `fetch` (the copy baked
 * into this Node's `fetch` is not the same copy) is rejected with
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`, which surfaces as the
 * bare "fetch failed" and reads like the registry being down. Borrowing the
 * client and the agent from the same module keeps their handler contract in
 * step.
 * @returns {Promise<{dispatcher: unknown, fetchImpl: typeof fetch | null, kind: string} | null>} the
 *   dispatcher holder, or null when no proxy applies.
 */
async function proxyDispatcher() {
  const proxy = proxyFromEnv()
  if (proxy === null) return null
  try {
    const undici = await import('undici')
    const fetchImpl = typeof undici.fetch === 'function' ? undici.fetch : null
    return { dispatcher: new undici.ProxyAgent(proxy), fetchImpl, kind: 'undici' }
  } catch {
    return { dispatcher: null, fetchImpl: null, kind: 'unavailable' }
  }
}

/**
 * Whether a registry URL may be used as a base for metadata requests.
 *
 * `npm config get registry` also answers `git:`/`file:`/plain paths on some
 * machines, and turning one of those into a fetch URL produces an exception
 * deep inside the request instead of an answer.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for an http(s) URL.
 */
export function isHttpRegistry(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Normalize a registry base: absolute http(s) URL, no trailing slash.
 * @param {unknown} value - the candidate.
 * @returns {string | null} the normalized base, or null when unusable.
 */
export function normalizeRegistry(value) {
  if (!isHttpRegistry(value)) return null
  return String(value).trim().replace(/\/+$/u, '')
}

/**
 * Ask npm itself which registry is configured — the one the install step
 * will actually use, which is the only one worth comparing versions against.
 * @param {{run: (args: string[]) => Promise<{code: number | null, stdout: string}>}} npmRunner
 *   - a runner bound to a resolved npm invocation.
 * @returns {Promise<string>} the configured registry, or the default.
 */
export async function registryFromNpmConfig(npmRunner) {
  try {
    const result = await npmRunner.run(['config', 'get', 'registry'])
    if (result.code !== 0) return DEFAULT_REGISTRY
    return normalizeRegistry(result.stdout.trim().split(/\r?\n/u).pop() ?? '') ?? DEFAULT_REGISTRY
  } catch {
    return DEFAULT_REGISTRY
  }
}

/**
 * Fetch a package's full metadata document.
 * @param {string} name - the package name, scoped or not.
 * @param {{registry?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [options] - knobs.
 * @returns {Promise<object>} the packument.
 * @throws {Error} when the registry does not answer with JSON.
 */
export async function fetchPackument(name, options = {}) {
  const { registry = DEFAULT_REGISTRY, timeoutMs = 12000, fetchImpl = globalThis.fetch } = options
  const base = normalizeRegistry(registry) ?? DEFAULT_REGISTRY
  const url = `${base}/${encodeURIComponent(name)}`
  const proxy = await proxyDispatcher()
  const headers = { accept: 'application/json', 'user-agent': 'dsh-auto-update' }

  /** @param {typeof fetch} impl @param {unknown} dispatcher */
  const attempt = async (impl, dispatcher) => {
    const init = { headers, signal: AbortSignal.timeout(timeoutMs) }
    if (dispatcher !== null) init.dispatcher = dispatcher
    const response = await impl(url, init)
    if (!response.ok) throw new Error(`registry answered HTTP ${response.status} for ${url}`)
    const doc = await response.json()
    if (doc === null || typeof doc !== 'object') throw new Error(`registry returned a non-object packument for ${name}`)
    return doc
  }

  if (proxy !== null && proxy.dispatcher !== null) {
    try {
      return await attempt(proxy.fetchImpl ?? fetchImpl, proxy.dispatcher)
    } catch (error) {
      // One retry without the proxy dispatcher: a mismatched agent, a dead
      // proxy or a flaky tunnel must not read as "the registry is down" while a
      // direct request would have answered.
      try {
        return await attempt(fetchImpl, null)
      } catch (direct) {
        throw new Error(`${String(error?.message ?? error)}; direct request also failed: ${String(direct?.message ?? direct)}`)
      }
    }
  }
  return attempt(fetchImpl, null)
}

/**
 * The version one dist-tag points at.
 * @param {string} name - the package name.
 * @param {string} tag - the dist-tag.
 * @param {{registry?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [options] - knobs.
 * @returns {Promise<string | null>} the version, or null when the tag does not resolve.
 */
export async function fetchTaggedVersion(name, tag, options = {}) {
  const { registry = DEFAULT_REGISTRY, timeoutMs = 10000, fetchImpl = globalThis.fetch } = options
  const base = normalizeRegistry(registry) ?? DEFAULT_REGISTRY
  const url = `${base}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
  const headers = { accept: 'application/json', 'user-agent': 'dsh-auto-update' }

  /** @param {typeof fetch} impl @param {unknown} dispatcher @returns {Promise<string | null>} */
  const attempt = async (impl, dispatcher) => {
    const init = { headers, signal: AbortSignal.timeout(timeoutMs) }
    if (dispatcher !== null) init.dispatcher = dispatcher
    const response = await impl(url, init)
    if (!response.ok) return null
    const doc = await response.json()
    return doc !== null && typeof doc === 'object' && typeof doc.version === 'string' ? doc.version : null
  }

  try {
    const proxy = await proxyDispatcher()
    if (proxy !== null && proxy.dispatcher !== null) {
      try {
        return await attempt(proxy.fetchImpl ?? fetchImpl, proxy.dispatcher)
      } catch {
        // Same fallback as the packument read: try the plain path once.
      }
    }
    return await attempt(fetchImpl, null)
  } catch {
    // An unpublished tag is the ordinary case for a channel nobody cut a
    // build on yet; a registry hiccup must not fail the whole check.
    return null
  }
}
