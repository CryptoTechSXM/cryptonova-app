// diag_pair_starvation.js — why do saturated pairs' MatA stop rotating?
//
// PairManagerV8.rescueReentry (:285):
//     dest = p.totalRegistered >= routeEntryThreshold ? p.matrixB : p.matrixA;
// So once a pair passes routeEntryThreshold, ALL of its own rescues/re-entries
// go to its MatB. New externals have already moved on to the next pair via
// _findExternalPair. Net effect: a saturated pair's MatA receives NOTHING, stops
// rotating, and everyone seated in it stops advancing (Sherwyn, 2026-08-08).
//
// Run: npx hardhat run scripts/diag_pair_starvation.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const PM = ["function allPairsStatus() view returns (address[],address[],uint256[],uint256[],uint256[],bool[])",
            "function routeEntryThreshold() view returns (uint256)",
            "function getActivePair() view returns (address,address,uint256,uint256)"];
const MX = ["function rotationCount() view returns (uint256)",
            "function getParkedCount() view returns (uint256)",
            "function chainNext() view returns (address)"];

async function main() {
  const pm = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const [As, Bs, occA, occB, reg, active] = await pm.allPairsStatus();
  const thr = Number(await pm.routeEntryThreshold());
  let act = null; try { const r = await pm.getActivePair(); act = Number(r[2]); } catch (_) {}

  console.log(`routeEntryThreshold = ${thr}   active routing pair = T1.${act === null ? "?" : act + 1}\n`);
  const name = a => {
    for (let i = 0; i < As.length; i++) {
      if (As[i].toLowerCase() === String(a).toLowerCase()) return `T1.${i + 1} MatA`;
      if (Bs[i].toLowerCase() === String(a).toLowerCase()) return `T1.${i + 1} MatB`;
    }
    return String(a).slice(0, 10) + "…";
  };

  for (let i = 0; i < As.length; i++) {
    const saturated = Number(reg[i]) >= thr;
    const a = await ethers.getContractAt(MX, As[i]);
    const b = await ethers.getContractAt(MX, Bs[i]);
    const [ra, rb, pa, pb, cnA, cnB] = await Promise.all([
      a.rotationCount(), b.rotationCount(),
      a.getParkedCount().catch(() => 0n), b.getParkedCount().catch(() => 0n),
      a.chainNext().catch(() => null), b.chainNext().catch(() => null),
    ]);
    console.log(`T1.${i + 1}  registered ${String(reg[i]).padStart(5)} / ${thr}` +
                `  ${saturated ? "SATURATED -> own rescues go to MatB ONLY" : "below threshold -> rescues return to MatA"}`);
    console.log(`     MatA  occ ${String(occA[i]).padStart(3)}  rotations ${String(ra).padStart(5)}  parked ${String(pa).padStart(3)}  -> ${name(cnA)}`);
    console.log(`     MatB  occ ${String(occB[i]).padStart(3)}  rotations ${String(rb).padStart(5)}  parked ${String(pb).padStart(3)}  -> ${name(cnB)}`);
    if (saturated) {
      const ratio = Number(ra) > 0 ? (Number(rb) / Number(ra)).toFixed(1) : "inf";
      console.log(`     >>> MatB has rotated ${ratio}x MatA. Members in MatA advance only when`);
      console.log(`         the ring returns someone from ${name(cnB === null ? null : undefined)}the previous matrix.`);
    }
    console.log("");
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
