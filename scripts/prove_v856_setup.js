// scripts/prove_v856_setup.js — session 92 (62.69). BUILD THE ON-CHAIN DP5 SUBJECT.
//
// Goal: put W1 (accountOne, the T1 root) into the DP5 shape on the PRIVATE V8.56 chain —
//   earnings in T1 MatA AND T1 MatB, active in T1 MatB (= upgrade-eligible, TierRouter
//   _upgradeEligible :937), NOT seated in T2 — so prove_v856_debt.js can then book a debt
//   bigger than each balance and smaller than both, and call hybridUpgrade(1).
// Mirrors test/V8_56_DebtPerMatrix.test.js DP5, except size 15 (fixture was smaller), so
// the number of referrals needed is NOT known in advance: this script registers referrals
// under W1 in small chunks and PRINTS W1's state after every one, and says READY when the
// shape exists. It does not guess the count.
//
// Signs with W1 ONLY (no deployer tx) so it cannot clash with live keeper jobs that sign
// with the deployer (R17). W1 funds each referral wallet's $fee USDC + gas ETH.
// Referral wallets: FILL_MNEMONIC std path m/44'/60'/0'/0/<OFFSET+i>, OFFSET default 900000
// (ranges used elsewhere: std 0.., child 300000-700059). Re-runs resume: wallets already
// globalJoined are skipped.
//
// MODE=dp2 (added session 92 after DP5 passed): W1 is then in T2 with $0 in T1. The DP2 shape only
//   needs free earnings in AT LEAST TWO matrices (any tier, any half) — READY when that is true.
//   The state line then walks every pair of T1, T2 and T3.
//
// Run (PC, contracts repo):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"; $env:MAX_REG="5"
//   npx hardhat run scripts/prove_v856_setup.js --network baseSepolia
const path = require("path");
require("./rpc_resilience");
const { ethers } = require("hardhat");

