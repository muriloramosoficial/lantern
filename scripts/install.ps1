<#
    Lantern — one-line installer for Windows.

        irm https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.ps1 | iex

    Options (when running the file locally):
        -Portable        install the portable build instead of the NSIS installer
        -Version 0.1.0   install a specific release
        -Dir <path>      install folder for the portable build

    Nothing is installed machine-wide, nothing is sent anywhere, and the
    script never collects telemetry.
#>
[CmdletBinding()]
param(
    [string]$Version = "latest",
    [switch]$Portable,
    [string]$Dir = "$env:LOCALAPPDATA\Lantern"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Owner = "muriloramosoficial"
$Repo = "lantern"
$AppName = "Lantern"
$TempRoot = Join-Path $env:TEMP "lantern-install"

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Gray }
function Write-Good($Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn2($Message) { Write-Host "  $Message" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  $AppName installer" -ForegroundColor DarkYellow
Write-Host "  local-first AI workbench — no account, no license server" -ForegroundColor DarkGray
Write-Host ""

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::DefaultConnectionLimit = 10

if (-not (Test-Path $TempRoot)) { New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null }

# ---------------------------------------------------------------- release ---
$ApiUrl = if ($Version -eq "latest") {
    "https://api.github.com/repos/$Owner/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Owner/$Repo/releases/tags/v$Version".Replace("vv", "v")
}

Write-Step "Looking up $Owner/$Repo ($Version)…"

try {
    $Release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "User-Agent" = "lantern-installer" } -UseBasicParsing
} catch {
    Write-Host "  Could not reach GitHub: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Download manually: https://github.com/$Owner/$Repo/releases" -ForegroundColor Gray
    return
}

$Tag = $Release.tag_name
$Assets = $Release.assets
if (-not $Assets -or $Assets.Count -eq 0) {
    Write-Host "  Release $Tag has no files attached." -ForegroundColor Red
    return
}

$PreferPortable = [bool]$Portable
$Asset = if ($PreferPortable) {
    $Assets | Where-Object { $_.name -like "*Portable*.exe" } | Select-Object -First 1
} else {
    $Assets | Where-Object { $_.name -like "Lantern-Setup*.exe" } | Select-Object -First 1
}
if (-not $Asset) { $Asset = $Assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1 }
if (-not $Asset) {
    Write-Host "  No Windows build found in release $Tag." -ForegroundColor Red
    return
}

Write-Good "Release $Tag — $($Asset.name)"
$DownloadPath = Join-Path $TempRoot $Asset.name

Write-Step "Downloading $([math]::Round($Asset.size / 1MB, 1)) MB…"
Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $DownloadPath -UseBasicParsing `
    -Headers @{ "User-Agent" = "lantern-installer" }

$FileInfo = Get-Item $DownloadPath
if ($FileInfo.Length -lt 1MB) {
    Write-Host "  Download looks incomplete ($($FileInfo.Length) bytes)." -ForegroundColor Red
    return
}

# ----------------------------------------------------------------- install ---
if ($Asset.name -like "Lantern-Setup*") {
    Write-Step "Running the installer (per-user, silent)…"
    $Process = Start-Process -FilePath $DownloadPath -ArgumentList "/S" -PassThru -Wait
    if ($Process.ExitCode -ne 0 -and $Process.ExitCode -ne 3010) {
        Write-Warn2 "Installer returned $($Process.ExitCode); falling back to the portable build."
        $PreferPortable = $true
    } else {
        Write-Good "Installed."
    }
}

if ($PreferPortable -or $Asset.name -like "*Portable*") {
    if ($Asset.name -like "Lantern-Setup*") {
        $PortableAsset = $Assets | Where-Object { $_.name -like "*Portable*.exe" } | Select-Object -First 1
        if ($PortableAsset) {
            $DownloadPath = Join-Path $TempRoot $PortableAsset.name
            Write-Step "Downloading the portable build…"
            Invoke-WebRequest -Uri $PortableAsset.browser_download_url -OutFile $DownloadPath -UseBasicParsing `
                -Headers @{ "User-Agent" = "lantern-installer" }
        }
    }

    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    $Target = Join-Path $Dir "$AppName.exe"

    if (-not ("LanternUnblock" -as [type])) {
        Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class LanternUnblock {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool DeleteFile(string name);
}
"@
    }
    [LanternUnblock]::DeleteFile("$DownloadPath`:Zone.Identifier") | Out-Null

    Copy-Item -Path $DownloadPath -Destination $Target -Force
    $Exe = Get-Item $Target
    try { $Exe.IsReadOnly = $false } catch { }

    $Shell = New-Object -ComObject WScript.Shell
    $StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    $Shortcut = $Shell.CreateShortcut((Join-Path $StartMenu "$AppName.lnk"))
    $Shortcut.TargetPath = $Target
    $Shortcut.WorkingDirectory = $Dir
    $Shortcut.Description = "$AppName — local-first AI workbench"
    $Shortcut.Save()

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$Dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$Dir", "User")
        Write-Step "Added $Dir to your user PATH (open a new terminal to use the 'lantern' command)."
    }

    Write-Good "Installed to $Target"
}

Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  $AppName is ready." -ForegroundColor Green
Write-Host "  Add a provider in Settings — your key stays on this machine." -ForegroundColor Gray
Write-Host "  Uninstall: remove $Dir (portable) or use Apps & features (installer)." -ForegroundColor DarkGray
Write-Host ""
