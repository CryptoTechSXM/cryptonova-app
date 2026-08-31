// diag_tx_events.js — DECODE EVERY EVENT IN A TRANSACTION, IN ORDER, WITH THE EMITTER NAMED.
// READ-ONLY: no signer, nothing sent. Built 2026-08-31 (session 53).
//
// WHY THIS EXISTS
// ───────────────
// V8.50 item G (MatB graduation) SHIPS WITHOUT AN EVENT OF ITS OWN — 50.4 added a view, a
// library branch and a flag, and no emit. Item S was given `RescueOverflowed` deliberately,
// with the reason written down (49.1f): "a silent routing change is one nobody can measure."
// That is exactly the position item G is in, so the only way to identify a graduation on
// chain is to read the whole event sequence of the transaction and recognise the shape.
//
// THE SHAPE OF A GRADUATION (fixture G1, V8_50_Graduation.test.js):
//     P1.MatA  MemberCycledOut          incumbent
//     P1.MatA  MemberCrossedToPartner   -> P1.MatB
//     P1.MatB  MemberCycledOut          root R_B
//     P2.MatA  MemberEntered            R_B            <- GRADUATED (the tell)
//     TierRtr  MemberReentered          R_B
//     P1.MatB  MemberEntered            R_A
//     P1.MatA  MemberEntered            ARRIVAL        <- and the arrival KEEPS its seat
//
// ⛔ WHAT IT IS NOT: a duplicate re-route (`_freePairFor`) also lands a member in a later
//    pair and is NOT item G. It is distinguishable because the member was already seated in
//    the pair they re-entered — so look for the member ALSO holding a seat elsewhere, and for
//    the absence of the MatB cycle-out immediately above the later-pair entry.
// ⛔ AND IT IS NOT ITEM S: that always carries a RescueOverflowed in the same transaction.
//
// This script does not classify for you. It prints the sequence and names the contracts, so
// the judgement is made on evidence you can re-check on BaseScan. A classification nobody
// can re-check is not evidence (noseat_witness.js's rule, carried over deliberately).
//
// Run: ADDRESSES_FILE=deployed_addresses_v8_51_private.json TX=0x…,0x… \
//      npx hardhat run scripts/diag_tx_events.js --network baseSepolia

const path = require("path");
require("./rpc_resilience");
const { ethers } = require("hardhat");

const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || ""));

// ⛔ EVENT SIGNATURES ARE READ FROM THE COMPILED ARTIFACTS, NOT HAND-WRITTEN — 2026-08-31.
// The first version of this script listed signatures from memory and most of them were
// WRONG, so a 104-log transaction printed as a wall of "not in this script's ABI list".
// The trace was still readable by shape, which is luck rather than design: a decoder that
// silently fails to decode is the same failure family as a monitor that reports a job it
// cannot see as ALIVE. Artifacts cannot drift from the deployed source the way my memory of
// a signature can — and if a contract is missing from this list it says so out loud.
const ARTIFACTS = [
  "FigureEightMatrixV8", "PairManagerV8", "TierRouter", "TierRouterLib", "MatrixLogicLib",
  "MatrixKeeper", "MatrixKeeperLib", "MatrixPairFactory", "MatrixFactory", "StabilityFund",
  "CNOVATreasury", "CNOVAToken", "CommunityWallet", "CNOVABuybackReserve", "CNOVADirectSale",
  "CouponRegistry", "V8Governance", "MockUSDC",
];

async function buildInterface(hre) {
  const frags = new Map();          // topicHash -> fragment, so duplicates collapse
  const missing = [];
  for (const name of ARTIFACTS) {
    let art;
    try { art = await hre.artifacts.readArtifact(name); }
    catch { missing.push(name); continue; }
    const i = new ethers.Interface(art.abi);
    i.forEachEvent(ev => { if (!frags.has(ev.topicHash)) frags.set(ev.topicHash, ev.format("full")); });
  }
  if (missing.length) console.log(`  ⚠ artifacts not found (run 'npx hardhat compile'): ${missing.join(", ")}`);
  console.log(`  event signatures loaded: ${frags.size} from ${ARTIFACTS.length - missing.length} artifact(s)`);
  return new ethers.Interface([...frags.values()]);
}

