/**
 * The status dashboard, rendered as one self-contained HTML document.
 *
 * Deliberately build-free: a plugin that can only be looked at after a
 * bundler run is a plugin nobody looks at, and this page's whole job is to
 * answer "what version am I on, what is available, and what happened last
 * time" without a toolchain in the loop. It talks to the same JSON endpoints
 * the agent tool reads.
 *
 * The information architecture is deliberately shallow: the page opens with
 * three lines — when it last looked, what it found, and whether anything is
 * waiting on the reader — and everything else (version numbers, the helper's
 * verdict, desktop drift, the compatibility scan) folds into "more details".
 * History and the log are filterable rather than dumped in full.
 *
 * Accessibility and interaction rules follow the Vercel Web Interface
 * Guidelines: every control is labelled, asynchronous results are announced,
 * focus is visible, numbers and dates go through `Intl`, and long content is
 * allowed to shrink instead of pushing the layout open.
 * @module dsh-auto-update/dashboard
 */

import { BASE_PATH } from './protocol.js'

const numberFormat = new Intl.NumberFormat('zh-CN')
const byteFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const stampFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })

/** How many history rows and log lines the page shows before folding. */
const HISTORY_FOLD = 10
const LOG_LINES = 50
const LOG_LINES_EXPANDED = 200

/**
 * Escape text for HTML interpolation.
 * @param {unknown} value - the value.
 * @returns {string} the escaped text.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/**
 * Render a byte count the way a human reads it.
 * @param {unknown} value - bytes.
 * @returns {string} a grouped, unit-suffixed figure, or an em dash.
 */
function fmtBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${numberFormat.format(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = -1
  do {
    size /= 1024
    unit += 1
  } while (size >= 1024 && unit < units.length - 1)
  return `${byteFormat.format(size)} ${units[unit]}`
}

/**
 * Render a timestamp as a `<time>` element the browser can re-localise.
 *
 * The server renders its own zone so the page reads correctly without
 * JavaScript; the client rewrites every `time[data-ts]` into the viewer's
 * locale, which is the only zone that is actually correct for the reader.
 * @param {unknown} value - epoch milliseconds.
 * @returns {string} the inline markup, or an em dash.
 */
function timeTag(value) {
  const at = Number(value)
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  return `<time datetime="${date.toISOString()}" data-ts>${esc(stampFormat.format(date))}</time>`
}

/**
 * Render one definition-list entry.
 * @param {string} term - the label.
 * @param {string} value - already-escaped markup for the value.
 * @returns {string} the entry.
 */
function fact(term, value) {
  return `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`
}

/**
 * Decide the three-line summary the page opens with.
 * @param {object} state - the status document.
 * @returns {{tone: string, label: string, sentence: string, needs: string[][]}} the summary.
 */
function summarise(state) {
  const decision = state?.check?.decision ?? 'unknown'
  const reason = state?.check?.reason ?? ''
  const candidate = state?.check?.candidate ?? null
  const candidateVersion = candidate?.version ?? null
  const helper = state?.helper ?? null
  const desktop = state?.desktop ?? null
  const blocked = state?.check?.compatibility?.blocked === true
  const autoApply = state?.config?.autoApply !== false
  const live = new Set(['pending', 'starting', 'installing', 'verifying', 'restarting'])
  const helperLive = helper !== null && helper.settled !== true && live.has(helper.phase ?? '')
  const age = candidate?.ageMinutes === null || candidate?.ageMinutes === undefined
    ? ''
    : ` · 发布 ${numberFormat.format(Math.round(candidate.ageMinutes))} 分钟前`
  const channel = state?.channel === 'stable' || state?.channel === undefined ? 'latest' : state.channel

  /** @type {{tone: string, label: string, sentence: string, needs: string[][]}} */
  const out = { tone: 'dim', label: decision, sentence: esc(reason), needs: [['不需要', '暂时没有要你处理的事。', 'ok']] }

  if (blocked) {
    out.tone = 'bad'
    out.label = '被闸门拦下'
    out.sentence = `<strong translate="no">${esc(candidateVersion ?? '')}</strong> 已发布，但兼容性预检判定装上会坏，所以没有装。`
    out.needs = [['是', '把依赖「目标版本已不再提供」的客户端插件更新到兼容版本；确实要装，可在 profile 里临时设 <code>compatibilityGate: warn</code>。', 'bad']]
  } else if (helperLive) {
    out.tone = 'warn'
    out.label = '正在安装'
    out.sentence = `正在装 <strong translate="no">${esc(helper.target ?? '')}</strong>，装完会重启 harness —— 那一刻本页会断开。`
    out.needs = [['不需要', '等它跑完，重启后刷新本页就能看到结果。', 'warn']]
  } else if (decision === 'update') {
    out.tone = 'warn'
    out.label = '有新版本'
    out.sentence = `<strong translate="no">${esc(candidateVersion ?? '')}</strong> 可用（${esc(channel)} 通道${esc(age)}）。`
    out.needs = autoApply
      ? [['不需要', '空闲 90 秒后会自己装、自己重启；想马上动手就点「立即更新」。', 'warn']]
      : [['是', '自动安装已关闭：点「立即更新」，或在 profile 里打开 <code>autoApply</code>。', 'warn']]
  } else if (decision === 'up-to-date') {
    out.tone = 'ok'
    out.label = '一切就绪'
    out.sentence = `正在运行 <strong class="mono" translate="no">${esc(state?.runningVersion ?? 'unknown')}</strong>，已经是 ${esc(channel)} 通道的最新版。`
    out.needs = [['不需要', '空闲时它会自己查、自己装；想不等这 30 分钟就点「立即检查」。', 'ok']]
  } else if (decision === 'registry-unreachable') {
    out.tone = 'warn'
    out.label = '连不上 registry'
    out.sentence = '这一次没有拿到判定结果，下一次检查会自动重试。'
    out.needs = [['暂时不需要', '连续失败再去看日志里的 registry 行。', 'warn']]
  } else if (decision === 'held') {
    out.tone = 'dim'
    out.label = '已锁定版本'
    out.sentence = `<code class="mono" translate="no">holdVersion</code> 把目标版本钉住了，符合条件的更新会被跳过。`
    out.needs = [['不需要', '要解除就在 profile 里去掉 <code>holdVersion</code>。', 'dim']]
  } else if (decision === 'too-fresh') {
    out.tone = 'dim'
    out.label = '版本太新，先等等'
    out.sentence = `新版本还没过最小发布年龄（<code class="mono" translate="no">minReleaseAgeMinutes</code>），到点后才会装。`
    out.needs = [['不需要', '等一会儿它会自己重试。', 'dim']]
  } else if (decision === 'unknown' || decision === 'busy') {
    out.tone = 'dim'
    out.label = '还没有判定'
    out.sentence = '已经排好检查，结果出来前这里保持这个样子。'
    out.needs = [['不需要', '等一次检查跑完，或点「立即检查」。', 'dim']]
  }

  if (desktop !== null && desktop.mode !== 'off' && desktop.stale === true) {
    out.needs.push(['是', '桌面端分发件与项目不一致：先退出 DSH Desktop，再点「同步桌面端」重新打包。', 'warn'])
  }

  return out
}

/**
 * Render the dashboard.
 * @param {object} state - the status document served by the JSON endpoint.
 * @returns {string} the complete HTML document.
 */
export function renderDashboard(state) {
  const summary = summarise(state)
  const decision = state?.check?.decision ?? 'unknown'
  const reason = state?.check?.reason ?? ''
  const candidate = state?.check?.candidate ?? null
  const helper = state?.helper ?? null
  const history = Array.isArray(state?.history) ? state.history : []
  const deferral = state?.deferral ?? null
  const desktop = state?.desktop ?? null
  const desktopSync = state?.desktopSync ?? null
  const probe = state?.check?.compatibility ?? null
  const zip = desktop === null || desktop.mode === 'off' || desktop.zip === null || desktop.zip === undefined
    ? ''
    : ` · 分发 zip ${desktop.zip.valid === true ? '完整' : (desktop.zip.bytes === null ? '缺失' : `不完整 ${fmtBytes(desktop.zip.bytes)}`)}`

  const needsHtml = summary.needs
    .map(([verb, detail, tone]) => `<li><strong class="${esc(tone)}">${esc(verb)}</strong> — ${detail}</li>`)
    .join('')

  const details = [
    fact('运行中', `<span class="mono" translate="no">${esc(state?.runningVersion ?? 'unknown')}</span>`),
    fact('磁盘上', `<span class="mono" translate="no">${esc(state?.installedVersion ?? 'unknown')}</span>`),
    fact('频道', `<span class="mono" translate="no">${esc(state?.channel ?? 'stable')}</span>${state?.channelOverride === null || state?.channelOverride === undefined ? '（配置里的值）' : '（面板里选过）'}`),
    fact('宿主', `<span class="mono" translate="no">${esc(state?.supervisor ?? 'unsupervised')}</span> · 重启方式 <span class="mono" translate="no">${esc(state?.restartMode ?? 'auto')}</span>`),
    fact('候选', candidate === null
      ? '—'
      : `<span class="mono" translate="no">${esc(candidate.version)}</span>${candidate.tag === null || candidate.tag === undefined ? '' : `（<span class="mono" translate="no">${esc(candidate.tag)}</span>）`}${candidate.ageMinutes === null || candidate.ageMinutes === undefined ? '' : ` · 发布 ${esc(numberFormat.format(Math.round(candidate.ageMinutes)))} 分钟前`}`),
    fact('上次检查', `${timeTag(state?.check?.checkedAt ?? state?.check?.at)} · <span class="mono" translate="no">${esc(decision)}</span>`),
  ].join('')

  const historyRows = history.length === 0
    ? '<tr><td colspan="5" class="dim">还没有更新记录 / no updates recorded yet</td></tr>'
    : history
      .slice()
      .reverse()
      .map((row, index) => {
        const from = esc(row.from)
        const to = esc(row.to)
        const outcome = esc(row.outcome ?? '')
        const trigger = esc(row.trigger ?? '')
        return `<tr data-outcome="${outcome}" data-trigger="${trigger}" data-versions="${from} ${to}"${index >= HISTORY_FOLD ? ' hidden' : ''}><td class="num">${timeTag(row.at)}</td><td translate="no">${from} → ${to}</td><td>${outcome}</td><td>${esc(row.detail ?? '')}</td><td class="dim">${trigger}</td></tr>`
      })
      .join('')
  const historyOutcomes = [...new Set(history.map((row) => String(row.outcome ?? '')).filter((value) => value !== ''))].sort()
  const historyTriggers = [...new Set(history.map((row) => String(row.trigger ?? '')).filter((value) => value !== ''))].sort()

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0d1117">
<title>DSH 自动更新 / Auto update</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #0d1117; color: #e6edf3;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif; }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; text-wrap: balance; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #9aa4b2; font-weight: 600; text-wrap: balance; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 18px; }
  .mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; }
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 12px; top: 12px; z-index: 10; background: #1f6feb; color: #fff;
                padding: 8px 12px; border-radius: 8px; text-decoration: none; }
  .status { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 18px; }
  .headline { margin: 0 0 14px; font-size: 16px; line-height: 1.55; }
  .chip { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600;
          border: 1px solid currentColor; margin-right: 8px; vertical-align: 1px; }
  .facts { margin: 0; display: grid; grid-template-columns: 84px 1fr; gap: 7px 14px; font-size: 13.5px; }
  .facts div { display: contents; }
  .facts dt { color: #8b949e; }
  .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .needs { margin: 12px 0 0; padding-left: 18px; }
  .needs li { margin: 3px 0; }
  .more { margin-top: 14px; border-top: 1px solid #21262d; padding-top: 10px; }
  .more summary { cursor: pointer; color: #9aa4b2; font-size: 13px; }
  .more summary:hover { color: #e6edf3; }
  .more .facts { margin-top: 12px; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .bad { color: #f85149; } .dim { color: #8b949e; }
  .panel { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
  .row > * { min-width: 0; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px;
           padding: 8px 14px; cursor: pointer; font-size: 13px;
           touch-action: manipulation; -webkit-tap-highlight-color: rgba(88, 166, 255, .12); }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; }
  button.primary:hover { background: #388bfd; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  select, input[type="search"] { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
           border-radius: 8px; padding: 8px 12px; font-size: 13px;
           touch-action: manipulation; -webkit-tap-highlight-color: rgba(88, 166, 255, .12); }
  select { cursor: pointer; }
  select:hover, input[type="search"]:hover { background: #30363d; }
  input[type="search"] { min-width: 130px; font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; }
  button:focus-visible, select:focus-visible, input:focus-visible, .skip:focus-visible, summary:focus-visible {
    outline: 2px solid #58a6ff; outline-offset: 2px; }
  .hint { flex: 1 1 240px; overflow-wrap: anywhere; font-size: 13px; }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; font-size: 13px; }
  .filters label { color: #8b949e; }
  .scroll-x { overflow-x: auto; }
  .scroll-x table { min-width: 640px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .alert { margin: 12px 0 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
           background: rgba(248, 81, 73, .1); border: 1px solid rgba(248, 81, 73, .45); }
  .alert[hidden] { display: none; }
  pre { background: #0b0f14; border: 1px solid #21262d; border-radius: 8px; padding: 12px;
        overflow: auto; max-height: 320px; font-size: 12px; margin: 0;
        overscroll-behavior: contain; overflow-wrap: anywhere; }
  .toast { min-height: 20px; display: inline-flex; align-items: center; margin-left: 4px; font-size: 13px; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<a class="skip" href="#main">跳到主要内容 / Skip to content</a>
<main id="main">
  <h1>DSH 自动更新</h1>
  <div class="sub">自动检测 <code translate="no">${esc(state?.package ?? '@deepseek-ai/dsh')}</code> 新版本，空闲时无人值守安装并重启；失败自动回滚。数据源为本机状态文件与 npm registry。</div>

  <section class="status" aria-labelledby="status-heading">
    <h2 id="status-heading" style="margin-top:0">现在 / Now</h2>
    <p class="headline"><span class="chip ${esc(summary.tone)}">${esc(summary.label)}</span>${summary.sentence}</p>
    <dl class="facts">
      ${fact('上次检查', `${timeTag(state?.check?.checkedAt ?? state?.check?.at)} · <span class="mono" translate="no">${esc(decision)}</span> · 触发 <span class="mono" translate="no">${esc(state?.check?.trigger ?? '—')}</span>`)}
      ${fact('结果', esc(reason) || '—')}
      <div><dt>需要你动手</dt><dd><ul class="needs">${needsHtml}</ul></dd></div>
    </dl>
    <details class="more">
      <summary>更多细节 / Details</summary>
      <dl class="facts">${details}</dl>
      ${deferral ? `<div class="warn" style="margin-top:10px">因等待空闲已推迟：${esc(deferral.reason ?? '')}（自 ${timeTag(deferral.detectedAt)} 起，最迟 ${timeTag(deferral.deadline)} 执行）</div>` : ''}
      ${probe?.blocked === true
        ? `<div class="bad" style="margin-top:10px"><strong>兼容性闸门已拦截</strong>：${esc(probe.detail)}<br><span class="dim">这些插件依赖目标版本已移除的包，装上就会加载失败。先把它们更新到兼容版本；确实要强行升级，可在 profile 里设 <code>compatibilityGate: warn</code>。</span></div>`
        : probe?.detail
          ? `<div class="dim" style="margin-top:10px">兼容性预检：${esc(probe.detail)}</div>`
          : ''}
      ${helper
        ? helper.supersededBy === undefined || helper.supersededBy === null
          ? `<div style="margin-top:10px">更新助手：<strong>${esc(helper.phase)}</strong> ${esc(helper.detail ?? helper.error ?? '')}</div>`
          : `<div class="dim" style="margin-top:10px">更新助手：上一次 <strong>${esc(helper.phase)}</strong> 已被取代 —— <strong translate="no">${esc(helper.supersededBy)}</strong> 正在运行（原始记录：${esc(helper.error ?? helper.detail ?? '')}）<br>这条只是历史：目标版本已经跑起来了，失败的是当时那段等待接管的验证窗口。</div>`
        : ''}
      ${desktop === null || desktop.mode === 'off'
        ? ''
        : `<div class="${desktop.stale === true ? 'warn' : 'dim'}" style="margin-top:10px">桌面端（dsh-desktop）：项目 ${esc(desktop.projectVersion ?? '—')} · 打包产物 ${esc(desktop.packagedVersion ?? '未打包')}${desktop.payload === null || desktop.payload === undefined ? '' : `（${esc(desktop.payload)} / ${esc(desktop.payloadLayout ?? '?')}）`}${zip} · 判定 <strong>${esc(desktop.action)}</strong>（${esc(desktop.reason ?? '')}）</div>${desktop === null || !Array.isArray(desktop.drift) || desktop.drift.length === 0 ? '' : `<div class="bad" style="margin-top:4px">打包产物与项目不一致：${esc(desktop.drift.join('、'))}</div>`}`}
      ${desktopSync === null
        ? ''
        : `<div class="${desktopSync.status === 'failed' || desktopSync.status === 'packaged-no-zip' ? 'bad' : 'dim'}" style="margin-top:4px">最近一次桌面端同步：<strong>${esc(desktopSync.status)}</strong> ${esc(desktopSync.detail ?? '')}${desktopSync.error === null || desktopSync.error === undefined ? '' : ` — ${esc(desktopSync.error)}`}</div>`}
      ${state?.profilePlugins && state.profilePlugins.updatable > 0
        ? `<div class="dim" style="margin-top:10px">插件市场报告：${esc(state.profilePlugins.updatable)} / ${esc(state.profilePlugins.checked)} 个已装插件有更新（本插件不代为安装）</div>`
        : ''}
    </details>
  </section>

  <div class="row">
    <button id="check" type="button">立即检查 / Check now</button>
    <button id="apply" class="primary" type="button">立即更新 / Update now</button>
    <button id="desktop" type="button">同步桌面端 / Sync desktop</button>
    <button id="reload" type="button">刷新 / Refresh</button>
    <span class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></span>
  </div>
  <div id="inline-error" class="alert bad" role="alert" hidden></div>

  <div class="row">
    <label class="dim" for="channel">频道 / Channel</label>
    <select id="channel" aria-describedby="channel-hint" title="选择接受哪条发布线：latest 只收正式版，next 也收预发布">
      ${[['stable', 'latest（只收正式版）'], ['next', 'next（含预发布）'], ['alpha', 'alpha（含内部版）']]
        .map(([value, label]) => `<option value="${esc(value)}" translate="no"${state?.channel === value ? ' selected' : ''}>${esc(label)}</option>`)
        .join('')}
    </select>
    <span class="dim hint" id="channel-hint">切换后约 20 秒内重新检查；这个选择会记住，重启后仍然生效（除非 profile 里的 <code translate="no">channel</code> 被改过）。</span>
  </div>

  <h2 id="history-heading">升级记录 / History</h2>
  <div class="panel">
    <div class="filters" role="group" aria-label="筛选升级记录">
      <label for="f-outcome">结果</label>
      <select id="f-outcome"><option value="">全部</option>${historyOutcomes.map((value) => `<option value="${esc(value)}" translate="no">${esc(value)}</option>`).join('')}</select>
      <label for="f-trigger">触发</label>
      <select id="f-trigger"><option value="">全部</option>${historyTriggers.map((value) => `<option value="${esc(value)}" translate="no">${esc(value)}</option>`).join('')}</select>
      <label for="f-version">版本</label>
      <input id="f-version" type="search" placeholder="0.2.1" autocomplete="off" spellcheck="false">
      <button id="f-all" type="button" aria-pressed="false">显示全部</button>
      <span class="dim" id="f-count" aria-live="polite"></span>
    </div>
    <div class="scroll-x">
      <table>
        <thead><tr><th scope="col">时间</th><th scope="col">版本</th><th scope="col">结果</th><th scope="col">说明</th><th scope="col">触发</th></tr></thead>
        <tbody id="history-body">${historyRows}</tbody>
      </table>
    </div>
  </div>

  <h2 id="log-heading">日志 / Log</h2>
  <div class="panel">
    <div class="row" style="margin-top:0">
      <label class="dim" for="log-filter">只看</label>
      <select id="log-filter" aria-describedby="log-hint">
        <option value="">全部</option>
        <option value="check">检查</option>
        <option value="update">更新</option>
        <option value="desktop">桌面端</option>
        <option value="problem">警告与错误</option>
      </select>
      <button id="log-more" type="button" aria-pressed="false">展开到 ${LOG_LINES_EXPANDED} 行</button>
      <span class="dim" id="log-count" aria-live="polite"></span>
    </div>
    <span class="dim" id="log-hint" style="display:block;margin-bottom:8px;font-size:12.5px">默认只显示最近 ${LOG_LINES} 行；过滤只作用于已经取到的那一段。</span>
    <pre id="log" role="log" aria-live="off" tabindex="0">加载中…</pre>
  </div>
</main>
<script>
const base = ${JSON.stringify(BASE_PATH)};
const FOLD = ${HISTORY_FOLD};
const LOG_DEFAULT = ${LOG_LINES};
const LOG_EXPANDED = ${LOG_LINES_EXPANDED};
const toast = (text, kind) => {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || 'dim');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 8000);
};
const showError = (message, hint) => {
  const el = document.getElementById('inline-error');
  el.textContent = message + (hint ? ' — ' + hint : '');
  el.hidden = false;
};
const clearError = () => {
  const el = document.getElementById('inline-error');
  el.hidden = true;
  el.textContent = '';
};
const busy = (button, text) => {
  button.dataset.idle = button.textContent;
  button.textContent = text;
  button.disabled = true;
};
const idle = (button) => {
  if (button.dataset.idle) button.textContent = button.dataset.idle;
  button.disabled = false;
};
const post = async (path, payload) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
};
const fail = (button, error, hint) => {
  showError(error.message, hint);
  toast('失败：' + error.message, 'bad');
  if (button) idle(button);
};
document.getElementById('check').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  clearError();
  busy(button, '检查中…');
  try {
    const out = await post('/api/v1/check');
    toast('检查完成：' + (out.check?.decision ?? ''), 'ok');
    setTimeout(() => location.reload(), 800);
  } catch (error) {
    fail(button, error, '稍后重试，或看下方日志');
  }
});
document.getElementById('apply').addEventListener('click', async (event) => {
  if (!confirm('立即安装新版本并重启 DSH？正在进行的对话会被中断。')) return;
  const button = event.currentTarget;
  clearError();
  busy(button, '启动中…');
  try {
    const out = await post('/api/v1/apply');
    toast('已开始更新：' + (out.target ?? ''), 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    fail(button, error, '原因见下方日志');
  }
});
document.getElementById('reload').addEventListener('click', () => location.reload());
document.getElementById('channel').addEventListener('change', async (event) => {
  const select = event.currentTarget;
  const choice = select.value;
  clearError();
  select.disabled = true;
  try {
    const out = await post('/api/v1/channel', { channel: choice });
    toast('频道已切到 ' + out.channel + '，正在重新检查…', 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    showError('切换失败：' + error.message, '稍后重试');
    toast('切换失败：' + error.message, 'bad');
    select.disabled = false;
  }
});
document.getElementById('desktop').addEventListener('click', async (event) => {
  if (!confirm('把打包的桌面端同步到当前 harness 版本？mode=package 时会重新打包（约 1-2 分钟，几百 MB 写盘）。')) return;
  const button = event.currentTarget;
  clearError();
  busy(button, '同步中…');
  try {
    const out = await post('/api/v1/desktop');
    const r = out.result || {};
    const good = r.status === 'packaged' || r.status === 'up-to-date' || r.status === 'version-synced';
    const detail = r.detail ? '（' + r.detail + '）' : '';
    toast('桌面端同步：' + r.status + detail + (r.error ? ' — ' + r.error : ''), good ? 'ok' : (r.status === 'skipped' ? 'dim' : 'bad'));
    setTimeout(() => location.reload(), 1500);
  } catch (error) {
    fail(button, error, '先确认桌面端已退出，再看下方日志');
  }
});

// History: filter first, then fold — the reader narrows, the fold follows.
const rows = Array.from(document.querySelectorAll('#history-body tr[data-outcome]'));
const outcomeInput = document.getElementById('f-outcome');
const triggerInput = document.getElementById('f-trigger');
const versionInput = document.getElementById('f-version');
const allButton = document.getElementById('f-all');
const countLabel = document.getElementById('f-count');
let showAll = false;
const applyFilters = () => {
  const outcome = outcomeInput.value;
  const trigger = triggerInput.value;
  const needle = versionInput.value.trim().toLowerCase();
  let matched = 0;
  let shown = 0;
  for (const row of rows) {
    const hit = (outcome === '' || row.dataset.outcome === outcome)
      && (trigger === '' || row.dataset.trigger === trigger)
      && (needle === '' || String(row.dataset.versions || '').toLowerCase().includes(needle));
    if (!hit) { row.hidden = true; continue; }
    matched += 1;
    if (showAll || matched <= FOLD) { row.hidden = false; shown += 1 } else { row.hidden = true }
  }
  if (rows.length === 0) { countLabel.textContent = ''; return }
  countLabel.textContent = matched === 0
    ? '没有匹配的记录'
    : '显示 ' + shown + ' / ' + matched + (showAll || matched <= FOLD ? '' : '（点「显示全部」展开）');
};
for (const control of [outcomeInput, triggerInput, versionInput]) {
  control.addEventListener(control === versionInput ? 'input' : 'change', applyFilters);
}
allButton.addEventListener('click', () => {
  showAll = !showAll;
  allButton.setAttribute('aria-pressed', showAll ? 'true' : 'false');
  allButton.textContent = showAll ? '只看最近 ' + FOLD + ' 条' : '显示全部';
  applyFilters();
});
applyFilters();

// Log: keep one fetch of text, filter it client-side so the filter is instant.
const log = document.getElementById('log');
const logFilter = document.getElementById('log-filter');
const logMore = document.getElementById('log-more');
const logCount = document.getElementById('log-count');
const PATTERNS = {
  check: /check|decision|registry|up-to-date|withheld/i,
  update: /update|apply|install|helper|rollback|restart|deferr/i,
  desktop: /desktop/i,
  problem: /fail|error|unreachable|aborted|rollback|timed out|denied|invalid/i,
};
let logRaw = '';
let logLines = LOG_DEFAULT;
const renderLog = () => {
  const pattern = PATTERNS[logFilter.value] || null;
  const all = logRaw === '' ? [] : logRaw.split('\\n');
  const kept = pattern === null ? all : all.filter((line) => pattern.test(line));
  log.textContent = kept.length === 0
    ? (all.length === 0 ? '（日志还是空的）' : '（这一段里没有符合条件的行，换一个筛选试试）')
    : kept.join('\\n');
  logCount.textContent = all.length === 0 ? '' : '显示 ' + kept.length + ' / ' + all.length + ' 行';
};
const fetchLog = async () => {
  if (document.hidden) return;
  const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const previous = log.scrollTop;
  try {
    const res = await fetch(base + '/api/v1/log?lines=' + logLines + '&format=text', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    logRaw = await res.text();
    renderLog();
    log.scrollTop = wasAtBottom ? log.scrollHeight : previous;
  } catch (error) {
    log.textContent = '日志不可用：' + error.message + '（每 10 秒重试）';
    logCount.textContent = '';
  }
};
logFilter.addEventListener('change', renderLog);
logMore.addEventListener('click', () => {
  const expanded = logLines === LOG_EXPANDED;
  logLines = expanded ? LOG_DEFAULT : LOG_EXPANDED;
  logMore.setAttribute('aria-pressed', expanded ? 'false' : 'true');
  logMore.textContent = expanded ? '展开到 ' + LOG_EXPANDED + ' 行' : '只看最近 ' + LOG_DEFAULT + ' 行';
  fetchLog();
});
fetchLog();
setInterval(fetchLog, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchLog(); });

// Timestamps are rendered server-side in the host's zone; rewrite them in the
// reader's own zone, which is the only one that is right for that person.
for (const node of document.querySelectorAll('time[data-ts]')) {
  const at = new Date(node.getAttribute('datetime'));
  if (!Number.isNaN(at.getTime())) node.textContent = at.toLocaleString();
}
</script>
</body>
</html>
`
}
