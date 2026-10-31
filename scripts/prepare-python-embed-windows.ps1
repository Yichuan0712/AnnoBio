# Build backend/python-embed (Windows embeddable CPython + backend deps) from scratch.
# Used by CI (build-desktop.yml) and can be run locally to refresh/regenerate the embed.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts\prepare-python-embed-windows.ps1
param(
  [string]$PythonVersion = "3.12.8"
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backendDir = Join-Path $repoRoot "backend"
$embedDir = Join-Path $backendDir "python-embed"
$zipPath = Join-Path $env:TEMP "python-embed-$PythonVersion.zip"
$getPipPath = Join-Path $env:TEMP "get-pip.py"

Write-Host "=== Downloading Python $PythonVersion embeddable package ===" -ForegroundColor Cyan
$url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
Invoke-WebRequest -Uri $url -OutFile $zipPath

Write-Host "=== Extracting to $embedDir ===" -ForegroundColor Cyan
if (Test-Path $embedDir) { Remove-Item -Recurse -Force $embedDir }
Expand-Archive -Path $zipPath -DestinationPath $embedDir

Write-Host "=== Enabling site-packages import ===" -ForegroundColor Cyan
$pth = Get-ChildItem $embedDir -Filter "python*._pth" | Select-Object -First 1
(Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' | Set-Content $pth.FullName
Add-Content -Path $pth.FullName -Value "Lib\site-packages"

Write-Host "=== Bootstrapping pip ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath
& (Join-Path $embedDir "python.exe") $getPipPath --no-warn-script-location

Write-Host "=== Installing backend dependencies ===" -ForegroundColor Cyan
& (Join-Path $embedDir "python.exe") -m pip install --no-cache-dir -r (Join-Path $backendDir "requirements.txt")
# textgrad is deliberately not in requirements.txt (see its comment there) - installed the
# same reduced-dependency way as backend/Dockerfile.
& (Join-Path $embedDir "python.exe") -m pip install --no-cache-dir --no-deps textgrad==0.1.8
& (Join-Path $embedDir "python.exe") -m pip install --no-cache-dir platformdirs diskcache

Write-Host "=== Done ===" -ForegroundColor Cyan
& (Join-Path $embedDir "python.exe") --version
