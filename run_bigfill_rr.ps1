# run_bigfill_rr.ps1 - bigfill with the leader round-robin referrer list.
# V8.47 rebuild (2026-08-05): restored from archive/windows_keeper (July cleanup
# had swept it), roster refreshed to the leader list (same set as the VPS
# SPONSORS/ROUND_ROBIN - if you change one, change both), and SLOW-DRIP
# pacing added: default 1 registration every 5 minutes (BatchSize/BatchDelay).
# ROUND_ROBIN is set for THIS SESSION ONLY, so the VPS keepers are unaffected.
# Unregistered leaders are skipped automatically; rotation fixed at run start.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1 -Count 127 -Offset 0
#   Burst mode (old behavior): add -BatchSize 5 -BatchDelay 8
#   Against a TEST deployment: add -AddressesFile deployed_addresses_v8_49.json

param(
    # OWNER RULE 2026-08-19: ONE new member per run (was 127). The fund is fed by the
    # SWEEPS (self-rescue + upgrade over ALL historical wallets), not by bulk
    # registration. Measured 2026-08-19 on the USDC ledger: bigfill days ran +$111/day,
    # quiet days -$136/day; self-rescues 73.5/day vs 16.0 and SF lending $76.72/day vs
    # $345.68. Bulk registration inflates the member count without adding any of that.
    [int]$Count  = 1,
    [int]$Offset = 0,
    [double]$SelfRescueRate = 1.0,   # 1.0 = every parked wallet self-rescues
    [double]$UpgradeRate    = 1.0,   # 1.0 = upgrade whenever eligible
    [int]$BatchSize  = 1,            # wallets per batch
    [int]$BatchDelay = 300,          # seconds between batches (300 = 5 min drip)
    [string]$AddressesFile = "",     # "" = inherit .env; see the block below
    [int]$ScanFrom = -1,             # -1 = leave bigfill's default; see COHORT BLEED below
    [switch]$NoEvictReentry,         # turn OFF the eviction re-entry phase
    [int]$EvictReentryMax = 25       # cap reinstatements per run, keeps a run bounded
)

# ---------------------------------------------------------------------------
# COHORT BLEED - -Offset DOES NOT ISOLATE A COHORT  (found 2026-08-16)
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
# own range - so we pin SCAN_FROM to its offset and say so loudly.
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

$env:CNOVA_BUY_RATE   = "0"
$env:CNOVA_SELL_RATE  = "0"
$env:BURN_SIMULATE    = "false"
$env:SELF_RESCUE_RATE = "$SelfRescueRate"
$env:UPGRADE_RATE     = "$UpgradeRate"
$env:BATCH_SIZE       = "$BatchSize"
$env:BATCH_DELAY      = "$BatchDelay"
# OWNER RULE 2026-08-19, the fifth action: an evicted member gets back in, pays their
# fees, and upgrades if eligible. WARNING: there is NO member-callable path for this on
# chain. It runs as an owner reinstatement (setGlobalJoined) plus a normal fee-paying
# register, so it SIMULATES a capability live members do not have. A real member-callable
# re-entry is scoped for V8.50; until it ships, do not read "evicted members returned" in
# this data as something the community can do. Set EVICT_REENTRY=0 to turn the phase off.
if ($NoEvictReentry) { $env:EVICT_REENTRY = "0" } else { $env:EVICT_REENTRY = "1" }
$env:EVICT_REENTRY_MAX = "$EvictReentryMax"

# 10-leader roster - REDUCED from the 41-wallet 2026-08-05 set by the owner on
# 2026-08-26 for the V8.50 community chain (his exact list, W1 first). The dropped 31
# stay in git history.
# VPS ENV IS NOW IN SYNC - cut 41 -> these same 10 on 2026-08-28 (session 45), backup
# at /root/keeper/.env.bak_roster41_20260828. Verified identical to this list AND to
# DEFAULT_SPONSOR_POOL in index.html, byte-for-byte incl. checksum case and order.
# THERE ARE TWO VPS VARIABLES, NOT ONE - measured 2026-08-28, they feed DIFFERENT
# scripts and both must move together:
#   ROUND_ROBIN -> stress_keeper.js:29
#   SPONSORS    -> rr_keeper.js:312  (VPS copy ONLY - see below)
# WARNING: the VPS rr_keeper.js is NOT the repo copy. A VPS-only script patch_rr.js
# rewrites it in place to add the SPONSORS block; neither file is in CryptoNova-Keepers.
# Grep the VPS, not the repo, before believing rr_keeper.js has no roster.
$leaders = @(
  "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435"   # W1 / accountOne
  "0x19a59fbD6d2c1289668795D41453e1505B7B8102"
  "0x1D3E33aAFFDb694E5a45d793B6946120467e93AB"
  "0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2"
  "0xaAda7eF0bbF0A08189a39f6d471A1728d3873c15"
  "0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2"
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e"
  "0xd56e7dF24D182Bc64Bd3Caa322951912A6cEf54c"
  "0x26388a81eb9448DF02144cc765Bb448444e61f9B"
  "0x391ab9edC83960e6ec468bDb7e6abE5858656F68"
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
if ($NoEvictReentry) {
    $evictLabel = "OFF"
} else {
    $evictLabel = "ON   (max $EvictReentryMax per run, OWNER OVERRIDE - not a member-callable path)"
}
Write-Host ("  evict re-entry   : {0}" -f $evictLabel)
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
