<#
.SYNOPSIS
    Remove dsh-temp-sweep from one dsh profile.

.DESCRIPTION
    Removes the bundle row and the copied package. Keeps the recorded state and
    the host markers under the harness home, so a reinstall stays idempotent and
    the sweep keeps knowing which Hosts are alive.

.PARAMETER Profile
    Profile name to remove from. Default: auto-detected ('desktop' or 'web').

.PARAMETER DshHome
    Harness home override. Defaults to $env:DSH_HOME, else ~/.dsh.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/uninstall.ps1
#>
[CmdletBinding()]
param(
    [string] $Profile,
    [string] $DshHome
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-temp-sweep'

function Write-Step([string] $Text) { Write-Host "  $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "  OK  $Text" -ForegroundColor Green }

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
    Which profile to remove from.

    The Electron build owns 'desktop', the CLI owns 'web'; removing from the
    wrong one leaves the plugin loaded while reporting success.
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

function Write-JsonFile([string] $Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 32)
    [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

$Profile = Resolve-Profile $Profile
$profileDir = Join-Path (Join-Path (Resolve-DshHome) 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir)) { throw "Profile '$Profile' was not found at $profileDir" }

$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Read-JsonFile $manifestPath
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
}

if ($bundles -contains $PackageName) {
    $kept = @($bundles | Where-Object { $_ -ne $PackageName })
    $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $kept -Force
    Write-JsonFile $manifestPath $manifest
    Write-Ok "removed bundle '$PackageName'"
} else {
    Write-Step "bundle '$PackageName' was not enabled"
}

$targetDir = Join-Path (Join-Path $profileDir 'node_modules') $PackageName
if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
    Write-Ok "removed $targetDir"
} else {
    Write-Step 'package directory was already gone'
}

Write-Host ''
Write-Host 'Uninstalled. Restart dsh to drop the plugin from the running Host.' -ForegroundColor Green
