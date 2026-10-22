/**
 * CLI argument tests.
 *
 * The CLI must fail loudly on a malformed limit: `Number('abc')` is NaN and every
 * `>= NaN` comparison is false, so an unchecked typo would silently switch a cap
 * or a threshold off instead of refusing to run.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSize, parseArgs, renderTable } from '../bin/sweep.mjs';

test('defaults are read-only and conservative', () => {
  const options = parseArgs([]);
  assert.equal(options.dryRun, true);
  assert.equal(options.apply, false);
  assert.equal(options.assumeNoHost, false);
  assert.equal(options.maxIdleHours, 24);
  assert.equal(options.protectMinutes, 10);
  assert.equal(options.maxDelete, 50);
});

test('--apply switches out of dry run; --dry-run switches back', () => {
  assert.equal(parseArgs(['--apply']).dryRun, false);
  assert.equal(parseArgs(['--apply', '--dry-run']).dryRun, true);
});

test('numeric flags reject non-numbers and out-of-range values', () => {
  assert.throws(() => parseArgs(['--max-idle-hours', 'abc']), /expects a number/);
  assert.throws(() => parseArgs(['--max-idle-hours', '0']), /between 1 and 8760/);
  assert.throws(() => parseArgs(['--max-idle-hours', '9000']), /between 1 and 8760/);
  assert.throws(() => parseArgs(['--protect-minutes', '-1']), /between/);
  assert.throws(() => parseArgs(['--max-delete', '0']), /between/);
  assert.equal(parseArgs(['--max-idle-hours', '168']).maxIdleHours, 168);
});

test('a missing flag value is an error, not a default', () => {
  assert.throws(() => parseArgs(['--roots']), /missing value/);
  assert.throws(() => parseArgs(['--nonsense']), /unknown argument/);
});

test('root and pattern lists split on comma and semicolon', () => {
  const options = parseArgs(['--roots', 'C:\\Temp;D:\\Temp', '--patterns', 'dsh-spill-*,dsh-acp-*']);
  assert.deepEqual(options.roots, ['C:\\Temp', 'D:\\Temp']);
  assert.deepEqual(options.patterns, ['dsh-spill-*', 'dsh-acp-*']);
});

test('formatSize uses readable units', () => {
  assert.equal(formatSize(512), '1 KB');
  assert.equal(formatSize(1024 * 1024 * 2), '2.0 MB');
  assert.equal(formatSize(1024 ** 3 * 1.5), '1.50 GB');
});

test('renderTable puts the divider directly under the header', () => {
  const text = renderTable([['A', 'B'], ['x', 'y']]);
  const lines = text.split('\n');
  assert.equal(lines[0].trimEnd(), 'A  B');
  assert.match(lines[1], /^-\s+-\s*$/);
  assert.equal(lines[2].trimEnd(), 'x  y');
});
