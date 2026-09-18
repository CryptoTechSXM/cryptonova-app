// scripts/prove_v856_debt.js — session 92 (62.69). ON-CHAIN RE-PROOF OF V8.56 DP5.
//
// Precondition (made by prove_v856_setup.js, READY): W1 active in T1 MatB, free earnings in
// T1 MatA (a) AND T1 MatB (b), automation OFF, no T2 seat, no debt.
// This script:
//   1. books a debt D with a < D, b < D, D < a + b  (D = hi + (a+b-hi)/2, same as the fixture)
//      via StabilityFund.increaseMemberDebt — owner-only, so signed by the DEPLOYER.
//      ⛔ R17: run it only inside a rr_keeper.OFF / system_keeper.OFF window (the owner block does that).
//   2. W1 approves TierRouter for fee2 + D (enough for the PRE-fix path too, so a regression
//      shows as the wrong number, not as a revert) and calls hybridUpgrade(1).
//   3. reads everything PINNED to the upgrade's block and the block before it, and prints the verdict.
// PREDICTION (printed before any tx, from the fixed library + fixture DP5):
//   wallet pays fee2 - (a + b - D); MatA 0; MatB 0; debt 0; highestTier 2.
//   PRE-FIX behaviour (fixture, measured on 0de4f1d) would be: wallet pays fee2 + D, MatA/MatB untouched.
//
// Run (PC, contracts repo):  $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"
//                            npx hardhat run scripts/prove_v856_debt.js --network baseSepolia
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

// read pinned to a block; retry while the node has not got that block yet
async function at(fn, blockTag, what) {
  for (let k = 0; ; k++) {
    try { return await fn({ blockTag }); }
    catch (e) {
      if (k >= 15) throw new Error(`read ${what} @${blockTag} failed 15x: ${e.shortMessage || e.message}`);
      await sleep(3000);
    }
  }
}

