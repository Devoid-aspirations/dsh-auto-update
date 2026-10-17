/**
 * The dashboard page.
 *
 * The route test proves the page is served; this file proves it is *correct*.
 * Two classes of regression are covered: escaping (every state field reaches
 * the page through `esc`, and a state file is attacker-adjacent input — it is
 * written by the update helper and by whatever the registry returned), and the
 * accessibility contract the page now carries (labelled controls, announced
 * status, a `<time>` element per timestamp, lazy-safe long content).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderDashboard } from '../lib/dashboard.js'

/**
 * A state document shaped like the live one, with every conditional branch off.
 * @param {object} [overrides] - fields to merge in.
 * @returns {object} the status document.
 */
function state(overrides = {}) {
  return {
    package: '@deepseek-ai/dsh',
    runningVersion: '0.3.0',
    installedVersion: '0.3.0',
    channel: 'stable',
    supervisor: 'none',
    restartMode: 'respawn',
    check: { decision: 'up-to-date', reason: 'running the newest stable release', at: 1792256904086, candidate: null },
    deferral: null,
    helper: null,
    desktop: null,
    desktopSync: null,
    history: [],
    ...overrides,
  }
}

test('the page advertises the dark scheme, a theme colour, and a skip link', () => {
  const html = renderDashboard(state())
  assert.match(html, /<html lang="zh-CN">/u)
  assert.match(html, /color-scheme: dark/u)
  assert.match(html, /<meta name="theme-color" content="#0d1117">/u)
  assert.match(html, /<a class="skip" href="#main">/u)
  assert.match(html, /<main id="main">/u)
})

test('every asynchronous result is announced, and the log region is labelled', () => {
  const html = renderDashboard(state())
  assert.match(html, /<span class="toast" id="toast" role="status" aria-live="polite"/u)
  assert.match(html, /<pre id="log" role="log" aria-live="off" tabindex="0">/u)
})

test('the channel selector has a real label and marks the current channel', () => {
  const html = renderDashboard(state({ channel: 'next' }))
  assert.match(html, /<label class="dim" for="channel">频道 \/ Channel<\/label>/u)
  assert.match(html, /<select id="channel" aria-describedby="channel-hint"/u)
  assert.match(html, /<option value="next" translate="no" selected>/u)
  assert.doesNotMatch(html, /<option value="stable" translate="no" selected>/u)
})

test('state values are escaped instead of being allowed into the markup', () => {
  const html = renderDashboard(state({
    runningVersion: '<img src=x onerror="alert(1)">',
    check: {
      decision: 'update',
      reason: '</script><script>alert(1)</script>',
      at: 1792256904086,
      candidate: { version: '0.3.1"><b>x</b>', tag: 'next', ageMinutes: 12.4 },
    },
    history: [{ at: 1792256904086, from: '0.2.0', to: '0.3.0', outcome: 'succeeded', detail: '<svg onload=alert(1)>', trigger: 'timer' }],
  }))
  assert.doesNotMatch(html, /<img src=x/u)
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/u)
  assert.doesNotMatch(html, /<svg onload/u)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u)
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/u)
})

test('timestamps become time elements that the browser can re-localise', () => {
  const html = renderDashboard(state({
    history: [{ at: 1792256904086, from: '0.2.0', to: '0.3.0', outcome: 'succeeded', trigger: 'timer' }],
  }))
  assert.match(html, /<time datetime="2026-10-17T17:08:24\.086Z" data-ts>/u)
  assert.match(html, /for \(const node of document\.querySelectorAll\('time\[data-ts\]'\)\)/u)
})

test('numbers go through Intl instead of being pasted in raw', () => {
  const html = renderDashboard(state({
    check: { decision: 'update', reason: '', at: 1792256904086, candidate: { version: '0.3.1', tag: 'next', ageMinutes: 12345.6 } },
    desktop: {
      mode: 'package',
      action: 'up-to-date',
      stale: false,
      reason: '',
      projectVersion: '0.3.0',
      packagedVersion: '0.3.0',
      payload: 'DSH Desktop',
      payloadLayout: 'unpacked',
      drift: [],
      zip: { valid: false, bytes: 162578757 },
    },
  }))
  assert.match(html, /12,346 分钟前/u)
  assert.match(html, /不完整 155 MB/u)
  assert.doesNotMatch(html, /162578757/u)
})

test('an empty history says so instead of rendering an empty table body', () => {
  const html = renderDashboard(state())
  assert.match(html, /<td colspan="5" class="dim">还没有更新记录/u)
})

test('the compatibility gate, the deferral, the helper verdict and the desktop drift each render when present', () => {
  const html = renderDashboard(state({
    channel: 'next',
    deferral: { reason: 'the harness is busy', detectedAt: 1792256904086, deadline: 1792267704086 },
    check: {
      decision: 'plugin-incompatible',
      reason: 'withheld',
      at: 1792256904086,
      candidate: { version: '0.3.1', tag: 'next', ageMinutes: 5 },
      compatibility: { blocked: true, detail: 'no profile plugin depends on a package this release removes' },
    },
    helper: { phase: 'failed', error: 'no healthy target', supersededBy: '0.3.0' },
    desktop: {
      mode: 'package',
      action: 'package',
      stale: true,
      reason: 'README.md (missing from the packaged build)',
      projectVersion: '0.3.0',
      packagedVersion: '0.2.0',
      payload: 'DSH Desktop',
      payloadLayout: 'unpacked',
      drift: ['README.md (missing from the packaged build)'],
      zip: { valid: false, bytes: 12 },
    },
    desktopSync: { status: 'failed', detail: 'sync failed', error: 'exit code 1' },
  }))
  assert.match(html, /兼容性闸门已拦截/u)
  assert.match(html, /因等待空闲已推迟：the harness is busy/u)
  assert.match(html, /已被取代/u)
  assert.match(html, /打包产物与项目不一致：README\.md \(missing from the packaged build\)/u)
  assert.match(html, /最近一次桌面端同步：<strong>failed<\/strong>/u)
  assert.match(html, /不完整 12 B/u)
})

test('identifiers are protected from browser auto-translation', () => {
  const html = renderDashboard(state())
  assert.match(html, /<code translate="no">@deepseek-ai\/dsh<\/code>/u)
  assert.match(html, /<div class="v" translate="no">0\.3\.0<\/div>/u)
})
