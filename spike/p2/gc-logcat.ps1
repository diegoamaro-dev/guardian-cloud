# P2 LONG ROTATION - external protocol, correction 2 of 3: PERSISTENT,
# IDENTIFIABLE CAPTURE.
#
# Exactly ONE logcat process. Its pid is written to a file BEFORE the operator
# presses anything, so it can be checked rather than assumed. The output path is
# absolute and is never built from a variable inside a background redirection —
# that mistake once left an orphan adb writing to D:\logcat-default-obs.log.

param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$AppPid,
  [string]$Adb = "D:\Programs\Android\Sdk\platform-tools\adb.exe"
)

$ErrorActionPreference = 'Stop'
$log    = Join-Path $Root 'logcat.log'
$err    = Join-Path $Root 'logcat.stderr'
$pidF   = Join-Path $Root 'logcat.pid'

if (-not [System.IO.Path]::IsPathRooted($log)) { throw "logcat path is not absolute: $log" }

# Truncate so no earlier capture can be mistaken for this one.
Set-Content -Path $log -Value $null -Encoding ascii
Set-Content -Path $err -Value $null -Encoding ascii

$p = Start-Process -FilePath $Adb `
                   -ArgumentList @('logcat', "--pid=$AppPid", '-T', '1', '-v', 'threadtime') `
                   -RedirectStandardOutput $log `
                   -RedirectStandardError  $err `
                   -NoNewWindow -PassThru

Set-Content -Path $pidF -Value $p.Id -Encoding ascii

Write-Output ("PROCESS_PID = " + $p.Id)
Write-Output ("PROCESS_ALIVE = " + (-not $p.HasExited))
Write-Output ("ABSOLUTE_OUTPUT_PATH = " + $log)
Write-Output ("OUTPUT_WRITABLE = " + (Test-Path $log))
Write-Output ("START_TIME = " + $p.StartTime.ToUniversalTime().ToString('o'))
