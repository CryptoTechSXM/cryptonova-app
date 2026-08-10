// diag_climb_ceiling.js — how far can a wallet actually climb, and what stops it?
//
// Written 2026-08-10 while designing the bigfill ladder-climb change (owner:
// "Reg + climb ladder to highest possible tier / self rescue / upgrade eligible
// and climb ladder to highest possible tier").
//
// THE CLIMB IS NOT GATED BY FUNDS. TierRouter already has the ladder primitive —
// bulkUpgrade(targetTierIndex), V8.35: ONE transaction through multiple tiers,
// seating the member in each tier's MatA. What bounds it is the WHALE GATE:
//
//   TierRouter._isTierUnlockedForManualEntry(tierNum)      (:1536)
//     tierNum <= 1  -> true
//     tierNum <= 5  -> tierWhaleGateActive[5]     // T2-T5 SHARE T5's gate
//     tierNum >= 6  -> tierWhaleGateActive[tierNum]
//
//   bulkUpgrade (:1049) requires the three-way eligibility for the FIRST tier
//   entered, then EVERY tier beyond it must have its gate open, or the whole
//   call reverts TRGate. It is ALL-OR-NOTHING: aiming one tier too high does not
//   climb as far as it can, it climbs nowhere.
//
// So the caller must compute the ceiling from the gates BEFORE sending, which is
// what this prints. Read-only — sends nothing.
//
// Run: npx hardhat run scripts/diag_climb_ceiling.js --network baseSepolia
//   WALLETS=0xabc,0xdef   override the sample
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const TR = [
  // NOTE: tierEntryFees and tierPairManagers are PUBLIC ARRAYS
  //   address[MAX_TIERS] public tierPairManagers;   (TierRouter:208)
  //   uint256[MAX_TIERS] public tierEntryFees;      (TierRouter:209)
  // Solidity generates their getters with a uint256 index. Declaring uint8 here
  // produces a DIFFERENT SELECTOR and the call reverts. tierCycles is a nested
  // mapping keyed (address, uint8) so that one really is uint8. Getting this wrong
  // is how the first version of this script printed "$0.00" for every tier fee.
  "function isWhaleGateActiveForTier(uint8) view returns (bool)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function memberHighestTier(address) view returns (uint8)",
  "function globalJoined(address) view returns (bool)",
  "function tierCycles(address,uint8) view returns (uint256)",
  "function tierPairManagers(uint256) view returns (address)",
];
const PM = [
  "function holdsSeatIn(address) view returns (bool)",
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX = ["function isActiveInMatrix(address) view returns (bool)"];

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);

async function main() {
  const p  = ethers.provider;
  const trAddr = A.tierRouter || A.TierRouter;
  const tr = new ethers.Contract(trAddr, TR, p);
  console.log("\n  TierRouter:", trAddr);

  console.log("\n  -- WHALE GATES (what actually bounds a climb) --");
  const gate = {};
  // null means READ FAILED and is printed as such — never collapsed into "SHUT",
  // which would read as a design state rather than a broken instrument.
  for (let t = 2; t <= 10; t++) {
    try { gate[t] = await tr.isWhaleGateActiveForTier(t); }
    catch { gate[t] = null; }
  }
  const t5 = gate[5];
  console.log(`    T5 gate (shared by T2-T5): ${t5 === null ? "READ FAILED" : t5 ? "OPEN" : "SHUT"}`);
  for (let t = 6; t <= 10; t++)
    console.log(`    T${t} gate:                  ${gate[t] === null ? "READ FAILED" : gate[t] ? "OPEN" : "SHUT"}`);

  let ceiling = 1;
  if (t5) { ceiling = 5; for (let t = 6; t <= 10; t++) { if (gate[t]) ceiling = t; else break; } }
  console.log(`\n    => SYSTEM CEILING: T${ceiling}` +
    (ceiling === 1 ? "  (no gate open -- a climb can only ever be ONE tier, via cycle/MatB eligibility)" : ""));

  console.log("\n  -- TIER FEES --");
  // NO .catch(() => 0n) HERE. The first version had one, the ABI was wrong, every read
  // reverted, and the catch turned all ten into "$0.00" — a confident, plausible,
  // completely false table. A failed read must never come back wearing a value.
  const fees = [];
  let feeReadFailed = false;
  for (let i = 0; i < 10; i++) {
    try { fees.push(await tr.tierEntryFees(i)); }
    catch (e) { fees.push(null); feeReadFailed = true; }
  }
  console.log("    " + fees.map((f, i) => `T${i + 1}=${f === null ? "READ FAILED" : usd(f)}`).join("  "));
  if (feeReadFailed) {
    console.log("\n    !! FEE READS FAILED — costs below are meaningless. Fix the ABI before trusting them.");
  }

  const sample = (process.env.WALLETS || [A.accountOne, A.w1, A.W1].filter(Boolean).join(","))
    .split(",").map(s => s.trim()).filter(Boolean);

  console.log("\n  -- PER-WALLET --");
  for (const w of sample) {
    const joined = await tr.globalJoined(w).catch(() => false);
    if (!joined) { console.log(`    ${w.slice(0, 10)}...  NOT REGISTERED`); continue; }

    const highest  = Number(await tr.memberHighestTier(w));
    const startIdx = highest;
    if (startIdx >= 10) { console.log(`    ${w.slice(0, 10)}...  already at T10`); continue; }

    const prevIdx = startIdx - 1;
    let why = null;
    if (prevIdx >= 0 && Number(await tr.tierCycles(w, prevIdx).catch(() => 0n)) >= 1) why = "cycle done in prev tier";
    if (!why && (startIdx + 1 <= 1 || (startIdx + 1 <= 5 ? t5 : gate[startIdx + 1]))) why = "gate open";
    if (!why && prevIdx >= 0) {
      const pmAddr = await tr.tierPairManagers(prevIdx);
      if (pmAddr && pmAddr !== ethers.ZeroAddress) {
        const pm = new ethers.Contract(pmAddr, PM, p);
        const n  = Number(await pm.pairCount());
        for (let i = 0; i < n; i++) {
          const [, matB] = await pm.getPairAt(i);
          if (matB !== ethers.ZeroAddress &&
              await new ethers.Contract(matB, MX, p).isActiveInMatrix(w)) { why = "seated in prev MatB"; break; }
        }
      }
    }

    const reach = why ? Math.max(highest, ceiling) : highest;
    let cost = 0n;   // null if any fee read failed
    for (let i = startIdx; i < reach; i++) {
      const pmAddr = await tr.tierPairManagers(i);
      if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
      if (await new ethers.Contract(pmAddr, PM, p).holdsSeatIn(w)) continue;
      if (fees[i] === null) { cost = null; break; }   // refuse to total unknown numbers
      cost += fees[i];
    }

    console.log(`    ${w.slice(0, 10)}...  at T${highest}  ->  can reach T${reach}` +
      `  | eligible: ${why || "NO -- needs a cycle or a MatB seat in T" + highest}` +
      `  | bulkUpgrade cost ${cost === null ? "UNKNOWN (fee read failed)" : usd(cost)}`);
  }

  console.log("\n  Note: bulkUpgrade is ALL-OR-NOTHING. Aiming above the ceiling reverts TRGate");
  console.log("  and climbs nothing, so bigfill must target the computed ceiling, never guess.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
