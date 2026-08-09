// unfreeze_matA.js — raise T1 routeEntryThreshold so rescueReentry returns own MatA.
//
// WHY (2026-08-09): PairManagerV8.rescueReentry (:286) still tests the CUMULATIVE
// counter `p.totalRegistered >= routeEntryThreshold` and sends saturated pairs'
// rescued members into their own MatB forever. V8.46 identified this exact bug
// and fixed it in TierRouter._sameTierTarget (now always-own-MatA) but MISSED
// this second call site. Result: T1.1 MatA + T1.2 MatA frozen, 254 members stuck.
//
// Raising routeEntryThreshold above any reachable totalRegistered makes the test
// false, so rescueReentry returns p.matrixA and MatA starts rotating again.
// V8.46 proved the technique on the sibling knob: "raising the threshold to
// 1,000,000 forced always-MatA behaviour and every MatA resumed rotating within
// seconds, integrity clean across 19+ hours."
//
// SIDE EFFECT (accepted): _findExternalPair (:581) shares this knob, so new
// registrations route to pair 0 (T1.1 MatA). That is additive here — it rotates
// the frozen matrix — but newer pairs stop receiving externals until reverted.
//
// PRECONDITION: pause route_rr.js on the VPS first. Line 156 of PairManagerV8
// notes T1's routeEntryThreshold is walked at runtime by that keeper, which
// would overwrite this on its next tick.
//
// Read-only by default:
//   npx hardhat run scripts/unfreeze_matA.js --network baseSepolia
// Apply:
//   APPLY=1 npx hardhat run scripts/unfreeze_matA.js --network baseSepolia
//   APPLY=1 NEW_ROUTE=1000000 npx hardhat run scripts/unfreeze_matA.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const APPLY     = process.env.APPLY === "1";
const NEW_ROUTE = BigInt(process.env.NEW_ROUTE || "1000000");

const PM = ["function deployEntryThreshold() view returns (uint256)",
            "function routeEntryThreshold() view returns (uint256)",
            "function setEntryThresholds(uint256,uint256)",
            "function owner() view returns (address)",
            "function allPairsStatus() view returns (address[],address[],uint256[],uint256[],uint256[],bool[])"];
const MX = ["function rotationCount() view returns (uint256)"];

async function snapshot(pm) {
  const [As, Bs, occA, occB, reg] = await pm.allPairsStatus();
  const thr = await pm.routeEntryThreshold();
  const out = [];
  for (let i = 0; i < As.length; i++) {
    const a = await ethers.getContractAt(MX, As[i]);
    const b = await ethers.getContractAt(MX, Bs[i]);
    out.push({ i, regs: Number(reg[i]), rotA: Number(await a.rotationCount()), rotB: Number(await b.rotationCount()),
               occA: Number(occA[i]), occB: Number(occB[i]),
               targetsMatB: Number(reg[i]) >= Number(thr) });
  }
  return out;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const pm = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const owner = await pm.owner();
  const [dep, route] = await Promise.all([pm.deployEntryThreshold(), pm.routeEntryThreshold()]);

  console.log(`T1 PairManager ${A.tiers.T1.pm}`);
  console.log(`  owner   ${owner}`);
  console.log(`  signer  ${signer.address}  ${owner.toLowerCase() === signer.address.toLowerCase() ? "(OWNER OK)" : "*** NOT OWNER — will revert ***"}`);
  console.log(`  deployEntryThreshold ${dep}`);
  console.log(`  routeEntryThreshold  ${route}   -> proposed ${NEW_ROUTE}`);
  if (NEW_ROUTE < dep) throw new Error("setEntryThresholds requires _route >= _deploy");

  console.log(`\nBEFORE:`);
  const before = await snapshot(pm);
  for (const p of before)
    console.log(`  T1.${p.i + 1}  reg ${String(p.regs).padStart(5)}  occ ${p.occA}/${p.occB}` +
                `  rotA ${String(p.rotA).padStart(5)}  rotB ${String(p.rotB).padStart(5)}` +
                `  rescueReentry -> ${p.targetsMatB ? "MatB  (FROZEN MatA)" : "MatA  (healthy)"}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing sent. Re-run with APPLY=1 to set the threshold.`);
    console.log(`Reminder: pause route_rr.js on the VPS first or it will overwrite this.`);
    return;
  }

  console.log(`\nsending setEntryThresholds(${dep}, ${NEW_ROUTE}) ...`);
  const tx = await pm.setEntryThresholds(dep, NEW_ROUTE);
  console.log(`  tx ${tx.hash}`);
  await tx.wait();

  const after = await pm.routeEntryThreshold();
  console.log(`  routeEntryThreshold now ${after}`);
  const post = await snapshot(pm);
  console.log(`\nAFTER:`);
  for (const p of post)
    console.log(`  T1.${p.i + 1}  rescueReentry -> ${p.targetsMatB ? "MatB  *** STILL FROZEN ***" : "MatA  (unfrozen)"}`);
  console.log(`\nNow watch rotA climb — re-run scripts/diag_pair_starvation.js in a few minutes.`);
  console.log(`If rotA does NOT move, the rescue path is not the only blocker and we stop and re-diagnose.`);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