const BOOK = process.env.ADDRESSES_FILE || "";
if (BOOK !== "deployed_addresses_v8_56_private.json") {
  console.error(`REFUSING: ADDRESSES_FILE must be deployed_addresses_v8_56_private.json (got "${BOOK}"). Private chain only.`);
  process.exit(1);
}
const A = require(path.join(__dirname, BOOK));
const MAX_REG = Number(process.env.MAX_REG || 5);
const OFFSET  = Number(process.env.OFFSET || 900000);
const MODE = (process.env.MODE || "dp5").toLowerCase();
const ETH_EACH = ethers.parseEther(process.env.ETH_EACH || "0.003");
const usd = v => "$" + (Number(v) / 1e6).toFixed(6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const provider = ethers.provider;
  if (!process.env.W1_PRIVATE_KEY) throw new Error("W1_PRIVATE_KEY missing from .env");
  if (!process.env.FILL_MNEMONIC)  throw new Error("FILL_MNEMONIC missing from .env");
  const w1 = new ethers.Wallet(process.env.W1_PRIVATE_KEY, provider);
  if (w1.address.toLowerCase() !== A.accountOne.toLowerCase())
    throw new Error(`W1_PRIVATE_KEY is ${w1.address}, book accountOne is ${A.accountOne}`);

  const tr   = await ethers.getContractAt("TierRouter", A.tierRouter, w1);
  const pm1  = await ethers.getContractAt("PairManagerV8", A.tiers.T1.pm);
  const pm2  = await ethers.getContractAt("PairManagerV8", A.tiers.T2.pm);
  const usdc = await ethers.getContractAt("MockUSDC", A.usdc, w1);
  const sf   = await ethers.getContractAt("StabilityFund", A.stabilityFund);
  const fee1 = await pm1.entryFee();

  const block = await provider.getBlockNumber();
  console.log(`prove_v856_setup  book ${BOOK}  block ${block}  router ${A.tierRouter}`);
  console.log(`W1 ${w1.address}  ETH ${ethers.formatEther(await provider.getBalance(w1.address))}  USDC ${usd(await usdc.balanceOf(w1.address))}  T1 fee ${usd(fee1)}`);

  async function stateDp2(tag) {
    await sleep(3000);
    const parts = []; let nz = 0;
    for (const t of ["T1", "T2", "T3"]) {
      const pm = await ethers.getContractAt("PairManagerV8", A.tiers[t].pm);
      const n = Number(await pm.pairCount());
      for (let i = 0; i < n; i++) {
        const [ma, mb] = await pm.getPairAt(i);
        for (const [h, addr] of [["A", ma], ["B", mb]]) {
          const m = await ethers.getContractAt("FigureEightMatrixV8", addr);
          const w = await m.withdrawableOf(w1.address);
          const act = await m.isActiveInMatrix(w1.address);
          if (w > 0n) nz++;
          if (w > 0n || act) parts.push(`${t}.${i + 1}.${h} ${usd(w)}${act ? "*" : ""}`);
        }
      }
    }
    const hi = await tr.memberHighestTier(w1.address);
    const debt = await sf.memberDebtOf(w1.address);
    console.log(`  [${tag}] ${parts.join(" · ") || "(no balances)"} · highestTier ${hi} · debt ${usd(debt)} · matrices with balance ${nz}   (* = active)`);
    return { nz };
  }

  async function state(tag) {
    await sleep(3000);
    const n = Number(await pm1.pairCount());
    let a = 0n, b = 0n, activeB = false; const parts = [];
    for (let i = 0; i < n; i++) {
      const [ma, mb] = await pm1.getPairAt(i);
      const A_ = await ethers.getContractAt("FigureEightMatrixV8", ma);
      const B_ = await ethers.getContractAt("FigureEightMatrixV8", mb);
      const wa = await A_.withdrawableOf(w1.address), wb = await B_.withdrawableOf(w1.address);
      const ia = await A_.isActiveInMatrix(w1.address), ib = await B_.isActiveInMatrix(w1.address);
      a += wa; b += wb; if (ib) activeB = true;
      parts.push(`T1.${i + 1} A ${usd(wa)}${ia ? "*" : ""} B ${usd(wb)}${ib ? "*" : ""}`);
    }
    const seat2 = await pm2.holdsSeatIn(w1.address);
    const hi = await tr.memberHighestTier(w1.address);
    const debt = await sf.memberDebtOf(w1.address);
    console.log(`  [${tag}] pairs ${n} · ${parts.join(" · ")} · T2 seat ${seat2} · highestTier ${hi} · debt ${usd(debt)}   (* = active in that matrix)`);
    return { a, b, activeB, seat2 };
  }

  // 0. automation OFF first (fixture DP5 note: with it ON a crossing auto-upgrades W1 into T2)
  const o = await tr.memberOptions(w1.address);
  console.log(`W1 options: autoUpgradeDisabled ${o[0]} · autoReentryEnabled ${o[1]}`);
  if (!o[0] || o[1]) {
    const tx = await tr.setMemberOptions(true, false, false);
    console.log(`  setMemberOptions(true,false,false) tx ${tx.hash}`);
    await tx.wait();
    console.log("  mined");
  }

  if (MODE === "dp2") {
    let s2 = await stateDp2("start");
    if (s2.nz >= 2) { console.log("✅ READY (dp2) already — run prove_v856_dp2.js"); return; }
  }
  let s = MODE === "dp2" ? { seat2: false, activeB: false, a: 0n, b: 0n } : await state("start");
  if (s.seat2) { console.log("⛔ W1 already holds a T2 seat — DP5 shape is impossible on this subject. STOP."); return; }
  if (s.activeB && s.a > 0n && s.b > 0n) { console.log("✅ READY already — run prove_v856_debt.js"); return; }

  const mn = ethers.Mnemonic.fromPhrase(process.env.FILL_MNEMONIC);
  let done = 0, i = 0;
  while (done < MAX_REG && i < 500) {
    const idx = OFFSET + i; i++;
    const w = ethers.HDNodeWallet.fromMnemonic(mn, `m/44'/60'/0'/0/${idx}`).connect(provider);
    if (await tr.globalJoined(w.address)) continue;
    console.log(`\n#${done + 1}/${MAX_REG}  wallet ${w.address} (std ${idx})`);
    if ((await usdc.balanceOf(w.address)) < fee1) {
      const t = await usdc.transfer(w.address, fee1); await t.wait();
      console.log(`  USDC ${usd(fee1)} from W1  ${t.hash}`);
    }
    if ((await provider.getBalance(w.address)) < ETH_EACH / 2n) {
      const t = await w1.sendTransaction({ to: w.address, value: ETH_EACH }); await t.wait();
      console.log(`  ETH ${ethers.formatEther(ETH_EACH)} from W1  ${t.hash}`);
    }
    // ⛔ MEASURED 2026-09-18 (#2 of the first chunk): the ETH send was MINED, then approve() died
    //    "insufficient funds … have 0" — the load-balanced node read the new wallet before it saw the
    //    transfer. Never send from a just-funded wallet until the node SHOWS the funds.
    for (let k = 0; ; k++) {
      const eb = await provider.getBalance(w.address), ub = await usdc.balanceOf(w.address);
      if (eb > 0n && ub >= fee1) { if (k) console.log(`  funds visible after ${k} probe(s)`); break; }
      if (k >= 20) throw new Error(`funds still not visible for ${w.address} after 20 probes (ETH ${eb}, USDC ${ub})`);
      await sleep(3000);
    }
    const u = usdc.connect(w);
    const ta = await u.approve(A.tiers.T1.pm, fee1); await ta.wait();
    const trw = tr.connect(w);
    const g = await trw.register.estimateGas(w1.address);
    let gl = (g * 15n) / 10n; if (gl > 16_000_000n) gl = 16_000_000n;
    const tx = await trw.register(w1.address, { gasLimit: gl });
    const rc = await tx.wait();
    console.log(`  register(W1) ${tx.hash}  block ${rc.blockNumber}  status ${rc.status}  gas ${rc.gasUsed}`);
    done++;
    if (MODE === "dp2") {
      const s2 = await stateDp2(`after #${done}`);
      if (s2.nz >= 2) { console.log("\n✅ READY (dp2) — W1 holds earnings in at least two matrices. Next: prove_v856_dp2.js"); return; }
      continue;
    }
    s = await state(`after #${done}`);
    if (s.seat2) { console.log("⛔ W1 now holds a T2 seat — automation did not stay off? STOP and read."); return; }
    if (s.activeB && s.a > 0n && s.b > 0n) { console.log("\n✅ READY — W1 active in T1 MatB with earnings in MatA and MatB, no T2 seat. Next: prove_v856_debt.js"); return; }
  }
  console.log(`\nchunk done (${done} registered). NOT READY yet — run again for the next chunk.`);
}
main().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
