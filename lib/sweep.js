/**
 * Sweep core: find DSH Session scratch directories that no live Host can own,
 * and remove them.
 *
 * Every input a decision depends on arrives as an option (clock, roots, limits,
 * live-Host start, remover), so the rules are testable without a real DSH.
 *
 * Two deletion rules, in order of strength:
 *
 * - `dead-owner`  the directory was created before every live Host started, so
 *                 no live process can own it. Strictly safe; this is the rule
 *                 that reclaims the tens of gigabytes left by Host crashes.
 * - `stale`       nothing under the directory changed for `maxIdleMs`. A live
 *                 Host writes objects at every turn start, so a genuinely used
 *                 scratch directory cannot stay quiet that long. This is the
 *                 conservative fallback for orphans created *after* this Host
 *                 started.
 *
 * Both rules additionally require the directory to be quiet for `protectMs`,
 * so a scratch directory created microseconds before the sweep is never touched.
 *
 * @module dsh-temp-sweep/sweep
 */

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

/** Files inspected per directory before the walk stops (bounds pathological trees). */
const MAX_ENTRIES = 200_000;

/**
 * Candidate temp roots for this process, in order of preference.
 *
 * `os.tmpdir()` follows TMP/TEMP, which a sandbox or an installer may redirect
 * into a per-process subdirectory; the platform default stays in the list so a
 * redirected process still knows where the real temp root lives.
 *
 * @returns {string[]} unique, existing-agnostic candidate roots.
 */
export function defaultRoots() {
  const env = process.env;
  const candidates = [
    env.TMP,
    env.TEMP,
    tmpdir(),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Temp') : undefined,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');

  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    const key = candidate.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate.replace(/[\\/]+$/, ''));
  }
  return roots;
}

/**
 * Compile glob patterns (`*`, `?`) into anchored, case-insensitive RegExps.
 *
 * @param {string[]} patterns - glob patterns such as `dsh-workspace-changes-*`.
 * @returns {RegExp[]} one RegExp per pattern.
 */
