/**
 * The browser half, as the client module table sees it.
 *
 * `lib/client.js` is never imported by Node in production — the Host serves it
 * to the browser, which registers its factory and materializes it. That makes
 * it the one file in this plugin a Node test cannot reach by ordinary means,
 * and also the one whose failures are loudest: a manifest that declares
 * `dsh.client` without a bundle, or a bundle that requires a specifier the
 * module table does not provide, breaks the whole web shell, not this plugin.
 *
 * So the seam is faked exactly the way the Host defines it:
 *   - `window.__ModuleLoader__.load({ id, factory })` registers a factory,
 *   - `factory(require)` materializes it against the module table,
 *   - the returned exports carry `apply(ctx)` and `inject`.
 * Everything below therefore runs the REAL bundle source against a stub module
 * table that throws on any specifier the browser could not resolve.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_FILE = join(ROOT, 'lib', 'client.js')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The bare specifiers the Host's client module table provides to plugin
 * bundles. A bundle may require only these; anything else is a load-time
 * failure in the browser, which no amount of Host-side testing would catch.
 */
const MODULE_TABLE = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/**
 * A `document` stub just rich enough for the stylesheet effect: one head, style
 * tags addressed by `data-plugin-css`, and removal that actually removes.
 * @returns {object} the fake document, with its live tags on `.tags`.
 */
function fakeDocument() {
  const tags = []
  return {
    tags,
    head: {
      append: (tag) => {
        tags.push(tag)
      },
    },
    createElement: () => {
      const tag = { dataset: {}, textContent: '' }
      tag.remove = () => {
        const index = tags.indexOf(tag)
        if (index >= 0) tags.splice(index, 1)
      }
      return tag
    },
    querySelector: (selector) => tags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  }
}

/**
 * Load the bundle the way the browser does: set up `window`, import the file
 * (its top-level statement registers the factory), then materialize it.
 *
 * `document` is deliberately absent here: the bundle touches it in `apply`, not
 * at import, so each test decides whether a document exists.
 * @returns {Promise<{record: object, exports: object, requires: string[]}>} the
 *   loader record, the materialized exports, and every specifier asked for.
 */
let materializations = 0

async function materialize() {
  const registered = []
  const requires = []
  const fakeWindow = { __ModuleLoader__: { load: (record) => registered.push(record) } }
  const previousWindow = globalThis.window
  globalThis.window = fakeWindow
  materializations += 1
  try {
    // A unique query keeps the module cache from handing back the first load:
    // every call is a fresh script execution, which is what materializing is.
    await import(`../lib/client.js?materialize=${materializations}`)
  } finally {
    globalThis.window = previousWindow
  }
  assert.equal(registered.length, 1, 'the bundle registers exactly one factory')
  const record = registered[0]
  const primitives = { IconDownloadOutlineRegular: (props) => ({ type: 'IconDownloadOutlineRegular', props }) }
  const stub = (specifier) => {
    requires.push(specifier)
    if (!MODULE_TABLE.has(specifier)) {
      throw new Error(`the module table has no factory for ${JSON.stringify(specifier)}`)
    }
    if (specifier === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      }
    }
    return primitives
  }
  return { record, exports: record.factory(stub), requires, primitives }
}

/**
 * A client plugin context that records what `apply` did with it.
 * @returns {object} the context plus the capture it fills.
 */
function fakeContext() {
  const capture = { injected: [], registrations: [], dictionaries: new Map(), effects: [], disposers: [] }
  const ctx = {
    effect: (factory, label) => {
      capture.effects.push(label)
      capture.disposers.push(factory())
    },
    locale: {
      register: (namespace, dictionaries) => capture.dictionaries.set(namespace, dictionaries),
      bind: (namespace) => (key) => capture.dictionaries.get(namespace)?.en?.[key] ?? key,
    },
    slots: {
      inject: (slotName, register) => capture.injected.push({ slotName, register }),
      register: (declaration, component) => capture.registrations.push({ declaration, component }),
    },
  }
  return { ctx, capture }
}

