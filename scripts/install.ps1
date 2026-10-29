<#
.SYNOPSIS
    Install dsh-temp-sweep into one dsh profile (auto-detected by default).

.DESCRIPTION
    Idempotent. Copies this package into the profile's node_modules, adds it to
    dsh.profile.bundles, and records the pre-install manifest so uninstall can
    restore it exactly. Never edits the dsh installation itself.

    The package has no runtime dependencies: it imports only node builtins, so
    no npm/pnpm install step is needed.

    Requires node 22.19 or newer and a profile that has been started once.
    Run it as the user who runs dsh, outside any dsh sandbox (it writes under
    the harness home, which a workspace-write sandbox blocks).

    Targeting: with no -Profile, the 'desktop' profile is used when it exists and
    carries @deepseek-ai/dsh-web-app (the Electron build), otherwise 'web'. The
    desktop profile is managed exclusively by the Electron application, so
    `dsh --profile desktop --dump-config` always fails; that is expected and the
    installer reports it as a step, not an error.

.PARAMETER Profile
    Profile name to install into. Default: auto-detected ('desktop' or 'web').

.PARAMETER DshHome
    Harness home override. Defaults to $env:DSH_HOME, else ~/.dsh.

.PARAMETER Force
    Reinstall even when the same version is already present.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile web
#>
[CmdletBinding()]
param(
    [string] $Profile,
    [string] $DshHome,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PackageName = 'dsh-temp-sweep'
$StateFolder = '.dsh-temp-sweep'

function Write-Step([string] $Text) { Write-Host "  $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Warn([string] $Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }

function Resolve-DshHome {
    if ($DshHome -and $DshHome.Trim() -ne '') { return (Resolve-Path -LiteralPath $DshHome).Path }
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Read-JsonFile([string] $Path) {
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return ($raw | ConvertFrom-Json)
}

function Write-JsonFile([string] $Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 32)
    [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

<#
    Which profile to target.

    The Electron build owns a profile named 'desktop' and the CLI owns 'web'.
    Installing into the wrong one looks exactly like "the plugin does nothing",
    so the default is detected from the profiles that actually exist.
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

Write-Host "`ndsh-temp-sweep installer" -ForegroundColor White

# --- preflight ---------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node was not found on PATH. Install Node.js 22.19 or newer.' }
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) { throw "node $nodeVersion is too old; 22.19 or newer is required." }

$dshHomeDir = Resolve-DshHome
$Profile = Resolve-Profile $Profile
$profileDir = Join-Path (Join-Path $dshHomeDir 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "Profile '$Profile' was not found at $profileDir. Start it once first: the Electron app creates 'desktop', the CLI creates 'web' (dsh web)."
}

$manifestPath = Join-Path $profileDir 'package.json'
$stateDir = Join-Path $profileDir $StateFolder
$statePath = Join-Path $stateDir 'install.json'
$targetDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName

Write-Step "profile      : $profileDir"
Write-Step "harness home : $dshHomeDir"

# --- already installed? ------------------------------------------------------
$version = (Read-JsonFile (Join-Path $PackageRoot 'package.json')).version
$manifest = Read-JsonFile $manifestPath
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
}
$installed = Test-Path -LiteralPath (Join-Path $targetDir 'package.json')
if ($installed -and -not $Force) {
    $installedVersion = (Read-JsonFile (Join-Path $targetDir 'package.json')).version
    if ($installedVersion -eq $version -and ($bundles -contains $PackageName)) {
        Write-Ok "already installed ($version); pass -Force to reinstall"
        exit 0
    }
}

# --- record the original manifest once --------------------------------------
if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
if (-not (Test-Path -LiteralPath $statePath)) {
    $state = [ordered]@{
        package       = $PackageName
        version       = $version
        profile       = $Profile
        installedAt   = (Get-Date).ToString('o')
        bundlesBefore = $bundles
    }
    Write-JsonFile $statePath $state
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stateDir 'package.json.before') -Force
    Write-Ok 'recorded the pre-install profile manifest'
} else {
    Write-Step 'keeping the existing install record (idempotent)'
}

# --- copy the package into the profile --------------------------------------
if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
$include = @('lib', 'bin', 'scripts', 'cordis.patch.yml', 'SKILL.md', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'package.json')
foreach ($item in $include) {
    $source = Join-Path $PackageRoot $item
    if (-not (Test-Path -LiteralPath $source)) { continue }
    Copy-Item -LiteralPath $source -Destination $targetDir -Recurse -Force
}
Write-Ok "copied package to $targetDir"

# --- enable the bundle row ---------------------------------------------------
if ($bundles -notcontains $PackageName) {
    $list = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $bundles) { $list.Add([string]$entry) }
    # Any bundle whose patch disables an upstream row wants to stay last; insert
    # before the first such package rather than after it.
    $insertAt = $list.Count
    for ($i = 0; $i -lt $list.Count; $i++) {
        if ($list[$i] -ne $PackageName -and $list[$i] -match 'copy-file|patch-last') { $insertAt = $i; break }
    }
    $list.Insert($insertAt, $PackageName)

    if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
    if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($list) -Force
    Write-JsonFile $manifestPath $manifest
    Write-Ok "enabled bundle '$PackageName' at position $insertAt"
} else {
    Write-Ok "bundle '$PackageName' is already enabled"
}

