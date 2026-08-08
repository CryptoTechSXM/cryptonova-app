// diag_withdraw_truth.js — Sherwyn-scenario verifier (V8.47, 2026-08-08)
//
// Prints, for ONE wallet, the three formulas that disagreed on 2026-08-07:
//   TRUTH   = line-for-line mirror of MatrixLogicLib.withdrawCore(:992)
//             (what the contract will actually release; what the UI shows
//              since Testnet-App commit 427beb5)
//   VIEW    = Σ freeWithdrawable() (the on-chain view — misses the V8.32
//             opt-out, so it UNDER-reports when automation is off)
//   OLD-UI  = VIEW minus reservedFor again (the pre-fix double subtraction)
//
// Run (contracts repo, Windows):
//   node scripts\diag_withdraw_truth.js 0xWALLET
//
const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const PM_ABI  = ["function pairCount() view returns (uint256)",
                 "function getPairAt(uint256) view returns (address,address)"];
const MAT_ABI = [
  "function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined))",
  "function pendingPoolOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function freeWithdrawable(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
];
const TR_ABI = ["function memberHighestTier(address) view returns (uint8)",
                "function reservedFor(address) view returns (uint256)"];
const SF_ABI = ["function memberDebtOf(address) view returns (uint256)"];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

(async () => {
  const wallet = process.argv[2];
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    console.log("Usage: node scripts\\diag_withdraw_truth.js 0xWALLET"); process.exit(1);
  }
  const p  = new ethers.JsonRpcProvider(RPC);
  const tr = new ethers.Contract(A.tierRouter, TR_ABI, p);
  const sf = new ethers.Contract(A.stabilityFund, SF_ABI, p);

  const blk = await p.getBlockNumber();
  const highest  = Number(await tr.memberHighestTier(wallet));
  const reserved = BigInt(await tr.reservedFor(wallet));
  const debt     = BigInt(await sf.memberDebtOf(wallet));

  console.log(`\nWallet ${wallet}  |  block ${blk}`);
  console.log(`memberHighestTier=T${highest}  reservedFor=${usd(reserved)}  memberDebt(SF)=${usd(debt)}${reserved === 0n ? "   << ALL-TOGGLES-OFF (Sherwyn scenario)" : ""}\n`);
  console.log("matrix        | seated | raw wd    | +pending  | crossRes  | VIEW free | TRUTH");
  console.log("--------------|--------|-----------|-----------|-----------|-----------|---------");

  let truthTotal = 0n, viewTotal = 0n, rawTotal = 0n;

  for (let t = 1; t <= 10; t++) {
    const tier = A.tiers["T" + t];
    if (!tier || !tier.pm) continue;
    let n = 1;
    try { n = Number(await new ethers.Contract(tier.pm, PM_ABI, p).pairCount()); } catch {}
    for (let i = 0; i < n; i++) {
      let matA = tier.matA, matB = tier.matB;
      if (i > 0 || n > 1) {
        try { [matA, matB] = await new ethers.Contract(tier.pm, PM_ABI, p).getPairAt(i); } catch { continue; }
      }
      for (const [half, addr] of [["MatA", matA], ["MatB", matB]]) {
        if (!addr || addr === ethers.ZeroAddress) continue;
        const mc = new ethers.Contract(addr, MAT_ABI, p);
        let m; try { m = await mc.getMember(wallet); } catch { continue; }
        const raw = BigInt(m.withdrawable);
        const credit = m.hasEverJoined || raw > 0n || BigInt(m.totalWithdrawn) > 0n || BigInt(m.totalEarned) > 0n;
        if (!credit) continue;
        const [pend, cres, view] = await Promise.all([
          mc.pendingPoolOf(wallet).then(BigInt).catch(() => 0n),
          mc.crossingReserveOf(wallet).then(BigInt).catch(() => 0n),
          mc.freeWithdrawable(wallet).then(BigInt).catch(() => 0n),
        ]);
        // ---- withdrawCore mirror (the TRUTH column) ----
        let bal = raw + pend;
        let note = "";
        if (bal > 0n && reserved > 0n && highest > 0 && (highest - 1) === (t - 1)) {
          if (m.isInMatrix) {
            const fee = BigInt(await mc.ENTRY_FEE().catch(() => 0n));
            const crossNeeded = fee > cres ? fee - cres : 0n;
            if (crossNeeded > 0n) {
              if (bal <= crossNeeded) { note = "held: crossing"; bal = 0n; }
              else bal -= crossNeeded;
            }
          }
          if (bal > 0n) {
            if (reserved >= bal) { note = "held: reserve"; bal = 0n; }
            else bal -= reserved;
          }
        }
        truthTotal += bal; viewTotal += view; rawTotal += raw;
        const lbl = `T${t}${n > 1 ? "." + (i + 1) : ""} ${half}`;
        console.log(`${lbl.padEnd(13)} | ${(m.isInMatrix ? "YES" : "no").padEnd(6)} | ${usd(raw).padEnd(9)} | ${usd(pend).padEnd(9)} | ${usd(cres).padEnd(9)} | ${usd(view).padEnd(9)} | ${usd(bal)}${note ? "  (" + note + ")" : ""}`);
      }
    }
  }

  const truthNet = truthTotal > debt ? truthTotal - debt : 0n;
  const oldUi    = reserved > 0n ? (viewTotal > reserved ? viewTotal - reserved : 0n) : viewTotal;
  const fee15    = truthNet * 150n / 10000n;

  console.log("\n──────────────────────────────────────────────────────");
  console.log(`RAW ledger sum        : ${usd(rawTotal)}   (what the ORIGINAL modal showed — Sherwyn's higher figure)`);
  console.log(`VIEW freeWithdrawable : ${usd(viewTotal)}   (on-chain view — misses V8.32 opt-out)`);
  console.log(`OLD-UI (view−reserve) : ${usd(oldUi)}   (pre-fix card/MAX — double subtraction)`);
  console.log(`TRUTH withdrawCore    : ${usd(truthTotal)}   gross`);
  console.log(`  − rescue debt       : ${usd(debt)}`);
  console.log(`= EXPECTED UI FIGURE  : ${usd(truthNet)}   << card, breakdown AND MAX must all show this`);
  console.log(`  after 1.5% fee      : ${usd(truthNet - fee15)}   << 'You Receive' / actual wallet payout on Withdraw All`);
  console.log("──────────────────────────────────────────────────────\n");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
