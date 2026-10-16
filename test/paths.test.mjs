/**
 * The bookkeeping around a run: the lock, the plan files an update leaves
 * behind, and the descriptors this process opens for its children.
 *
 * All three were places where state accumulated silently — a lock nobody could
 * release, one plan file per update kept forever, and a handle per spawn — so
 * each case here asserts what the directory looks like afterwards, not just
 * that nothing threw.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, openSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { closeQuietly, lockPath, planPath, processAlive, prunePlans, readJson, releaseLock, writeJsonAtomic } from '../lib/paths.js'
import { clean } from './support/sandbox.mjs'

/**
 * A pid nothing is using. Scanned rather than guessed: pids are recycled, and
 * on Windows a pid that exists but belongs to another user still reports as
 * alive, so the first candidate that reports dead is the honest answer.
 * @returns {number} the pid.
 */
function deadPid() {
  for (let pid = 60000; pid < 65000; pid += 1) {
    if (!processAlive(pid)) return pid
  }
  return 2147483646
}

test('a lock is released by its owner and cleared when its owner died', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  const file = lockPath(dir)

  writeJsonAtomic(file, { pid: process.pid, at: Date.now(), kind: 'update' })
  releaseLock(dir)
  assert.equal(existsSync(file), false, 'this process may release its own lock')

  // A holder that is alive but is not us: the test runner that started this file.
  writeJsonAtomic(file, { pid: process.ppid, at: Date.now(), kind: 'update' })
  assert.equal(processAlive(process.ppid), true, 'the parent process is the live holder in this case')
  releaseLock(dir)
  assert.equal(existsSync(file), true, 'a lock a living process still holds is left alone')

  writeJsonAtomic(file, { pid: deadPid(), at: Date.now(), kind: 'update' })
  releaseLock(dir)
  assert.equal(existsSync(file), false, 'nothing is left to release a dead holder lock')
  clean(dir)
})

test('plan files older than the retention window are pruned, and nothing else is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plans-'))
  const oldPlan = planPath(dir, 'old')
  const freshPlan = planPath(dir, 'fresh')
  const unrelated = join(dir, 'update.log')
  writeFileSync(oldPlan, '{}\n')
  writeFileSync(freshPlan, '{}\n')
  writeFileSync(unrelated, 'log\n')
  const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  utimesSync(oldPlan, new Date(longAgo), new Date(longAgo))

  const removed = prunePlans(dir)
  assert.deepEqual(removed, [basename(oldPlan)], 'only the expired plan is reported')
  assert.equal(existsSync(oldPlan), false)
  assert.equal(existsSync(freshPlan), true, 'a plan young enough to belong to a run is kept')
  assert.equal(existsSync(unrelated), true, 'only plan files are considered')

  assert.deepEqual(prunePlans(join(dir, 'missing')), [], 'a directory that is not there is not an error')
  clean(dir)
})

test('a JSON file written with a byte-order mark is still read', () => {
  // PowerShell's file cmdlets add a BOM by default on Windows, and `JSON.parse`
  // rejects a document that starts with one — so a hand-maintained manifest read
  // as `null`, i.e. as "there is no such file". Seen on a real packaged app.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-json-'))
  const file = join(dir, 'package.json')
  writeFileSync(file, `\uFEFF${JSON.stringify({ name: 'dsh-desktop', version: '0.2.0-rc.2' }, null, 2)}\n`, 'utf8')
  assert.equal(readJson(file)?.version, '0.2.0-rc.2')
  writeFileSync(join(dir, 'broken.json'), '\uFEFF{ not json\n', 'utf8')
  assert.equal(readJson(join(dir, 'broken.json'), 'fallback'), 'fallback', 'a mark does not make broken JSON readable')
  clean(dir)
})

test('closing a descriptor is safe however it is spelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fd-'))
  const file = join(dir, 'capture.log')
  const fd = openSync(file, 'a')
  closeQuietly(fd)
  assert.throws(() => writeSync(fd, 'x'), /EBADF/u, 'the descriptor really is closed')
  closeQuietly(fd) // closing twice must not throw
  closeQuietly('ignore') // the stdio token a caller may pass instead of a number
  closeQuietly(null)
  clean(dir)
})