/**
 * Run `body` with a fresh fake document installed.
 * @param {Function} body - receives the fake document.
 */
async function withDocument(body) {
  const previous = globalThis.document
  const document = fakeDocument()
  globalThis.document = document
  try {
    await body(document)
  } finally {
    globalThis.document = previous
  }
}

/**
 * Materialize the bundle and apply it to a fresh fake context, returning
 * everything a caller needs to inspect the result.
 * @param {object} [document] - a caller-owned fake document; when omitted the
 *   apply runs against a throwaway one.
 * @returns {Promise<{ctx: object, capture: object}>} the applied context and
 *   its capture.
 */
async function applyOnce(document) {
  const { exports, primitives } = await materialize()
  const { ctx, capture } = fakeContext()
  if (document !== undefined) {
    exports.apply(ctx)
    return { ctx, capture, primitives }
  }
  const previous = globalThis.document
  globalThis.document = fakeDocument()
  try {
    exports.apply(ctx)
  } finally {
    globalThis.document = previous
  }
  return { ctx, capture, primitives }
}

test('the manifest ships a client bundle the Host can find and serve', () => {
  const entry = MANIFEST.exports['./client']
  const relative = typeof entry === 'string' ? entry : entry?.default
  assert.equal(typeof relative, 'string', 'exports["./client"] names a bundle (string or {default})')
  assert.equal(existsSync(join(ROOT, relative)), true, `${relative} exists in the checkout`)
  // `files` decides what an install actually receives: a bundle outside it is a
  // route the Host cannot serve from the installed copy.
  assert.equal(MANIFEST.files.includes('lib'), true, 'the `lib` directory is shipped')
  assert.equal(MANIFEST.dsh.client.platform, 'web', 'the browser half targets the web platform')
  assert.equal(Array.isArray(MANIFEST.dsh.client.inject), true, 'dsh.client.inject is a string array')
  for (const dependency of MANIFEST.dsh.client.inject) {
    assert.equal(typeof dependency, 'string', 'every injected client id is a string')
  }
})