async function main() {
  const provider = ethers.provider;
  const w1  = new ethers.Wallet(process.env.W1_PRIVATE_KEY, provider);
  const dep = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  if (w1.address.toLowerCase() !== A.accountOne.toLowerCase()) throw new Error("W1 key != book accountOne");
  if (dep.address.toLowerCase() !== A.deployer.toLowerCase())  throw new Error("DEPLOYER key != book deployer");

  const tr   = await ethers.getContractAt("TierRouter", A.tierRouter, w1);
  const pm1  = await ethers.getContractAt("PairManagerV8", A.tiers.T1.pm);
  const pm2  = await ethers.getContractAt("PairManagerV8", A.tiers.T2.pm);
  const usdc = await ethers.getContractAt("MockUSDC", A.usdc, w1);
  const sf   = await ethers.getContractAt("StabilityFund", A.stabilityFund, dep);
  if (Number(await pm1.pairCount()) !== 1) throw new Error("T1 has more than one pair — this script reads pair 0 only; re-scope before running");
  const [ma, mb] = await pm1.getPairAt(0);
  const matA = await ethers.getContractAt("FigureEightMatrixV8", ma);
  const matB = await ethers.getContractAt("FigureEightMatrixV8", mb);
  const fee2 = await pm2.entryFee();

  const B0 = await provider.getBlockNumber();
  const r = async (c, fn, ...args) => at(o => c[fn](...args, o), B0, fn);
  const a  = await r(matA, "withdrawableOf", w1.address), b  = await r(matB, "withdrawableOf", w1.address);
  const fa = await r(matA, "freeWithdrawable", w1.address), fb = await r(matB, "freeWithdrawable", w1.address);
  const activeB = await r(matB, "isActiveInMatrix", w1.address);
  const seat2 = await r(pm2, "holdsSeatIn", w1.address);
  const debt0 = await r(sf, "memberDebtOf", w1.address);
  const opts  = await r(tr, "memberOptions", w1.address);
  console.log(`prove_v856_debt  book ${BOOK}  pinned block ${B0}`);
  console.log(`  W1 ${w1.address}`);
  console.log(`  T1 MatA ${ma}: stored ${usd(a)} free ${usd(fa)}`);
  console.log(`  T1 MatB ${mb}: stored ${usd(b)} free ${usd(fb)}  active ${activeB}`);
  console.log(`  T2 seat ${seat2} · debt ${usd(debt0)} · autoUpgradeDisabled ${opts[0]} autoReentry ${opts[1]} · T2 fee ${usd(fee2)}`);

  const stop = m => { console.log("⛔ PRECONDITION FAILED: " + m + " — nothing sent."); process.exit(1); };
  if (!activeB) stop("W1 not active in T1 MatB (not upgrade-eligible)");
  if (seat2) stop("W1 already holds a T2 seat");
  if (!(a > 0n && b > 0n)) stop("need earnings in both halves");
  const hi = a > b ? a : b;
  const D = hi + (a + b - hi) / 2n;
  if (!(D > a && D > b && D < a + b)) stop("cannot build a < D, b < D, D < a+b");
  if (debt0 !== 0n && debt0 !== D) stop(`W1 already carries a different debt ${usd(debt0)}`);
  // ⛔ FIXED 2026-09-18 (session 92): the first version demanded free == stored even when the debt
  //    was ALREADY booked — but the view subtracts the whole debt in EVERY matrix (that is DP1), so
  //    with D booked free MUST read max(0, stored - D). The guard refused the very state it was built for.
  const viewOf = x => (x > debt0 ? x - debt0 : 0n);
  if (fa !== viewOf(a) || fb !== viewOf(b))
    stop(`free != stored - debt (A ${usd(fa)} vs ${usd(viewOf(a))}, B ${usd(fb)} vs ${usd(viewOf(b))}) — an extra hold applies`);
  if (debt0 === D)
    console.log(`  DP1 ON CHAIN: with debt ${usd(D)} booked, freeWithdrawable reads A ${usd(fa)} · B ${usd(fb)} although true claimable is ${usd(a + b - D)}`);

  const want = fee2 - (a + b - D);
  console.log(`\n  ▶ PREDICTION (written before any tx): debt D = ${usd(D)} · earnings net of debt ${usd(a + b - D)}`);
  console.log(`    FIXED (V8.56):  wallet pays ${usd(want)} · MatA 0 · MatB 0 · debt 0 · highestTier 2`);
  console.log(`    PRE-FIX would:  wallet pays ${usd(fee2 + D)} · MatA ${usd(a)} · MatB ${usd(b)} untouched`);

  // 1. book the debt (deployer)
  if (debt0 === 0n) {
    const tx = await sf.increaseMemberDebt(w1.address, 0, D);
    const rc = await tx.wait();
    const d = await at(o => sf.memberDebtOf(w1.address, o), rc.blockNumber, "memberDebtOf");
    console.log(`\n  1. increaseMemberDebt(W1, 0, ${usd(D)})  ${tx.hash}  block ${rc.blockNumber}  → debt ${usd(d)}`);
    if (d !== D) stop(`debt reads ${usd(d)} after booking, expected ${usd(D)}`);
  } else console.log(`\n  1. debt ${usd(D)} already booked (resume) — not re-booked`);

  // 2. approve + hybridUpgrade (W1)
  const ta = await usdc.approve(A.tierRouter, fee2 + D); await ta.wait();
  console.log(`  2. W1 approve(TierRouter, ${usd(fee2 + D)})  ${ta.hash}`);
  let gl;
  try { const g = await tr.hybridUpgrade.estimateGas(1); gl = (g * 15n) / 10n; if (gl > 16_000_000n) gl = 16_000_000n; }
  catch (e) { console.log(`  ⛔ hybridUpgrade(1) estimate REVERTS: ${e.shortMessage || e.message}  — debt stays booked; paste this.`); process.exit(1); }
  const tx = await tr.hybridUpgrade(1, { gasLimit: gl });
  const rc = await tx.wait();
  console.log(`  3. hybridUpgrade(1)  ${tx.hash}  block ${rc.blockNumber}  status ${rc.status}  gas ${rc.gasUsed}`);

  // 3. pinned reads: block before vs the upgrade block
  const B1 = rc.blockNumber, Bm = B1 - 1;
  const uBefore = await at(o => usdc.balanceOf(w1.address, o), Bm, "usdc before");
  const uAfter  = await at(o => usdc.balanceOf(w1.address, o), B1, "usdc after");
  const a2 = await at(o => matA.withdrawableOf(w1.address, o), B1, "A after");
  const b2 = await at(o => matB.withdrawableOf(w1.address, o), B1, "B after");
  const d2 = await at(o => sf.memberDebtOf(w1.address, o), B1, "debt after");
  const t2 = await at(o => tr.memberHighestTier(w1.address, o), B1, "tier after");
  const spent = uBefore - uAfter;
  console.log(`\n  MEASURED @${B1} (wallet vs @${Bm}): wallet paid ${usd(spent)} · MatA ${usd(a2)} · MatB ${usd(b2)} · debt ${usd(d2)} · highestTier ${t2}`);
  const ok = spent === want && a2 === 0n && b2 === 0n && d2 === 0n && Number(t2) === 2;
  if (ok) console.log("  ✅✅ DP5 ON CHAIN: PREDICTION HELD — the debt was netted ONCE from both T1 matrices; the wallet paid only the gap.");
  else if (spent === fee2 + D) console.log("  ⛔⛔ PRE-FIX BEHAVIOUR ON CHAIN — wallet paid fee + whole debt. The deployed TierRouterLib is NOT the fix.");
  else console.log(`  ⚠ DIFFERENT FROM BOTH — expected ${usd(want)} (fixed) or ${usd(fee2 + D)} (pre-fix). Do not explain it; paste the output.`);
}
main().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
