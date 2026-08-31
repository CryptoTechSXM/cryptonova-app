// set_graduation.js — turn V8.50 item G (MatB graduation) ON or OFF, deliberately.
// Built 2026-08-31 (session 53).
//
// ⛔⛔ THIS SCRIPT SENDS A TRANSACTION. It is the only script in this session that does.
//     Everything it can reach is guarded, because the failure mode is flipping a routing
//     feature on a chain members are standing on:
//
//   1. ADDRESSES_FILE is REQUIRED — no default. A stale default drives a dead deployment
//      and reports the result as fact (47.7 item 7, and diag_headroom_stuck.js's header).
//   2. It PRINTS the TierRouter address and the addresses file, then requires
//      CONFIRM_TIER_ROUTER to match that address exactly. Naming a file is not enough:
//      the live chain and the pending release were BOTH called "V8.50" for a while, and a
//      wrong-deploy run has already cost this project a session (49.1d).
//   3. It reads the flag BEFORE and AFTER and prints both. A setter whose effect nobody
//      read is a setter nobody can trust — and `graduationEnabled` ships FALSE precisely
//      so that turning it on is a decision somebody makes on purpose.
//   4. If the flag is already at the requested value it does nothing and says so, rather
//      than spending a transaction to change nothing.
//
// ⚠ ITEM S IS NOT AFFECTED BY THIS FLAG AND HAS NO FLAG OF ITS OWN. rescueReentry's
//   _bothHalvesFull escape hatch is active from the moment the contracts are deployed.
//   Turning graduation off does NOT return the chain to pre-V8.51 routing.
//
// Run:
//   $env:ADDRESSES_FILE="deployed_addresses_v8_51_private.json"
//   $env:CONFIRM_TIER_ROUTER="0x..."      # must equal the router in that file
//   $env:ENABLE="true"                     # or "false"
//   npx hardhat run scripts/set_graduation.js --network baseSepolia

const path = require("path");
require("./rpc_resilience");   // Base Sepolia sheds state reads — see the read-back loop below
const { ethers } = require("hardhat");

const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || ""));

const TR_ABI = [
  "function graduationEnabled() view returns (bool)",
  "function setGraduationEnabled(bool enabled) external",
  "function owner() view returns (address)",
];

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
    process.exit(1);
  }
  const want = String(process.env.ENABLE || "").toLowerCase();
  if (want !== "true" && want !== "false") {
    console.log('FATAL: set ENABLE="true" or ENABLE="false" explicitly. No default — this is a routing change.');
    process.exit(1);
  }
  const target = !!(want === "true");

  const [signer] = await ethers.getSigners();
  const tr = new ethers.Contract(A.tierRouter, TR_ABI, signer);

  console.log("=".repeat(92));
  console.log("set_graduation.js — ⛔ THIS SENDS A TRANSACTION");
  console.log("addresses file :", process.env.ADDRESSES_FILE);
  console.log("TierRouter     :", A.tierRouter);
  console.log("signer         :", signer.address);
  console.log("requested      :", target);
  console.log("=".repeat(92));

  const confirm = (process.env.CONFIRM_TIER_ROUTER || "").trim();
  if (confirm.toLowerCase() !== A.tierRouter.toLowerCase()) {
    console.log("\n⛔ REFUSING TO SEND.");
    console.log("   CONFIRM_TIER_ROUTER does not match the router in the addresses file.");
    console.log(`   expected: ${A.tierRouter}`);
    console.log(`   got     : ${confirm || "(not set)"}`);
    console.log("\n   Set it to the address printed above, having checked it is the chain you mean:");
    console.log(`     $env:CONFIRM_TIER_ROUTER="${A.tierRouter}"`);
    process.exit(1);
  }

  let owner = null;
  try { owner = await tr.owner(); } catch { /* not fatal; the send will revert if wrong */ }
  if (owner) {
    console.log("owner          :", owner, owner.toLowerCase() === signer.address.toLowerCase() ? "✅ signer is owner" : "⚠ signer is NOT owner — expect a revert");
  }

  const before = await tr.graduationEnabled();
  console.log(`\ngraduationEnabled BEFORE : ${before}`);
  if (before === target) {
    console.log(`\n✅ Already ${target}. Nothing to do — not spending a transaction to change nothing.`);
    return;
  }

  console.log(`\nsending setGraduationEnabled(${target}) …`);
  const tx = await tr.setGraduationEnabled(target);
  console.log("  tx:", tx.hash);
  const rc = await tx.wait();
  console.log("  mined in block", rc.blockNumber, "status", rc.status);

  // ⛔⛔ THE READ-BACK MUST RETRY, AND THE FIRST VERSION OF THIS DID NOT — 2026-08-31.
  // A single bare read immediately after mining reported `false` on a transaction that had
  // ALREADY SET THE FLAG (status 1, block 46210522). Re-running the script seconds later
  // read `true`. Base Sepolia sheds state reads; that is why deploy_v8.js carries an
  // rpc_resilience layer and why it probes repeatedly for code at freshly deployed
  // addresses. A guard that cries wolf is as costly as one that hides a fault (session 45),
  // and this one nearly sent us hunting a storage-layout bug that did not exist.
  //
  // ⛔ IT IS BOUNDED AND IT REPORTS FAILURE HONESTLY. It does NOT loop until it gets the
  // answer it wants — that would be confirmation bias with a timer. If the flag never
  // matches within the window, a MINED transaction genuinely did not change state, which
  // is a contract-level problem and must be investigated, not retried.
  const PROBES = 10, GAP_MS = 3000;
  let after = null, probes = 0;
  for (let i = 1; i <= PROBES; i++) {
    probes = i;
    try { after = await tr.graduationEnabled(); } catch (e) {
      console.log(`  probe ${i}: read failed — ${(e.shortMessage || e.message || "").slice(0, 60)}`);
      after = null;
    }
    if (after === target) break;
    if (i < PROBES) {
      console.log(`  probe ${i}: reads ${after}, want ${target} — node is likely behind, waiting ${GAP_MS / 1000}s`);
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  }
  console.log(`\ngraduationEnabled AFTER  : ${after}   (settled after ${probes} probe${probes === 1 ? "" : "s"})`);
  if (after !== target) {
    console.log(`⛔⛔ THE FLAG DID NOT CHANGE after ${probes} probes over ~${(PROBES - 1) * GAP_MS / 1000}s.`);
    console.log("    The transaction MINED (status 1) and state did not move. That is NOT RPC lag at");
    console.log("    this point — investigate the contract before continuing. Do not describe item G");
    console.log("    as enabled, and do not send it again hoping for a different result.");
    process.exit(1);
  }
  console.log(`\n✅ Item G is now ${after ? "ON" : "OFF"} on ${A.tierRouter}.`);
  if (after) {
    console.log("   ⚠ Graduation only fires on genuine contention (crossingInProgress on a full MatA");
    console.log("     with a SOLVENT MatB root). An insolvent root still funding-parks first (G2),");
    console.log("     and with no pair having room it falls back to today's park and never reverts (G4).");
  }
  console.log("=".repeat(92));
}

main().catch((e) => { console.error(e); process.exit(1); });
