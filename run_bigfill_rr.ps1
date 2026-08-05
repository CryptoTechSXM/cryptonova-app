# run_bigfill_rr.ps1 - bigfill with the leader round-robin referrer list.
# V8.47 rebuild (2026-08-05): restored from archive/windows_keeper (July cleanup
# had swept it), roster refreshed to the full 41-leader list (same set as the
# VPS SPONSORS/ROUND_ROBIN - if you change one, change both), and SLOW-DRIP
# pacing added: default 1 registration every 5 minutes (BatchSize/BatchDelay).
# ROUND_ROBIN is set for THIS SESSION ONLY, so the VPS keepers are unaffected.
# Unregistered leaders are skipped automatically; rotation fixed at run start.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1 -Count 127 -Offset 0
#   Burst mode (old behavior): add -BatchSize 5 -BatchDelay 8

param(
    [int]$Count  = 127,
    [int]$Offset = 0,
    [double]$SelfRescueRate = 1.0,   # 1.0 = every parked wallet self-rescues
    [double]$UpgradeRate    = 1.0,   # 1.0 = upgrade whenever eligible
    [int]$BatchSize  = 1,            # wallets per batch
    [int]$BatchDelay = 300           # seconds between batches (300 = 5 min drip)
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
$env:CNOVA_BUY_RATE   = "0"
$env:CNOVA_SELL_RATE  = "0"
$env:BURN_SIMULATE    = "false"
$env:SELF_RESCUE_RATE = "$SelfRescueRate"
$env:UPGRADE_RATE     = "$UpgradeRate"
$env:BATCH_SIZE       = "$BatchSize"
$env:BATCH_DELAY      = "$BatchDelay"

# Full 41-leader roster (2026-08-05). Identical to VPS SPONSORS/ROUND_ROBIN.
$leaders = @(
  "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435"   # W1 / accountOne
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102"
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB"
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2"
  "0xaAda7eF0bbF0A08189a39f6d471A1728d3873c15"
  "0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2"
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e"
  "0x141a5B0d42B0ba2AF1BE4eC771B96Db460896a50"
  "0xd56e7dF24D182Bc64Bd3Caa322951912A6cEf54c"
  "0xfD01b470E1c4035E672B2b96d23e6CCa1c748DD7"
  "0x26388a81eb9448DF02144cc765Bb448444e61f9B"
  "0x391ab9edC83960e6ec468bDb7e6abE5858656F68"
  "0x305029890b8Bc7806CaF641B0cf8FC8b3e0ec137"
  "0x7974967be8d32965Ac320135cF98c51F4b16A610"
  "0x64618fa6f364aD88B929F554015DA2BcC2F7F3ab"
  "0xb231B42397B717D11176D06dDE0078589C6200f4"
  "0xacb1Afd6a6B525daE853D7E7C351917b438C4EeB"
  "0xF28D6416Bdf5dC272B08BCA98761a0b3b94c0a5E"
  "0xF6193F6Cd1133e725B981DFb47ff4373fCD9131F"
  "0xF1AD812938B7a57Bb1B5E9E34C0ACb9B12Bdf8d3"
  "0xdE5fe7cBDc941CC83C25780C9c72FB4F6274A4A3"
  "0xD887d66b7bA50141e12F7C136B8D872FCe0571ae"
  "0xc731b6eA3057B66bE73512cFE2db4eF1D290dCEa"
  "0x536685F063927d3B45394270A0aa785bB5B588f0"
  "0xD6FbdF7Ade38c8066c8798aECd0dB94DcD5CdCfe"
  "0xf675bA5425e23ed1DEB2a481C7e499a956e237dd"
  "0xe8Ad7bbA862002414566a3e28f664E8BeA7F5ad5"
  "0x84A4D33A4EF25e5dE8dCA960aB7AF592351E4650"
  "0x7CAFC198D7f59c43fCAec0d177Ca8610fc4b14BD"
  "0x473C629A054eE4CE4d962e2C6092Bd215Ef02Fc6"
  "0x0043FfD9986D64D3d38A291E6C8D16Bff089F35A"
  "0x5d52218FF7Fe7678F87252A0bDA33c122B1B3191"
  "0x8E2d895624Bb82dc7148f5b4b576159616C8aAcC"
  "0x0AF857609673Ad0C16403264b75FF8adA0244e93"
  "0x1acc02252BfB5c7434771Bf848F6D77d11F60949"
  "0x558E7848BD190C32251f7610c14329C594E5b0A0"
  "0xa2f6FBfDf7bfB5601c3f3C6Ef3FbF6CEFf4044Ed"
  "0x09D160F2f966d4dF8f83b72610794CaC945C8D8D"
  "0x4634327b78Fb0Ec7d0ba6d8D72Ff2035388e79f0"
  "0x1C56C63A7c501aCbcCd32cdab0485B0a8eC906b7"
  "0x7a66F06674e7A0a46e026fd2f4762dbD15987AA9"
)

$env:ROUND_ROBIN = ($leaders -join ",")
$env:COUNT       = "$Count"
$env:HDR_OFFSET  = "$Offset"

Write-Host ""
Write-Host "BIGFILL - register / self-rescue / manual-upgrade ONLY"
Write-Host ("  leaders supplied : {0}" -f $leaders.Count)
Write-Host ("  COUNT            : {0}" -f $Count)
Write-Host ("  HDR_OFFSET       : {0}" -f $Offset)
Write-Host ("  batch size/delay : {0} wallet(s) every {1}s" -f $BatchSize, $BatchDelay)
Write-Host ("  self-rescue rate : {0}" -f $SelfRescueRate)
Write-Host ("  upgrade rate     : {0}" -f $UpgradeRate)
Write-Host "  CNOVA buy/sell   : DISABLED"
Write-Host "  burn sweep       : DISABLED"
Write-Host "  (unregistered leaders are skipped automatically)"
Write-Host ""

Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
