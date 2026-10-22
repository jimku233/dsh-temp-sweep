# dsh-temp-sweep

A DSH **Host plugin** that reclaims Session scratch residue. It removes
`dsh-workspace-changes-*` directories that provably belong to a dead Host process,
at Host start and on an interval — no manual script, no waiting for "today" to
become "yesterday".

```text
[temp-sweep] reclaimed 39.25 GiB from 32 scratch directories (startup); kept 8
```

## What it fixes, and what it does not

| | Content | Owner |
|---|---|---|
| ✅ fixes | Scratch directories left by a crash, a kill, or a restart (the 44.9 GB kind) | **this plugin** |
| ✅ fixes | Orphaned Session directories slowly piling up in a long-lived Host | **this plugin** |
| ❌ does not | Every Session still copies the work tree once on its first turn (~950 MB of IO and temp space) | upstream `dsh-workspace-changes` |
| ❌ does not | Cross-Session deduplication, or the scratch location hard-wired to `os.tmpdir()` | upstream |

Reducing the per-Session cost needs `.gitignore` rules or moving large files out
of the workspace. This plugin does exactly one thing: **stop the residue from
accumulating.**

## Why the rule can be proven

The upstream plugin creates the directory with `mkdtemp()`. The name is random,
nothing on disk names the owner, and the path lives only in that Host's memory.
So "which process owns this directory?" is unanswerable from outside.

One narrower question is answerable:

> Was this directory created before **every live Host** started?

If so, every process that could have created it is gone, so it is certainly dead.
That needs one fact per Host — pid and start time — which is what the markers are
for:

```text
<DSH_HOME>/temp-sweep/hosts/<pid>-<startedAt>.json
```

Two deletion rules follow, strongest first:

| Rule | Condition | Basis |
|---|---|---|
| `dead-owner` | created before the earliest live Host started, minus clock skew | no live process can own it |
| `stale` | nothing below it written for 24 hours (configurable) | a live Session writes objects every turn |

Both additionally require the directory to be quiet for `protectMinutes`
(default 10), so a directory created or written moments ago is never eligible.
Every degraded path (recycled pid, unreadable marker store, missing `birthtime`)
falls back to the more conservative rule — the tool can delete less, never more.

## Install

Requires Node 22.19+ and a profile that has been started once.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

The installer copies the package into the profile's `node_modules`, adds
`dsh-temp-sweep` to `dsh.profile.bundles`, and records the pre-install manifest so
uninstall can restore it. **It never edits the DSH installation.** The package has
no runtime dependencies — only `node:` built-ins.

> Run it outside the dsh sandbox: it writes under `~/.dsh`, which a
> workspace-write sandbox refuses.

### Does it need a restart?

Depends on the profile's `patchReload`:

- `live` (DSH default): **no restart**. On a live-reload profile the plugin loaded
  and finished its first sweep seconds after the installer exited (11 directories
  → 4, 7.08 GB reclaimed, measured).
- Anything else: restart the Host so the new bundle row is composed in.

Two things remain true either way:

1. The marker uses `process.uptime()` to derive the **Host's real start time**, not
   the load time — so a plugin loaded three hours into a Host's life still judges
   "who died before me" correctly.
2. **Upgrading the package** does need a restart: code already loaded in memory is
   not swapped.

## Verify

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

It checks the package and the bundle row, runs a **read-only** dry run against the
real temp roots, and prints the last sweep the Host recorded
(`<DSH_HOME>/temp-sweep/last-run.json`).

## Configure

Override the `id: temp-sweep` row in the profile's own `cordis.patch.yml`, not the
`cordis.patch.yml` shipped in the package (an upgrade would overwrite that):

