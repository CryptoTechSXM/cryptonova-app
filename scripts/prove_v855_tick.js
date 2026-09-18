// scripts/prove_v855_tick.js — session 92 (62.70). ONE keeper tick on the PRIVATE V8.56 chain, to PAY
// the parked rescue that V8.55 discovery released once the fund's spendable covered it.
//
// Signs with the DEPLOYER, which is MatrixKeeper.owner() — performUpkeep accepts owner() directly
// (MatrixKeeper ~:934), so no keeper EOA, no VPS sandbox, and no nonce clash with the live keeper
// 0xd419… that the VPS fleet signs with. ⛔ The deployer IS shared with live VPS jobs (R17): run only
// while /root/keeper/rr_keeper.OFF + system_keeper.OFF are in place.
//
// Refuses unless checkUpkeep (read now) contains a PARKED_RESCUE for MEMBER. Prints the queue, the
// member / fund / debt BEFORE, sends performData exactly as checkUpkeep returned it, then reads every
// figure again AT THE RECEIPT BLOCK and decodes the receipt's keeper / fund events.
//
// Run (PC, contracts repo):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"; $env:MEMBER="0x…"
//   npx hardhat run scripts/prove_v855_tick.js --network baseSepolia
const path = require("path");
const { ethers, artifacts } = require("hardhat");

const BOOK = process.env.ADDRESSES_FILE || "";
if (BOOK !== "deployed_addresses_v8_56_private.json") {
  console.error(`REFUSING: ADDRESSES_FILE must be deployed_addresses_v8_56_private.json (got "${BOOK}"). Private chain only.`);
  process.exit(1);
}
// MEMBER optional: unset = the queue must hold EXACTLY ONE PARKED_RESCUE, and that member is the subject.
let MEMBER = (process.env.MEMBER || "").trim();
if (MEMBER && !/^0x[0-9a-fA-F]{40}$/.test(MEMBER)) { console.error("MEMBER must be a full address, or unset."); process.exit(1); }
const A = require(path.join(__dirname, BOOK));
const NAMES = ["VELOCITY", "GHOST", "RECLAIM", "CHAIN_LINK", "PARKED_RESCUE", "VELOCITY_GATE",
               "EVICT_PARKED", "DISTRIBUTE_CW", "FORCE_ROTATE", "ADVANCE_EPOCH"];
const usd = v => "$" + (Number(v) / 1e6).toFixed(6);

