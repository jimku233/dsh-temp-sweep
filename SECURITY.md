# Security policy

## What this tool touches

`dsh-temp-sweep` deletes directories. Everything below exists to keep that
statement narrow and reviewable.

**It only deletes** direct children of a configured temp root whose name matches
an accepted pattern (`dsh-<family>-*`), and only when the directory is quiet and
either provably ownerless or stale past the idle threshold.

**It never reads file contents.** Classification uses `stat`/`lstat` metadata
only: byte size, mtime, birthtime, and the directory entry type. No file is
opened, parsed, hashed, or transmitted.

**It never follows links.** `junction`/symlink entries are skipped, both while
measuring and while deleting. A link inside a target directory is never descended
into, so a link to `C:\Windows` cannot widen a delete.

**It never touches the network.** No HTTP client, no telemetry, no update check,
no dependency that could add one. The package has zero runtime dependencies and
imports only `node:fs`, `node:os`, `node:path`, `node:url`.

## Guardrails

| Guard | Effect |
|---|---|
| `safePatterns` | Rejects `*`, `**`, `dsh-*`, and anything not naming one DSH scratch family. A misconfiguration cannot become "empty %TEMP%". |
| `safeRoots` | Rejects drive roots (`C:\`, `/`) and bare shares; only real subdirectories are scanned. |
| `protectMinutes` | A directory touched inside the window is never deleted, whichever rule fires. |
| `maxDeletePerRun` | Caps how many directories one sweep may remove. |
| `dryRun` / `--dry-run` | Classify and report without deleting. |
| `dead-owner` requires evidence | The rule needs at least one live Host marker; absent markers disable it instead of assuming "nothing is running". |

## What it writes locally

| Path | Content |
|---|---|
| `<DSH_HOME>/temp-sweep/hosts/<pid>-<startedAt>.json` | `pid`, `startedAt`, `writtenAt`. Nothing about the machine, the user, or any Session. |
| `<DSH_HOME>/temp-sweep/last-run.json` | The last sweep: directory names (random `mkdtemp` codes), sizes, verdict reasons, error strings. |

Both stay on the local disk. Deleting the directory `<DSH_HOME>/temp-sweep`
removes all of it and costs only one extra conservative sweep.

## Threat model boundary

A local process that can already write `<DSH_HOME>` can forge a marker and make
the sweep treat older directories as ownerless. That process has the same
privileges as the user running DSH, so it is outside this tool's threat model —
and the guardrails above still bound the blast radius to "directories matching a
DSH scratch pattern under a temp root".

## Reporting

Open a private security advisory on the repository, or email the maintainer
listed in `package.json`. Please include the pattern, root, and config in use;
do not paste directory listings that contain personal paths.

This project will not accept a change that:
- widens deletion beyond direct children of a configured root,
- removes or weakens `safePatterns` / `safeRoots`,
- reads file contents,
- adds a runtime dependency or a network call,
- deletes a directory inside the `protectMinutes` window.
