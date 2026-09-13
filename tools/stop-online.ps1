# Stop the public tunnel and (optionally) the local game server.
# ASCII-only messages.

Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location ..

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  Fanzhuan Zuolun - Stop Online Room' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

# ---- 1. stop tunnels ----
$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($cf) {
  $cf | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; Write-Host ('  Tunnel stopped (PID ' + $_.Id + ')') -ForegroundColor Green } catch { }
  }
} else {
  Write-Host '  No tunnel process running.' -ForegroundColor Gray
}

# ---- 2. stop the game server bound to port 3000 ----
$stopped = 0
try {
  $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') {
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $stopped++; Write-Host ('  Game server stopped (PID ' + $p.Id + ')') -ForegroundColor Green } catch { }
    }
  }
} catch { }

if ($stopped -eq 0) {
  Write-Host '  No game server on port 3000 (or it was not started by this project).' -ForegroundColor Gray
}

# ---- 3. tidy up url file ----
Remove-Item 'tools\tunnel-url.txt' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  All done. The public address is now invalid.' -ForegroundColor Yellow
Read-Host 'Press Enter to exit'
