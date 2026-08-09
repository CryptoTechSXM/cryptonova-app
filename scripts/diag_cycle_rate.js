// diag_cycle_rate.js — why does one wallet cycle 6x while another cycles once?
//
// Sherwyn, 2026-08-08 (BUGS.md): 0x001d82.. has 6 T1 cycles, 0x7d3c94.. has 1,
// and his T2 cycles faster than his T1. Expectation was that T1 cycles fastest
// because every registration enters there.
//
// MECHANIC (MatrixLogicLib): _cycleOutRoot cycles the member at POSITION 1, and
// every rotation advances each member one seat toward it. So cycle rate is set
// by (a) the seat you were given and (b) whether YOUR matrix is still receiving
// entries. Registrations route to the OLDEST NON-SATURATED pair, so once a pair
// saturates it stops rotating and its members stop advancing.
//
// This prints, per wallet, which T1 pair/matrix holds them, their seat, that
// matrix's occupancy + rotationCount, and their recorded cycles.
//
// Run: npx hardhat run scripts/diag_cycle_rate.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const WALLETS = (process.env.WALLETS ||
  "0x001d82fb20dc3b947f7023f198eee009533538a3,0x7d3c94885d2022200934d4908bca7b47905bbcf6"
).split(",").map(s => s.trim());

const PM  = ["function pairCount() view returns (uint256)",
             "function getPairAt(uint256) view returns (address,address)",
             "function routeEntryThreshold() view returns (uint256)"];
const MX  = ["function matrixPos(address) view returns (uint256)",
             "function occupancy() view returns (uint256)",
             "function rotationCount() view returns (uint256)",
             "function MATRIX_SIZE() view returns (uint256)",
             "function partner() view returns (address)",
             "function chainNext() view returns (address)",
             "function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 crossingReserve,uint256 cyclesCompleted,bool isInMatrix,bool hasGraduated))"];
const TR  = ["function tierCycles(address,uint8) view returns (uint256)",
             "function memberHighestTier(address) view returns (uint8)"];

async function main() {
  const pm = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const tr = await ethers.getContractAt(TR, A.tierRouter);
  const n  = Number(await pm.pairCount());
  let route = null; try { route = Number(await pm.routeEntryThreshold()); } catch (_) {}

  console.log(`T1 has ${n} pair(s). routeEntryThreshold = ${route ?? "n/a"}\n`);

  const mats = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = await pm.getPairAt(i);
    for (const [label, addr] of [[`T1.${i + 1} MatA`, a], [`T1.${i + 1} MatB`, b]]) {
      const m = await ethers.getContractAt(MX, addr);
      const [occ, rot, size] = await Promise.all([m.occupancy(), m.rotationCount(), m.MATRIX_SIZE()]);
      let partner = null, chainNext = null;
      try { partner   = await m.partner(); }   catch (_) {}
      try { chainNext = await m.chainNext(); } catch (_) {}
      mats.push({ label, addr, m, occ: Number(occ), rot: Number(rot), size: Number(size), partner, chainNext });
    }
  }

  console.log("MATRIX STATE");
  for (const x of mats) {
    console.log(`  ${x.label.padEnd(12)} occ ${String(x.occ).padStart(4)}/${x.size}  rotations ${String(x.rot).padStart(5)}`);
  }

  for (const w of WALLETS) {
    console.log(`\n──── ${w}`);
    console.log(`  highest tier: T${Number(await tr.memberHighestTier(w))}   ` +
                `router tierCycles(T1)=${Number(await tr.tierCycles(w, 0))}  T2=${Number(await tr.tierCycles(w, 1))}`);
    let found = false;
    for (const x of mats) {
      const pos = Number(await x.m.matrixPos(w));
      if (pos === 0) continue;
      found = true;
      const mem = await x.m.getMember(w);
      const toRoot = pos - 1;
      console.log(`  ${x.label}: seat ${pos}/${x.size}  cyclesCompleted ${Number(mem.cyclesCompleted)}  inMatrix ${mem.isInMatrix}`);
      console.log(`     ${toRoot} more rotation(s) until this seat reaches position 1 and cycles out.`);
      const nm = a => { const f = mats.find(y => y.addr.toLowerCase() === String(a).toLowerCase()); return f ? f.label : a; };
      console.log(`     this matrix feeds cycle-outs to: ${x.chainNext && x.chainNext !== ethers.ZeroAddress ? nm(x.chainNext) + '  (chainNext SET)' : nm(x.partner) + '  (partner - chainNext unset)'}`);
    }
    if (!found) console.log("  not seated in any T1 matrix right now (graduated, parked, or between re-entries)");
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