```yaml
- id: temp-sweep
  config:
    maxIdleHours: 48        # idle fallback threshold, default 24
    protectMinutes: 15      # protection window, default 10
    dryRun: true            # classify and report only
    patterns:
      - dsh-workspace-changes-*
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | turn the plugin off |
| `roots` | TMP/TEMP + platform default | drive roots are refused |
| `patterns` | `dsh-workspace-changes-*` | globs (`*`, `?`); must be `dsh-<family>-*`, `*` and `dsh-*` are refused |
| `maxIdleHours` | `24` | idle fallback (1–8760) |
| `protectMinutes` | `10` | protection window (0–1440) |
| `intervalMinutes` | `60` | periodic sweep (1–1440) |
| `maxDeletePerRun` | `50` | per-run deletion cap (1–10000) |
| `dryRun` | `false` | report without deleting |
| `sweepOnStart` | `true` | sweep at activation |
| `logWhenClean` | `false` | also log when there was nothing to reclaim |
| `markerDir` | `<DSH_HOME>/temp-sweep/hosts` | marker directory |

## CLI

Read-only by default; `--apply` is the only way to delete:

```bash
node bin/sweep.mjs                       # dry run
node bin/sweep.mjs --apply               # delete
node bin/sweep.mjs --max-idle-hours 168  # more conservative
node bin/sweep.mjs --json                # machine readable
node bin/sweep.mjs --assume-no-host      # only when you know no Host is running
```

`--assume-no-host` reads "no live marker" as "no live Host". It is **not** the
default, because a Host started before this package was installed has no marker
either — assuming otherwise would call its live directories ownerless.

## Security and privacy

This tool deletes directories, so the boundary must be reviewable line by line:

| Promise | How |
|---|---|
| **never reads file contents** | `stat`/`lstat` metadata only (size, mtime, birthtime, entry type); no open, parse, hash, or upload |
| **never follows links** | junctions/symlinks are skipped while measuring, unlocking, and deleting |
| **never leaves the root** | only direct children of a configured root whose name matches; drive and share roots are refused |
| **never becomes "empty %TEMP%"** | `patterns` must be `dsh-<family>-*`; `*`, `**`, `dsh-*` are rejected (`safePatterns`, applied twice) |
| **never deletes a live Session** | two rules + protection window + per-run cap; `dead-owner` needs marker evidence |
| **no network, no telemetry** | zero runtime dependencies; imports only `node:` built-ins |

Locally it writes two files, neither carrying a machine name, user name, or
Session content: the markers (`pid`, `startedAt`, `writtenAt`) and
`last-run.json` (roots, random directory codes, sizes, reasons, error strings).
Deleting `<DSH_HOME>/temp-sweep` removes all of it. See [SECURITY.md](SECURITY.md).

## Tests

```bash
node tools/test.mjs          # same as npm test
node tools/test.mjs --fork   # per-file isolation via node --test; normal environments only
```

34 cases: both rules and their boundaries, protection-window precedence, deletion
cap, junction skipping, read-only git objects, marker pruning and junk tolerance,
missing roots, drive-root refusal, catch-all refusal, CLI flag validation. Every
case builds a real tree in a throwaway temp directory and never touches the real
`%TEMP%`.

> Do not use `node --test tests/`: Node 22/24 loads `tests` as a module and fails
> with `MODULE_NOT_FOUND`. The single entry point is `tools/test.mjs` (explicit
> file list, in-process by default, so it also runs inside a confined sandbox).

## Release gate

```bash
node tools/check-release.mjs
```

Four gates: no generated artifacts tracked, no sensitive strings in tracked files
**or in the full git history**, version agreement between `package.json` and
`CHANGELOG.md`, and the test suite.

## Known limitations

- **The per-Session copy cost is unchanged**: that is upstream behaviour; this
  plugin can only reclaim afterwards.
- **Multi-Host upgrade window**: a Host started before the install has no marker.
  The plugin derives its own start with `process.uptime()`, so it judges correctly
  about itself — but upgrade all instances rather than leaving one unpatched.
- On filesystems without `birthtime` (some Linux setups) the `dead-owner` rule
  degrades to `stale` automatically.
- Measured on Windows 11; Linux/macOS are untested, though the rules are
  platform-independent.

## License

MIT, see [LICENSE](LICENSE).