async function main() {
  const [signer] = await ethers.getSigners();
  const mk  = await ethers.getContractAt("MatrixKeeper", A.matrixKeeper, signer);
  const sf  = await ethers.getContractAt("StabilityFund", A.stabilityFund);
  const owner = await mk.owner();
  console.log(`prove_v855_tick  book ${BOOK}  signer ${signer.address}  MK owner ${owner}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) { console.error("⛔ signer is not MatrixKeeper.owner() — performUpkeep would revert. STOP."); process.exit(1); }

  const head = await ethers.provider.getBlockNumber();
  const [needed, pd] = await mk.checkUpkeep("0x", { blockTag: head });
  if (!needed) { console.error(`⛔ checkUpkeep says no work at block ${head}. STOP.`); process.exit(1); }
  const items = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"], pd)[0];
  console.log(`queue at block ${head}: ${items.length} item(s)`);
  let matrix = null;
  const rescues = items.filter(it => Number(it.workType) === 4);
  for (const it of items) console.log(`  ${NAMES[Number(it.workType)] || it.workType}  tier ${it.tierIndex}  ${it.addr1}  ${it.addr2}`);
  if (!MEMBER) {
    if (rescues.length !== 1) { console.error(`⛔ MEMBER unset and the queue holds ${rescues.length} PARKED_RESCUE items (need exactly 1). Nothing sent.`); process.exit(1); }
    MEMBER = rescues[0].addr2;
    console.log(`subject (the one PARKED_RESCUE): ${MEMBER}`);
  }
  for (const it of rescues) if (it.addr2.toLowerCase() === MEMBER.toLowerCase()) matrix = it.addr1;
  if (!matrix) { console.error(`⛔ no PARKED_RESCUE for ${MEMBER} in the queue. Nothing sent.`); process.exit(1); }
  const mat = await ethers.getContractAt("FigureEightMatrixV8", matrix);

  async function snap(tag, blockTag) {
    const o = { blockTag };
    const bal = await sf.totalBalance(o), fl = await sf.stabilityFloor(o);
    const r = {
      parked: await mat.isParked(MEMBER, o), pcount: await mat.getParkedCount(o),
      occ: await mat.occupancy(o), rot: await mat.rotationCount(o),
      bal, fl, debt: await sf.memberDebtOf(MEMBER, o),
    };
    console.log(`  [${tag} @${blockTag}] member parked ${r.parked} · matrix occ ${r.occ} rot ${r.rot} parked ${r.pcount} · ` +
                `SF ${usd(bal)} floor ${usd(fl)} spendable ${usd(bal > fl ? bal - fl : 0n)} · member debt ${usd(r.debt)}`);
    return r;
  }
  const before = await snap("BEFORE", head);

  // ⛔ MEASURED 2026-09-18 (first run, tx 0xab7e9220…, block 47000359): gasLimit = estimate x 1.5 sent
  // 143,239 gas and the batch did NOTHING — BatchGasHalted(0, 2, 113061). performUpkeep refuses to START an
  // item with gasleft() < minGasPerItem (7.5M) and exits cleanly, so estimateGas finds that cheap no-op
  // path and reports ~95k. AN ESTIMATE OF A SELF-HALTING BATCH IS AN ESTIMATE OF THE HALT.
  // Fixed limit, as direct_keeper.js does (15M; the measured per-tx ceiling is 2^24 = 16,777,216).
  const mgpi = await mk.minGasPerItem();
  const gl = 15_000_000n;
  console.log(`\nminGasPerItem ${mgpi} · items ${items.length} · gasLimit ${gl} (fixed)`);
  const tx = await mk.performUpkeep(pd, { gasLimit: gl });
  console.log(`performUpkeep sent ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`mined block ${rc.blockNumber} · status ${rc.status} · gas ${rc.gasUsed}\n`);

  // ABIs straight from the artifacts (a linked-library factory cannot be built without addresses).
  // MatrixLogicLib is included because its events are emitted from the MATRIX via delegatecall.
  const ifaces = [];
  for (const n of ["MatrixKeeper", "StabilityFund", "FigureEightMatrixV8", "MatrixLogicLib"]) {
    try { ifaces.push(new ethers.Interface((await artifacts.readArtifact(n)).abi)); } catch { console.log(`  (no artifact for ${n})`); }
  }
  let n = 0;
  for (const lg of rc.logs) {
    let shown = false;
    for (const i of ifaces.filter(Boolean)) {
      try {
        const d = i.parseLog(lg); if (!d) continue;
        if (["ParkedRescued", "RescueOverflowed", "MemberEntered", "WorkItemFailed", "FrozenMatBRotated", "MemberDebtIncreased", "RescueLoanIssued",
             "MemberParked", "MemberCycledOut", "BatchGasHalted"].includes(d.name)) {
          console.log(`  log ${lg.index}: ${d.name}(${d.args.map(x => typeof x === "bigint" && x > 1000n ? `${x} (${usd(x)})` : String(x)).join(", ")})`);
        }
        shown = true; n++; break;
      } catch {}
    }
  }
  console.log(`  (${rc.logs.length} logs, ${n} decoded; only the rescue-relevant names are printed)\n`);
  // The first run died here: "block not found" — the read node had not reached the receipt block yet.
  let after = null;
  for (let k = 1; k <= 10 && !after; k++) {
    try { after = await snap("AFTER ", rc.blockNumber); }
    catch (e) { console.log(`  (AFTER read ${k}: ${(e.shortMessage || e.message).slice(0, 60)} — retrying in 3s)`); await new Promise(r => setTimeout(r, 3000)); }
  }
  if (!after) { console.log("⛔ AFTER state UNREAD after 10 tries — the tx above is mined; re-read with diag_parked_verdict, do NOT resend."); return; }
  console.log(`\nΔ SF balance ${usd(after.bal - before.bal)} · Δ member debt ${usd(after.debt - before.debt)} · member parked ${before.parked} -> ${after.parked}`);
}
main().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
