// scripts/prove_v856_dp2.js — session 92 (62.69). ON-CHAIN RE-PROOF OF V8.56 DP2 (partial withdraw).
//
// Precondition (prove_v856_setup.js MODE=dp2, READY): W1 holds free earnings in >= 2 matrices, automation OFF.
// This script:
//   1. books a debt D bigger than EVERY single matrix balance and smaller than their sum
//      (D = max + (sum - max)/2, the fixture rule) — owner-only, signed by the DEPLOYER.
//      ⛔ R17: run only inside a rr_keeper.OFF / system_keeper.OFF window (the owner block does that).
//      Skipped if exactly D is already booked (resume).
//   2. W1 calls bulkWithdraw(sum - D)  — the one-signature PARTIAL withdrawal.
//   3. reads everything pinned to that block and the block before, prints the verdict.
// PREDICTION (fixed library + fixture DP2): wallet + (want − want·feeBps/10000), debt 0, all balances 0.
//   PRE-FIX (fixture, measured on 0de4f1d): bulkWithdraw(want) REVERTS TRState — every per-matrix cap is 0.
//
// Run: $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"
//      npx hardhat run scripts/prove_v856_dp2.js --network baseSepolia
const path = require("path");
require("./rpc_resilience");
const { ethers } = require("hardhat");

