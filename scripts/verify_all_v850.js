// verify_all_v850.js — verify EVERY V8.50 contract on BaseScan. Continues past
// already-verified entries and past failures, then prints a summary.
//
//   npx hardhat run scripts/verify_all_v850.js --network baseSepolia
//
// ⛔ WHY THIS EXISTS AND WHY IT IS URGENT (session 44, 2026-08-27).
// MetaMask shows "Malicious site detected — you could lose all your assets" on
// admin.crypto-nova.app AND on www.crypto-nova.app (owner-verified). That is the
// Blockaid flag. CLAUDE.md's post-deploy section records the same thing happening
// on 2026-07-30 and names the trigger: an UNVERIFIED contract asking a fresh domain's
// visitors for token spending caps is the textbook shape of a drainer. The cure has a
// MANDATORY ORDER — verify the contracts FIRST, then submit the domain + addresses to
// report.blockaid.io/mistake, so the re-scan sees clean contracts and the de-list
// sticks. A de-list requested while the contracts are still unverified re-scans dirty.
//
// ⚠ THE TRAP THIS SCRIPT WAS WRITTEN TO AVOID. Its predecessor verify_all_v846.js
// hard-codes SPLITS as [500,1350,1800,500,300,100,50,50,50,50]. V8.47 CHANGED THEM
// (community 50→100, buyback/liquidity 50→25). Copying that file forward would have
// passed wrong constructor args and failed on all 20 matrices with an error that says
// nothing about why. Every constant below is copied from scripts/deploy_v8.js — the
// script that actually deployed these addresses — and must be re-checked against it
// whenever deploy_v8.js changes. Two copies of one fact, no mechanism to keep them
// equal, is a recurring failure in this codebase; this comment is the mechanism.
//
// V8.50 also has THREE libraries where V8.46 had one. Each linked contract must be
// verified with its own `libraries` map or BaseScan cannot match the bytecode:
//   TierRouterLib   -> TierRouter
//   MatrixLogicLib  -> MatrixPairFactory, FigureEightMatrixV8 (every MatA/MatB)
//   MatrixKeeperLib -> MatrixKeeper
const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const file = process.env.ADDRESSES_FILE || "deployed_addresses_v8_50.json";
  const A = JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
  console.log(`\nVerifying from ${file}  (deployed ${A.deployedAt || "?"})\n`);

  // ── constants, mirroring scripts/deploy_v8.js :131-166 and :862-865 ────────
  const MSIZE  = Number(process.env.MATRIX_SIZE || 127);
  const SPLITS = [500, 1350, 1800, 500, 300, 100, 50, 100, 25, 25];  // V8.47 values
  const CHAIN  = [270, 270, 270, 270, 270, 0];                        // sums to 1350
  const FEES   = ["10000000","25000000","50000000","100000000","250000000",
                  "500000000","1000000000","2500000000","5000000000","10000000000"];
  const DS_SF_TARGET = process.env.DS_SF_TARGET || "500000000";   // $500
  const DS_LQ_TARGET = process.env.DS_LQ_TARGET || "1000000000";  // $1,000
  const COUPON_AMT   = process.env.COUPON_AMOUNT || "10000000";   // $10
  const ZERO = "0x0000000000000000000000000000000000000000";

  const { usdc, cnova, treasury, stabilityFund: sf, buybackReserve: bbr,
          tierRouter: tr, matrixKeeper: keeper, admin, devWallet, opsWallet,
          accountOne, liquidityReserve } = A;
  const libs = A.libraries || {};
  const matrixLib = libs.MatrixLogicLib, trLib = libs.TierRouterLib, kLib = libs.MatrixKeeperLib;
  if (!matrixLib || !trLib || !kLib) {
    console.log("  ! addresses file is missing one of the three library addresses — "
              + "linked contracts cannot be verified without them.");
  }

  // The DeployParams struct FigureEightMatrixV8 takes as its first constructor arg.
  const dp = { usdc, cnova, treasury, devWallet, opsWallet, accountOne, admin };

  const jobs = [];
  const P = (name, address, args, libraries) => jobs.push({ name, address, args, libraries });

  P("CNOVAToken",          cnova,             [A.deployer || admin]);
  P("CNOVATreasury",       treasury,          [cnova, usdc, admin]);
  P("StabilityFund",       sf,                [usdc, admin]);
  P("CNOVABuybackReserve", bbr,               [usdc, cnova, ZERO, ZERO, admin]);
  P("TierRouterLib",       trLib,             []);
  P("TierRouter",          tr,                [usdc, admin], { TierRouterLib: trLib });
  P("MatrixFactory",       A.matrixFactory,   [admin, tr, sf, ZERO]);
  P("MatrixLogicLib",      matrixLib,         []);
  P("MatrixPairFactory",   A.pairFactory,     [admin, usdc, cnova, treasury], { MatrixLogicLib: matrixLib });
  P("MatrixKeeperLib",     kLib,              []);
  P("MatrixKeeper",        keeper,            [tr, sf], { MatrixKeeperLib: kLib });
  P("V8Governance",        A.v8Governance,    [cnova, tr, keeper]);
  P("CommunityWallet",     A.communityWallet, [usdc, admin]);
  P("CouponRegistry",      A.couponRegistry,  [usdc, COUPON_AMT]);
  P("CNOVADirectSale",     A.directSale,
    [usdc, cnova, treasury, sf, liquidityReserve, DS_SF_TARGET, DS_LQ_TARGET]);

  for (let t = 1; t <= 10; t++) {
    const tier = (A.tiers && A.tiers["T" + t]) || A["T" + t];
    if (!tier || !tier.pm) { console.log(`  ! tier T${t} not in ${file} — skipped`); continue; }
    const fee = FEES[t - 1], idx = t - 1;
    P(`PairManagerV8 T${t}`, tier.pm,   [usdc, fee, admin]);
    P(`MatA T${t}`,          tier.matA, [dp, fee, MSIZE, true,  idx, SPLITS, CHAIN], { MatrixLogicLib: matrixLib });
    P(`MatB T${t}`,          tier.matB, [dp, fee, MSIZE, false, idx, SPLITS, CHAIN], { MatrixLogicLib: matrixLib });
  }

  let ok = 0, already = 0, fail = 0, skipped = 0;
  const failures = [];
  for (const j of jobs) {
    if (!j.address) { console.log(`  SKIP ${j.name} (no address in file)`); skipped++; continue; }
    try {
      await hre.run("verify:verify", {
        address: j.address,
        constructorArguments: j.args,
        libraries: j.libraries,
      });
      // ⚠ hardhat's verify task does NOT throw for an already-verified contract — it
      // prints "has already been verified" and returns normally. The first run of this
      // script therefore counted 30 pre-existing verifications as fresh and reported
      // "verified 45 · already 0", which was wrong. There is no return value to inspect,
      // so the honest summary is a single total rather than a fabricated split.
      console.log(`  OK       ${j.name}  ${j.address}`); ok++;
    } catch (e) {
      const m = (e && e.message) || String(e);
      if (/already verified/i.test(m)) { console.log(`  ALREADY  ${j.name}  ${j.address}`); already++; }
      else {
        console.log(`  FAIL     ${j.name}  ${j.address}\n           ${m.split("\n")[0]}`);
        fail++; failures.push(j.name);
      }
    }
  }

  console.log(`\n  ${ok} verified or already-verified · ${fail} failed · ${skipped} skipped`);
  console.log(`  (hardhat does not distinguish the two, so this is deliberately one number)`);
  if (fail) {
    console.log(`  failed: ${failures.join(", ")}`);
    const allMatrices = failures.length && failures.every(n => /^Mat[AB] T/.test(n));
    if (allMatrices) {
      console.log("\n  ⚠ EVERY failure is a matrix. That is the signature of drifted");
      console.log("    constructor constants — re-check SPLITS / CHAIN / MSIZE in this");
      console.log("    file against scripts/deploy_v8.js before debugging anything else.");
    }
  }
  console.log("\n  NEXT, ONLY ONCE THIS IS CLEAN: submit the domains + these addresses to");
  console.log("  report.blockaid.io/mistake so the re-scan sees verified contracts.\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