export function compilePatterns(patterns) {
  return patterns.map((pattern) => {
    const source = String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${source}$`, 'i');
  });
}

/**
 * Accept only patterns that name a DSH scratch family.
 *
 * The sweep deletes recursively, so a pattern that could match arbitrary temp
 * entries (`*`, `dsh-*`, `**`) is refused rather than narrowed: a misconfiguration
 * must never turn this tool into "empty %TEMP%". Every accepted pattern starts
 * with `dsh-` followed by at least one literal character, which excludes the
 * bare `dsh-*` catch-all while allowing `dsh-workspace-changes-*`.
 *
 * @param {unknown[]} patterns - operator-supplied glob patterns.
 * @returns {string[]} the accepted subset.
 */
export function safePatterns(patterns) {
  const accepted = [];
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim();
    if (pattern === '') continue;
    if (!/^dsh-[a-z0-9._-]+/i.test(pattern)) continue;
    accepted.push(pattern);
  }
  return accepted;
}

/**
 * Walk a directory without following links.
 *
 * Returns the byte total (for the report), the file count, and the newest
 * modification time found anywhere below it. The newest mtime matters: git
 * writes objects into `objects/xx/`, so the scratch root's own mtime stops
 * moving after the first turn while the tree is very much alive.
 *
 * @param {string} root - directory to measure.
 * @returns {Promise<{bytes:number,files:number,newestMs:number,truncated:boolean}>} facts.
 */
export async function measure(root) {
  let bytes = 0;
  let files = 0;
  let newestMs = 0;
  let visited = 0;
  let truncated = false;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        return { bytes, files, newestMs, truncated };
      }
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await fsp.stat(full);
        bytes += info.size;
        files += 1;
        if (info.mtimeMs > newestMs) newestMs = info.mtimeMs;
      } catch {
        // A file that disappeared mid-walk is not evidence of activity.
      }
    }
  }
  return { bytes, files, newestMs, truncated };
}

/**
 * List candidate directories under the configured roots.
 *
 * Only direct children are considered, so a pattern can never reach into an
 * unrelated subtree, and reparse points are reported but never followed.
 *
 * @param {string[]} roots - temp roots to scan.
 * @param {RegExp[]} regexes - compiled patterns.
 * @returns {Promise<Array<object>>} candidates and skipped entries.
 */
export async function inspect(roots, regexes) {
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const matched = regexes.some((regex) => regex.test(entry.name));
      if (!matched) continue;
      const full = join(root, entry.name);

      if (entry.isSymbolicLink()) {
        candidates.push({ path: full, name: entry.name, root, skipped: 'reparse-point' });
        continue;
      }
      if (!entry.isDirectory()) continue;

      let info;
      try {
        info = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        candidates.push({ path: full, name: entry.name, root, skipped: 'reparse-point' });
        continue;
      }
      candidates.push({
        path: full,
        name: entry.name,
        root,
        birthMs: info.birthtimeMs,
        dirMtimeMs: info.mtimeMs,
      });
    }
  }
  return candidates;
}

/**
 * Clear read-only bits so a recursive remove succeeds on Windows.
 *
 * Git writes loose objects read-only by convention; `fs.rm` can retry its way
 * around that, but only for files it manages to open. Clearing the bit up front
 * makes the failure mode explicit instead of partially deleted trees.
 *
 * @param {string} root - directory to unlock.
 * @returns {Promise<void>} resolves when every reachable file is writable.
 */
async function unlock(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const info = await fsp.stat(full);
        if ((info.mode & 0o200) === 0) await fsp.chmod(full, 0o666);
      } catch {
        // Losing the race with a concurrent delete is fine.
      }
    }
  }
}

/**
 * Remove one directory, tolerating Windows read-only objects.
 *
 * @param {string} target - directory to remove.
 * @returns {Promise<void>} resolves once the directory is gone.
 */
export async function defaultRemove(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOTEMPTY') throw error;
    await unlock(target);
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

/**
 * Decide the fate of one measured candidate.
 *
 * Exported so tests can pin the exact boundary conditions without touching disk.
 *
 * @param {object} facts - measurement plus classification inputs.
 * @returns {{action:'delete'|'keep',reason:string,idleMs:number}} the verdict.
 */
export function decide(facts) {
  const { birthMs, newestMs, now, oldestLiveMs, maxIdleMs, protectMs, skewMs } = facts;
  const idleMs = now - newestMs;

  if (idleMs < protectMs) return { action: 'keep', reason: 'touched-recently', idleMs };

  const bornBeforeAnyLiveHost =
    Number.isFinite(oldestLiveMs) && Number.isFinite(birthMs) && birthMs > 0 && birthMs < oldestLiveMs - skewMs;
  if (bornBeforeAnyLiveHost) return { action: 'delete', reason: 'dead-owner', idleMs };

  if (idleMs >= maxIdleMs) return { action: 'delete', reason: 'stale', idleMs };

  return { action: 'keep', reason: Number.isFinite(oldestLiveMs) ? 'live-or-fresh' : 'fresh', idleMs };
}

/**
 * Scan, classify, and (unless `dryRun`) delete.
 *
 * @param {object} options - inputs and limits.
 * @param {string[]} options.roots - temp roots to scan.
 * @param {string[]} options.patterns - glob patterns to match.
 * @param {number} [options.now] - epoch ms used as "now".
 * @param {number|null} [options.oldestLiveMs] - earliest live Host start, or null when unknown.
 * @param {number} options.maxIdleMs - idle fallback threshold.
 * @param {number} [options.protectMs] - never delete anything touched more recently.
 * @param {number} [options.skewMs] - clock-skew guard on the birth comparison.
 * @param {boolean} [options.dryRun] - classify without deleting.
 * @param {number} [options.maxDelete] - per-run deletion cap.
 * @param {(target:string)=>Promise<void>} [options.remove] - remover override.
 * @returns {Promise<object>} a summary suitable for logging.
 */
export async function sweep(options) {
  const {
    roots,
    patterns,
    now = Date.now(),
    oldestLiveMs = null,
    maxIdleMs,
    protectMs = 10 * 60_000,
    skewMs = 120_000,
    dryRun = false,
    maxDelete = 50,
    remove = defaultRemove,
  } = options;

  const acceptedPatterns = safePatterns(patterns);
  if (acceptedPatterns.length === 0) {
    return {
      scanned: 0,
      deleted: [],
      kept: [],
      skipped: [],
      errors: [],
      bytesReclaimed: 0,
      truncatedWalks: 0,
      dryRun,
      oldestLiveMs,
      configError: 'no pattern names a DSH scratch family; refusing to scan',
    };
  }

  const regexes = compilePatterns(acceptedPatterns);
  const candidates = await inspect(roots, regexes);

  const deleted = [];
  const kept = [];
  const skipped = [];
  const errors = [];
  let bytesReclaimed = 0;
  let truncatedWalks = 0;

  for (const candidate of candidates) {
    if (candidate.skipped) {
      skipped.push({ name: candidate.name, reason: candidate.skipped });
      continue;
    }

    const measured = await measure(candidate.path);
    if (measured.truncated) truncatedWalks += 1;
    const newestMs = Math.max(measured.newestMs, candidate.dirMtimeMs ?? 0);
    const verdict = decide({
      birthMs: candidate.birthMs,
      newestMs,
      now,
      oldestLiveMs,
      maxIdleMs,
      protectMs,
      skewMs,
    });

    const record = {
      name: candidate.name,
      path: candidate.path,
      bytes: measured.bytes,
      files: measured.files,
      idleMs: verdict.idleMs,
      reason: verdict.reason,
    };

    if (verdict.action === 'keep') {
      kept.push(record);
      continue;
    }
    if (deleted.length >= maxDelete) {
      kept.push({ ...record, reason: `${verdict.reason} (capped)` });
      continue;
    }
    if (dryRun) {
      deleted.push({ ...record, dryRun: true });
      bytesReclaimed += measured.bytes;
      continue;
    }
    try {
      await remove(candidate.path);
      deleted.push(record);
      bytesReclaimed += measured.bytes;
    } catch (error) {
      errors.push({ name: candidate.name, path: candidate.path, message: String(error?.message ?? error) });
    }
  }

  return {
    scanned: candidates.length,
    deleted,
    kept,
    skipped,
    errors,
    bytesReclaimed,
    truncatedWalks,
    dryRun,
    oldestLiveMs,
    configError: null,
  };
}

/**
 * Reject roots that would make a pattern dangerous (drive roots, UNC shares).
 *
 * @param {string[]} roots - candidate temp roots.
 * @returns {string[]} the accepted subset.
 */
export function safeRoots(roots) {
  const accepted = [];
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const parsed = parse(raw);
    // A relative root has no volume: scanning "." would be an accident, not a setting.
    if (!parsed.root) continue;
    const trimmed = raw.replace(/[\\/]+$/, '');
    const volume = parsed.root.replace(/[\\/]+$/, '');
    // Reject the filesystem root ("/") and a bare volume ("C:", "C:\", "\\server\share").
    if (trimmed === '' || trimmed === volume) continue;
    accepted.push(raw);
  }
  return accepted;
}
