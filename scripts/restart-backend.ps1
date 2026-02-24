# Restart backend: kill process on port 8000, remove __pycache__
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts\restart-backend.ps1
# Or from app folder:  powershell -ExecutionPolicy Bypass -File ..\scripts\restart-backend.ps1

$port = 8000
$backendDir = Join-Path $PSScriptRoot ".." "backend"
$backendDir = [System.IO.Path]::GetFullPath($backendDir)

Write-Host "=== 1) Kill process on port $port ===" -ForegroundColor Cyan
$found = $false
try {
  foreach ($conn in Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue) {
    $pid = $conn.OwningProcess
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "  Killing PID $pid ($($proc.ProcessName))"
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
      $found = $true
    }
  }
} catch { }
if (-not $found) {
  $line = netstat -ano | Select-String ":\s*$port\s"
  if ($line) {
    $parts = $line -split '\s+'
    $pid = $parts[-1]
    if ($pid -match '^\d+$') {
      Write-Host "  Killing PID $pid (netstat)"
      taskkill /PID $pid /F 2>$null
      $found = $true
    }
  }
}
if (-not $found) { Write-Host "  No process on port $port" }

Write-Host "`n=== 2) Remove backend\__pycache__ ===" -ForegroundColor Cyan
$pycache = Join-Path $backendDir "__pycache__"
if (Test-Path $pycache) {
  Remove-Item -Recurse -Force $pycache
  Write-Host "  Removed $pycache"
} else {
  Write-Host "  Not found: $pycache"
}

Write-Host "`n=== 3) Next steps ===" -ForegroundColor Cyan
Write-Host "  After starting the app, open: http://localhost:8000/api/debug/backend-info"
Write-Host "  New backend shows models_count=11 and model_ids with claude/gemini."
Write-Host "`nClose all Electron windows, then run: npm run start" -ForegroundColor Yellow
