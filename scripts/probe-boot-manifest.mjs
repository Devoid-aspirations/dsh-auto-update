/**
 * Read the client boot manifest the running harness injects into its page.
 *
 * `dsh web` hands the browser `window.__DSH_BOOT__`, which names every client
 * plugin bundle the client will load. That list — not a guess about URL
 * shapes — is the authoritative answer to "what does the GUI try to load",
 * and each entry can then be fetched to see whether it is served at all.
 *
 * Usage: node scripts/probe-boot-manifest.mjs [port]
 */

const PORT = Number(process.argv[2]) || 3080
const base = `http://127.0.0.1:${PORT}`

const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(10000) })
const html = await response.text()
process.stdout.write(`GET / -> HTTP ${response.status}, ${html.length} bytes\n`)

const match = html.match(/__DSH_BOOT__\s*=\s*([\s\S]*?);?\s*<\/script>/u)
if (match === null) {
  const scripts = [...html.matchAll(/<script[^>]*>/gu)].map((entry) => entry[0])
  process.stdout.write(`no __DSH_BOOT__ found. script tags seen:\n${scripts.slice(0, 10).join('\n')}\n`)
  process.exit(0)
}

const payload = match[1].trim()
process.stdout.write(`boot payload: ${payload.length} bytes\n`)

/** Every string that looks like a client bundle URL, however it is nested. */
const urls = [...payload.matchAll(/"([^"]*?(?:client|bundle)[^"]*?\.js[^"]*)"/gu)].map((entry) => entry[1])
process.stdout.write(`bundle URLs named in the payload: ${urls.length}\n`)
for (const url of urls.slice(0, 30)) process.stdout.write(`   ${url}\n`)

if (urls.length === 0) {
  process.stdout.write(`--- first 1500 chars of the payload ---\n${payload.slice(0, 1500)}\n`)
}

// Fetch each one: a bundle the manifest names but the host cannot serve is
// exactly the "failed to load" the user saw.
for (const url of urls.slice(0, 30)) {
  const target = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`
  try {
    const probe = await fetch(target, { signal: AbortSignal.timeout(8000) })
    process.stdout.write(`${String(probe.status).padEnd(5)} ${target}\n`)
  } catch (error) {
    process.stdout.write(`ERR   ${target}  (${String(error?.message ?? error)})\n`)
  }
}
