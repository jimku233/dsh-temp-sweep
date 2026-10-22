/**
 * Host-marker tests: markers are the only evidence the sweep has about which
 * Host processes are alive, so their parsing and pruning rules are pinned here.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { earliestStart, listMarkers, pidAlive, pruneMarkers, writeMarker } from '../lib/markers.js';

let dir;

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'dsh-temp-sweep-markers-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('pidAlive sees this process and rejects impossible pids', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('123'), false, 'non-integers are not pids');
  assert.equal(pidAlive(2_000_000_000), false);
});

test('writeMarker then listMarkers round-trips', async () => {
  const file = await writeMarker(dir, { pid: process.pid, startedAt: 1_700_000_000_000 });
  assert.ok(file.endsWith('.json'));
  const markers = await listMarkers(dir);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].pid, process.pid);
  assert.equal(markers[0].startedAt, 1_700_000_000_000);

  // Data minimization: the marker carries no hostname, user, path, or version.
  const raw = JSON.parse(await fsp.readFile(markers[0].file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['pid', 'startedAt', 'writtenAt']);
});

test('listMarkers ignores junk files', async () => {
  await fsp.writeFile(join(dir, 'not-a-marker.json'), '{ broken', 'utf8');
  await fsp.writeFile(join(dir, 'notes.txt'), 'hello', 'utf8');
  await fsp.writeFile(join(dir, 'wrong-shape.json'), JSON.stringify({ pid: 'x' }), 'utf8');
  assert.deepEqual(await listMarkers(dir), []);
});

test('pruneMarkers drops dead hosts and keeps live ones', async () => {
  await writeMarker(dir, { pid: process.pid, startedAt: 1_700_000_000_000 });
  await writeMarker(dir, { pid: 2_000_000_000, startedAt: 1_600_000_000_000 });

  const { kept, removed } = await pruneMarkers(dir, { selfPid: process.pid });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pid, process.pid);
  assert.equal(removed.length, 1);
  assert.equal((await listMarkers(dir)).length, 1);
});

test('earliestStart returns the oldest live Host and null when unknown', () => {
  assert.equal(earliestStart([{ startedAt: 300 }, { startedAt: 100 }, { startedAt: 200 }]), 100);
  assert.equal(earliestStart([]), null);
  assert.equal(earliestStart([{ startedAt: Number.NaN }]), null);
});
