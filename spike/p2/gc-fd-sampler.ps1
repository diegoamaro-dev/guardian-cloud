# P2 LONG ROTATION - FD sampling, bound to real events, in ONE persistent process.
#
# The previous run invalidated 56 of 74 recovery samples: Start-Job spawned a
# whole PowerShell process per take (~2.4 s), so a take scheduled at t+1 s ran at
# a median of t+3.245 s while the next rotation was requested at t+3.0 s.
# This process performs the adb call INLINE and SEQUENTIALLY. Measured cost of
# the call itself: 233-295 ms over 12 takes, against a 2000 ms budget.
#
# TERMINATION. Two ABSOLUTE monotonic deadlines, checked at the top of every
# iteration including when lines are still pending. Log activity never resets
# them: a session that keeps logging but never emits session_released must still
# terminate. The idle timeout is kept as a SECONDARY diagnostic only.
#
# VALIDITY. A sample is valid only when its value is numeric and its error is
# empty. An invalid readiness, baseline or final ends the run non-zero. Errors on
# intermediate samples are counted and reported, never hidden under "complete".
#
# EXIT CODES
#   0 complete   2 readiness invalid   3 pre-start timeout   4 session timeout
#   5 contaminated (foreign session)   6 baseline/final invalid   7 pid unresolved

param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$Adb = "D:\Programs\Android\Sdk\platform-tools\adb.exe",
  [string]$Pkg = "com.guardiancloud.app",
  [int]$TakeAsec = 1,
  [int]$TakeBsec = 5,
  [int]$PreStartTimeoutSec = 900,
  [int]$SessionTimeoutSec  = 1200,
  [int]$IdleDiagnosticSec  = 300,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$log  = Join-Path $Root 'logcat.log'
$csv  = Join-Path $Root 'fd_samples.csv'
$pidF = Join-Path $Root 'fd_sampler.pid'
Set-Content -Path $pidF -Value $PID -Encoding ascii

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$freq = [System.Diagnostics.Stopwatch]::Frequency
function MonoNs { return [long](($sw.ElapsedTicks / $freq) * 1e9) }

"phase,index,take,mono_ns,utc_iso,session_id,fd_count,error" | Out-File -FilePath $csv -Encoding ascii
function Row([string]$phase, [string]$index, [string]$take, [string]$sid, [string]$val, [string]$err) {
  "$phase,$index,$take,$(MonoNs),$((Get-Date).ToUniversalTime().ToString('o')),$sid,$val,$err" |
    Out-File -FilePath $csv -Encoding ascii -Append
}

# The pid is resolved by THIS process, never inherited from a stale file.
$pidOut = & $Adb shell pidof $Pkg 2>&1
$pidCode = $LASTEXITCODE
$appPid = ($pidOut | Out-String).Trim()
if ($pidCode -ne 0 -or $appPid -notmatch '^\d+$') {
  Row 'readiness' '' '' '' '' "pid unresolved exit=$pidCode value='$appPid'"
  Write-Output "FD_SAMPLER: RESULT=INCOMPLETE cause=pid_unresolved"
  exit 7
}
Write-Output ("FD_SAMPLER: APP_PID = " + $appPid)

$errCount = 0
function Take([string]$phase, [string]$index, [string]$take, [string]$sid) {
  $val = ''; $err = ''
  try {
    $out  = & $Adb shell "run-as $Pkg ls /proc/$appPid/fd" 2>&1
    $code = $LASTEXITCODE
    $arr  = @($out)
    if ($code -ne 0) { $err = "adb exit $code" }
    elseif ($arr.Count -eq 0) { $err = "empty output" }
    elseif (($arr | Out-String) -match 'run-as:|No such file|Permission denied|error:|Exception') { $err = "error-shaped output" }
    else { $val = $arr.Count }
  } catch { $err = ($_.Exception.Message -replace ',', ';') }
  Row $phase $index $take $sid $val $err
  $valid = ($err -eq '' -and $val -match '^\d+$')
  if (-not $valid) { $script:errCount++ }
  return @{ value = $val; error = $err; valid = $valid }
}

# READINESS. Proves the sampler works BEFORE anything is pressed, and is tagged
# so it can never be mistaken for a session sample.
$r = Take 'readiness' '' '' ''
Write-Output ("FD_SAMPLER: readiness fd_count='" + $r.value + "' error='" + $r.error + "' valid=" + $r.valid)
if (-not $r.valid) {
  Write-Output "FD_SAMPLER: RESULT=INCOMPLETE cause=readiness_invalid"
  exit 2
}
if ($DryRun) { Write-Output "FD_SAMPLER: RESULT=DRY_OK"; exit 0 }

# ---- absolute deadlines, fixed at start, never moved by log activity ---------
$preStartDeadlineMs = $sw.ElapsedMilliseconds + ($PreStartTimeoutSec * 1000)
$sessionDeadlineMs  = [long]::MaxValue
Write-Output ("FD_SAMPLER: PRE_START_TIMEOUT=" + $PreStartTimeoutSec + "s SESSION_TIMEOUT=" + $SessionTimeoutSec + "s")

while (-not (Test-Path $log)) {
  if ($sw.ElapsedMilliseconds -gt $preStartDeadlineMs) {
    Row 'timeout' '' '' '' '' "RUN INCOMPLETE: pre-start timeout ${PreStartTimeoutSec}s, logcat file never appeared"
    Write-Output "FD_SAMPLER: RESULT=INCOMPLETE cause=pre_start_timeout"
    exit 3
  }
  Start-Sleep -Milliseconds 200
}
$fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
$sr = New-Object System.IO.StreamReader($fs)

