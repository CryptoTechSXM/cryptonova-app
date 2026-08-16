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
#   Against a TEST deployment: add -AddressesFile deployed_addresses_v8_49.json

param(
    [int]$Count  = 127,
    [int]$Offset = 0,
    [double]$SelfRescueRate = 1.0,   # 1.0 = every parked wallet self-rescues
    [double]$UpgradeRate    = 1.0,   # 1.0 = upgrade whenever eligible
    [int]$BatchSize  = 1,            # wallets per batch
    [int]$BatchDelay = 300,          # seconds between batches (300 = 5 min drip)
    [string]$AddressesFile = "",     # "" = inherit .env; see the block below
    [int]$ScanFrom = -1              # -1 = leave bigfill's default; see COHORT BLEED below
)

# ---------------------------------------------------------------------------
# COHORT BLEED — -Offset DOES NOT ISOLATE A COHORT  (found 2026-08-16)
#
# bigfill_v8.js:1261-1269 builds the rescue/upgrade population as
#     historicalCount = max(0, HDR_OFFSET - SCAN_FROM)
#     allWallets      = makeWallets(historicalCount, SCAN_FROM) + newWallets
# and SCAN_FROM DEFAULTS TO 0. So a run at -Offset 127 also sweeps wallets
# 0..126 for rescue and upgrade, and applies ITS OWN SELF_RESCUE_RATE to them.
#
# For the V8.49 split cohort that is fatal: cohort B (-SelfRescueRate 0) would
# reach into cohort A's wallets and stop them self-rescuing, so the control
# would be driven by the subject. -Offset separates who gets REGISTERED, not
# who gets SWEPT. The bleed is one-directional (cohort A at offset 0 has
# historicalCount 0 and never reaches B), which is worse, not better: it
# produces a plausible confusing result instead of an obvious failure.
#
# Default stays bigfill's own (0) so ordinary runs keep sweeping everything,
# which is how the system is normally kept moving. But a run with a non-default
# self-rescue rate is a COHORT, and a cohort must not touch wallets outside its
# own range — so we pin SCAN_FROM to its offset and say so loudly.
# ---------------------------------------------------------------------------
if ($SelfRescueRate -ne 1.0 -and $ScanFrom -lt 0) {
    $ScanFrom = $Offset
    Write-Host ""
    Write-Host "  NOTE: -ScanFrom pinned to $Offset automatically." -ForegroundColor Yellow
    Write-Host "  -SelfRescueRate $SelfRescueRate makes this a COHORT run. Left at bigfill's" -ForegroundColor Yellow
    Write-Host "  default of 0 it would also sweep wallets 0..$($Offset - 1) for rescue and" -ForegroundColor Yellow
    Write-Host "  upgrade, applying this cohort's self-rescue rate to another cohort's" -ForegroundColor Yellow
    Write-Host "  wallets. Pass -ScanFrom explicitly to override." -ForegroundColor Yellow
    Write-Host ""
}
if ($ScanFrom -ge 0) { $env:SCAN_FROM = "$ScanFrom" }

# ---------------------------------------------------------------------------
# WHICH DEPLOYMENT DOES THIS RUN DRIVE?  (added 2026-08-16)
#
# This wrapper used to set no ADDRESSES_FILE at all, so every run silently
# inherited .env's value -- which is the LIVE community deployment. Harmless
# for the default (-SelfRescueRate 1.0) run; NOT harmless for a split-cohort
# test. A cohort at -SelfRescueRate 0 registers wallets that CANNOT self-fund,
# so they park, accrue debt and get evicted. Pointed at the live chain that is
# not a wasted test -- it is damage to the chain members are registered on.
#
# hardhat.config.js:2 calls dotenv.config() with NO override, so a shell
# variable set here WINS over .env. Read out of the loader, not assumed.
#
# The interlock is deliberately written WITHOUT naming a version. "A cohort
# that cannot self-fund must name its chain out loud" stays true after V8.49,
# V8.50 and every deploy after; a hardcoded "is it v8_48" check would go stale
# on the next deploy -- the three-copies pattern that has already cost this
# project two items.
# ---------------------------------------------------------------------------
if ($SelfRescueRate -ne 1.0 -and $AddressesFile -eq "") {
    Write-Host ""
    Write-Host "REFUSING TO RUN." -ForegroundColor Red
    Write-Host ("  -SelfRescueRate {0} means this cohort CANNOT self-fund." -f $SelfRescueRate) -ForegroundColor Red
    Write-Host "  Those wallets park, accrue debt and get evicted -- that belongs on a" -ForegroundColor Red
    Write-Host "  TEST deployment only, never on the chain members are registered on." -ForegroundColor Red
    Write-Host "  Name the chain explicitly, e.g.:" -ForegroundColor Red
    Write-Host "    -AddressesFile deployed_addresses_v8_49.json" -ForegroundColor Red
    Write-Host ""
    exit 1
}

if ($AddressesFile -ne "") {
    $env:ADDRESSES_FILE = $AddressesFile
    $effectiveAddrs = $AddressesFile
    $addrsSource    = "-AddressesFile (chosen for this run)"
} else {
    $dotenvPath = Join-Path $PSScriptRoot ".env"
    $dotenvLine = Select-String -Path $dotenvPath -Pattern '^\s*ADDRESSES_FILE\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($dotenvLine) {
        $effectiveAddrs = ($dotenvLine.Line -split '=', 2)[1].Trim()
        $addrsSource    = ".env  <-- INHERITED, not chosen for this run"
    } else {
        $effectiveAddrs = "<built-in default inside bigfill_v8.js>"
        $addrsSource    = "script default (no ADDRESSES_FILE in .env)"
    }
}

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
Write-Host ("  ADDRESSES FILE   : {0}" -f $effectiveAddrs)
Write-Host ("    source         : {0}" -f $addrsSource)
Write-Host ("  leaders supplied : {0}" -f $leaders.Count)
Write-Host ("  COUNT            : {0}" -f $Count)
Write-Host ("  HDR_OFFSET       : {0}" -f $Offset)
Write-Host ("  wallet range     : HDR {0} .. {1}" -f $Offset, ($Offset + $Count - 1))
if ($ScanFrom -ge 0) {
    Write-Host ("  sweeps (rescue)  : HDR {0} .. {1}" -f $ScanFrom, ($Offset + $Count - 1))
} else {
    Write-Host ("  sweeps (rescue)  : HDR 0 .. {0}   <-- bigfill default, ALL earlier wallets" -f ($Offset + $Count - 1))
}
Write-Host ("  batch size/delay : {0} wallet(s) every {1}s" -f $BatchSize, $BatchDelay)
Write-Host ("  self-rescue rate : {0}" -f $SelfRescueRate)
Write-Host ("  upgrade rate     : {0}" -f $UpgradeRate)
Write-Host "  CNOVA buy/sell   : DISABLED"
Write-Host "  burn sweep       : DISABLED"
Write-Host "  (unregistered leaders are skipped automatically)"
Write-Host ""

Set-Location "C:\CryptoNite-Smart-Contracts\CryptoNova"
npx hardhat run scripts/bigfill_v8.js --network baseSepolia
