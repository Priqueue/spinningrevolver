# Start the game server (if needed) and expose it through a Cloudflare quick tunnel.
# Prints the public URL live and also saves it to tools\tunnel-url.txt
# ASCII-only messages: avoids codepage mangling on Chinese Windows.

$ErrorActionPreference = 'Continue'
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location ..

$cf = 'tools\cloudflared.exe'
$urlFile = 'tools\tunnel-url.txt'
# 每次运行使用独立日志文件，避免与残留进程抢占同一文件句柄
$log = 'tools\tunnel-' + (Get-Date -Format 'MMdd-HHmmss') + '-' + $PID + '.log'

Write-Host '==========================================' -ForegroundColor Cyan
Write-Host '  Fanzhuan Zuolun - Start Online Room' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $cf)) {
  Write-Host '[ERROR] tools\cloudflared.exe not found.' -ForegroundColor Red
  Write-Host '        Download cloudflared into the tools folder first.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

# ---- 1. reuse an already running game server, or start one ----
$listening = $false
try {
  $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop
  if ($conn) { $listening = $true }
} catch {
  $listening = $false
}

if ($listening) {
  Write-Host '[1/2] Game server already listening on port 3000. Reusing it.' -ForegroundColor Green
} else {
  Write-Host '[1/2] Starting game server...' -ForegroundColor Yellow
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WindowStyle Minimized
  Start-Sleep -Seconds 7
}

Write-Host '[2/2] Creating public tunnel (about 15 seconds)...' -ForegroundColor Yellow
Write-Host ''

# 清理上一次可能残留的 cloudflared，避免隧道与日志文件冲突
$stale = Get-Process cloudflared -ErrorAction SilentlyContinue
if ($stale) {
  Write-Host ('  Cleaning up ' + $stale.Count + ' stale cloudflared process(es)...') -ForegroundColor DarkGray
  $stale | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
  Start-Sleep -Seconds 2
}
Write-Host '  A public address will be printed below, shaped like:' -ForegroundColor Gray
Write-Host '      https://xxxx-xxxx.trycloudflare.com' -ForegroundColor Gray
Write-Host '  Send that address to your friends so they can join.' -ForegroundColor Gray
Write-Host ''
Write-Host '  KEEP THIS WINDOW OPEN. Closing it kills the public address.' -ForegroundColor Gray
Write-Host '  Local play stays available at http://localhost:3000' -ForegroundColor Gray
Write-Host ''

Remove-Item $urlFile -ErrorAction SilentlyContinue

# cloudflared 的 stderr 才是日志流，必须 2>&1 合并后再逐行处理
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Resolve-Path $cf).Path
$psi.Arguments = 'tunnel --url http://localhost:3000 --no-autoupdate'
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$writer = New-Object System.IO.StreamWriter($log, $false, [System.Text.Encoding]::UTF8)
$writer.AutoFlush = $true

$found = $false

function Handle-Line([string]$line, $writer, [ref]$found, [string]$urlFile) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  $writer.WriteLine($line)
  $m = [regex]::Match($line, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($m.Success) {
    if (-not $found.Value) {
      $found.Value = $true
      Set-Content -Path $urlFile -Value $m.Value -Encoding ascii
      Write-Host ''
      Write-Host '  ====================================================' -ForegroundColor DarkGray
      Write-Host ('   >>> PUBLIC URL: ' + $m.Value) -ForegroundColor Green
      Write-Host '  ====================================================' -ForegroundColor DarkGray
      Write-Host '   Send this address to your friends.' -ForegroundColor Gray
      Write-Host ''
    }
    return
  }
  if ($line -match 'ERR|error') {
    Write-Host ('  ' + $line) -ForegroundColor DarkYellow
  } else {
    Write-Host ('  ' + $line) -ForegroundColor DarkGray
  }
}

try {
  $outTask = $proc.StandardOutput.ReadLineAsync()
  $errTask = $proc.StandardError.ReadLineAsync()
  while ($true) {
    $progress = $false
    if ($outTask -and $outTask.IsCompleted) {
      $line = $outTask.Result
      if ($null -eq $line) { $outTask = $null } else {
        Handle-Line $line $writer ([ref]$found) $urlFile
        $progress = $true
        $outTask = $proc.StandardOutput.ReadLineAsync()
      }
    }
    if ($errTask -and $errTask.IsCompleted) {
      $line = $errTask.Result
      if ($null -eq $line) { $errTask = $null } else {
        Handle-Line $line $writer ([ref]$found) $urlFile
        $progress = $true
        $errTask = $proc.StandardError.ReadLineAsync()
      }
    }
    if ($null -eq $outTask -and $null -eq $errTask) { break }
    if (-not $progress) { Start-Sleep -Milliseconds 40 }
  }
} finally {
  $writer.Flush()
  $writer.Close()
  if (-not $proc.HasExited) { $proc.Kill() }
}

Write-Host ''
Write-Host 'Tunnel has ended.' -ForegroundColor Yellow
Write-Host 'Note: the game server may still run in the background.' -ForegroundColor Yellow
if (Test-Path $urlFile) {
  Write-Host ('Last public URL: ' + (Get-Content $urlFile -Raw).Trim()) -ForegroundColor DarkGray
}
Read-Host 'Press Enter to exit'
