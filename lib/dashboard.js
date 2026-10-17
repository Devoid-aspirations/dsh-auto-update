/**
 * The status dashboard, rendered as one self-contained HTML document.
 *
 * Deliberately build-free: a plugin that can only be looked at after a
 * bundler run is a plugin nobody looks at, and this page's whole job is to
 * answer "what version am I on, what is available, and what happened last
 * time" without a toolchain in the loop. It talks to the same JSON endpoints
 * the agent tool reads.
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
 * Render the dashboard.
 * @param {object} state - the status document served by the JSON endpoint.
 * @returns {string} the complete HTML document.
 */
export function renderDashboard(state) {
  const running = state?.runningVersion ?? 'unknown'
  const latest = state?.check?.candidate ?? null
  const decision = state?.check?.decision ?? 'unknown'
  const reason = state?.check?.reason ?? ''
  const helper = state?.helper ?? null
  const history = Array.isArray(state?.history) ? state.history : []
  const deferral = state?.deferral ?? null
  const desktop = state?.desktop ?? null
  const desktopSync = state?.desktopSync ?? null
  const badges = [
    ['版本', running, true],
    ['频道', state?.channel === 'stable' ? 'latest（稳定）' : (state?.channel ?? 'stable'), true],
    ['状态', decision, false],
    ['宿主', state?.supervisor ?? 'unsupervised', false],
    ['重启方式', state?.restartMode ?? 'auto', true],
    ['磁盘版本', state?.installedVersion ?? 'unknown', true],
  ]
  const desktopZip = desktop === null || desktop.mode === 'off' || desktop.zip === null || desktop.zip === undefined
    ? ''
    : ` · 分发 zip ${desktop.zip.valid === true ? '完整' : (desktop.zip.bytes === null ? '缺失' : `不完整 ${fmtBytes(desktop.zip.bytes)}`)}`
  const desktopDrift = desktop === null || desktop.mode === 'off' || !Array.isArray(desktop.drift) || desktop.drift.length === 0
    ? ''
    : `<div class="bad" style="margin-top:4px">打包产物与项目不一致：${esc(desktop.drift.join('、'))}</div>`
  const desktopLine = desktop === null || desktop.mode === 'off'
    ? ''
    : `<div class="${desktop.stale === true ? 'warn' : 'dim'}" style="margin-top:8px">桌面端（dsh-desktop）：项目 ${esc(desktop.projectVersion ?? '—')} · 打包产物 ${esc(desktop.packagedVersion ?? '未打包')}${desktop.payload === null || desktop.payload === undefined ? '' : `（${esc(desktop.payload)} / ${esc(desktop.payloadLayout ?? '?')}）`}${desktopZip} · 判定 <strong>${esc(desktop.action)}</strong>（${esc(desktop.reason ?? '')}）</div>${desktopDrift}`
  const desktopSyncLine = desktopSync === null
    ? ''
    : `<div class="${desktopSync.status === 'failed' || desktopSync.status === 'packaged-no-zip' ? 'bad' : 'dim'}" style="margin-top:4px">最近一次桌面端同步：<strong>${esc(desktopSync.status)}</strong> ${esc(desktopSync.detail ?? '')}${desktopSync.error === null || desktopSync.error === undefined ? '' : ` — ${esc(desktopSync.error)}`}</div>`
  const historyRows = history.length === 0
    ? '<tr><td colspan="5" class="dim">还没有更新记录 / no updates recorded yet</td></tr>'
    : history
      .slice()
      .reverse()
      .map((row) => `<tr><td class="num">${timeTag(row.at)}</td><td translate="no">${esc(row.from)} → ${esc(row.to)}</td><td>${esc(row.outcome)}</td><td>${esc(row.detail ?? '')}</td><td class="dim">${esc(row.trigger ?? '')}</td></tr>`)
      .join('')

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
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 12px; top: 12px; z-index: 10; background: #1f6feb; color: #fff;
                padding: 8px 12px; border-radius: 8px; text-decoration: none; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
          padding: 12px 16px; min-width: 150px; flex: 1 1 150px; }
  .card .k { color: #8b949e; font-size: 12px; }
  .card .v { font-size: 17px; font-weight: 600; margin-top: 2px; word-break: break-all;
             font-variant-numeric: tabular-nums; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .bad { color: #f85149; }
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
  select { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px;
           padding: 8px 12px; font-size: 13px; cursor: pointer;
           touch-action: manipulation; -webkit-tap-highlight-color: rgba(88, 166, 255, .12); }
  select:hover { background: #30363d; }
  button:focus-visible, select:focus-visible, .skip:focus-visible {
    outline: 2px solid #58a6ff; outline-offset: 2px; }
  .hint { flex: 1 1 240px; overflow-wrap: anywhere; }
  .scroll-x { overflow-x: auto; }
  .scroll-x table { min-width: 640px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dim { color: #8b949e; }
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

  <div class="cards">
    ${badges.map(([k, v, raw]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v"${raw === true ? ' translate="no"' : ''}>${esc(v)}</div></div>`).join('')}
  </div>

  <div class="row">
    <button id="check" type="button">立即检查 / Check now</button>
    <button id="apply" class="primary" type="button">立即更新 / Update now</button>
    <button id="desktop" type="button">同步桌面端 / Sync desktop</button>
    <button id="reload" type="button">刷新 / Refresh</button>
    <span class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></span>
  </div>

  <div class="row">
    <label class="dim" for="channel">频道 / Channel</label>
    <select id="channel" aria-describedby="channel-hint" title="选择接受哪条发布线：latest 只收正式版，next 也收预发布">
      ${[['stable', 'latest（只收正式版）'], ['next', 'next（含预发布）'], ['alpha', 'alpha（含内部版）']]
        .map(([value, label]) => `<option value="${esc(value)}" translate="no"${state?.channel === value ? ' selected' : ''}>${esc(label)}</option>`)
        .join('')}
    </select>
    <span class="dim hint" id="channel-hint">切换后约 20 秒内重新检查；这个选择会记住，重启后仍然生效（除非 profile 里的 <code translate="no">channel</code> 被改过）。</span>
  </div>

  <h2>当前判断 / Decision</h2>
  <div class="panel">
    <div><strong>${esc(decision)}</strong> — ${esc(reason)}</div>
    <div class="dim" style="margin-top:8px">
      最新候选：<span translate="no">${esc(latest?.version ?? '—')}</span>${latest?.tag ? ` (<span translate="no">${esc(latest.tag)}</span>)` : ''}
      ${latest?.ageMinutes === null || latest?.ageMinutes === undefined ? '' : ` · 发布 ${numberFormat.format(Math.round(latest.ageMinutes))} 分钟前`}
      · 最近检查：${timeTag(state?.check?.at)}
    </div>
    ${deferral ? `<div class="warn" style="margin-top:8px">因等待空闲已推迟：${esc(deferral.reason ?? '')}（自 ${timeTag(deferral.detectedAt)} 起，最迟 ${timeTag(deferral.deadline)} 执行）</div>` : ''}
    ${state?.check?.compatibility?.blocked === true
      ? `<div class="bad" style="margin-top:8px"><strong>兼容性闸门已拦截</strong>：${esc(state.check.compatibility.detail)}<br><span class="dim">这些插件依赖目标版本已移除的包，装上就会加载失败。先把它们更新到兼容版本；确实要强行升级，可在 profile 里设 <code>compatibilityGate: warn</code>。</span></div>`
      : state?.check?.compatibility?.detail
        ? `<div class="dim" style="margin-top:8px">兼容性预检：${esc(state.check.compatibility.detail)}</div>`
        : ''}
    ${state?.profilePlugins && state.profilePlugins.updatable > 0
      ? `<div class="dim" style="margin-top:8px">插件市场报告：${esc(state.profilePlugins.updatable)} / ${esc(state.profilePlugins.checked)} 个已装插件有更新（本插件不代为安装）</div>`
      : ''}
    ${helper
      ? helper.supersededBy === undefined || helper.supersededBy === null
        ? `<div style="margin-top:8px">更新助手：<strong>${esc(helper.phase)}</strong> ${esc(helper.detail ?? helper.error ?? '')}</div>`
        : `<div class="dim" style="margin-top:8px">更新助手：上一次 <strong>${esc(helper.phase)}</strong> 已被取代 —— <strong translate="no">${esc(helper.supersededBy)}</strong> 正在运行（原始记录：${esc(helper.error ?? helper.detail ?? '')}）<br>这条只是历史：目标版本已经跑起来了，失败的是当时那段等待接管的验证窗口。</div>`
      : ''}
    ${desktopLine}
    ${desktopSyncLine}
  </div>

  <h2>历史 / History</h2>
  <div class="panel">
    <div class="scroll-x">
      <table>
        <thead><tr><th scope="col">时间</th><th scope="col">版本</th><th scope="col">结果</th><th scope="col">说明</th><th scope="col">触发</th></tr></thead>
        <tbody>${historyRows}</tbody>
      </table>
    </div>
  </div>

  <h2>日志 / Log</h2>
  <div class="panel"><pre id="log" role="log" aria-live="off" tabindex="0">加载中…</pre></div>
</main>
<script>
const base = ${JSON.stringify(BASE_PATH)};
const toast = (text, kind) => {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || 'dim');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.textContent = ''; }, 8000);
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
document.getElementById('check').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  busy(button, '检查中…');
  try {
    const out = await post('/api/v1/check');
    toast('检查完成：' + (out.check?.decision ?? ''), 'ok');
    setTimeout(() => location.reload(), 800);
  } catch (error) {
    toast('检查失败：' + error.message + '（可稍后重试，或看下方日志）', 'bad');
    idle(button);
  }
});
document.getElementById('apply').addEventListener('click', async (event) => {
  if (!confirm('立即安装新版本并重启 DSH？正在进行的对话会被中断。')) return;
  const button = event.currentTarget;
  busy(button, '启动中…');
  try {
    const out = await post('/api/v1/apply');
    toast('已开始更新：' + (out.target ?? ''), 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    toast('无法开始：' + error.message + '（原因见下方日志）', 'bad');
    idle(button);
  }
});
document.getElementById('reload').addEventListener('click', () => location.reload());
document.getElementById('channel').addEventListener('change', async (event) => {
  const select = event.currentTarget;
  const choice = select.value;
  select.disabled = true;
  try {
    const out = await post('/api/v1/channel', { channel: choice });
    toast('频道已切到 ' + out.channel + '，正在重新检查…', 'ok');
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    toast('切换失败：' + error.message + '（可稍后重试）', 'bad');
    select.disabled = false;
  }
});
document.getElementById('desktop').addEventListener('click', async (event) => {
  if (!confirm('把打包的桌面端同步到当前 harness 版本？mode=package 时会重新打包（约 1-2 分钟，几百 MB 写盘）。')) return;
  const button = event.currentTarget;
  busy(button, '同步中…');
  try {
    const out = await post('/api/v1/desktop');
    const r = out.result || {};
    const good = r.status === 'packaged' || r.status === 'up-to-date' || r.status === 'version-synced';
    const detail = r.detail ? '（' + r.detail + '）' : '';
    toast('桌面端同步：' + r.status + detail + (r.error ? ' — ' + r.error : ''), good ? 'ok' : (r.status === 'skipped' ? 'dim' : 'bad'));
    setTimeout(() => location.reload(), 1500);
  } catch (error) {
    toast('同步失败：' + error.message + '（原因见下方日志）', 'bad');
    idle(button);
  }
});
// Timestamps are rendered server-side in the host's zone; rewrite them in the
// reader's own zone, which is the only one that is right for that person.
for (const node of document.querySelectorAll('time[data-ts]')) {
  const at = new Date(node.getAttribute('datetime'));
  if (!Number.isNaN(at.getTime())) node.textContent = at.toLocaleString();
}
const log = document.getElementById('log');
const loadLog = async () => {
  if (document.hidden) return;
  const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const previous = log.scrollTop;
  try {
    const res = await fetch(base + '/api/v1/log?lines=200&format=text', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    log.textContent = await res.text();
    log.scrollTop = wasAtBottom ? log.scrollHeight : previous;
  } catch (error) {
    log.textContent = '日志不可用：' + error.message + '（每 10 秒重试）';
  }
};
loadLog();
setInterval(loadLog, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLog(); });
</script>
</body>
</html>
`
}
