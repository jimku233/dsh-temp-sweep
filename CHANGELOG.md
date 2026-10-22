# Changelog

## 0.1.1 — 2026-10-22

Hardening pass after a self-review. No behaviour change for correctly configured
installs.

- **Safety:** `safePatterns` refuses `*`, `**`, `dsh-*`, and anything that does not
  name one DSH scratch family. Previously a `patterns: ['*']` config would have
  matched every temp entry. `sweep()` applies the same guard, so a direct caller
  cannot bypass it.
- **Bug:** the CLI now rejects non-numeric or out-of-range limit flags. `Number('abc')`
  used to become `NaN`, and every `>= NaN` comparison is false, so a typo silently
  disabled a cap.
- **Privacy:** markers no longer record the hostname, and no longer record a version
  field. They hold `pid`, `startedAt`, `writtenAt` and nothing else.
- **Bug:** `bin/sweep.mjs` now runs only when it is the process entry point.
  Importing it (tests, wrappers) used to start a sweep as a side effect.
- **Polish:** a clean sweep is no longer logged at info level unless
  `logWhenClean: true`. Hourly "nothing to reclaim" lines train users to ignore
  the log line that matters.
- **Transparency:** a directory whose walk hit the entry cap is counted in
  `truncatedWalks` and reported, instead of silently understating its size.
- Tests: 24 → 34 (catch-all refusal, decoy names, marker data minimization, CLI
  flag validation, table rendering).

## 0.1.0 — 2026-10-22

First release.

- Host plugin that reclaims Session scratch residue at Host start and on an
  interval, with two deletion rules: `dead-owner` (the directory was created
  before every live Host started, so no live process can own it) and `stale`
  (nothing below it changed for `maxIdleHours`).
- `protectMinutes` guard: a directory quieter than the window is never touched,
  whichever rule would otherwise fire.
- Host markers under `<DSH_HOME>/temp-sweep/hosts` record pid and start time so
  the dead-owner rule can be proven instead of guessed; markers of dead Hosts
  are pruned on every sweep.
- `bin/sweep.mjs` CLI: dry run by default, `--apply` to delete,
  `--assume-no-host` for the case where the user knows no Host is running.
- Status file `<DSH_HOME>/temp-sweep/last-run.json` records every sweep.
- Activates through the profile's bundle patch, so a profile with
  `patchReload: live` starts sweeping without a Host restart.
- 24 tests (`node --test`) covering both rules, the protect window, the deletion
  cap, reparse points, read-only git objects, and marker pruning.

Measured on the machine it was written for (Windows 11, DSH 0.2.0-rc.2, live
patch reload): first sweep reduced 11 scratch directories to 4 and reclaimed
7.08 GB.

### Not fixed here

The upstream plugin still copies every untracked, non-ignored work-tree file
into a fresh per-Session object store on the first turn. This package removes
the residue of that design; it does not remove the cost. Cross-Session object
deduplication and a configurable scratch root need an upstream change.