const PM_ABI = [
  "function pairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];

async function main() {
  if (!process.env.ADDRESSES_FILE) { console.log("FATAL: ADDRESSES_FILE not set."); process.exit(1); }
  const txs = (process.env.TX || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!txs.length) { console.log('FATAL: set TX="0x…,0x…"'); process.exit(1); }

  const p = ethers.provider;

  // ── Build an address -> label map so every log line names its emitter. ──────
  const label = new Map();
  const put = (addr, name) => { if (addr && addr !== ethers.ZeroAddress) label.set(addr.toLowerCase(), name); };
  put(A.tierRouter, "TierRouter");
  put(A.matrixKeeper, "MatrixKeeper");
  put(A.stabilityFund, "StabilityFund");
  put(A.treasury, "Treasury");
  put(A.cnova, "CNOVA");
  put(A.usdc, "USDC");
  put(A.communityWallet, "CommunityWallet");
  for (const tk of Object.keys(A.tiers || {})) {
    const t = A.tiers[tk];
    put(t.pm, `${tk} PairManager`);
    try {
      const pm = new ethers.Contract(t.pm, PM_ABI, p);
      const n = Number(await pm.pairCount());
      for (let i = 0; i < n; i++) {
        const [a, b] = await pm.getPairAt(i);
        put(a, `${tk}.${i + 1} MatA`);
        put(b, `${tk}.${i + 1} MatB`);
      }
    } catch {
      put(t.matA, `${tk}.1 MatA`);
      put(t.matB, `${tk}.1 MatB`);
      console.log(`  ⚠ ${tk}: pair enumeration failed — later pairs will show as raw addresses, not as unknown-but-named.`);
    }
  }

  const iface = await buildInterface(require("hardhat"));

  for (const tx of txs) {
    console.log("\n" + "=".repeat(100));
    console.log("tx:", tx);
    let rc;
    try { rc = await p.getTransactionReceipt(tx); }
    catch (e) { console.log("  ⛔ receipt read FAILED:", (e.shortMessage || e.message || "").slice(0, 90)); continue; }
    if (!rc) { console.log("  ⛔ no receipt — wrong network, or not mined."); continue; }
    console.log(`block ${rc.blockNumber}   status ${rc.status}   logs ${rc.logs.length}   from ${rc.from}`);
    console.log("-".repeat(100));
    for (const lg of rc.logs) {
      const who = label.get(lg.address.toLowerCase()) || lg.address;
      let d = null;
      try { d = iface.parseLog({ topics: [...lg.topics], data: lg.data }); } catch { /* not one of ours */ }
      if (!d) { console.log(`  ${who.padEnd(18)} ⚠ UNDECODED topic ${lg.topics[0].slice(0, 14)}… — no artifact in ARTIFACTS declares it`); continue; }
      const args = d.fragment.inputs.map(inp => {
        const v = d.args[inp.name];
        if (["shortfall", "amount", "sfShare", "fee"].includes(inp.name)) return `${inp.name}=$${(Number(v) / 1e6).toFixed(2)}`;
        return `${inp.name}=${v}`;
      }).join("  ");
      console.log(`  ${who.padEnd(18)} ${d.name.padEnd(24)} ${args}`);
    }
  }
  console.log("\n" + "=".repeat(100));
  console.log("READ IT AS A SEQUENCE, NOT A SET. The order is the finding: which matrix cycled out,");
  console.log("who crossed, and WHO ENDED UP IN THE LATER PAIR. If a MatB root cycles out and appears");
  console.log("in the NEXT pair's MatA with no RescueOverflowed in the tx, that is item G graduating.");
  console.log("=".repeat(100));
}

main().catch((e) => { console.error(e); process.exit(1); });
