# build_keeper_env.ps1 — rebuild the VPS keeper .env from the Windows .env
# Reads values locally, writes C:\keeper_env_upload.txt. NEVER prints secret values.
# Usage:  powershell -ExecutionPolicy Bypass -File .\build_keeper_env.ps1

$src = "C:\CryptoNite-Smart-Contracts\CryptoNova\.env"
# NOTE: C:\ root is admin-protected — write to the user profile instead.
$out = "$env:USERPROFILE\keeper_env_upload.txt"

if (-not (Test-Path $src)) { Write-Host "ERROR: $src not found"; exit 1 }

# Parse the Windows .env into a lookup table
$env_map = @{}
foreach ($line in Get-Content $src) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') {
        $env_map[$matches[1]] = $matches[2].Trim()
    }
}

function Get-Val($name) {
    if ($env_map.ContainsKey($name) -and $env_map[$name] -ne "") {
        $v = $env_map[$name]
        # ethers v6 requires the 0x prefix on private keys — normalise bare 64-hex.
        if ($name -like "*PRIVATE_KEY*" -and $v -match '^[0-9a-fA-F]{64}$') { $v = "0x$v" }
        return $v
    }
    return $null
}

# name -> source. $null source = fixed value or manual fill.
$lines = @()
$missing = @()

function Add-FromEnv($key, $srcKey) {
    $v = Get-Val $srcKey
    if ($null -eq $v) { $script:missing += $key; $script:lines += "$key=FILL_IN_MANUALLY" }
    else { $script:lines += "$key=$v" }
}

Add-FromEnv "BASE_SEPOLIA_RPC_URL" "BASE_SEPOLIA_RPC_URL"
$lines += "ADDRESSES_FILE=deployed_addresses_v8_44.json"
$lines += "KEEPER_PRIVATE_KEY=FILL_IN_MANUALLY"          # VPS-only, not in Windows .env
Add-FromEnv "DISTRIBUTOR_PRIVATE_KEY" "DISTRIBUTOR_PRIVATE_KEY"
Add-FromEnv "TELEGRAM_BOT_TOKEN" "TELEGRAM_BOT_TOKEN"
$lines += "TELEGRAM_CHAT_ID=-1003929944148"
$lines += "ONRAMP_POOL_ADDRESS=0x387055f332C5558a2439D76FfFB4a5A3EbABc4EA"
$lines += "TELEGRAM_ANNOUNCE_CHANNEL_ID=-1003833364004"
Add-FromEnv "FILL_MNEMONIC" "FILL_MNEMONIC"
Add-FromEnv "DEPLOYER_PRIVATE_KEY" "DEPLOYER_PRIVATE_KEY"
$lines += "PARKED_WARN=200"
$lines += "GITHUB_TOKEN=FILL_IN_MANUALLY"                # regenerate at GitHub
Add-FromEnv "ROUND_ROBIN" "ROUND_ROBIN"

Set-Content -Path $out -Value $lines -Encoding ASCII

Write-Host ""
Write-Host "Wrote $out"
Write-Host "Lines written: $($lines.Count)"
Write-Host ""
Write-Host "Copied from Windows .env (values NOT shown):"
foreach ($l in $lines) {
    $k = ($l -split '=')[0]
    $v = $l.Substring($k.Length + 1)
    if ($v -eq "FILL_IN_MANUALLY") { Write-Host ("  [ ] {0}  <-- YOU MUST FILL THIS IN" -f $k) }
    else { Write-Host ("  [x] {0}  ({1} chars)" -f $k, $v.Length) }
}
Write-Host ""
Write-Host "NEXT: open $out in Notepad, replace the FILL_IN_MANUALLY values, save."
Write-Host "      Then scp it up, and DELETE the local copy."
