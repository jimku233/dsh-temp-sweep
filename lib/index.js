/**
 * dsh-temp-sweep, Host half.
 *
 * Reclaims temp space that DSH can never reclaim on its own: Session scratch
 * directories left behind when a Host process died, was killed, or never reached
 * `session/disposed`.
 *
 * What it is not
 * --------------
 * This does not stop `@deepseek-ai/dsh-workspace-changes` from copying the work
 * tree into a fresh per-Session object store on the first turn of every Session;
 * that copy happens inside the upstream plugin, which exposes no hook here.
 * The sweep removes the *residue* of that design, which is what turns a per-Day
 * cost into a one-off disaster.
 *
 * Safety model
 * ------------
 * A directory is deleted only when it is quiet AND one of:
 * - it was created before every live Host started (no live process can own it), or
 * - nothing below it changed for `maxIdleHours`.
 *
 * Both rules are skipped while the directory is quieter than `protectMinutes`.
 *
 * @module dsh-temp-sweep
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { earliestStart, listMarkers, pruneMarkers, writeMarker } from './markers.js';
import { defaultRoots, safePatterns, safeRoots, sweep } from './sweep.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'temp-sweep';

/** The sweep's own default scratch pattern: only the plugin that leaks. */
const DEFAULT_PATTERNS = ['dsh-workspace-changes-*'];

/**
 * Clamp a numeric config field.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the candidate is not a number.
 * @param {number} min - smallest accepted value.
 * @param {number} max - largest accepted value.
 * @returns {number} the accepted value.
 */
function clamp(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Resolve the Harness home without importing the settings package.
 *
 * @returns {string} absolute harness home.
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  return join(homedir(), '.dsh');
}

/**
 * Normalize raw loader config into the shape the sweep expects.
 *
 * @param {object} raw - config as authored in the profile patch.
 * @returns {object} validated config.
 */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const roots = Array.isArray(config.roots) && config.roots.length > 0
    ? config.roots.map(String)
    : defaultRoots();
  // Patterns go through the same DSH-family guard the sweep applies, so a config
  // of `patterns: ['*']` can never reach the deletion loop.
  const requestedPatterns = Array.isArray(config.patterns) && config.patterns.length > 0
    ? safePatterns(config.patterns.map(String))
    : DEFAULT_PATTERNS;

  return {
    enabled: config.enabled !== false,
    roots: safeRoots(roots),
    patterns: requestedPatterns.length > 0 ? requestedPatterns : DEFAULT_PATTERNS,
    maxIdleHours: clamp(config.maxIdleHours, 24, 1, 24 * 365),
    protectMinutes: clamp(config.protectMinutes, 10, 0, 24 * 60),
    intervalMinutes: clamp(config.intervalMinutes, 60, 1, 24 * 60),
    maxDeletePerRun: clamp(config.maxDeletePerRun, 50, 1, 10_000),
    dryRun: config.dryRun === true,
    sweepOnStart: config.sweepOnStart !== false,
    // A clean sweep is the normal case; logging it every interval trains users
    // to ignore the log line that matters.
    logWhenClean: config.logWhenClean === true,
    markerDir: typeof config.markerDir === 'string' && config.markerDir.trim() !== ''
      ? config.markerDir
      : join(dshHome(), 'temp-sweep', 'hosts'),
  };
}

/**
 * Pick a logger without assuming the logging service is mounted.
 *
 * @param {object} ctx - plugin context.
 * @returns {{info:Function,warn:Function,error:Function}} logger facade.
 */
function pickLogger(ctx) {
  const fallback = {
    info: (...args) => console.log('[temp-sweep]', ...args),
    warn: (...args) => console.warn('[temp-sweep]', ...args),
    error: (...args) => console.error('[temp-sweep]', ...args),
  };
  const logger = ctx?.logger;
  if (!logger || typeof logger.info !== 'function') return fallback;
  return {
    info: (...args) => logger.info(...args),
    warn: (...args) => logger.warn(...args),
    error: (...args) => logger.error(...args),
  };
}

