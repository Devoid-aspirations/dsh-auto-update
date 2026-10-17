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
      // Placement. The shell's foot is a column with exactly two children:
      // `footerActions` (a nowrap flex row holding every `sidebar.footer.action`
      // contribution) and `settingsArea` (the settings control). So a footer
      // action can only ever sit beside its siblings or above/below the whole
      // settings row — `order` alone cannot put it *between* them, because the
      // two live in different parents.
      //
      // Taking a row of its own in the middle therefore needs the row parent
      // flattened: `footerActions` becomes `display:contents`, which promotes
      // this button and the remote-access entry to `footArea` items, and then
      // `order` really does decide the vertical stack. Flattening is gated on
      // `:has()` (Chromium 105+, and the shell is Electron/Chromium) so the
      // collapsed rail, where this button is icon-only and the shell centres a
      // 36 px column, keeps its stock layout untouched.
      //
      // The settings control keeps the bottom of the rail, which is where the
      // shell already puts it: the stack reads remote access → auto update →
      // settings from top to bottom, i.e. settings → auto update → remote access
      // counting up from the floor.
      '[class*=footArea]>[class*=footerActions]:has(>[data-slot="sidebar.footer.action"]>.dsh-auto-update-footer-row){display:contents}',
      '[class*=footArea]>[class*=settingsArea]{order:5}',
      // `padding-left: 6px` puts this row's icon on the same x as the settings
      // icon: that control sits in a row offset by -2px with 8px of padding, so
      // its glyph starts 6px into the foot. The runtime pass above re-measures it
      // anyway, so this is the number that holds even if JS never runs.
      '[class*=footArea]>[class*=footerActions]>[data-slot="sidebar.footer.action"]>.dsh-auto-update-footer-row{order:4;width:100%;min-width:0;justify-content:flex-start;padding:0 9px 0 6px}',
      // The other footer entries are promoted into the same column, which centres
      // its items; keep them on the rail's left edge instead so the group reads
      // as one column rather than a scattering of centred glyphs.
      '[class*=footArea]>[class*=footerActions]>[data-slot="sidebar.footer.action"]>:not(.dsh-auto-update-footer-row){order:3;align-self:flex-start}',
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
     * Put this row and the sibling footer entries on the settings icon's left edge.
     *
     * The settings control has its own geometry (`width: calc(100% + 4px)`,
     * `margin: 0 -2px`, `padding-left: 8px` in the current shell), which is not
     * something a sibling can assume: hard-coding one number here would misalign
     * the row the day that control changes its padding. So the target is
     * measured from the settings icon itself and the difference is applied as
     * padding on this full-width row, and as a margin on the entries we do not
     * own (their icon is centred inside their own box, so padding would not move
     * it).
     *
     * The CSS below already carries the number this produces today; this pass
     * exists so the row keeps tracking the shell instead of the shell's 2xx
     * release notes. Everything is guarded: a shell without that markup must
     * leave the layout alone, not throw inside a ref callback.
     * @param button - this plugin's rendered button.
     */
    function alignFooterIcons(button) {
      const anchor = button.parentElement
      const foot = typeof anchor?.closest === 'function' ? anchor.closest('[class*=footArea]') : null
      const settingsIcon = typeof foot?.querySelector === 'function'
        ? foot.querySelector('[class*=settingsArea] svg')
        : null
      const target = settingsIcon?.getBoundingClientRect?.().left
      if (typeof target !== 'number') return

      const iconOf = (element) => element?.querySelector?.('svg') ?? null
      const current = (element, property) => {
        const value = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(element)[property]) : 0
        return Number.isFinite(value) ? value : 0
      }

      /** Move this row's own content: full width, content left-aligned. */
      const own = iconOf(button)
      const ownBox = own?.getBoundingClientRect?.()
      if (ownBox) button.style.paddingLeft = `${Math.max(0, current(button, 'paddingLeft') + (target - ownBox.left))}px`

      // Entries we do not own: the glyph sits inside whatever markup that plugin
      // chose, and the element carrying it may be wrapped in a `display:contents`
      // box where a margin does nothing. So travel the box that actually owns the
      // glyph — the button it sits in — and mark the value important, because
      // that plugin's stylesheet is free to use `!important` on its own control.
      const siblings = anchor?.children ?? []
      for (const sibling of siblings) {
        if (sibling === button) continue
        const icon = iconOf(sibling)
        const box = icon?.getBoundingClientRect?.()
        if (!box) continue
        const delta = target - box.left
        if (Math.abs(delta) < 1) continue
        const owner = typeof icon.closest === 'function' ? icon.closest('button') ?? sibling : sibling
        const next = current(owner, 'marginLeft') + delta
        owner.style.setProperty('margin-left', `${next}px`, 'important')
      }
    }

    /**
     * Run {@link alignFooterIcons} whenever the footer's roster changes.
     *
     * One pass is not enough: this plugin and the others register into the same
     * slot from independent `inject` callbacks, so a sibling like the
     * remote-access entry can mount a frame after this row does — and it is
     * re-registered whenever its own settings toggle flips. Measuring once, at
     * mount, therefore measured an empty roster and moved nothing. The observer
     * covers both the later mount and the later re-mount; viewport changes are
     * covered too, because the sidebar can widen or collapse.
     * @param button - this plugin's rendered button.
     */
    const observedFoots = new WeakSet()

    function mountFooterAlignment(button) {
      scheduleFooterAlignment(button)
      try {
        const anchor = button.parentElement
        const foot = typeof anchor?.closest === 'function' ? anchor.closest('[class*=footArea]') : null
        if (!foot || observedFoots.has(foot)) return
        observedFoots.add(foot)
        if (typeof MutationObserver === 'function') {
          const observer = new MutationObserver(() => scheduleFooterAlignment(button))
          observer.observe(foot, { childList: true, subtree: true })
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', () => scheduleFooterAlignment(button))
        }
      } catch {
        // A shell without that footer shape keeps the CSS-only number.
      }
    }

    /**
     * Run {@link alignFooterIcons} once the element is laid out.
     * @param button - this plugin's rendered button.
     */
    function scheduleFooterAlignment(button) {
      try {
        const run = () => {
          try {
            alignFooterIcons(button)
          } catch {
            // A shell whose footer markup moved on is not worth a crash.
          }
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else run()
      } catch {
        // Same: never let layout polish break the button.
      }
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
        className: wide ? 'dsh-auto-update-footer dsh-auto-update-footer-row' : 'dsh-auto-update-footer',
        title: t('action.hint'),
        'aria-label': label,
        ref: wide ? mountFooterAlignment : undefined,
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
