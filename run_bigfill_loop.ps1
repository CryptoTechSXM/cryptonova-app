# run_bigfill_loop.ps1 - keep bigfill ticking over unattended
#
# Written 2026-08-19 (session 9). Owner wanted bigfill running in the background while other
# work continues. This wraps run_bigfill_rr.ps1 in a loop that advances the wallet offset,
# waits between runs, logs every run to its own file, and STOPS ITSELF if the chain goes bad.
#
# WHY THE STOP CONDITION MATTERS MORE THAN THE LOOP:
# On 2026-08-19 Base Sepolia dropped state reads twice. A run during the second episode
# logged HH110 on 31 consecutive wallets and still printed a tidy summary. An unattended loop
# on a flapping chain does that over and over, burns test funds, and leaves a pile of logs
# that all look like results. So: consecutive failures abort the whole loop, loudly.
#
# ONE REGISTRATION PER RUN is the owner rule (2026-08-19) - the fund is fed by the SWEEPS,
# which cover ALL historical wallets regardless of -Count. The offset advances by 1 each
# iteration so each run brings exactly one new member in.
#
#   cd C:\CryptoNite-Smart-Contracts\CryptoNova
#   powershell -ExecutionPolicy Bypass -File .\run_bigfill_loop.ps1 -StartOffset 289
#
# Stop it any time with Ctrl+C - it finishes nothing mid-transaction, each run is atomic.

param(
    [int]$StartOffset = 289,      # HDR wallet index for the first run (see the NEXT RUN HINT)
    [int]$Runs        = 0,        # 0 = run until stopped
    [int]$GapMinutes  = 20,       # wait between runs. Do not set this near zero.
    [int]$EvictMax    = 3,        # cap reinstatements per run
    [int]$AbortAfter  = 2         # consecutive failed runs before the loop gives up
)

$ErrorActionPreference = 'Continue'

# ---- console encoding -------------------------------------------------------------
# node writes UTF-8. Windows PowerShell 5.1 decodes a child process's output with the
# ANSI code page unless told otherwise, which is what turned dashes into mojibake in the
# run logs. bigfill_v8.js is now ASCII-only on every line that can reach the console, so
# this is the second belt rather than the first - it still matters for hardhat and ethers
# messages, whose text we do not control.
# NOTE: keep this file pure ASCII. It has no BOM, so a non-ASCII byte in executable code
# is read as ANSI and can break quoting outright (cost this project a run on 2026-08-19).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

$repo    = "C:\CryptoNite-Smart-Contracts\CryptoNova"
$logDir  = Join-Path $repo "logs\bigfill_loop"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$offset   = $StartOffset
$i        = 0
$failRun  = 0
$okRun    = 0

Write-Host ""
Write-Host "BIGFILL LOOP"
Write-Host ("  start offset : {0}" -f $StartOffset)
Write-Host ("  runs         : {0}" -f $(if ($Runs -eq 0) { "until stopped (Ctrl+C)" } else { $Runs }))
Write-Host ("  gap          : {0} min" -f $GapMinutes)
Write-Host ("  abort after  : {0} consecutive failures" -f $AbortAfter)
Write-Host ("  logs         : {0}" -f $logDir)
Write-Host ""

while ($true) {
    if ($Runs -gt 0 -and $i -ge $Runs) { Write-Host "`nReached $Runs runs. Done."; break }
    $i++
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $log   = Join-Path $logDir ("run_{0}_offset{1}.log" -f $stamp, $offset)

    Write-Host ("[{0}] run {1} - offset {2} -> {3}" -f (Get-Date -Format "HH:mm:ss"), $i, $offset, $log)

    Set-Location $repo
    & powershell -ExecutionPolicy Bypass -File (Join-Path $repo "run_bigfill_rr.ps1") `
        -Offset $offset -EvictReentryMax $EvictMax *>&1 | Tee-Object -FilePath $log

    # A run is judged on its LOG, not on the exit code - bigfill swallows a lot internally and
    # can exit 0 while the chain refused most of the sweep. The two markers that matter:
    $text        = Get-Content $log -Raw -ErrorAction SilentlyContinue
    $fatal       = $text -match "fatal error|ABORTING THE SWEEP"
    $networkWall = $text -match "NETWORK FAILURES"

    if ($fatal -or $networkWall) {
        $failRun++
        Write-Host ("  ** run {0} looks BAD (fatal or network failures) - consecutive: {1}/{2}" -f $i, $failRun, $AbortAfter) -ForegroundColor Yellow
        if ($failRun -ge $AbortAfter) {
            Write-Host ""
            Write-Host "  STOPPING THE LOOP - $failRun consecutive bad runs." -ForegroundColor Red
            Write-Host "  The chain is probably not answering. Check with:"
            Write-Host "     cd C:\CryptoNova-Testnet-App; node watch_base_sepolia.mjs"
            Write-Host "  Runs taken during an outage are FLOORS, not measurements - do not read their"
            Write-Host "  totals as member behaviour. Restart the loop after a clean streak."
            Write-Host ""
            break
        }
        # do NOT advance the offset on a bad run - that wallet never really got its chance
    } else {
        $okRun++; $failRun = 0; $offset++
    }

    if ($Runs -gt 0 -and $i -ge $Runs) { Write-Host "`nReached $Runs runs. Done."; break }
    Write-Host ("  sleeping {0} min... (Ctrl+C to stop)" -f $GapMinutes)
    Start-Sleep -Seconds ($GapMinutes * 60)
}

Write-Host ""
Write-Host ("LOOP ENDED - {0} good run(s), {1} consecutive bad at the end. Next offset: {2}" -f $okRun, $failRun, $offset)
Write-Host ("Logs: {0}" -f $logDir)
Write-Host ""
