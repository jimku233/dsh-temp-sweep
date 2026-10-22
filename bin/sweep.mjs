#!/usr/bin/env node
/**
 * dsh-temp-sweep CLI: inspect and reclaim DSH Session scratch residue without
 * restarting the Host.
 *
 * Dry run by default. `--apply` is the only way to delete anything.
 *
 * @module dsh-temp-sweep/bin
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { earliestStart, listMarkers, pruneMarkers } from '../lib/markers.js';
import { defaultRoots, safePatterns, safeRoots, sweep } from '../lib/sweep.js';

/** Resolve the Harness home the same way the plugin does. */
function dshHome() {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(homedir(), '.dsh');
}

/**
 * Parse `--flag value` style arguments.
 *
 * @param {string[]} argv - process arguments after the script name.
 * @returns {object} parsed options.
 */
function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    dryRun: true,
    assumeNoHost: false,
    maxIdleHours: 24,
    protectMinutes: 10,
    maxDelete: 50,
    patterns: ['dsh-workspace-changes-*'],
    roots: defaultRoots(),
  };

  /**
   * Read a numeric flag, refusing anything that is not a number in range.
   *
   * `Number('abc')` is NaN and `NaN >= threshold` is false, so an unchecked typo
   * would silently disable a limit instead of failing loudly.
   */
  const numberArg = (name, raw, min, max) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} expects a number, got ${JSON.stringify(raw)}`);
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    switch (arg) {
      case '--apply': options.apply = true; options.dryRun = false; break;
      case '--dry-run': options.dryRun = true; break;
      case '--assume-no-host': options.assumeNoHost = true; break;
      case '--json': options.json = true; break;
      case '--max-idle-hours': options.maxIdleHours = numberArg(arg, next(), 1, 8760); break;
      case '--protect-minutes': options.protectMinutes = numberArg(arg, next(), 0, 1440); break;
      case '--max-delete': options.maxDelete = numberArg(arg, next(), 1, 10_000); break;
      case '--roots': options.roots = next().split(/[;,]/).map((item) => item.trim()).filter(Boolean); break;
      case '--patterns': options.patterns = next().split(/[;,]/).map((item) => item.trim()).filter(Boolean); break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Render one padded table.
 *
 * @param {string[][]} rows - first row is the header.
 * @returns {string} table text.
 */
function renderTable(rows) {
  const [header, ...body] = rows;
  const widths = header.map((_, column) =>
    Math.max(...[header, ...body].map((row) => String(row[column] ?? '').length)),
  );
  const line = (row) => row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n');
}

/**
 * Format a byte count.
 *
 * @param {number} bytes - byte total.
 * @returns {string} human-readable size.
 */
function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Entry point.
 *
 * @returns {Promise<void>} resolves when the CLI finishes.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`dsh-temp-sweep — reclaim DSH Session scratch residue

  --apply                  actually delete (default: dry run)
  --assume-no-host         treat every directory as ownerless (only when no DSH
                           Host is running; without a live marker the tool cannot
                           tell a running Host from a dead one)
  --max-idle-hours N       idle fallback threshold (default 24)
  --protect-minutes N      never touch anything quieter than this (default 10)
  --max-delete N           per-run deletion cap (default 50)
  --roots a;b              temp roots to scan (default: os.tmpdir())
  --patterns a;b           glob patterns; must name a DSH family, not 'dsh-*'
  --json                   machine-readable output
`);
    return;
  }

  const roots = safeRoots(options.roots);
  if (roots.length === 0) throw new Error('no usable temp root');

  const patterns = safePatterns(options.patterns);
  if (patterns.length === 0) {
    throw new Error('no pattern names a DSH scratch family (must start with "dsh-" and name one family, e.g. dsh-workspace-changes-*)');
  }

  const markerDir = join(dshHome(), 'temp-sweep', 'hosts');
  let oldestLiveMs = null;
  let liveMarkers = [];
  let markerStoreReadable = true;

  try {
    await fsp.mkdir(markerDir, { recursive: true });
    await pruneMarkers(markerDir, { selfPid: process.pid });
    liveMarkers = await listMarkers(markerDir);
    oldestLiveMs = earliestStart(liveMarkers);
  } catch {
    markerStoreReadable = false;
  }

  // A CLI run is not a Host, so it never writes a marker. Absent markers are *
  // not* proof that no Host is running — a Host started before this package was
  // installed has no marker either. The dead-owner rule therefore needs at least
  // one live marker, and "nothing is running" is an explicit opt-in.
  if (options.assumeNoHost) {
    oldestLiveMs = Date.now();
  } else if (oldestLiveMs === null) {
    oldestLiveMs = null;
  }

  const summary = await sweep({
    roots,
    patterns,
    oldestLiveMs,
    maxIdleMs: options.maxIdleHours * 3_600_000,
    protectMs: options.protectMinutes * 60_000,
    dryRun: options.dryRun,
    maxDelete: options.maxDelete,
  });

  if (options.json) {
    console.log(JSON.stringify({ ...summary, roots, markerStoreReadable, liveMarkers }, null, 2));
    return;
  }

  const hostLine = liveMarkers.length > 0
    ? liveMarkers.map((marker) => `pid ${marker.pid} since ${new Date(marker.startedAt).toLocaleString()}`).join('; ')
    : '(none alive)';

  console.log('');
  console.log('== dsh-temp-sweep ==');
  console.log(`temp roots   : ${roots.join(' | ')}`);
  console.log(`patterns     : ${patterns.join(', ')}`);
  console.log(`live hosts   : ${hostLine}`);
  console.log(`mode         : ${options.dryRun ? 'DRY RUN (pass --apply to delete)' : 'APPLY'}`);
  console.log('');

  const rows = [['DIRECTORY', 'SIZE', 'FILES', 'IDLE(h)', 'VERDICT']];
  const bySize = (a, b) => b.bytes - a.bytes;
  for (const item of [...summary.deleted].sort(bySize)) {
    rows.push([item.name, formatSize(item.bytes), String(item.files), (item.idleMs / 3_600_000).toFixed(1), `delete (${item.reason})`]);
  }
  for (const item of [...summary.kept].sort(bySize)) {
    rows.push([item.name, formatSize(item.bytes), String(item.files), (item.idleMs / 3_600_000).toFixed(1), `keep (${item.reason})`]);
  }
  for (const item of summary.skipped) rows.push([item.name, '-', '-', '-', `skip (${item.reason})`]);
  if (rows.length === 1) rows.push(['(nothing matched)', '', '', '', '']);
  console.log(renderTable(rows));
  console.log('');

  const verb = summary.dryRun ? 'would reclaim' : 'reclaimed';
  console.log(`${verb} ${formatSize(summary.bytesReclaimed)} from ${summary.deleted.length} director${summary.deleted.length === 1 ? 'y' : 'ies'}; kept ${summary.kept.length}`);
  if (summary.truncatedWalks > 0) {
    console.log(`warning: ${summary.truncatedWalks} director${summary.truncatedWalks === 1 ? 'y' : 'ies'} exceeded the walk cap; sizes may be understated`);
  }
  for (const failure of summary.errors) console.log(`error: ${failure.name}: ${failure.message}`);
  console.log('');
}

// Run only when this file is the process entry point. Importing it (tests, or a
// future wrapper) must never start a sweep as a side effect.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`dsh-temp-sweep: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

// Keep the import surface honest for tests that only want the helpers.
export { formatSize, parseArgs, renderTable };
