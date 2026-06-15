param(
    [int]$StartOffset = 0,
    [int]$IntervalMin = 5,
    [int]$MaxMembers = 9999
)

Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"

$offset = $StartOffset
$count = 0
$delay = $IntervalMin * 60

Write-Host "Drip Fill started — 1 member every $IntervalMin min, HDR_OFFSET=$offset" -ForegroundColor Cyan

while ($count -lt $MaxMembers) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] Registering member $($count+1) at HDR_OFFSET=$offset" -ForegroundColor Green

    $env:COUNT = "1"
    $env:HDR_OFFSET = "$offset"
    npx hardhat run scripts/bigfill_v8.js --network baseSepolia

    if ($LASTEXITCODE -eq 0) {
        $offset++
        $count++
    } else {
        Write-Host "Run failed — retrying same offset in 30s" -ForegroundColor Yellow
        Start-Sleep -Seconds 30
        continue
    }

    if ($count -lt $MaxMembers) {
        $next = (Get-Date).AddSeconds($delay).ToString("HH:mm:ss")
        Write-Host "Next at $next" -ForegroundColor DarkCyan
        Start-Sleep -Seconds $delay
    }
}

Write-Host "Done — $count members added. Resume with -StartOffset $offset" -ForegroundColor Green
