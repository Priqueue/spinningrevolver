# Tail tools\tunnel.log, extract the public trycloudflare URL, print it and save it.
# ASCII-only: avoids codepage mangling on Chinese Windows.
param(
  [string]$LogPath = "tools\tunnel.log",
  [string]$OutPath = "tools\tunnel-url.txt",
  [int]$TimeoutSeconds = 120
)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$found = $null

while (-not $found -and (Get-Date) -lt $deadline) {
  if (Test-Path $LogPath) {
    try {
      $raw = Get-Content -Path $LogPath -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        $m = [regex]::Matches($raw, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Count -gt 0) { $found = $m[$m.Count - 1].Value }
      }
    } catch {
      # log file may be locked mid-write; just retry
    }
  }
  if (-not $found) { Start-Sleep -Milliseconds 600 }
}

if ($found) {
  Set-Content -Path $OutPath -Value $found -Encoding ascii
  Write-Host ""
  Write-Host "  ====================================================" -ForegroundColor DarkGray
  Write-Host ("   >>> PUBLIC URL: " + $found) -ForegroundColor Green
  Write-Host "  ====================================================" -ForegroundColor DarkGray
  Write-Host "   Send this address to your friends." -ForegroundColor Gray
  Write-Host ""
} else {
  Write-Host ""
  Write-Host "  [WARN] No public URL detected within the time limit." -ForegroundColor Yellow
  Write-Host "         Check tools\tunnel.log for details." -ForegroundColor Yellow
  Write-Host ""
}
