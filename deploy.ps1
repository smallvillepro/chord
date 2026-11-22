# Deploys the freshly built client over F:\program\chord, keeping user data.
# Usage: powershell -File deploy.ps1
$ErrorActionPreference = 'Stop'

$source = 'F:\Dima\Documents\Ai\chord-fork\rust\gui-spike\target\release\chord-client.exe'
$target = 'F:\program\chord'
$backup = Join-Path $target ("chord-client.backup-{0}.exe" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

if (-not (Test-Path $source)) { throw "build not found: $source" }
if (-not (Test-Path $target)) { throw "install dir not found: $target" }

Get-Process chord-client -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

if (Test-Path (Join-Path $target 'chord-client.exe')) {
    Copy-Item (Join-Path $target 'chord-client.exe') $backup -Force
    "backup: $backup"
}

Copy-Item $source (Join-Path $target 'chord-client.exe') -Force
"deployed: $source -> $target"

# Keep only the three newest backups.
Get-ChildItem $target -Filter 'chord-client.backup-*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 3 |
    Remove-Item -Force

if (-not (Test-Path (Join-Path $target 'userplugins'))) {
    New-Item -ItemType Directory (Join-Path $target 'userplugins') | Out-Null
    "created: $target\userplugins"
}

Get-Item (Join-Path $target 'chord-client.exe') | Select-Object FullName, Length, LastWriteTime
