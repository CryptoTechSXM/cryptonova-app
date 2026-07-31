// Verify ALL V8.46 contracts on BaseScan. Continues past already-verified / errors.
// Run: npx hardhat run scripts/verify_all_v846.js --network baseSepolia
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const A = JSON.parse(fs.readFileSync(
    path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_46.json"), "utf8"));

  // Deploy constants (from deploy_v8.js / deploy output)
  const admin      = "0xCd0Af6a4116f2062c1594aDf34c1821D45175506";
  const devWallet  = "0x7fc2158892F14b9A1fB6e39B788d4d08daF49C0a";
  const opsWallet  = "0xa23A0492A823a2FfB6D3998dDd487695F5ba4019";
  const accountOne = "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435";
  const liquidityReserve = "0x961fDE5C78200891f36858B2940a2B6d4F1Af854";
  const matrixLib  = A.matrixLib || "0xf2E24Edd81831099b733c62D0Df70B5c7D145fD4";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const usdc=A.usdc, cnova=A.cnova, treasury=A.treasury, sf=A.stabilityFund,
        bbr=A.buybackReserve, tr=A.tierRouter, keeper=A.matrixKeeper;

  const MSIZE = 127;
  const SPLITS = [500,1350,1800,500,300,100,50,50,50,50];
  const CHAIN = [270,270,270,270,270,0];
  const FEES = ["10000000","25000000","50000000","100000000","250000000",
                "500000000","1000000000","2500000000","5000000000","10000000000"];
  const dp = { usdc, cnova, treasury, devWallet, opsWallet, accountOne, admin };

  const jobs = [];
  const P = (name, address, args, libs) => jobs.push({ name, address, args, libs });

  P("CNOVAToken", cnova, [admin]);
  P("CNOVATreasury", treasury, [cnova, usdc, admin]);
  P("StabilityFund", sf, [usdc, admin]);
  P("CNOVABuybackReserve", bbr, [usdc, cnova, ZERO, ZERO, admin]);
  P("TierRouter", tr, [usdc, admin]);
  P("MatrixFactory", A.matrixFactory, [admin, tr, sf, ZERO]);
  P("MatrixLogicLib", matrixLib, []);
  P("MatrixPairFactory", A.pairFactory, [admin, usdc, cnova, treasury], { MatrixLogicLib: matrixLib });
  P("MatrixKeeper", keeper, [tr, sf]);
  P("V8Governance", A.v8Governance, [cnova, tr, keeper]);
  P("CommunityWallet", A.communityWallet, [usdc, admin]);
  P("CouponRegistry", A.couponRegistry, [usdc, "10000000"]);
  P("CNOVADirectSale", A.directSale, [usdc, cnova, treasury, sf, liquidityReserve, "500000000", "1000000000"]);

  for (let t = 1; t <= 10; t++) {
    const tier = (A.tiers && A.tiers["T"+t]) || A["T"+t];
    if (!tier || !tier.pm) { console.log("  ! tier T"+t+" not found in addresses file"); continue; }
    const fee = FEES[t-1], idx = t-1;
    P(`PairManagerV8 T${t}`, tier.pm, [usdc, fee, admin]);
    P(`MatA T${t}`, tier.matA, [dp, fee, MSIZE, true,  idx, SPLITS, CHAIN], { MatrixLogicLib: matrixLib });
    P(`MatB T${t}`, tier.matB, [dp, fee, MSIZE, false, idx, SPLITS, CHAIN], { MatrixLogicLib: matrixLib });
  }

  let ok=0, already=0, fail=0;
  for (const j of jobs) {
    if (!j.address) { console.log(`  SKIP ${j.name} (no address)`); continue; }
    try {
      await hre.run("verify:verify", { address: j.address, constructorArguments: j.args, libraries: j.libs });
      console.log(`  OK   ${j.name}  ${j.address}`); ok++;
    } catch (e) {
      const m = (e.message||"").toLowerCase();
      if (m.includes("already verified") || m.includes("already been verified")) { console.log(`  =    ${j.name} already verified`); already++; }
      else { console.log(`  FAIL ${j.name}: ${(e.message||"").split("\n")[0].slice(0,110)}`); fail++; }
    }
  }
  console.log(`\n  DONE — newly verified ${ok}, already ${already}, failed ${fail}, of ${jobs.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
