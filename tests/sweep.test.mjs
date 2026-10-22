/**
 * Sweep rule tests: every case builds a real directory tree under a throwaway
 * root, so the deletion path (including Windows read-only objects) is exercised
 * rather than mocked.
 *
 * The "dead owner" condition is simulated by making the live-Host boundary a
 * timestamp in the future: a directory born now is then provably older than any
 * live Host, which is exactly the shape a crashed Host leaves behind.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { compilePatterns, decide, safePatterns, safeRoots, sweep } from '../lib/sweep.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

let root;

beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'dsh-temp-sweep-test-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

/**
 * Create a scratch-shaped directory with one object file.
 *
 * @param {string} name - directory name.
 * @param {{ageMs?:number, bytes?:number, readOnly?:boolean}} [options] - fixture knobs.
 * @returns {Promise<string>} the created directory path.
 */
async function fixture(name, options = {}) {
  const dir = join(root, name);
  const objects = join(dir, 'objects', 'ab');
  await fsp.mkdir(objects, { recursive: true });
  const file = join(objects, 'cdef0123456789');
  await fsp.writeFile(file, Buffer.alloc(options.bytes ?? 1024, 7));
  if (options.ageMs) {
    const stamp = new Date(Date.now() - options.ageMs);
    await fsp.utimes(file, stamp, stamp);
    await fsp.utimes(objects, stamp, stamp);
    await fsp.utimes(dir, stamp, stamp);
  }
  if (options.readOnly) await fsp.chmod(file, 0o444);
  return dir;
}

test('compilePatterns anchors globs and ignores unrelated names', () => {
  const [regex] = compilePatterns(['dsh-workspace-changes-*']);
  assert.equal(regex.test('dsh-workspace-changes-GO8lWX'), true);
  assert.equal(regex.test('DSH-WORKSPACE-CHANGES-abc123'), true, 'case-insensitive');
  assert.equal(regex.test('dsh-workspace-changes'), false, 'suffix is required');
  assert.equal(regex.test('dsh-workspace-changes-x-y'), true);
  assert.equal(regex.test('dsh-spill-abc'), false);
  assert.equal(regex.test('xdsh-workspace-changes-a'), false, 'anchored at the start');
});

test('decide deletes a directory born before every live Host', () => {
  const now = Date.now();
  const verdict = decide({
    birthMs: now - 2 * HOUR,
    newestMs: now - 2 * HOUR,
    now,
    oldestLiveMs: now,
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });
  assert.deepEqual([verdict.action, verdict.reason], ['delete', 'dead-owner']);
});

test('decide keeps a directory born after the oldest live Host started', () => {
  const now = Date.now();
  const verdict = decide({
    birthMs: now - 30 * MINUTE,
    newestMs: now - 30 * MINUTE,
    now,
    oldestLiveMs: now - 2 * HOUR,
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });
  assert.equal(verdict.action, 'keep');
  assert.equal(verdict.reason, 'live-or-fresh');
});

test('decide protects a directory touched inside the protect window', () => {
  const now = Date.now();
  const verdict = decide({
    birthMs: now - 10 * HOUR,
    newestMs: now - 1 * MINUTE,
    now,
    oldestLiveMs: now,
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });
  assert.equal(verdict.action, 'keep');
  assert.equal(verdict.reason, 'touched-recently');
});

test('decide falls back to the idle rule when ownership cannot be proven', () => {
  const now = Date.now();
  const stale = decide({
    birthMs: now - 30 * HOUR,
    newestMs: now - 30 * HOUR,
    now,
    oldestLiveMs: null,
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });
  assert.deepEqual([stale.action, stale.reason], ['delete', 'stale']);

  const fresh = decide({
    birthMs: now - 2 * HOUR,
    newestMs: now - 2 * HOUR,
    now,
    oldestLiveMs: null,
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });
  assert.deepEqual([fresh.action, fresh.reason], ['keep', 'fresh']);
});

test('sweep removes a dead-owner directory and keeps a live one', async () => {
  const dead = await fixture('dsh-workspace-changes-DEAD01', { ageMs: 2 * HOUR });
  const live = await fixture('dsh-workspace-changes-LIVE01', { ageMs: 5 * MINUTE });

  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR, // every fixture is older than "every live Host"
    maxIdleMs: 24 * HOUR,
    protectMs: 10 * MINUTE,
    skewMs: 2 * MINUTE,
  });

  assert.equal(summary.deleted.length, 1);
  assert.equal(summary.deleted[0].name, 'dsh-workspace-changes-DEAD01');
  assert.equal(summary.deleted[0].reason, 'dead-owner');
  assert.equal(summary.kept.length, 1);
  assert.equal(summary.kept[0].name, 'dsh-workspace-changes-LIVE01');
  assert.equal(summary.kept[0].reason, 'touched-recently');

  await assert.rejects(fsp.stat(dead), { code: 'ENOENT' });
  await fsp.stat(live);
});