# --- smoke check the composed tree ------------------------------------------
Write-Step 'checking the composed configuration'
$managed = $false
$dump = ''
# `dsh --dump-config` writes its refusal to stderr, and under
# $ErrorActionPreference = 'Stop' PowerShell 5.1 turns redirected stderr into a
# terminating error before the message can be inspected. Relax it for this call
# so the refusal is classified instead of thrown.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $dump = (& dsh --profile $Profile --dump-config 2>&1 | Out-String)
} catch {
    $dump = "$($_.Exception.Message)"
} finally {
    $ErrorActionPreference = $previousEap
}
if ($dump -match 'managed exclusively') {
    # The Electron app owns this profile; composing it from the CLI is refused by
    # design, so this outcome says nothing about the install being incomplete.
    $managed = $true
    Write-Step 'profile is managed by the Electron application; dump-config is unavailable here (expected)'
} elseif ($dump -match 'temp-sweep') {
    Write-Ok 'composed config contains the temp-sweep row'
} elseif ($dump.Trim() -ne '') {
    Write-Warn 'the composed config does not show the row yet; restart dsh to apply the new bundle'
} else {
    Write-Step 'dump-config produced no output; skipping the composed-tree check'
}

Write-Host ""
Write-Host 'Installed.' -ForegroundColor Green
$patchReload = ''
try {
    $profileManifest = Read-JsonFile $manifestPath
    if ($profileManifest.dsh.profile.patchReload) { $patchReload = [string]$profileManifest.dsh.profile.patchReload }
} catch { }
if ($managed) {
    Write-Host 'This profile belongs to the DeepSeek Harness desktop app: quit the app completely' -ForegroundColor Gray
    Write-Host 'and start it again. The plugin loads at app startup and sweeps then.' -ForegroundColor Gray
} elseif ($patchReload -eq 'live') {
    Write-Host 'This profile uses patchReload: live, so the plugin activates without a restart' -ForegroundColor Gray
    Write-Host 'and the first sweep runs as soon as the loader reloads the patch.' -ForegroundColor Gray
} else {
    Write-Host 'Restart dsh to activate the Host plugin; the first sweep runs at startup.' -ForegroundColor Gray
}
Write-Host 'Upgrading an already-loaded copy later still requires a restart.' -ForegroundColor Gray
Write-Host ''
Write-Host 'Verify with: powershell -ExecutionPolicy Bypass -File scripts/verify.ps1' -ForegroundColor Gray
Write-Host 'Remove with: powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1' -ForegroundColor Gray
