/**
 * The status dashboard, rendered as one self-contained HTML document.
 *
 * Deliberately build-free: a plugin that can only be looked at after a
 * bundler run is a plugin nobody looks at, and this page's whole job is to
 * answer "what version am I on, what is available, and what happened last
 * time" without a toolchain in the loop. It talks to the same JSON endpoints
 * the agent tool reads.
 * @module dsh-auto-update/dashboard
 */

import { BASE_PATH } from './protocol.js'

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
    ['版本', running],
    ['频道', state?.channel ?? 'stable'],
    ['状态', decision],
    ['宿主', state?.supervisor ?? 'unsupervised'],
    ['重启方式', state?.restartMode ?? 'auto'],
    ['磁盘版本', state?.installedVersion ?? 'unknown'],
  ]
  const desktopZip = desktop === null || desktop.mode === 'off' || desktop.zip === null || desktop.zip === undefined
    ? ''
    : ` · 分发 zip ${desktop.zip.valid === true ? '完整' : (desktop.zip.bytes === null ? '缺失' : `不完整 ${esc(String(desktop.zip.bytes))}B`)}`
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
      .map((row) => `<tr><td>${esc(row.at ? new Date(row.at).toLocaleString() : '')}</td><td>${esc(row.from)} → ${esc(row.to)}</td><td>${esc(row.outcome)}</td><td>${esc(row.detail ?? '')}</td><td class="dim">${esc(row.trigger ?? '')}</td></tr>`)
      .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 自动更新 / Auto update</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #0d1117; color: #e6edf3;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif; }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #9aa4b2; font-weight: 600; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 18px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px;
          padding: 12px 16px; min-width: 150px; flex: 1 1 150px; }
  .card .k { color: #8b949e; font-size: 12px; }
  .card .v { font-size: 17px; font-weight: 600; margin-top: 2px; word-break: break-all; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .bad { color: #f85149; }
  .panel { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px;
           padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; }
  button.primary:hover { background: #388bfd; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; }
  .dim { color: #8b949e; }
  pre { background: #0b0f14; border: 1px solid #21262d; border-radius: 8px; padding: 12px;
        overflow: auto; max-height: 320px; font-size: 12px; margin: 0; }
  .toast { margin-left: 10px; font-size: 13px; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>DSH 自动更新</h1>
  <div class="sub">自动检测 <code>${esc(state?.package ?? '@deepseek-ai/dsh')}</code> 新版本，空闲时无人值守安装并重启；失败自动回滚。数据源为本机状态文件与 npm registry。</div>

  <div class="cards">
    ${badges.map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
  </div>

  <div class="row">
    <button id="check">立即检查 / Check now</button>
    <button id="apply" class="primary">立即更新 / Update now</button>
    <button id="desktop">同步桌面端 / Sync desktop</button>
    <button id="reload">刷新 / Refresh</button>
    <span class="toast" id="toast"></span>
  </div>

  <h2>当前判断 / Decision</h2>
  <div class="panel">
    <div><strong>${esc(decision)}</strong> — ${esc(reason)}</div>
    <div class="dim" style="margin-top:8px">
      最新候选：${esc(latest?.version ?? '—')}${latest?.tag ? ` (${esc(latest.tag)})` : ''}
      ${latest?.ageMinutes === null || latest?.ageMinutes === undefined ? '' : ` · 发布 ${Math.round(latest.ageMinutes)} 分钟前`}
      · 最近检查：${esc(state?.check?.at ? new Date(state.check.at).toLocaleString() : '—')}
    </div>
    ${deferral ? `<div class="warn" style="margin-top:8px">因等待空闲已推迟：${esc(deferral.reason ?? '')}（自 ${esc(deferral.detectedAt ? new Date(deferral.detectedAt).toLocaleString() : '')} 起，最迟 ${esc(deferral.deadline ? new Date(deferral.deadline).toLocaleString() : '')} 执行）</div>` : ''}
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
        : `<div class="dim" style="margin-top:8px">更新助手：上一次 <strong>${esc(helper.phase)}</strong> 已被取代 —— <strong>${esc(helper.supersededBy)}</strong> 正在运行（原始记录：${esc(helper.error ?? helper.detail ?? '')}）<br>这条只是历史：目标版本已经跑起来了，失败的是当时那段等待接管的验证窗口。</div>`
      : ''}
    ${desktopLine}
    ${desktopSyncLine}
  </div>

  <h2>历史 / History</h2>
  <div class="panel">
    <table>
      <thead><tr><th>时间</th><th>版本</th><th>结果</th><th>说明</th><th>触发</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
  </div>

  <h2>日志 / Log</h2>
  <div class="panel"><pre id="log">loading…</pre></div>
</main>
<script>
const base = ${JSON.stringify(BASE_PATH)};
const toast = (text, kind) => {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast ' + (kind || 'dim');
  setTimeout(() => { el.textContent = ''; }, 6000);
};
const post = async (path) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
};
document.getElementById('check').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try { const out = await post('/api/v1/check'); toast('检查完成：' + (out.check?.decision ?? ''), 'ok'); setTimeout(() => location.reload(), 600); }
  catch (error) { toast('检查失败：' + error.message, 'bad'); }
  finally { event.target.disabled = false; }
});
document.getElementById('apply').addEventListener('click', async (event) => {
  if (!confirm('立即安装新版本并重启 DSH？正在进行的对话会被中断。')) return;
  event.target.disabled = true;
  try { const out = await post('/api/v1/apply'); toast('已开始更新：' + (out.target ?? ''), 'ok'); setTimeout(() => location.reload(), 1200); }
  catch (error) { toast('无法开始：' + error.message, 'bad'); }
  finally { event.target.disabled = false; }
});
document.getElementById('reload').addEventListener('click', () => location.reload());
document.getElementById('desktop').addEventListener('click', async (event) => {
  if (!confirm('把打包的桌面端同步到当前 harness 版本？mode=package 时会重新打包（约 1-2 分钟，几百 MB 写盘）。')) return;
  event.target.disabled = true;
  toast('正在同步桌面端…', 'dim');
  try {
    const out = await post('/api/v1/desktop');
    const r = out.result || {};
    const good = r.status === 'packaged' || r.status === 'up-to-date' || r.status === 'version-synced';
    const detail = r.detail ? '（' + r.detail + '）' : '';
    toast('桌面端同步：' + r.status + detail + (r.error ? ' — ' + r.error : ''), good ? 'ok' : (r.status === 'skipped' ? 'dim' : 'bad'));
    setTimeout(() => location.reload(), 1500);
  } catch (error) { toast('同步失败：' + error.message, 'bad'); }
  finally { event.target.disabled = false; }
});
const loadLog = async () => {
  try {
    const res = await fetch(base + '/api/v1/log?lines=200&format=text');
    document.getElementById('log').textContent = await res.text();
  } catch (error) { document.getElementById('log').textContent = 'log unavailable: ' + error.message; }
};
loadLog();
setInterval(loadLog, 10000);
</script>
</body>
</html>
`
}
