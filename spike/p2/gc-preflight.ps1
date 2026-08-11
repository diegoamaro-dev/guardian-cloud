# P2 LONG ROTATION - external protocol, correction 1 of 3: REAL METRO PROBE.
#
# packager-status:running is recorded as information only. It is NEVER accepted
# as proof: in this very campaign Metro answered /status while its file watcher
# had failed, so it could not build a bundle at all and the app rendered blank.
#
# Product is not touched by this script. It only reads.

param(
  [string]$Root = "C:\Users\diego\AppData\Local\Temp\claude\D--guardian-cloud\af0c8eba-2c86-4d80-b35a-2e6fc4f4ce72\scratchpad\p2-long-run-2",
  [string]$Adb  = "D:\Programs\Android\Sdk\platform-tools\adb.exe",
  [string]$Pkg  = "com.guardiancloud.app",
  [string]$GateMarker = "LONG_ROTATION"
)

$ErrorActionPreference = 'Continue'
$fail = @()

Write-Output "=== PREFLIGHT ==="
Write-Output ("root : " + $Root)

# ---- absolute, writable output paths ---------------------------------------
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
$paths = @{
  logcat = Join-Path $Root 'logcat.log'
  fdCsv  = Join-Path $Root 'fd_samples.csv'
  pssCsv = Join-Path $Root 'pss_samples.csv'
  evtCsv = Join-Path $Root 'events.csv'
}
foreach ($k in $paths.Keys) {
  $p = $paths[$k]
  if (-not [System.IO.Path]::IsPathRooted($p)) { $fail += "$k path is not absolute: $p" }
  try {
    $probe = "$p.writeprobe"
    Set-Content -Path $probe -Value 'x' -Encoding ascii -ErrorAction Stop
    Remove-Item $probe -Force
    Write-Output ("PATH_OK    {0,-7} {1}" -f $k, $p)
  } catch { $fail += "$k path not writable: $p"; Write-Output ("PATH_FAIL  {0,-7} {1}" -f $k, $p) }
}

# Invoke-WebRequest returns .Content as String or Byte[] depending on the
# response, so both shapes are normalised before anything touches them.
function AsText($content) {
  if ($null -eq $content) { return '' }
  if ($content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($content) }
  return [string]$content
}
function ByteLen($content) {
  if ($null -eq $content) { return 0 }
  if ($content -is [byte[]]) { return $content.Length }
  return [System.Text.Encoding]::UTF8.GetByteCount([string]$content)
}

# ---- Metro: information only ------------------------------------------------
$statusText = ''
try { $statusText = AsText (Invoke-WebRequest -Uri 'http://127.0.0.1:8081/status' -TimeoutSec 15 -UseBasicParsing).Content } catch { $statusText = "unreachable" }
Write-Output ("METRO_STATUS_INFO_ONLY = " + $statusText.Trim())

# ---- Metro: the actual proof ------------------------------------------------
$bundleUrl = 'http://127.0.0.1:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&hot=false&transform.routerRoot=app'
$httpStatus = 0
$bundleBytes = 0
$markerPresent = 'NO'
try {
  $r = Invoke-WebRequest -Uri $bundleUrl -TimeoutSec 400 -UseBasicParsing
  $httpStatus = [int]$r.StatusCode
  $body = AsText $r.Content
  $bundleBytes = ByteLen $r.Content
  if ($body.Contains($GateMarker)) { $markerPresent = 'YES' }
} catch {
  $httpStatus = 0
  # Only the message, never the body: a failed bundle response is megabytes.
  $fail += ("bundle request failed: " + ($_.Exception.Message -split "`n")[0])
}
Write-Output ("HTTP_STATUS = " + $httpStatus)
Write-Output ("BUNDLE_BYTES = " + $bundleBytes)
Write-Output ("EXPECTED_GATE_MARKER_PRESENT = " + $markerPresent)
if ($httpStatus -ne 200)     { $fail += "HTTP_STATUS is $httpStatus, required 200" }
if ($bundleBytes -le 0)      { $fail += "BUNDLE_BYTES is $bundleBytes, required > 0" }
if ($markerPresent -ne 'YES'){ $fail += "gate marker '$GateMarker' absent from the served bundle" }

# ---- device ------------------------------------------------------------------
$pidOut = & $Adb shell pidof $Pkg 2>&1
$pidCode = $LASTEXITCODE
$appPid = ($pidOut | Out-String).Trim()
if ($pidCode -ne 0 -or $appPid -notmatch '^\d+$') {
  $fail += "app pid unresolved: exit $pidCode, value '$appPid'"
  Write-Output "APP_PID = UNRESOLVED"
} else {
  Write-Output ("APP_PID = " + $appPid)
  Set-Content -Path (Join-Path $Root 'apppid.txt') -Value $appPid -Encoding ascii
}

$dfOut = & $Adb shell "df /data/user/0" 2>&1
$avail = ($dfOut | Out-String) -split "`n" | Where-Object { $_ -match '/data/user/0' } | Select-Object -First 1
Write-Output ("DEVICE_STORAGE = " + ($avail -replace '\s+', ' ').Trim())

Write-Output ""
if ($fail.Count -eq 0) {
  Write-Output "PREFLIGHT_RESULT = PASS"
  exit 0
} else {
  Write-Output "PREFLIGHT_RESULT = FAIL"
  $fail | ForEach-Object { Write-Output ("  - " + $_) }
  exit 1
}
