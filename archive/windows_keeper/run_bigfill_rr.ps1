# run_bigfill_rr.ps1 - bigfill with the leader round-robin referrer list.
# ROUND_ROBIN is set for THIS SESSION ONLY, so the VPS stress keeper is unaffected.
# Unregistered addresses are skipped automatically (V8.44 change); rotation runs
# across whoever is registered at start time.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1
#   ...with options:
#   powershell -ExecutionPolicy Bypass -File ...\run_bigfill_rr.ps1 -Count 127 -Offset 0
#
# To change the roster later: edit the list below (keep them comma-joined).

param(
    [int]$Count  = 127,
    [int]$Offset = 0,
    [double]$SelfRescueRate = 1.0,   # 1.0 = rescue every parked wallet
    [double]$UpgradeRate    = 0.75   # fraction of eligible wallets that manual-upgrade
)

# ---------------------------------------------------------------------------
# OWNER RULE (2026-07-25): bigfill does FOUR things and nothing else --
#   1. register  2. self rescue  3. manual upgrade  4. repeat
# Everything else in bigfill_v8.js is switched OFF here on purpose:
#   CNOVA_BUY_RATE=0   - no CNOVA purchases (default would be 25% of wallets)
#   CNOVA_SELL_RATE=0  - no CNOVA sells/burns (default would be 15%)
#   BURN_SIMULATE=false- no earlyUnlockAll() burn sweep (default is ON)
# Do NOT remove these three lines. See BIGFILL_RULES.md.
# ---------------------------------------------------------------------------
$env:CNOVA_BUY_RATE  = "0"
$env:CNOVA_SELL_RATE = "0"
$env:BURN_SIMULATE   = "false"
$env:SELF_RESCUE_RATE = "$SelfRescueRate"
$env:UPGRADE_RATE     = "$UpgradeRate"

# Owner list trimmed 39 -> 13 on 2026-07-26. Kept in sync with the VPS stress
# keeper's ROUND_ROBIN in /root/keeper/.env — if you change one, change both.
$leaders = @(
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102"
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB"
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2"
  "0xa2Dfd8c3b99b4395550558acf6cFFe79017b702C"
  "0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2"
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e"
  "0x141a5B0d42B0ba2AF1BE4eC771B96Db460896a50"
  "0xa2f6FBfDf7bfB5601c3f3C6Ef3FbF6CEFf4044Ed"
  "0x09D160F2f966d4dF8f83b72610794CaC945C8D8D"
  "0x4634327b78Fb0Ec7d0ba6d8D72Ff2035388e79f0"
  "0x1C56C63A7c501aCbcCd32cdab0485B0a8eC906b7"
  "0x7a66F06674e7A0a46e026fd2f4762dbD15987AA9"
  "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435"   # W1 / accountOne
)

$env:ROUND_ROBIN = ($leaders -join ",")
$env:COUNT       = "$Count"
$env:HDR_OFFSET  = "$Offset"

Write-Host ""
Write-Host "BIGFILL - register / self-rescue / manual-upgrade ONLY"
Write-Host ("  leaders supplied : {0}" -f $leaders.Count)
Write-Host ("  COUNT            : {0}" -f $Count)
Write-Host ("  HDR_OFFSET       : {0}" -f $Offset)
Write-Host ("  self-rescue rate : {0}" -f $SelfRescueRate)
Write-Host ("  upgrade rate     : {0}" -f $UpgradeRate)
Write-Host "  CNOVA buy/sell   : DISABLED"
Write-Host "  burn sweep       : DISABLED"
Write-Host "  (unregistered leaders are skipped automatically)"
Write-Host ""

Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
