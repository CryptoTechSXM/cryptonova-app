// cw_distribute.js — RUN THE COMMUNITY WALLET'S MONTHLY DISTRIBUTION BY HAND.
//
// THE DEFECT THIS WORKS AROUND (found 2026-08-25, session 40, from an owner report that the
// dashboard had said "Distribution ready to trigger" for 12 hours instead of giving members
// something to claim):
//
//   `MatrixKeeperLib.discover()` fills a work list and stops at `maxItemsPerUpkeep`.
//   ON THE DEPLOYED V8.48 LIBRARY (commit 6211928, 2026-08-13) the order is:
//       VELOCITY -> ... -> FORCE_ROTATE -> _scanMatrix(matA) + _scanMatrix(matB)  <- UNBOUNDED
//       -> VELOCITY_GATE -> WORK_DISTRIBUTE_CW                                    <- LAST
//   and the CW item is only added `if (count < cfg.maxItems)`. Live runs `maxItemsPerUpkeep`
//   15 against a parked queue in the hundreds, so the two unbounded scans can take every slot
//   and work type 7 is never discovered. `distributeReady()` stays true forever, the badge is
//   CORRECT, and nothing ever calls distribute().
//
//   ⛔ THE FIX ALREADY EXISTS AND IS NOT ON THE LIVE CHAIN. Commit 2ca0927 (2026-08-17) moved
//   the CW block ABOVE both scans precisely because "WORK_ADVANCE_EPOCH has a CALENDAR
//   deadline (the 25th) and used to sit dead last, behind two unbounded scans". V8.48 was
//   deployed 2026-08-13 — FOUR DAYS EARLIER. That reorder ships with V8.50.
//   ⚠ It is an ORDER, not a parameter, so NO setter can fix the live chain. Until V8.50,
//   the distribution must be triggered by hand (or by a monthly cron) on the 25th.
//
// WHY THIS IS SAFE FOR ANYONE TO RUN: `CommunityWallet.distribute()` is `external` with NO
// role gate in the DEPLOYED code (checked at commit c9a1ffc, the V8.48 CW) — its own comment
// says "Callable by anyone on or after distributionDayOfMonth, once per month". Its only
// requirement is `totalEnrolled > 0`. It is idempotent by calendar: the gate refuses a second
// run in the same month, so a duplicate call reverts rather than double-paying.
//
// ⛔ READ-ONLY UNLESS `ARM=1`. Without it this reports and changes nothing.
//
// Run (read-only first, ALWAYS):
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/cw_distribute.js --network baseSepolia
//
// Then, to actually send it:
//   ARM=1 ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/cw_distribute.js --network baseSepolia
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.log("  (34.1's trap, and 39.4's: a dead addresses file on a script that moves money.)");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
const ARM = process.env.ARM === "1";

// WHO=1 — answer "who actually ran the distribution", from the chain rather than from
// memory. Added 2026-08-25 because distributionCount went 0 -> 1 between two runs and the
// honest answer to "was that me or the keeper?" was NOT ESTABLISHED. It matters: if the
// KEEPER sent it, the starvation diagnosis in the header is wrong (or only intermittent),
// and a wrong diagnosis left in a header is quoted as fact by later sessions.
//   WHO=1 ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/cw_distribute.js --network baseSepolia
const WHO = process.env.WHO === "1";

const CW_ABI = [
  "function distribute() external",
  "function distributeReady() view returns (bool)",
  "function distributionDayOfMonth() view returns (uint8)",
  "function distributionCount() view returns (uint256)",
  "function totalEnrolled() view returns (uint256)",
  "function claimable(address) view returns (uint256)",
];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

const usd = (v) => "$" + (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 39.5's lesson: ONE READ IS NOT A MEASUREMENT against an RPC that can serve stale state.
 *  Retry, and pin to the mined block so a lagging node ERRORS instead of quietly answering
 *  about an earlier one. A false alarm on a live fix costs the same trust as a missed failure. */
async function readBack(cw, blockTag) {
  for (let i = 0; i < 6; i++) {
    try {
      return {
        ready: await cw.distributeReady({ blockTag }),
        count: await cw.distributionCount({ blockTag }),
      };
    } catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 1700));
    }
  }
}

