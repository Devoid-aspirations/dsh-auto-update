/**
 * The `auto_update` agent tool: the same three operations the dashboard
 * offers, reachable from a conversation.
 *
 * The tool is deliberately narrow. It reports, it checks, it starts an
 * update — and it says out loud that starting one restarts the harness,
 * because that is the part a model must not do by accident.
 * @module dsh-auto-update/tools
 */

/** Actions the tool accepts. */
const ACTIONS = ['status', 'check', 'apply', 'log', 'desktop']

/**
 * Register the `auto_update` tool.
 * @param {object} ctx - the plugin context carrying `tools`.
 * @param {object} api - the host-side operations.
 * @param {() => object} api.status - the status document.
 * @param {(options: object) => Promise<object>} api.check - run a registry check.
 * @param {(options: object) => Promise<object>} api.apply - start an update.
 * @param {(options: object) => Promise<object>} api.desktop - sync the packaged desktop wrapper.
 * @param {(lines: number) => string} api.logTail - the log tail.
 * @returns {Promise<() => void>} the disposer.
 */
export async function registerTools(ctx, api) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')

  const tool = defineTool({
    name: 'auto_update',
    description:
      'Inspect and drive DeepSeek Harness self-update. `status` reports the running version, the version the release channel offers, the current verdict and the last few operations — use it before answering any question about versions. `check` asks the npm registry again right now. `apply` installs an available update and RESTARTS the harness, which interrupts whatever is running: only call it when the user asked for the update to happen now, and prefer letting the configured idle policy do it. `desktop` brings the packaged dsh-desktop wrapper (manifest version, rebuilt bundle, distributable zip) in step with the installed harness — it REPACKAGES, so it takes a minute or two. `log` returns the feature\'s own log tail.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'status | check | apply | desktop | log.',
      },
      version: {
        type: 'string',
        description: 'Target version for `apply`; omit to install whatever the channel offers.',
      },
      lines: {
        type: 'integer',
        description: 'How many trailing log lines `log` returns (default 100, max 1000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          runningVersion: { type: 'string', required: true },
          targetVersion: { type: 'string', required: true },
          decision: { type: 'string', required: true },
          updateAvailable: { type: 'boolean', required: true },
          started: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.detail === '' ? value.summary : `${value.summary}\n\n${value.detail}` }],
    },
    async execute(args) {
      const state = api.status()
      const base = {
        action: args.action,
        runningVersion: String(state.runningVersion ?? 'unknown'),
        targetVersion: String(state.check?.candidate?.version ?? ''),
        decision: String(state.check?.decision ?? 'unknown'),
        updateAvailable: state.check?.updateAvailable === true,
        started: false,
        summary: '',
        detail: '',
      }
      if (args.action === 'status') {
        base.summary = `${base.runningVersion} running; ${base.updateAvailable ? `${base.targetVersion} available` : 'no update available'} (${base.decision}).`
        base.detail = JSON.stringify(
          {
            running: state.runningVersion,
            installed: state.installedVersion,
            channel: state.channel,
            latest: state.check?.candidate ?? null,
            decision: state.check?.decision,
            reason: state.check?.reason,
            checkedAt: state.check?.at ? new Date(state.check.at).toISOString() : null,
            blocked: state.check?.blocked === true,
            blockReason: state.check?.blockReason ?? null,
            compatibility: state.check?.compatibility ?? null,
            desktop: state.desktop ?? null,
            desktopSync: state.desktopSync ?? null,
            deferral: state.deferral ?? null,
            helper: state.helper ?? null,
            supervisor: state.supervisor,
            restartMode: state.restartMode,
            history: (state.history ?? []).slice(-5),
          },
          null,
          2,
        )
        return base
      }
      if (args.action === 'check') {
        const result = await api.check({ trigger: 'tool', force: true })
        base.summary = `Check finished: ${result.check?.decision ?? 'unknown'}.`
        base.decision = String(result.check?.decision ?? base.decision)
        base.updateAvailable = result.check?.updateAvailable === true
        base.targetVersion = String(result.check?.candidate?.version ?? base.targetVersion)
        base.detail = String(result.check?.reason ?? '')
        return base
      }
      if (args.action === 'apply') {
        const result = await api.apply({ trigger: 'tool', force: true, version: args.version ?? null })
        base.started = result.started === true
        base.summary = result.started === true
          ? `Update to ${result.target} started; the harness will restart when it is installed.`
          : `Update not started: ${result.reason ?? 'unknown reason'}.`
        base.targetVersion = String(result.target ?? base.targetVersion)
        base.detail = JSON.stringify(result, null, 2)
        return base
      }
      if (args.action === 'desktop') {
        const result = await api.desktop({ trigger: 'tool' })
        const sync = result.result ?? result
        base.summary = `Desktop sync: ${sync.status}.`
        base.started = sync.status === 'packaged' || sync.status === 'version-synced'
        base.detail = JSON.stringify({ result: sync, inspection: result.status?.desktop ?? null }, null, 2)
        return base
      }
      const lines = Math.min(1000, Math.max(1, Number(args.lines ?? 100) || 100))
      const text = api.logTail(lines)
      base.summary = `Last ${lines} log lines.`
      base.detail = text
      return base
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'apply' ? 'Start harness update' : `Auto update: ${args.action}`,
      kind: 'other',
      rawInput: args.action,
    }),
  })

  return ctx.tools.register(tool)
}