$pending      = New-Object System.Collections.ArrayList
$sessionId    = ''
$sessionSeen  = $false
$startCount   = 0
$contaminated = $false
$baselineOk   = $false
$finalOk      = $false
$lastLineMs   = $sw.ElapsedMilliseconds
$idleFlagged  = $false
$outcome      = ''
$exitCode     = 0

while ($true) {

  # ---- 1. ABSOLUTE DEADLINES FIRST, before any read ------------------------
  $nowMs = $sw.ElapsedMilliseconds
  if (-not $sessionSeen -and $nowMs -gt $preStartDeadlineMs) {
    Row 'timeout' '' '' '' '' "RUN INCOMPLETE: pre-start timeout ${PreStartTimeoutSec}s, session_start never observed"
    $outcome = 'pre_start_timeout'; $exitCode = 3; break
  }
  if ($sessionSeen -and $nowMs -gt $sessionDeadlineMs) {
    Row 'timeout' '' '' $sessionId '' "RUN INCOMPLETE: session timeout ${SessionTimeoutSec}s, session_released never observed"
    $outcome = 'session_timeout'; $exitCode = 4; break
  }
  # Secondary diagnostic only. It never terminates the run on its own.
  if (-not $idleFlagged -and ($nowMs - $lastLineMs) -gt ($IdleDiagnosticSec * 1000)) {
    Row 'diagnostic' '' '' $sessionId '' "no new log line for ${IdleDiagnosticSec}s (diagnostic only, run continues)"
    $idleFlagged = $true
  }

  # ---- 2. due takes --------------------------------------------------------
  $fire = @($pending | Where-Object { $_.dueMs -le $nowMs })
  foreach ($t in $fire) { Take 'window' $t.index $t.take $sessionId | Out-Null; [void]$pending.Remove($t) }

  # ---- 3. read ------------------------------------------------------------
  $line = $sr.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 50; continue }
  $lastLineMs = $sw.ElapsedMilliseconds
  $idleFlagged = $false

  if ($line -match 'GC_P2_GATE session_start id=(p2gate-\d+)') {
    $id = $Matches[1]
    $startCount++
    if ($startCount -eq 1) {
      $sessionId = $id
      $sessionSeen = $true
      $sessionDeadlineMs = $sw.ElapsedMilliseconds + ($SessionTimeoutSec * 1000)
      Write-Output ("FD_SAMPLER: SESSION_ID = " + $sessionId)
      # BASELINE on the real activation. The first harness_rotation_requested
      # arrives ~3 s later, so this is the sample that precedes it.
      $b = Take 'baseline' '' '' $sessionId
      $baselineOk = $b.valid
      Write-Output ("FD_SAMPLER: baseline fd_count='" + $b.value + "' valid=" + $b.valid)
      if (-not $baselineOk) { Row 'diagnostic' '' '' $sessionId '' 'RUN INCOMPLETE: baseline sample invalid' }
    } else {
      Row 'contamination' '' '' $id '' "RUN INCOMPLETE: second session_start observed ($id), capture contaminated"
      $contaminated = $true
      $outcome = 'contaminated_second_session_start'; $exitCode = 5; break
    }
    continue
  }

  if ($sessionSeen) {
    # Any line carrying a DIFFERENT p2gate id means two sessions overlapped.
    $ids = [regex]::Matches($line, 'p2gate-\d+') | ForEach-Object { $_.Value }
    $foreign = @($ids | Where-Object { $_ -ne $sessionId })
    if ($foreign.Count -gt 0) {
      Row 'contamination' '' '' ($foreign -join '|') '' "RUN INCOMPLETE: foreign session id in the window"
      $contaminated = $true
      $outcome = 'contaminated_foreign_id'; $exitCode = 5; break
    }

    if ($line -match 'GC_P2_GATE segment_stable index=(\d+)') {
      $k = $Matches[1]
      $now2 = $sw.ElapsedMilliseconds
      [void]$pending.Add(@{ dueMs = $now2 + ($TakeAsec * 1000); index = $k; take = 'a' })
      [void]$pending.Add(@{ dueMs = $now2 + ($TakeBsec * 1000); index = $k; take = 'b' })
    }

    if ($line -match 'GC_P2_GATE session_released' -and $line -match [regex]::Escape("id=$sessionId")) {
      $f = Take 'final' '' '' $sessionId
      $finalOk = $f.valid
      Write-Output ("FD_SAMPLER: final fd_count='" + $f.value + "' valid=" + $f.valid)
      if (-not $finalOk) { Row 'diagnostic' '' '' $sessionId '' 'RUN INCOMPLETE: final sample invalid' }
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
Row 'summary' '' '' $sessionId '' ("outcome=$outcome intermediate_errors=$errCount contaminated=$contaminated session_starts=$startCount")
Write-Output ("FD_SAMPLER: SESSION_ID=" + $sessionId + " SESSION_STARTS=" + $startCount +
              " INTERMEDIATE_ERRORS=" + $errCount + " CONTAMINATED=" + $contaminated)
Write-Output ("FD_SAMPLER: RESULT=" + $(if ($complete) { 'COMPLETE' } else { 'INCOMPLETE' }) + " cause=" + $outcome)
exit $exitCode
