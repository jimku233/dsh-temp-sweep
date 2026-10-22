/**
 * Host markers: one small file per running DSH Host process.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-workspace-changes` creates its scratch directory with
 * `mkdtemp(join(os.tmpdir(), "dsh-workspace-changes-"))`. The name carries no
 * owner, the path lives only in that Host's memory, and it is removed only on
 * `session/disposed` or plugin dispose. Nothing on disk says which process owns
 * a directory, so a reaper cannot ask "is the owner alive?".
 *
 * It can still answer a strictly safer question. If a directory was created
 * *before every currently running Host started*, no live process can own it:
 * every Host that could have created it is gone. That needs one fact per Host —
 * its pid and start time — which is what a marker records.
 *
 * Markers live under the Harness home (stable across TMP changes), not under
 * the temp root they help to clean.
 *
 * @module dsh-temp-sweep/markers
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/**
 * Report whether a pid is alive.
 *
 * `process.kill(pid, 0)` performs the existence check without delivering a
 * signal. `EPERM` means the process exists but belongs to someone else, which
 * still counts as alive. A recycled pid makes a dead Host look alive; that only
 * keeps directories longer (conservative), never deletes a live one.
 *
 * @param {unknown} pid - candidate process id.
 * @returns {boolean} true when the process exists.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Write this Host's marker, replacing an earlier file for the same process.
 *
 * The marker holds the smallest set of facts the sweep needs — a pid and a start
 * time — and nothing about the machine, the user, or the Sessions. It never
 * leaves the disk it is written to.
 *
 * @param {string} dir - marker directory.
 * @param {{pid:number,startedAt:number}} marker - facts to record.
 * @returns {Promise<string>} absolute path of the written marker.
 */
export async function writeMarker(dir, marker) {
  await fsp.mkdir(dir, { recursive: true });
  const file = join(dir, `${marker.pid}-${marker.startedAt}.json`);
  const body = {
    pid: marker.pid,
    startedAt: marker.startedAt,
    writtenAt: Date.now(),
  };
  await fsp.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Read every parseable marker in a directory.
 *
 * Unparseable files are ignored rather than deleted: the marker directory is
 * also where a future version could keep operator notes.
 *
 * @param {string} dir - marker directory.
 * @returns {Promise<Array<{file:string,pid:number,startedAt:number}>>} markers.
 */
export async function listMarkers(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const markers = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!Number.isInteger(parsed?.pid) || !Number.isInteger(parsed?.startedAt)) continue;
      markers.push({ file, pid: parsed.pid, startedAt: parsed.startedAt });
    } catch {
      // A half-written marker is not evidence about any directory.
    }
  }
  return markers;
}

/**
 * Drop markers whose Host process is gone.
 *
 * @param {string} dir - marker directory.
 * @param {{selfPid?:number}} [options] - the caller's own pid, never reaped.
 * @returns {Promise<{kept:Array<object>,removed:Array<object>}>} the split.
 */
export async function pruneMarkers(dir, options = {}) {
  const kept = [];
  const removed = [];
  for (const marker of await listMarkers(dir)) {
    if (marker.pid === options.selfPid || pidAlive(marker.pid)) {
      kept.push(marker);
      continue;
    }
    try {
      await fsp.rm(marker.file, { force: true });
      removed.push(marker);
    } catch {
      kept.push(marker);
    }
  }
  return { kept, removed };
}

/**
 * Earliest start time among live markers.
 *
 * A directory born before this instant cannot belong to any live Host.
 *
 * @param {Array<{startedAt:number}>} markers - live markers.
 * @returns {number|null} epoch milliseconds, or null when nothing is known.
 */
export function earliestStart(markers) {
  const starts = markers.map((marker) => marker.startedAt).filter((value) => Number.isFinite(value));
  return starts.length ? Math.min(...starts) : null;
}