const BOOK = process.env.ADDRESSES_FILE || "";
if (BOOK !== "deployed_addresses_v8_56_private.json") {
  console.error(`REFUSING: ADDRESSES_FILE must be deployed_addresses_v8_56_private.json (got "${BOOK}"). Private chain only.`);
  process.exit(1);
}
const A = require(path.join(__dirname, BOOK));
const usd = v => (v < 0n ? "-$" : "$") + (Number(v < 0n ? -v : v) / 1e6).toFixed(6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function at(fn, blockTag, what) {
  for (let k = 0; ; k++) {
    try { return await fn({ blockTag }); }
    catch (e) { if (k >= 15) throw new Error(`read ${what} @${blockTag} failed 15x: ${e.shortMessage || e.message}`); await sleep(3000); }
  }
}

async function main() {
  const provider = ethers.provider;
  const w1  = new ethers.Wallet(process.env.W1_PRIVATE_KEY, provider);
  const dep = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  if (w1.address.toLowerCase() !== A.accountOne.toLowerCase()) throw new Error("W1 key != book accountOne");
  if (dep.address.toLowerCase() !== A.deployer.toLowerCase())  throw new Error("DEPLOYER key != book deployer");
  const tr   = await ethers.getContractAt("TierRouter", A.tierRouter, w1);
  const usdc = await ethers.getContractAt("MockUSDC", A.usdc, w1);
  const sf   = await ethers.getContractAt("StabilityFund", A.stabilityFund, dep);

  const B0 = await provider.getBlockNumber();
  const mats = [];
  for (const t of ["T1", "T2", "T3"]) {
    const pm = await ethers.getContractAt("PairManagerV8", A.tiers[t].pm);
    const n = Number(await at(o => pm.pairCount(o), B0, "pairCount"));
    for (let i = 0; i < n; i++) {
      const [ma, mb] = await at(o => pm.getPairAt(i, o), B0, "getPairAt");
      for (const [h, addr] of [["A", ma], ["B", mb]]) {
        const m = await ethers.getContractAt("FigureEightMatrixV8", addr);
        const stored = await at(o => m.withdrawableOf(w1.address, o), B0, "withdrawableOf");
        const free   = await at(o => m.freeWithdrawable(w1.address, o), B0, "freeWithdrawable");
        const fee    = await at(o => m.withdrawalFeeBps(o), B0, "feeBps");
        mats.push({ label: `${t}.${i + 1}.${h}`, addr, m, stored, free, fee });
      }
    }
  }
  const debt0 = await at(o => sf.memberDebtOf(w1.address, o), B0, "debt");
  const opts  = await at(o => tr.memberOptions(w1.address, o), B0, "options");
  const held = mats.filter(x => x.stored > 0n);
  console.log(`prove_v856_dp2  book ${BOOK}  pinned block ${B0}  W1 ${w1.address}`);
  for (const x of held) console.log(`  ${x.label} ${x.addr}: stored ${usd(x.stored)} free ${usd(x.free)} feeBps ${x.fee}`);
  console.log(`  debt ${usd(debt0)} · autoUpgradeDisabled ${opts[0]} autoReentry ${opts[1]} · matrices read ${mats.length}`);

  const stop = m => { console.log("⛔ PRECONDITION FAILED: " + m + " — nothing sent."); process.exit(1); };
  if (held.length < 2) stop("need earnings in at least two matrices");
  const fees = [...new Set(held.map(x => x.fee.toString()))];
  if (fees.length !== 1) stop(`matrices carry different fees ${fees} — expected value would be per-matrix; re-scope`);
  const feeBps = held[0].fee;
  const sum = held.reduce((s, x) => s + x.stored, 0n);
  const max = held.reduce((s, x) => (x.stored > s ? x.stored : s), 0n);
  const D = max + (sum - max) / 2n;
  if (!(held.every(x => D > x.stored) && D < sum)) stop("cannot build: D > every balance and D < sum");
  if (debt0 !== 0n && debt0 !== D) stop(`W1 already carries a different debt ${usd(debt0)}`);
  const view = x => (x > debt0 ? x - debt0 : 0n);
  const bad = held.filter(x => x.free !== view(x.stored));
  if (bad.length) stop(`free != stored − debt on ${bad.map(x => x.label).join(",")} — an extra hold applies`);

  const want = sum - D;
  const net  = want - (want * feeBps) / 10_000n;
  console.log(`\n  ▶ PREDICTION (written before any tx): balances sum ${usd(sum)} · debt D ${usd(D)} (> every balance, < sum) · true claimable ${usd(want)}`);
  console.log(`    FIXED (V8.56):  bulkWithdraw(${usd(want)}) pays the wallet ${usd(net)} (net of ${feeBps} bps) · debt 0 · every balance 0`);
  console.log(`    PRE-FIX would:  REVERT TRState (each matrix's cap = balance − whole debt = 0)`);

  if (debt0 === 0n) {
    const tx = await sf.increaseMemberDebt(w1.address, 0, D);
    const rc = await tx.wait();
    let d = 0n;
    for (let k = 0; k < 10; k++) { d = await at(o => sf.memberDebtOf(w1.address, o), rc.blockNumber, "debt"); if (d === D) break; await sleep(3000); }
    console.log(`\n  1. increaseMemberDebt(W1, 0, ${usd(D)})  ${tx.hash}  block ${rc.blockNumber}  → debt ${usd(d)}`);
    if (d !== D) stop(`debt reads ${usd(d)} at the booking block after 10 probes, expected ${usd(D)} — re-run: it resumes`);
  } else console.log(`\n  1. debt ${usd(D)} already booked (resume) — not re-booked`);

  let gl;
  try { const g = await tr["bulkWithdraw(uint256)"].estimateGas(want); gl = (g * 15n) / 10n; if (gl > 16_000_000n) gl = 16_000_000n; }
  catch (e) {
    const msg = e.shortMessage || e.message;
    console.log(`  2. bulkWithdraw(${usd(want)}) estimate REVERTS: ${msg}`);
    console.log("  ⛔⛔ PRE-FIX BEHAVIOUR ON CHAIN (or another refusal) — paste this. Debt stays booked; a re-run resumes.");
    process.exit(1);
  }
  const tx = await tr["bulkWithdraw(uint256)"](want, { gasLimit: gl });
  const rc = await tx.wait();
  console.log(`  2. bulkWithdraw(${usd(want)})  ${tx.hash}  block ${rc.blockNumber}  status ${rc.status}  gas ${rc.gasUsed}`);

  const B1 = rc.blockNumber, Bm = B1 - 1;
  const uBefore = await at(o => usdc.balanceOf(w1.address, o), Bm, "usdc before");
  const uAfter  = await at(o => usdc.balanceOf(w1.address, o), B1, "usdc after");
  let left = 0n; const lefts = [];
  for (const x of held) { const v = await at(o => x.m.withdrawableOf(w1.address, o), B1, x.label); left += v; lefts.push(`${x.label} ${usd(v)}`); }
  const d2 = await at(o => sf.memberDebtOf(w1.address, o), B1, "debt after");
  const got = uAfter - uBefore;
  console.log(`\n  MEASURED @${B1} (wallet vs @${Bm}): wallet +${usd(got)} · ${lefts.join(" · ")} · debt ${usd(d2)}`);
  if (got === net && left === 0n && d2 === 0n)
    console.log("  ✅✅ DP2 ON CHAIN: PREDICTION HELD — the partial withdrawal paid the true claimable net of fee and cleared the debt once.");
  else console.log(`  ⚠ DIFFERENT FROM THE PREDICTION — expected +${usd(net)}, balances 0, debt 0. Do not explain it; paste the output.`);
}
main().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