test('sweep ignores names that do not match the pattern', async () => {
  const other = await fixture('dsh-spill-ABC123', { ageMs: 48 * HOUR });
  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
  });
  assert.equal(summary.scanned, 0);
  await fsp.stat(other);
});

test('sweep deletes read-only git objects', async () => {
  await fixture('dsh-workspace-changes-RO0001', { ageMs: 3 * HOUR, readOnly: true });
  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
  });
  assert.equal(summary.deleted.length, 1);
  await assert.rejects(fsp.stat(join(root, 'dsh-workspace-changes-RO0001')), { code: 'ENOENT' });
});

test('dry run reports without deleting', async () => {
  const dir = await fixture('dsh-workspace-changes-DRY001', { ageMs: 3 * HOUR });
  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
    dryRun: true,
  });
  assert.equal(summary.deleted.length, 1);
  assert.equal(summary.deleted[0].dryRun, true);
  assert.ok(summary.bytesReclaimed > 0);
  await fsp.stat(dir);
});

test('sweep respects the per-run deletion cap', async () => {
  for (const name of ['A1', 'A2', 'A3']) {
    await fixture(`dsh-workspace-changes-${name}`, { ageMs: 5 * HOUR });
  }
  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
    maxDelete: 2,
  });
  assert.equal(summary.deleted.length, 2);
  assert.equal(summary.kept.length, 1);
  assert.match(summary.kept[0].reason, /capped/);
});

test('sweep skips reparse points instead of following them', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('junction creation is Windows-only');
    return;
  }
  const outside = await fsp.mkdtemp(join(tmpdir(), 'dsh-temp-sweep-outside-'));
  const link = join(root, 'dsh-workspace-changes-JUNC01');
  try {
    await fsp.symlink(outside, link, 'junction');
  } catch (error) {
    context.skip(`cannot create a junction here: ${error.code}`);
    return;
  }
  try {
    const summary = await sweep({
      roots: [root],
      patterns: ['dsh-workspace-changes-*'],
      oldestLiveMs: Date.now() + HOUR,
      maxIdleMs: 24 * HOUR,
    });
    assert.equal(summary.deleted.length, 0);
    assert.equal(summary.skipped.length, 1);
    assert.equal(summary.skipped[0].reason, 'reparse-point');
    await fsp.stat(outside, { throwIfNoEntry: true });
  } finally {
    await fsp.rm(link, { force: true }).catch(() => {});
    await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('sweep tolerates a missing root', async () => {
  const summary = await sweep({
    roots: [join(root, 'does-not-exist')],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: null,
    maxIdleMs: 24 * HOUR,
  });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.errors.length, 0);
});

test('safeRoots rejects drive roots and bare shares', () => {
  const accepted = safeRoots(['C:\\Temp', '/tmp', 'C:\\', '', '   ']);
  assert.ok(accepted.includes('C:\\Temp'));
  assert.equal(accepted.includes('C:\\'), false);
  assert.equal(accepted.includes(''), false);
});

test('safePatterns refuses anything that is not one DSH scratch family', () => {
  assert.deepEqual(safePatterns(['dsh-workspace-changes-*']), ['dsh-workspace-changes-*']);
  assert.deepEqual(safePatterns(['dsh-spill-*']), ['dsh-spill-*']);
  // A catch-all would turn this tool into "empty %TEMP%".
  assert.deepEqual(safePatterns(['*']), []);
  assert.deepEqual(safePatterns(['**']), []);
  assert.deepEqual(safePatterns(['dsh-*']), []);
  assert.deepEqual(safePatterns(['']), []);
  assert.deepEqual(safePatterns(['not-dsh-*']), []);
  assert.deepEqual(safePatterns([42, null, undefined]), []);
});

test('sweep refuses to run with a catch-all pattern', async () => {
  await fixture('dsh-workspace-changes-KEEP01', { ageMs: 5 * HOUR });
  const summary = await sweep({
    roots: [root],
    patterns: ['*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
  });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.deleted.length, 0);
  assert.match(summary.configError, /DSH scratch family/);
  await fsp.stat(join(root, 'dsh-workspace-changes-KEEP01'));
});

test('sweep never leaves a root by following a pattern', async () => {
  // A directory whose name merely contains the pattern is not a candidate.
  const decoy = await fixture('prefixed-dsh-workspace-changes-X', { ageMs: 50 * HOUR });
  const summary = await sweep({
    roots: [root],
    patterns: ['dsh-workspace-changes-*'],
    oldestLiveMs: Date.now() + HOUR,
    maxIdleMs: 24 * HOUR,
  });
  assert.equal(summary.scanned, 0);
  await fsp.stat(decoy);
});
