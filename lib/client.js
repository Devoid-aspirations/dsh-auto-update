/**
 * Browser half of the auto-update plugin: one sidebar-footer button that opens
 * the panel the Host already serves at `/auto-update/`.
 *
 * Where it opens depends on the shell it is loaded into. In the Desktop app the
 * preload bridge exposes `window.dshDesktop.openExternal`, and that is the only
 * way to reach the system browser: `window.open` there is intercepted by the
 * window-open handler and opens an Electron child window instead, which is not
 * what a link to a loopback-only page should do. In a plain browser the panel
 * opens in a tab of its own, so the session view is never replaced.
 *
 * There is nothing to re-implement here. The panel is ordinary HTML served by
 * `lib/dashboard.js`, and its buttons talk to the same HTTP API the agent tool
 * uses, so all the browser needs is a door on the shell — a plugin whose panel
 * only exists at a URL nobody can find is a panel that does not exist.
 *
 * This file is loaded by the Host's client module table, never by Node. It is a
 * plain script that registers a factory; the factory body (styles included)
 * runs at materialization, which is why the stylesheet goes in through an
 * effect rather than at script execution.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-update',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react_jsx_runtime = require('react/jsx-runtime')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Where the HTTP half of this plugin serves its panel. */
    const PANEL_PATH = '/auto-update/'

    /** Locale namespace owned by this bundle. */
    const NS = 'auto-update'

    /** Simplified Chinese dictionary. */
    const zh = {
      'action.label': '自动更新',
      'action.hint': '打开自动更新面板',
    }

    /** English dictionary. */
    const en = {
      'action.label': 'Auto update',
      'action.hint': 'Open the auto-update panel',
    }

    /**
     * Footer-button styles.
     *
     * Sizes and tokens are copied from the shell's own footer badges (36 px
     * pill, 16/18 px glyph, hover fill from the theme) so the extra button sits
     * in the rail without looking foreign. Nothing here assumes a theme: the
     * three colour tokens all exist in light and dark.
     */
    const css = [
      '.dsh-auto-update-footer{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;height:36px;min-width:36px;padding:0 9px;border:0;border-radius:12px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1;cursor:pointer;overflow:hidden;transition:background .12s ease-in-out}',
      '.dsh-auto-update-footer:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-auto-update-footer:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
      '.dsh-auto-update-footer-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      // Placement: the foot stacks three things — the settings control, this
      // button, and whatever else registered a footer action (here the
      // remote-access entry). Slot outlets and `footerActions` are both
      // `display:contents`, so every contribution is laid out directly by
      // `footArea`, and `order` is the only lever on that stack.
      //
      // `@linxin666/dsh-remote-web-ui` owns numbers 1/3/4 for (other
      // contributions) / (settings) / (its own entry), which already gives this
      // button a row of its own — but above the settings control. Sitting
      // between the two therefore needs a number between 3 and 4, and `order`
      // takes integers only: this button takes 4 and the remote entry moves to
      // 5, so the stack reads settings → auto-update → remote access. The extra
      // `[class*=footArea]` step outranks that plugin's own rule, so load order
      // of the two stylesheets does not decide the outcome.
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footArea] [class*=footerActions]>[data-slot="sidebar.footer.action"]>.dsh-auto-update-footer{flex:1 0 100%;order:4;min-width:0}',
      '[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footArea] [class*=footerActions]>[data-slot="sidebar.footer.action"]>[data-dsh-part=entry]{order:5}',
    ].join('')

    /** Stable tag id, so a re-apply replaces the stylesheet instead of stacking one. */
    const cssTagId = 'dsh-auto-update/sidebar-button.css'

    /**
     * Put the stylesheet in the document once.
     * @returns a disposer that removes the tag again.
     */
    function mountStyles() {
      const selector = `style[data-plugin-css=${JSON.stringify(cssTagId)}]`
      let tag = document.querySelector(selector)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-auto-update'
        tag.dataset.pluginCss = cssTagId
        document.head.append(tag)
      }
      tag.textContent = css
      return () => {
        tag.remove()
      }
    }

    /** Open the panel: system browser under the Desktop bridge, a new tab otherwise. */
    function openPanel() {
      const url = new URL(PANEL_PATH, window.location.href).href
      const desktop = window.dshDesktop
      if (desktop !== null && typeof desktop === 'object' && typeof desktop.openExternal === 'function') {
        desktop.openExternal(url)
        return
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    }

    /**
     * Render the sidebar-footer button.
     * @param props - slot props: `wide` from the sidebar, `t` from the locale namespace.
     */
    function SidebarButton(props) {
      const { wide, t } = props
      const label = t('action.label')
      return react_jsx_runtime.jsxs('button', {
        type: 'button',
        className: 'dsh-auto-update-footer',
        title: t('action.hint'),
        'aria-label': label,
        onClick: openPanel,
        children: [
          react_jsx_runtime.jsx(primitives.IconDownloadOutlineRegular, { size: wide ? 16 : 18 }),
          wide
            ? react_jsx_runtime.jsx('span', { className: 'dsh-auto-update-footer-label', children: label })
            : null,
        ],
      })
    }

    /** Services this browser plugin needs from the client runtime. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the footer button.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-update: dictionaries')
      ctx.effect(mountStyles, 'auto-update: styles')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'auto-update-panel',
        locale: NS,
      }, SidebarButton))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
