/**
 * What "installed" means on disk.
 *
 * These are the two checks the update helper now makes before it believes an
 * install is finished, so they are tested directly rather than only through the
 * end-to-end transaction: the failure they exist for (2026-11-27) was a
 * manifest that named 0.2.2-rc.5 while the dependency tree was still being
 * unpacked, and nothing in the helper read past that field.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inspectTree, treeFingerprint } from '../lib/tree.js'

const PACKAGE = '@deepseek-ai/dsh'

/**
 * Write a package directory.
 * @param {object} shape - what to write.
 * @param {string} shape.version - the manifest version.
 * @param {Record<string, string>} [shape.dependencies] - declared dependencies.
 * @param {boolean} [shape.createDependencies] - whether to create the dependency directories.
 * @param {boolean} [shape.createEntry] - whether to write the bin target.
 * @returns {string} the package directory.
 */
function fixture(shape) {
  const { version, dependencies = {}, createDependencies = true, createEntry = true } = shape
  const base = mkdtempSync(join(tmpdir(), 'dsh-tree-'))
  const dir = join(base, ...PACKAGE.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: PACKAGE, version, bin: { dsh: 'lib/bin.js' }, ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }) }, null, 2)}\n`,
    'utf8',
  )
  if (createEntry) {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'bin.js'), '// entry\n', 'utf8')
  }
  if (createDependencies) {
    for (const dependency of Object.keys(dependencies)) {
      const target = join(dir, 'node_modules', ...dependency.split('/'))
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: dependency, version: '1.0.0' })}\n`, 'utf8')
    }
  }
  return dir
}

test('a complete tree is complete', (t) => {
  const dir = fixture({ version: '0.2.2-rc.5', dependencies: { '@deepseek-ai/cordis': '^4.0.0', '@deepseek-ai/dsh-app-boot': '^0.2.2' } })
  t.after(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

  const verdict = inspectTree(dir, PACKAGE, '0.2.2-rc.5')
  assert.equal(verdict.ok, true, verdict.reason)
  assert.deepEqual(verdict.missing, [])
})

test('a manifest that names the target while a dependency is missing is not complete', (t) => {
  // The exact 2026-11-27 shape: version first, tree second.
  const dir = fixture({ version: '0.2.2-rc.5', dependencies: { '@deepseek-ai/dsh-app-boot': '^0.2.2' }, createDependencies: false })
  t.after(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

  const verdict = inspectTree(dir, PACKAGE, '0.2.2-rc.5')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not unpacked yet/u)
  assert.match(verdict.reason, /dsh-app-boot/u)
  assert.deepEqual(verdict.missing, ['@deepseek-ai/dsh-app-boot'])
})

test('a tree whose entry file has not landed yet is not complete', (t) => {
  const dir = fixture({ version: '0.2.2-rc.5', createEntry: false })
  t.after(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

  const verdict = inspectTree(dir, PACKAGE, '0.2.2-rc.5')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /entry file/u)
})

test('the wrong version is reported as the wrong version, not as a missing dependency', (t) => {
  const dir = fixture({ version: '0.2.2-rc.3', dependencies: { '@deepseek-ai/cordis': '^4.0.0' } })
  t.after(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

  const verdict = inspectTree(dir, PACKAGE, '0.2.2-rc.5')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /0\.2\.2-rc\.3/u)
})

test('a missing global root is a failure, not an empty success', () => {
  const verdict = inspectTree(null, PACKAGE, '0.2.2-rc.5')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /global root/u)
})

test('the fingerprint moves when a dependency is unpacked and settles when nothing writes', (t) => {
  const dir = fixture({ version: '0.2.2-rc.5', dependencies: { '@deepseek-ai/cordis': '^4.0.0' }, createDependencies: false })
  t.after(() => rmSync(join(dir, '..', '..'), { recursive: true, force: true }))

  const before = treeFingerprint(dir)
  assert.notEqual(before, null, 'a tree with no node_modules still has a fingerprint')

  const target = join(dir, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), '{}\n', 'utf8')

  const after = treeFingerprint(dir)
  assert.notEqual(after, before, 'unpacking changes the fingerprint')

  assert.equal(treeFingerprint(dir), after, 'and it stops moving once nothing writes')
})
