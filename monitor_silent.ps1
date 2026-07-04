Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"

$log = "monitor_log.txt"

# Rotate log if > 500 KB
if (Test-Path $log) {
    if ((Get-Item $log).Length -gt 512000) {
        Copy-Item $log "monitor_log_prev.txt" -Force
        Remove-Item $log -Force
    }
}

$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"" | Add-Content $log
"==========================================" | Add-Content $log
"$ts - Monitor starting" | Add-Content $log
"==========================================" | Add-Content $log

& node scripts/monitor_v8.js 2>&1 | Add-Content $log

if ($LASTEXITCODE -eq 0) {
    "$ts - Monitor completed OK" | Add-Content $log
} else {
    "$ts - Monitor FAILED (exit code $LASTEXITCODE)" | Add-Content $log
}