test('the bundle registers under the package id and asks only for resolvable modules', async () => {
  const { record, exports, requires } = await materialize()
  assert.equal(record.id, MANIFEST.name, 'the loader id is the package name the Host serves')
  assert.equal(typeof exports.apply, 'function', 'the bundle exports apply')
  assert.deepEqual(exports.inject, ['slots', 'locale'], 'it asks for the slot registry and the locale service')
  assert.equal(requires.includes('react/jsx-runtime'), true, 'it renders through the shared JSX runtime')
  assert.equal(requires.includes('@deepseek-ai/dsh-client-ui-primitives'), true, 'the icon comes from the shared primitives')
  // The stub already throws on an unknown specifier; this also catches a
  // require that only runs on a path the test never reaches.
  const text = readFileSync(CLIENT_FILE, 'utf8')
  const declared = [...text.matchAll(/require\('([^']+)'\)/gu)]
  assert.equal(declared.length > 0, true, 'the bundle does require shared modules (the scan is not vacuous)')
  for (const match of declared) {
    assert.equal(MODULE_TABLE.has(match[1]), true, `${match[1]} is in the client module table`)
  }
})

test('apply registers the dictionaries and the sidebar footer button', async () => {
  const { capture } = await applyOnce()
  assert.deepEqual([...capture.dictionaries.keys()], ['auto-update'], 'one namespace, registered once')
  const { zh, en } = capture.dictionaries.get('auto-update')
  assert.equal(typeof zh['action.label'], 'string')
  assert.equal(typeof en['action.label'], 'string')
  // The panel opens a page, so the label has to exist in both languages: a key
  // missing from one dictionary renders the raw key in that language.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'both dictionaries carry the same keys')
  assert.equal(capture.injected.length, 1)
  assert.equal(capture.injected[0].slotName, 'sidebar.footer.action')
  // The slot registration is contributed lazily, as the shell expects.
  capture.injected[0].register()
  assert.equal(capture.registrations.length, 1)
  const { declaration, component } = capture.registrations[0]
  assert.equal(declaration.name, 'sidebar.footer.action')
  assert.equal(declaration.id, 'auto-update-panel')
  assert.equal(declaration.locale, 'auto-update')
  assert.equal(typeof component, 'function')
})

test('the button renders a label when the sidebar is wide and an icon when it is not', async () => {
  const { capture, primitives } = await applyOnce()
  capture.injected[0].register()
  const { component } = capture.registrations[0]
  const { zh } = capture.dictionaries.get('auto-update')
  const t = (key) => zh[key]

  const wide = component({ wide: true, t })
  assert.equal(wide.type, 'button')
  assert.equal(wide.props.type, 'button')
  assert.equal(wide.props.className, 'dsh-auto-update-footer')
  assert.equal(wide.props['aria-label'], '自动更新')
  assert.equal(wide.props.title, zh['action.hint'])
  assert.equal(wide.props.children[0].type, primitives.IconDownloadOutlineRegular, 'the glyph is a shared primitive icon')
  assert.equal(wide.props.children[0].props.size, 16)
  assert.equal(wide.props.children[1].props.children, '自动更新')

  const narrow = component({ wide: false, t })
  assert.equal(narrow.props.children[1], null, 'no label in the collapsed rail')
  assert.equal(narrow.props.children[0].props.size, 18)
})

test('clicking opens the panel in a tab, and a re-apply replaces the stylesheet', async () => {
  const calls = []
  const previous = globalThis.window
  globalThis.window = { location: { href: 'http://127.0.0.1:3080/' }, open: (...args) => calls.push(args) }
  try {
    await withDocument(async (document) => {
      for (let index = 0; index < 2; index += 1) {
        const { capture } = await applyOnce(document)
        capture.injected[0].register()
        const { component } = capture.registrations[0]
        const { zh } = capture.dictionaries.get('auto-update')
        component({ wide: true, t: (key) => zh[key] }).props.onClick()
        // A re-apply must replace the tag, not stack a second copy of the CSS.
        assert.equal(document.tags.length, 1, 'one stylesheet per document, however often apply runs')
        assert.equal(document.tags[0].dataset.plugin, 'dsh-auto-update')
      }
      assert.deepEqual(calls, [
        ['http://127.0.0.1:3080/auto-update/', '_blank', 'noopener,noreferrer'],
        ['http://127.0.0.1:3080/auto-update/', '_blank', 'noopener,noreferrer'],
      ])
      const css = document.tags[0].textContent
      assert.equal(css.includes('.dsh-auto-update-footer'), true, 'the injected CSS carries the button rule')
      assert.equal(css.includes('--dsw-alias-interactive-bg-hover'), true, 'the hover fill comes from the theme')
      // The panel is a loopback-only page: it must open on its own, not replace
      // the session view, and the placement rules must be present.
      assert.equal(css.includes('order:4'), true, 'the button sits between the settings and remote-access rows')
      assert.equal(css.includes('[data-dsh-part=entry]'), true, 'the other footer entries are ordered around it')
    })
  } finally {
    globalThis.window = previous
  }
})

test('under the Desktop bridge the panel opens in the system browser', async () => {
  const opened = []
  const externals = []
  const previous = globalThis.window
  // The preload bridge exposes `openExternal`; `window.open` is what the Desktop
  // window-open handler would turn into an Electron child window instead.
  globalThis.window = {
    location: { href: 'http://127.0.0.1:3080/' },
    open: (...args) => opened.push(args),
    dshDesktop: { openExternal: (url) => externals.push(url) },
  }
  try {
    await withDocument(async () => {
      const { capture } = await applyOnce()
      capture.injected[0].register()
      const { component } = capture.registrations[0]
      const { zh } = capture.dictionaries.get('auto-update')
      component({ wide: true, t: (key) => zh[key] }).props.onClick()
    })
    assert.deepEqual(externals, ['http://127.0.0.1:3080/auto-update/'], 'the bridge gets the absolute loopback URL')
    assert.deepEqual(opened, [], 'no Electron child window is opened')
  } finally {
    globalThis.window = previous
  }
})
