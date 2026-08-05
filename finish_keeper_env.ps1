# finish_keeper_env.ps1 - completes C:\Users\<you>\keeper_env_upload.txt
#   * copies DEPLOYER_PRIVATE_KEY -> KEEPER_PRIVATE_KEY (same wallet owns V8.44)
#   * reports which lines are still placeholders, WITHOUT printing any value
# ASCII ONLY - no em-dashes or smart quotes (they break PowerShell parsing).
# Usage: powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\finish_keeper_env.ps1

$f = "$env:USERPROFILE\keeper_env_upload.txt"
if (-not (Test-Path $f)) { Write-Host "ERROR: $f not found. Run build_keeper_env.ps1 first."; exit 1 }

$lines = Get-Content $f
$map = @{}
foreach ($l in $lines) {
    if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $map[$matches[1]] = $matches[2] }
}

$changed = $false
if ($map.ContainsKey("DEPLOYER_PRIVATE_KEY") -and $map["DEPLOYER_PRIVATE_KEY"] -notmatch "FILL_IN_MANUALLY") {
    if (-not $map.ContainsKey("KEEPER_PRIVATE_KEY") -or $map["KEEPER_PRIVATE_KEY"] -match "FILL_IN_MANUALLY") {
        $dep = $map["DEPLOYER_PRIVATE_KEY"]
        $lines = $lines | ForEach-Object {
            if ($_ -match '^\s*KEEPER_PRIVATE_KEY\s*=') { "KEEPER_PRIVATE_KEY=$dep" } else { $_ }
        }
        $changed = $true
    }
}
if ($changed) {
    Set-Content -Path $f -Value $lines -Encoding ASCII
    Write-Host "Filled KEEPER_PRIVATE_KEY from DEPLOYER_PRIVATE_KEY."
} else {
    Write-Host "KEEPER_PRIVATE_KEY already set (or deployer key missing). No change."
}

# Normalise private keys: ethers v6 requires the 0x prefix on a 64-hex key.
$fixed = 0
$lines = Get-Content $f | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]*PRIVATE_KEY)\s*=\s*([0-9a-fA-F]{64})\s*$') {
        $script:fixed++
        "$($matches[1])=0x$($matches[2])"
    } else { $_ }
}
if ($fixed -gt 0) {
    Set-Content -Path $f -Value $lines -Encoding ASCII
    Write-Host "Added missing 0x prefix to $fixed private key(s)."
}

Write-Host ""
Write-Host "STATUS (values never shown):"
$todo = 0
foreach ($l in (Get-Content $f)) {
    if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') {
        $k = $matches[1]
        $v = $matches[2]
        if ($v -match "FILL_IN_MANUALLY|PASTE_FROM|REGENERATE" -or $v -eq "") {
            Write-Host ("  [ ] {0}  <-- STILL NEEDS A VALUE" -f $k)
            $todo++
        } else {
            Write-Host ("  [x] {0}  ({1} chars)" -f $k, $v.Length)
        }
    }
}
Write-Host ""
if ($todo -eq 0) {
    Write-Host "READY TO UPLOAD."
} else {
    Write-Host "$todo field(s) still need values. Paste them in Notepad, save, then rerun this script."
}
