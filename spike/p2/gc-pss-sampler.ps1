# P2 LONG ROTATION - PSS sampling bound to the REAL activation.
#
# The previous run used a fixed 700 s window opened by hand. It started 148 s
# before the operator pressed and closed 86 s before session_released, so it
# covered neither end. This process starts, proves it can sample, then WAITS:
# the window opens on session_start and closes on session_released.
#
# TERMINATION. Two ABSOLUTE monotonic deadlines, checked at the top of every
# iteration including when lines are still pending. Log activity never resets
# them. The idle timeout survives as a SECONDARY diagnostic only.
#
# VALIDITY. A sample is valid only when its value is numeric and its error is
# empty. Invalid readiness, baseline or final ends the run non-zero.
#
# PSS variation is an OBSERVATION of memory during the window. It is never
# evidence of a leak, and this script does not compute one.
#
# On this OxygenOS build `dumpsys meminfo <package>` returns the SYSTEM-WIDE
# report with no TOTAL PSS line at all; it must be called with the pid.
#
# EXIT CODES
#   0 complete   2 readiness invalid   3 pre-start timeout   4 session timeout
#   5 contaminated (foreign session)   6 baseline/final invalid   7 pid unresolved

param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$Adb = "D:\Programs\Android\Sdk\platform-tools\adb.exe",
  [string]$Pkg = "com.guardiancloud.app",
  [int]$IntervalSec = 30,
  [int]$PreStartTimeoutSec = 900,
  [int]$SessionTimeoutSec  = 1200,
  [int]$IdleDiagnosticSec  = 300,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$log  = Join-Path $Root 'logcat.log'
$csv  = Join-Path $Root 'pss_samples.csv'
$pidF = Join-Path $Root 'pss_sampler.pid'
Set-Content -Path $pidF -Value $PID -Encoding ascii

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$freq = [System.Diagnostics.Stopwatch]::Frequency
function MonoNs { return [long](($sw.ElapsedTicks / $freq) * 1e9) }

$i = 0
"phase,sample_index,mono_ns,utc_iso,session_id,pss_kib,error" | Out-File -FilePath $csv -Encoding ascii
function Row([string]$phase, [string]$sid, [string]$val, [string]$err) {
  "$phase,$script:i,$(MonoNs),$((Get-Date).ToUniversalTime().ToString('o')),$sid,$val,$err" |
    Out-File -FilePath $csv -Encoding ascii -Append
}

$pidOut = & $Adb shell pidof $Pkg 2>&1
$pidCode = $LASTEXITCODE
$appPid = ($pidOut | Out-String).Trim()
if ($pidCode -ne 0 -or $appPid -notmatch '^\d+$') {
  Row 'readiness' '' '' "pid unresolved exit=$pidCode value='$appPid'"
  Write-Output "PSS_SAMPLER: RESULT=INCOMPLETE cause=pid_unresolved"
  exit 7
}
Write-Output ("PSS_SAMPLER: APP_PID = " + $appPid)

$errCount = 0
function Take([string]$phase, [string]$sid) {
  $script:i++
  $val = ''; $err = ''
  try {
    $out  = & $Adb shell "dumpsys meminfo $appPid" 2>&1
    $code = $LASTEXITCODE
    $arr  = @($out)
    if ($code -ne 0) { $err = "adb exit $code" }
    elseif ($arr.Count -eq 0) { $err = "empty output" }
    else {
      $text = ($arr | Out-String)
      if ($text -match 'TOTAL PSS:\s+(\d+)') { $val = [int]$Matches[1] } else { $err = "TOTAL PSS not found" }
    }
  } catch { $err = ($_.Exception.Message -replace ',', ';') }
  Row $phase $sid $val $err
  $valid = ($err -eq '' -and "$val" -match '^\d+$')
  if (-not $valid) { $script:errCount++ }
  return @{ value = $val; error = $err; valid = $valid }
}

$r = Take 'readiness' ''
Write-Output ("PSS_SAMPLER: readiness pss_kib='" + $r.value + "' error='" + $r.error + "' valid=" + $r.valid)
if (-not $r.valid) {
  Write-Output "PSS_SAMPLER: RESULT=INCOMPLETE cause=readiness_invalid"
  exit 2
}
if ($DryRun) { Write-Output "PSS_SAMPLER: RESULT=DRY_OK"; exit 0 }

$preStartDeadlineMs = $sw.ElapsedMilliseconds + ($PreStartTimeoutSec * 1000)
$sessionDeadlineMs  = [long]::MaxValue
Write-Output ("PSS_SAMPLER: PRE_START_TIMEOUT=" + $PreStartTimeoutSec + "s SESSION_TIMEOUT=" + $SessionTimeoutSec + "s")

while (-not (Test-Path $log)) {
  if ($sw.ElapsedMilliseconds -gt $preStartDeadlineMs) {
    Row 'timeout' '' '' "RUN INCOMPLETE: pre-start timeout ${PreStartTimeoutSec}s, logcat file never appeared"
    Write-Output "PSS_SAMPLER: RESULT=INCOMPLETE cause=pre_start_timeout"
    exit 3
  }
  Start-Sleep -Milliseconds 200
}
$fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
$sr = New-Object System.IO.StreamReader($fs)

