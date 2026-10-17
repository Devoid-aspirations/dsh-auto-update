/**
 * The compatibility gate.
 *
 * The case these tests exist for is the one that actually happened: a harness
 * release that renames client packages, a profile plugin built against the old
 * name, and an unattended updater that must NOT cross that line on its own.
 * The fixtures are therefore shaped like the real packages — a hard literal
 * require, an assembled fallback, an `inject` naming a removed package — rather
 * than like convenient strings.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyCompatibilityGate,
  clientBundleOf,
  collectClientReferences,
  missingFromTarget,
  packageNamesIn,
  referenceKind,
  removedPackages,
  runningPackageSet,
  scanClientPlugins,
  splitFindings,
  targetPackageSet,
} from '../lib/compat.js'
import { defaults } from '../lib/config.js'
import { clean } from './support/sandbox.mjs'

/**
 * Build a fake profile: `node_modules/<name>/package.json` plus a client bundle.
 * @param {object} packages - package name → { manifest, bundle }.
 * @returns {string} the modules directory.
 */
function profileWith(packages) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
  const modules = join(root, 'node_modules')
  for (const [name, spec] of Object.entries(packages)) {
    const dir = join(modules, ...name.split('/'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(spec.manifest, null, 2)}\n`, 'utf8')
    if (spec.bundle !== undefined) writeFileSync(join(dir, 'lib', 'client.js'), spec.bundle, 'utf8')
  }
  return modules
}

const OLD_STYLE = 'const engine = require("@deepseek-ai/dsh-client-runtime/client");\n'
const NEW_STYLE = 'const platform = ["@deepseek-ai/dsh-client", "-store"].join("");\nconst legacy = ["@deepseek-ai/dsh-client-runtime", "/client"].join("");\nlet e;\ntry { e = require(platform) } catch { e = require(legacy) }\n'

test('the package sets expose what a release adds and removes', () => {
  const running = new Set(['dsh-base', 'dsh-client-runtime', 'dsh-web-app', 'dsh-client-store'])
  const target = new Set(['dsh-base', 'dsh-web-app', 'dsh-client-store', 'dsh-client-modules'])
  assert.deepEqual(removedPackages(running, target), ['dsh-client-runtime'])
  assert.deepEqual([...targetPackageSet({ '@deepseek-ai/dsh-base': '1', 'js-yaml': '2' })], ['dsh-base'])
  assert.deepEqual([...targetPackageSet(undefined)], [])
})

test('a literal require is hard, an assembled probe is a fallback', () => {
  assert.equal(referenceKind(OLD_STYLE, 'dsh-client-runtime'), 'hard')
  assert.equal(referenceKind(NEW_STYLE, 'dsh-client-runtime'), 'fallback', 'the fragment-assembled probe is deliberate compatibility code')
  assert.equal(
    referenceKind(NEW_STYLE, 'dsh-client-store'),
    null,
    'a name that only ever appears as fragments is not a reference at all — neither hard nor a probe',
  )
  assert.equal(referenceKind('const x = 1\n', 'dsh-client-runtime'), null)
  assert.equal(referenceKind('require("@deepseek-ai/dsh-client-runtime-extra/x")', 'dsh-client-runtime'), null, 'a different package name is not a match')
})

test('the client bundle is found through the export map, then by convention', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-'))
  const made = (name, manifest, files) => {
    const dir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    for (const file of files) {
      const full = join(dir, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, '// bundle\n', 'utf8')
    }
    return dir
  }
  const read = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  // A declared entry that exists wins, even when a conventional path also exists.
  const declared = made(
    'declared-plugin',
    { name: 'declared-plugin', version: '1.0.0', exports: { './client': './dist/bundle.js' }, dsh: { client: { platform: 'web' } } },
    ['dist/bundle.js', 'lib/client.js'],
  )
  assert.match(clientBundleOf(declared, read(declared)), /dist[\\/]bundle\.js$/u)

  // A declaration pointing nowhere falls back to the conventional path rather
  // than reporting "no bundle" — the package does ship one, just not where it says.
  const dangling = made(
    'dangling-plugin',
    { name: 'dangling-plugin', version: '1.0.0', exports: { './client': './dist/nope.js' }, dsh: { client: { platform: 'web' } } },
    ['lib/client.js'],
  )
  assert.match(clientBundleOf(dangling, read(dangling)), /lib[\\/]client\.js$/u)

  // Nothing at all: reported as no bundle, so a scan can say "unknown" instead of "clean".
  const none = made('server-only', { name: 'server-only', version: '1.0.0' }, [])
  assert.equal(clientBundleOf(none, read(none)), null)
  clean(root)
})

test('a profile plugin that hard-requires a removed package blocks the update', () => {
  const modules = profileWith({
    'old-plugin': {
      manifest: { name: 'old-plugin', version: '0.1.20', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web' } } },
      bundle: OLD_STYLE,
    },
    'new-plugin': {
      manifest: { name: 'new-plugin', version: '0.4.5', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web' } } },
      bundle: NEW_STYLE,
    },
    'server-only': { manifest: { name: 'server-only', version: '1.0.0' } },
  })
  const scan = scanClientPlugins({
    modulesDir: modules,
    names: ['old-plugin', 'new-plugin', 'server-only'],
    removed: ['dsh-client-runtime'],
  })
  assert.equal(scan.scanned, 2, 'only packages with a client surface are scanned')
  const split = splitFindings(scan)
  assert.equal(split.ok, false)
  assert.deepEqual(split.blocking.map((entry) => entry.name), ['old-plugin'])
  assert.deepEqual(split.blocking[0].hard, ['dsh-client-runtime'])
  assert.deepEqual(split.warning.map((entry) => entry.name), ['new-plugin'], 'the fallback build is news, not a blocker')
  clean(join(modules, '..'))
})

test('a declared inject of a removed package warns without blocking', () => {
  const modules = profileWith({
    'injecting-plugin': {
      manifest: {
        name: 'injecting-plugin',
        version: '0.1.0',
        exports: { './client': './lib/client.js' },
        dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale'] } },
      },
      bundle: 'const nothing = 1\n',
    },
  })
  const scan = scanClientPlugins({ modulesDir: modules, names: ['injecting-plugin'], removed: ['dsh-client-runtime'] })
  assert.equal(scan.findings.length, 1)
  assert.deepEqual(scan.findings[0].injects, ['dsh-client-runtime'])
  assert.deepEqual(scan.findings[0].hard, [])
  assert.equal(splitFindings(scan).ok, true, 'an inject is a warning: the plugin may load degraded, not fail')
  clean(join(modules, '..'))
})

test('a byte-order mark in a plugin manifest does not hide a hard dependency', () => {
  // PowerShell writes a BOM by default. A manifest the scan cannot parse used to
  // be counted `unreadable` and skipped, so the plugin's hard require was never
  // seen and the gate let the very update it exists to withhold through.
  const modules = profileWith({
    'bom-plugin': {
      manifest: { name: 'bom-plugin', version: '0.1.0', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'web' } } },
      bundle: OLD_STYLE,
    },
  })
  const file = join(modules, 'bom-plugin', 'package.json')
  writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8')

  const scan = scanClientPlugins({ modulesDir: modules, names: ['bom-plugin'], removed: ['dsh-client-runtime'] })
  assert.equal(scan.unreadable, 0, 'the mark is not a read failure')
  assert.equal(scan.scanned, 1, 'the plugin is inspected like any other')
  const verdict = splitFindings(scan)
  assert.equal(verdict.ok, false, 'and its hard require still withholds the release')
  assert.deepEqual(verdict.blocking[0]?.hard, ['dsh-client-runtime'])
  clean(join(modules, '..'))
})

test('the gate withholds the release and says why', () => {
  const check = {
    ok: true,
    updateAvailable: true,
    decision: 'update',
    reason: '0.2.0-rc.2 is available',
    candidate: { version: '0.2.0-rc.2' },
    removedPackages: ['dsh-client-runtime'],
  }
  const compat = {
    ok: false,
    blocking: [{ name: 'old-plugin', version: '0.1.20', hard: ['dsh-client-runtime'] }],
    warning: [],
    scanned: 3,
    unreadable: 0,
    removed: ['dsh-client-runtime'],
    target: '0.2.0-rc.2',
  }
  const blocked = applyCompatibilityGate(check, compat, defaults())
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.decision, 'plugin-incompatible', 'the decision names the reason, not just "no"')
  assert.match(blocked.reason, /withheld/u)
  assert.match(blocked.reason, /old-plugin@0\.1\.20 → dsh-client-runtime/u, 'the reason names the plugin and the package')

  const warnOnly = applyCompatibilityGate(check, compat, { ...defaults(), compatibilityGate: 'warn' })
  assert.equal(warnOnly.blocked, false)
  assert.equal(warnOnly.decision, 'update', 'warn applies it anyway, with the detail attached')
  assert.equal(warnOnly.compatibility.blocked, false)
  assert.match(warnOnly.compatibility.detail, /hard-require/u)

  const off = applyCompatibilityGate(check, compat, { ...defaults(), compatibilityGate: 'off' })
  assert.equal(off.compatibility, undefined, 'off skips the check entirely')

  const clean2 = applyCompatibilityGate(check, { ok: true, blocking: [], warning: [], scanned: 4, unreadable: 0, removed: [], target: '0.2.0-rc.2' }, defaults())
  assert.equal(clean2.blocked, false)
  assert.match(clean2.compatibility.detail, /no profile plugin/u)
})

test('the running package set reads the harness install', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app'), { recursive: true })
  const set = runningPackageSet(root)
  assert.deepEqual([...set].sort(), ['dsh-base', 'dsh-web-app'])
  assert.equal(runningPackageSet(null).size, 0)
  assert.equal(packageNamesIn(join(root, 'missing')).size, 0)
  clean(root)
})

test('the references come from what plugins mention, not from the target dependency map', () => {
  const modules = profileWith({
    'plugin-a': {
      manifest: { name: 'plugin-a', version: '1.0.0', dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-primitives'] } } },
      bundle: OLD_STYLE,
    },
    'plugin-b': {
      manifest: { name: 'plugin-b', version: '1.0.0', dsh: { client: { platform: 'web', inject: [] } } },
      bundle: NEW_STYLE,
    },
    'not-a-plugin': { manifest: { name: 'not-a-plugin', version: '1.0.0' } },
  })

  const references = collectClientReferences({ modulesDir: modules, names: ['plugin-a', 'plugin-b', 'not-a-plugin', 'missing'] })
  assert.deepEqual(
    references.refs,
    ['dsh-client-runtime', 'dsh-client-ui-primitives'],
    'a literal require and a declared inject are candidates; a name assembled at runtime is not guessed at',
  )
  assert.equal(references.scanned, 2, 'only the two packages with a dsh.client block are client plugins')
  assert.equal(references.unreadable, 1, 'the missing package is counted, not fatal')
  clean(join(modules, '..'))
})

test('a package the target no longer publishes is the only thing called removed', async () => {
  const asked = []
  const removed = await missingFromTarget(['dsh-client-ui-primitives', 'dsh-client-runtime', 'dsh-client-store'], async (name) => {
    asked.push(name)
    if (name === 'dsh-client-ui-primitives') return true
    return name !== 'dsh-client-runtime'
  })

  assert.deepEqual(removed, ['dsh-client-runtime'], 'the two the target still publishes are not accused')
  assert.deepEqual(asked.sort(), ['dsh-client-runtime', 'dsh-client-store', 'dsh-client-ui-primitives'])
})

test('a probe that cannot answer does not accuse the release of dropping a package', async () => {
  const removed = await missingFromTarget(['flaky'], async () => {
    throw new Error('registry hiccup')
  })
  assert.deepEqual(removed, [])
  assert.deepEqual(await missingFromTarget([], async () => false), [])
})
