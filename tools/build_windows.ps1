param([ValidatePattern('^\d+\.\d+\.\d+([.-][a-zA-Z0-9]+)*$')][string]$Version = '1.0.0')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Create .venv and install requirements-build.txt first.' }
Push-Location $projectRoot
try {
    & $pythonPath tools/create_assets.py
    if ($LASTEXITCODE -ne 0) { throw 'Artwork generation failed' }
    & $pythonPath -m PyInstaller --noconfirm --clean --onefile --windowed --name Shiji --icon docs/images/shiji.ico --add-data 'static;static' app.py
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed' }
    $bundle = Join-Path $projectRoot "release\Shiji-v$Version-windows-x64"
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\Shiji.exe') -Destination $bundle
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $bundle
    @'
@echo off
"%~dp0Shiji.exe" --stop
'@ | Set-Content -LiteralPath (Join-Path $bundle 'Stop-Shiji.cmd') -Encoding ascii
    @'
@echo off
"%~dp0Shiji.exe" --stop
start "" "%~dp0Shiji.exe" --lan
'@ | Set-Content -LiteralPath (Join-Path $bundle 'Start-LAN.cmd') -Encoding ascii
    @'
Shiji / 拾记

Start: double-click Shiji.exe. No Python installation needed.
Stop backend: double-click Stop-Shiji.cmd. Closing the window leaves reminders running.
Phone access: run Start-LAN.cmd, then use the Phone Connection menu on a trusted Wi-Fi.

Data folder: %LOCALAPPDATA%\Shiji\
Stop the backend before backing up this complete folder. Updates do not require deleting it.
No cloud sync or mobile push. Protected records use application access control, not disk encryption.
Save protected edits before the fixed 15-minute display authorization expires.

中文使用指南与下载说明：
https://github.com/zenghong128-ui/shiji

This build is unsigned. Release checksums are published alongside the archive.
'@ | Set-Content -LiteralPath (Join-Path $bundle 'QUICKSTART.txt') -Encoding utf8
    $archive = Join-Path $projectRoot "release\Shiji-v$Version-windows-x64.zip"
    Compress-Archive -Path (Join-Path $bundle '*') -DestinationPath $archive -Force
    Get-Item -LiteralPath $archive | Select-Object Name, Length
} finally { Pop-Location }