$sessionId    = ''
$sessionSeen  = $false
$startCount   = 0
$contaminated = $false
$baselineOk   = $false
$finalOk      = $false
$nextDueMs    = [long]::MaxValue
$lastLineMs   = $sw.ElapsedMilliseconds
$idleFlagged  = $false
$outcome      = ''
$exitCode     = 0

while ($true) {

  # ---- 1. ABSOLUTE DEADLINES FIRST, before any read ------------------------
  $nowMs = $sw.ElapsedMilliseconds
  if (-not $sessionSeen -and $nowMs -gt $preStartDeadlineMs) {
    Row 'timeout' '' '' "RUN INCOMPLETE: pre-start timeout ${PreStartTimeoutSec}s, session_start never observed"
    $outcome = 'pre_start_timeout'; $exitCode = 3; break
  }
  if ($sessionSeen -and $nowMs -gt $sessionDeadlineMs) {
    Row 'timeout' $sessionId '' "RUN INCOMPLETE: session timeout ${SessionTimeoutSec}s, session_released never observed"
    $outcome = 'session_timeout'; $exitCode = 4; break
  }
  if (-not $idleFlagged -and ($nowMs - $lastLineMs) -gt ($IdleDiagnosticSec * 1000)) {
    Row 'diagnostic' $sessionId '' "no new log line for ${IdleDiagnosticSec}s (diagnostic only, run continues)"
    $idleFlagged = $true
  }

  # ---- 2. interval sampling inside the window ------------------------------
  if ($sessionSeen -and $nowMs -ge $nextDueMs) {
    Take 'window' $sessionId | Out-Null
    $nextDueMs = $sw.ElapsedMilliseconds + ($IntervalSec * 1000)
  }

  # ---- 3. read ------------------------------------------------------------
  $line = $sr.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 100; continue }
  $lastLineMs = $sw.ElapsedMilliseconds
  $idleFlagged = $false

  if ($line -match 'GC_P2_GATE session_start id=(p2gate-\d+)') {
    $id = $Matches[1]
    $startCount++
    if ($startCount -eq 1) {
      $sessionId = $id
      $sessionSeen = $true
      $sessionDeadlineMs = $sw.ElapsedMilliseconds + ($SessionTimeoutSec * 1000)
      Write-Output ("PSS_SAMPLER: SESSION_ID = " + $sessionId)
      $b = Take 'baseline' $sessionId
      $baselineOk = $b.valid
      Write-Output ("PSS_SAMPLER: window opened, baseline pss_kib='" + $b.value + "' valid=" + $b.valid)
      if (-not $baselineOk) { Row 'diagnostic' $sessionId '' 'RUN INCOMPLETE: baseline sample invalid' }
      $nextDueMs = $sw.ElapsedMilliseconds + ($IntervalSec * 1000)
    } else {
      Row 'contamination' $id '' "RUN INCOMPLETE: second session_start observed ($id), capture contaminated"
      $contaminated = $true
      $outcome = 'contaminated_second_session_start'; $exitCode = 5; break
    }
    continue
  }

  if ($sessionSeen) {
    $ids = [regex]::Matches($line, 'p2gate-\d+') | ForEach-Object { $_.Value }
    $foreign = @($ids | Where-Object { $_ -ne $sessionId })
    if ($foreign.Count -gt 0) {
      Row 'contamination' ($foreign -join '|') '' "RUN INCOMPLETE: foreign session id in the window"
      $contaminated = $true
      $outcome = 'contaminated_foreign_id'; $exitCode = 5; break
    }

    if ($line -match 'GC_P2_GATE session_released' -and $line -match [regex]::Escape("id=$sessionId")) {
      $f = Take 'final' $sessionId
      $finalOk = $f.valid
      Write-Output ("PSS_SAMPLER: window closed, final pss_kib='" + $f.value + "' valid=" + $f.valid)
      if (-not $finalOk) { Row 'diagnostic' $sessionId '' 'RUN INCOMPLETE: final sample invalid' }
      $outcome = 'closed'; break
    }
  }
}

$sr.Close(); $fs.Close()

if ($exitCode -eq 0) {
  if (-not $baselineOk) { $outcome = 'baseline_invalid'; $exitCode = 6 }
  elseif (-not $finalOk) { $outcome = 'final_invalid'; $exitCode = 6 }
}
$complete = ($exitCode -eq 0)
Row 'summary' $sessionId '' ("outcome=$outcome intermediate_errors=$errCount contaminated=$contaminated session_starts=$startCount")
Write-Output ("PSS_SAMPLER: SESSION_ID=" + $sessionId + " SESSION_STARTS=" + $startCount +
              " INTERMEDIATE_ERRORS=" + $errCount + " CONTAMINATED=" + $contaminated)
Write-Output ("PSS_SAMPLER: RESULT=" + $(if ($complete) { 'COMPLETE' } else { 'INCOMPLETE' }) + " cause=" + $outcome)
Write-Output "PSS_SAMPLER: NOTE - PSS variation is an observation, never evidence of a leak."
exit $exitCode
