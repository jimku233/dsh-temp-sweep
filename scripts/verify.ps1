<#
.SYNOPSIS
    Verify a dsh-temp-sweep installation.

.DESCRIPTION
    Checks the copied package, the bundle row, runs the CLI in dry-run mode
    against the real temp roots, and reports the last sweep the Host recorded.

.PARAMETER Profile
    Profile name to verify. Default: auto-detected ('desktop' or 'web').

.PARAMETER DshHome
    Harness home override. Defaults to $env:DSH_HOME, else ~/.dsh.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
#>
[CmdletBinding()]
param(
    [string] $Profile,
    [string] $DshHome
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-temp-sweep'
$problems = 0

function Write-Step([string] $Text) { Write-Host "  $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Bad([string] $Text) { Write-Host "  !!  $Text" -ForegroundColor Red; $script:problems++ }

function Resolve-DshHome {
    if ($DshHome -and $DshHome.Trim() -ne '') { return (Resolve-Path -LiteralPath $DshHome).Path }
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Read-JsonFile([string] $Path) {
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return ($raw | ConvertFrom-Json)
}

<#
    Which profile to verify.

    The Electron build owns 'desktop', the CLI owns 'web'; verifying the wrong
    one reports "package is not installed" for a perfectly good install.
#>
function Resolve-Profile([string] $Requested) {
    if ($Requested -and $Requested.Trim() -ne '') { return $Requested.Trim() }
    $profilesDir = Join-Path (Resolve-DshHome) 'profiles'
    $desktopManifest = Join-Path (Join-Path $profilesDir 'desktop') 'package.json'
    if (Test-Path -LiteralPath $desktopManifest) {
        try {
            $desktop = Read-JsonFile $desktopManifest
            $desktopBundles = @()
            if ($desktop.dsh -and $desktop.dsh.profile -and $desktop.dsh.profile.bundles) {
                $desktopBundles = @($desktop.dsh.profile.bundles)
            }
            if ($desktopBundles -contains '@deepseek-ai/dsh-web-app') { return 'desktop' }
        } catch { }
    }
    return 'web'
}

Write-Host "`ndsh-temp-sweep verification" -ForegroundColor White

$dshHomeDir = Resolve-DshHome
$Profile = Resolve-Profile $Profile
$profileDir = Join-Path (Join-Path $dshHomeDir 'profiles') $Profile
$targetDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
Write-Step "profile      : $profileDir"

if (-not (Test-Path -LiteralPath (Join-Path $targetDir 'package.json'))) {
    Write-Bad "package is not installed at $targetDir"
} else {
    $installed = Read-JsonFile (Join-Path $targetDir 'package.json')
    Write-Ok "package installed (version $($installed.version))"
}

$manifest = Read-JsonFile (Join-Path $profileDir 'package.json')
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
}
if ($bundles -contains $PackageName) {
    Write-Ok "bundle row present at position $([array]::IndexOf($bundles, $PackageName))"
} else {
    Write-Bad "bundle row missing from $profileDir\package.json"
}

# The CLI proves the rules against the real temp roots without deleting anything.
$cli = Join-Path $targetDir 'bin\sweep.mjs'
if (Test-Path -LiteralPath $cli) {
    Write-Step 'dry run against the current temp roots'
    try {
        $json = (& node $cli --json 2>&1 | Out-String)
        $summary = $json | ConvertFrom-Json
        Write-Ok "scanned $($summary.scanned); would delete $($summary.deleted.Count); keep $($summary.kept.Count)"
        foreach ($item in $summary.deleted) {
            Write-Host ("       would delete {0} ({1}) -- {2}" -f $item.name, $item.reason, ('{0:N1} MB' -f ($item.bytes / 1MB))) -ForegroundColor Yellow
        }
        if ($summary.deleted.Count -eq 0) {
            Write-Step 'nothing to reclaim right now (expected after a clean start)'
        }
    } catch {
        Write-Bad "dry run failed: $($_.Exception.Message)"
    }
} else {
    Write-Bad "CLI missing at $cli"
}

$lastRun = Join-Path $dshHomeDir 'temp-sweep\last-run.json'
if (Test-Path -LiteralPath $lastRun) {
    $record = Read-JsonFile $lastRun
    Write-Ok "last Host sweep: $($record.at) ($($record.trigger)), reclaimed $([math]::Round($record.bytesReclaimed / 1MB, 1)) MB from $($record.deleted.Count)"
    if ($record.errors -and $record.errors.Count -gt 0) {
        Write-Bad "$($record.errors.Count) removal error(s); see the file"
    }
} else {
    Write-Step "no Host sweep recorded yet ($lastRun)"
    Write-Step 'the plugin sweeps when it loads (patchReload: live) or at Host startup'
}

Write-Host ''
if ($problems -gt 0) {
    Write-Host "Verification finished with $problems problem(s)." -ForegroundColor Red
    exit 1
}
Write-Host 'Verification finished clean.' -ForegroundColor Green