async function main() {
  if (!A.communityWallet) { console.log("FATAL: addresses file has no 'communityWallet'."); process.exit(1); }
  const [signer] = await ethers.getSigners();
  const cw   = new ethers.Contract(A.communityWallet, CW_ABI, signer);
  const usdc = new ethers.Contract(A.usdc, USDC_ABI, signer);

  console.log(`addresses file  ${process.env.ADDRESSES_FILE}`);
  console.log(`communityWallet ${A.communityWallet}`);
  console.log(`signer          ${await signer.getAddress()}   (distribute() needs no role)`);

  if (WHO) {
    // The deployed CW emits DistributionExecuted(distId, actualDist, perGenesis,
    // perPioneer, gCount, pCount) — CommunityWallet.sol:149/349 at commit c9a1ffc.
    const ev = new ethers.Contract(A.communityWallet, [
      "event DistributionExecuted(uint256 indexed distId, uint256 amount, uint256 perGenesis, uint256 perPioneer, uint256 genesisCount, uint256 pioneerCount)",
    ], signer.provider);
    const KEEPER = "0xd419681BA72992636f05e256168681c939826B4b"; // the one authorised upkeepCaller (39.2)
    const latest = await signer.provider.getBlockNumber();
    let logs = [];
    // chunked: the public endpoint caps eth_getLogs ranges.
    for (let to = latest; to > 0 && logs.length === 0; to -= 40000) {
      const from = to - 40000 > 0 ? to - 40000 : 0;
      try { logs = await ev.queryFilter(ev.filters.DistributionExecuted(), from, to); } catch (e) {
        console.log(`  (range ${from}-${to} failed: ${e.shortMessage || e.message})`);
      }
      if (from === 0) break;
    }
    console.log(`\nWHO RAN THE DISTRIBUTION — ${logs.length} DistributionExecuted event(s) found`);
    for (const l of logs) {
      const tx = await signer.provider.getTransaction(l.transactionHash);
      const who = tx ? tx.from : "?";
      const tag = who === "?" ? "" :
        who.toLowerCase() === KEEPER.toLowerCase() ? "   <- THE KEEPER (starvation diagnosis would be WRONG)" :
        who.toLowerCase() === (await signer.getAddress()).toLowerCase() ? "   <- this signer (a human ran it by hand)" : "   <- someone else";
      console.log(`  distId ${l.args?.distId}  block ${l.blockNumber}  amount ${usd(l.args?.amount ?? 0n)}`);
      console.log(`    tx   ${l.transactionHash}`);
      console.log(`    from ${who}${tag}`);
    }
    if (logs.length === 0) console.log("  none found in the scanned range — widen it before concluding anything.");
    return;
  }

  const [ready, day, count, enrolled, bal] = await Promise.all([
    cw.distributeReady(), cw.distributionDayOfMonth(), cw.distributionCount(),
    cw.totalEnrolled(), usdc.balanceOf(A.communityWallet),
  ]);
  const now = new Date();
  console.log(`\nSTATE`);
  console.log(`  distributeReady()        ${ready}`);
  console.log(`  distributionDayOfMonth   ${day}      (today is the ${now.getUTCDate()}, UTC)`);
  console.log(`  distributionCount()      ${count}`);
  console.log(`  totalEnrolled()          ${enrolled}`);
  console.log(`  USDC held by the CW      ${usd(bal)}`);

  if (!ready) {
    console.log(`\n-> distributeReady() is FALSE. Nothing to do: either this month's distribution`);
    console.log(`   has already run (distributionCount above), or the 25th has not arrived.`);
    return;
  }
  if (enrolled === 0n) {
    console.log(`\n⛔ totalEnrolled() is 0 — distribute() would revert "CW: no members enrolled".`);
    return;
  }

  // Prove it succeeds BEFORE spending gas, and surface the real revert if not.
  try {
    await cw.distribute.staticCall();
    console.log(`\n  staticCall: WOULD SUCCEED`);
  } catch (e) {
    console.log(`\n⛔ staticCall REVERTS -> ${e.reason || e.shortMessage || e.message}`);
    console.log(`   Not sending. Investigate before arming.`);
    return;
  }

  if (!ARM) {
    console.log(`\n  DRY RUN — nothing sent. Re-run with ARM=1 to distribute.`);
    return;
  }

  console.log(`\n  ARMED — sending distribute()...`);
  const tx = await cw.distribute();
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  block ${rc.blockNumber}   status ${rc.status}`);
  if (rc.status !== 1) { console.log(`⛔ status != 1. Stop.`); return; }

  const after = await readBack(cw, rc.blockNumber);
  console.log(`\nAFTER (pinned to block ${rc.blockNumber})`);
  console.log(`  distributeReady()   ${after.ready}    (expected false — it has now run this month)`);
  console.log(`  distributionCount() ${after.count}    (expected ${count + 1n})`);
  if (after.ready === false && after.count === count + 1n) {
    console.log(`\n✅ DISTRIBUTION RAN. The pending pool is now per-member claimable —`);
    console.log(`   members should see a claim amount instead of "ready to trigger".`);
  } else {
    console.log(`\n⚠ Read-back did not match expectations. Re-read before telling anybody.`);
  }
  console.log(`\n⛔ THIS IS A WORKAROUND, NOT THE FIX. The live keeper still cannot discover`);
  console.log(`   work type 7 (see the header). It will need doing again next month unless`);
  console.log(`   V8.50 has shipped by then, or a monthly cron is added on the droplet.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
