/**
 * Put the plugin into report-only mode, and take it out again — surgically.
 *
 * WHY THIS IS NOT A REGION DELETE ANY MORE
 * ----------------------------------------
 * The first version wrapped a managed block in BEGIN/END markers and removed
 * everything between them. That was safe exactly until someone else wrote into
 * the file: the plugin market composes its own rows into the profile's
 * `cordis.patch.yml`, and five of them (ui-theme, agent-default-model,
 * web-ui-pet, …) ended up BETWEEN those markers. A region delete would have
 * silently taken the user's UI settings with it.
 *
 * So the removal now touches only lines this script owns: its markers, its
 * comment, and the `autoApply` key of the `auto-update` row. Anything else
 * found inside the markers is left exactly where it is.
 *
 * The override is written to the HOME patch layer (`$DSH_HOME/cordis.patch.yml`)
 * by default: that layer outranks the per-profile layer and, unlike the profile
 * file, nothing else composes rows into it. `--profile` targets the profile
 * layer instead, which is where the current override lives.
 *
 * Usage:
 *   node scripts/profile-mode.mjs status                  # what is set, in both layers
 *   node scripts/profile-mode.mjs detect-only [--profile] # autoApply: false
 *   node scripts/profile-mode.mjs auto [--profile]        # remove the override
 *   node scripts/profile-mode.mjs auto --profile --dry-run  # show the result, write nothing
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DSH_HOME, PROFILE_DIR } from './_env.mjs'

const HOME_PATCH = join(DSH_HOME, 'cordis.patch.yml')
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')

const BEGIN = '# >>> dsh-auto-update: report-only (managed block) >>>'
const END = '# <<< dsh-auto-update: report-only <<<'
const NOTE = '# dsh-auto-update: 首次激活先只检测不安装；删除本段即恢复「空闲时全自动」。'
const ROW_ID = '- id: auto-update'

/**
 * Remove this script's own lines from a patch file, leaving every foreign row
 * that happens to sit between the markers in place.
 *
 * Ownership is decided by SHAPE, not by remembering the exact wording: inside
 * the markers, a comment naming auto-update and the `auto-update` row itself
 * are ours; everything else belongs to whoever else composes this file. An
 * earlier version matched the note comment verbatim and silently left it
 * behind the moment the wording changed.
 * @param {string} text - the file contents.
 * @returns {{text: string, removed: number}} the cleaned text and how many lines went.
 */
function stripOwnLines(text) {
  const lines = text.split(/\r?\n/u)
  const out = []
  let removed = 0
  let inBlock = false
  let inOwnRow = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      if (trimmed === BEGIN) {
        inBlock = true
        removed += 1
        continue
      }
      if (trimmed === END) {
        inBlock = false
        removed += 1
        continue
      }
      if (inBlock && /auto-?update|自动/iu.test(trimmed)) {
        // Both the English marker wording and the Chinese note, in any of the
        // phrasings this script has shipped.
        removed += 1
        continue
      }
      out.push(line)
      continue
    }
    if (trimmed === ROW_ID) {
      inOwnRow = true
      removed += 1
      continue
    }
    if (inOwnRow) {
      // The row's own body: `config:` and the keys indented under it.
      if (/^\s+\S/u.test(line)) {
        removed += 1
        continue
      }
      inOwnRow = false
    }
    out.push(line)
  }
  const collapsed = out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')
  return { text: `${collapsed}\n`, removed }
}

/** The managed block, as it is appended to a patch file. */
const BLOCK = ['', BEGIN, NOTE, ROW_ID, '  config:', '    autoApply: false', END, ''].join('\n')

const mode = process.argv[2] ?? 'status'
const useProfileLayer = process.argv.includes('--profile')
const target = useProfileLayer ? PROFILE_PATCH : HOME_PATCH

if (mode === 'status') {
  for (const [label, file] of [['home layer   ', HOME_PATCH], ['profile layer', PROFILE_PATCH]]) {
    if (!existsSync(file)) {
      process.stdout.write(`${label}: missing (${file})\n`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const has = text.includes(ROW_ID) && text.includes('autoApply: false')
    process.stdout.write(`${label}: ${has ? 'report-only override PRESENT' : 'no override'}  (${file})\n`)
    if (text.includes(BEGIN) && text.includes(END)) {
      const between = text.slice(text.indexOf(BEGIN), text.indexOf(END))
      const foreign = between
        .split(/\r?\n/u)
        .filter((line) => /^\s*-\s*id:/u.test(line) && !line.includes('auto-update'))
      if (foreign.length > 0) {
        process.stdout.write(`  note: ${foreign.length} foreign row(s) sit inside the markers: ${foreign.map((line) => line.trim()).join(', ')}\n`)
      }
    }
  }
  process.exit(0)
}

if (!existsSync(target)) writeFileSync(target, '[]\n', 'utf8')
const original = readFileSync(target, 'utf8')
const { text: cleaned, removed } = stripOwnLines(original)
const next = mode === 'detect-only' ? `${cleaned.replace(/\s+$/u, '')}\n${BLOCK}` : cleaned
const dryRun = process.argv.includes('--dry-run')
if (!dryRun) {
  writeFileSync(`${target}.bak-${Date.now()}`, original, 'utf8')
  writeFileSync(target, next, 'utf8')
}
process.stdout.write(
  `${dryRun ? '[dry run] would write' : mode === 'detect-only' ? 'added the report-only override to' : 'removed the override from'} ${target}\n(this script rewrote ${removed} of its own lines; every foreign row was left untouched)\n`,
)
process.stdout.write(`--- ${dryRun ? 'resulting' : target} contents ---\n${next}\n`)