/**
 * Format a byte count for the log line.
 *
 * @param {number} bytes - byte total.
 * @returns {string} human-readable size.
 */
function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

/**
 * Plugin body: one sweep at activation, then one per interval.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - loader config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const log = pickLogger(ctx);
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const lastRunPath = join(config.markerDir, '..', 'last-run.json');
  let running = false;

  if (config.roots.length === 0) {
    log.warn('no usable temp root; check the roots config');
    return;
  }

  /**
   * One sweep: refresh this Host's marker, drop dead ones, then reclaim.
   *
   * @param {string} trigger - `startup` or `interval`, recorded in the summary.
   * @returns {Promise<void>} resolves when the sweep settles.
   */
  const run = async (trigger) => {
    if (running) return;
    running = true;
    try {
      let oldestLiveMs = null;
      try {
        await writeMarker(config.markerDir, {
          pid: process.pid,
          startedAt,
        });
        await pruneMarkers(config.markerDir, { selfPid: process.pid });
        oldestLiveMs = earliestStart(await listMarkers(config.markerDir));
      } catch (error) {
        // Without the marker store the dead-owner rule is unproven, so the sweep
        // degrades to the idle rule only instead of guessing.
        oldestLiveMs = null;
        log.warn(`marker store unavailable (${error?.message ?? error}); dead-owner rule disabled`);
      }

      const summary = await sweep({
        roots: config.roots,
        patterns: config.patterns,
        oldestLiveMs,
        maxIdleMs: config.maxIdleHours * 3_600_000,
        protectMs: config.protectMinutes * 60_000,
        dryRun: config.dryRun,
        maxDelete: config.maxDeletePerRun,
      });

      const record = {
        at: new Date().toISOString(),
        trigger,
        pid: process.pid,
        roots: config.roots,
        dryRun: summary.dryRun,
        scanned: summary.scanned,
        deleted: summary.deleted.map((item) => ({
          name: item.name,
          bytes: item.bytes,
          reason: item.reason,
          idleHours: Number((item.idleMs / 3_600_000).toFixed(1)),
        })),
        bytesReclaimed: summary.bytesReclaimed,
        kept: summary.kept.length,
        skipped: summary.skipped.length,
        truncatedWalks: summary.truncatedWalks,
        configError: summary.configError,
        errors: summary.errors,
        oldestLiveAt: oldestLiveMs === null ? null : new Date(oldestLiveMs).toISOString(),
      };

      try {
        await fsp.mkdir(join(config.markerDir, '..'), { recursive: true });
        await fsp.writeFile(lastRunPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } catch {
        // The status file is convenience, never a requirement.
      }

      if (summary.configError) {
        log.warn(`sweep refused: ${summary.configError}`);
      } else if (summary.deleted.length > 0) {
        const verb = summary.dryRun ? 'would reclaim' : 'reclaimed';
        log.info(
          `${verb} ${formatSize(summary.bytesReclaimed)} from ${summary.deleted.length} scratch director` +
            `${summary.deleted.length === 1 ? 'y' : 'ies'} (${trigger}); kept ${summary.kept.length}`,
        );
      } else if (config.logWhenClean) {
        log.info(`nothing to reclaim (${trigger}); scanned ${summary.scanned}, kept ${summary.kept.length}`);
      }
      if (summary.truncatedWalks > 0) {
        log.warn(`${summary.truncatedWalks} director${summary.truncatedWalks === 1 ? 'y' : 'ies'} exceed the walk cap; sizes may be understated`);
      }
      for (const failure of summary.errors) log.warn(`could not remove ${failure.name}: ${failure.message}`);
    } catch (error) {
      log.warn(`sweep failed: ${error?.message ?? error}`);
    } finally {
      running = false;
    }
  };

  if (config.sweepOnStart) {
    // Never block plugin activation on disk work; the Host boots in parallel.
    setImmediate(() => void run('startup'));
  }

  ctx.effect(() => {
    const timer = setInterval(() => void run('interval'), config.intervalMinutes * 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'temp-sweep.interval');
}

