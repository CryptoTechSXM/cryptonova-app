"use strict";
/**
 * testchain_keeper.js — drives MatrixKeeper.performUpkeep on the V8.49 PRIVATE
 * measurement chain, and doubles as the instrument that answers test T4.
 *
 * ── WHY A NEW SCRIPT AND NOT run_keeper.js (2026-08-16) ────────────────────
 * run_keeper.js is a V8.6-era drain tool and every one of these would have bitten:
 *   :7   comment claims "performUpkeep has no access control" — untrue since
 *        V8.46 item 1 added the upkeepCaller allowlist.
 *   :28  signs with signers[1] (the funder), which is neither owner() nor
 *        allowlisted → every call reverts "MK: not authorized keeper".
 *   :21  defaults to deployed_addresses_v8_6.json.
 *   :100 pins a static gasLimit of 15_000_000 — CLAUDE.md forbids static limits
 *        on any cascade path and forbids clamping an estimate downward.
 *   :116 truncates the error to 120 chars and BREAKS the loop on first failure.
 *
 * That last one is disqualifying for this job. T4's pass condition is
 * "WorkItemFailed events appear and performUpkeep never reverts" — a driver that
 * truncates the error and exits on the first one cannot produce that answer.
 *
 * ── WHAT THIS DOES DIFFERENTLY ─────────────────────────────────────────────
 *  - Signs as signers[0] (the DEPLOYER = owner()), which performUpkeep always
 *    accepts. So the test chain needs NO setUpkeepCaller call at all, and the
 *    live VPS keeper EOA is never authorized anywhere near this deployment.
 *  - REFUSES to run without an explicit ADDRESSES_FILE. No literal default: a
 *    stale default is how this project has twice pointed a script at dead
 *    contracts and reported the output as fact.
 *  - estimateGas ladder (x1.15 → x1.05 → est), never a static limit.
 *  - A revert is COUNTED AND SURVIVED, never swallowed and never fatal. The full
 *    error is printed. A batch revert is the T4 FAIL signal, so it must be
 *    recorded rather than crashed on.
 *  - Appends one CSV row per tick to logs/testchain_keeper.csv, so T4 is
 *    answerable from a file afterwards and not from scrollback.
 *
 * ── KNOWN LIMIT, STATED SO NOBODY REDISCOVERS IT ───────────────────────────
 * WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1,
 * address addr2) carries NO reason string. This script can tell you WHICH item
 * was skipped and of what type; it cannot tell you WHY. To get the why, cross
 * the addresses against diag_floor_halt.js at a nearby block.
 *
 * Usage (PowerShell, repo root, its own window — leave it running):
 *   $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
 *   npx hardhat run scripts/testchain_keeper.js --network baseSepolia
 *
 * Optional: INTERVAL_SECS (default 60), MAX_TICKS (default 0 = run until Ctrl+C).
 */
require("./run_log");
require("./rpc_resilience");   // 29.2: Base Sepolia sheds state reads; retry + endpoint fail-over   // G.2 transcript -> logs/runs/testchain_keeper/
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── WHICH CHAIN? ───────────────────────────────────────────────────────────
// FIRST VERSION OF THIS GUARD WAS WRONG, AND IT IS WORTH KNOWING WHY (2026-08-16).
// It was `if (!process.env.ADDRESSES_FILE) refuse`. That never fires under
// `npx hardhat run`: hardhat.config.js:2 calls dotenv.config(), which populates
// ADDRESSES_FILE from .env BEFORE this file executes. Tested with the shell
// variable explicitly removed — the script started anyway and ran five ticks
// against the LIVE deployment as owner. A guard that cannot fire is worse than
// no guard, because the comment above it tells the next reader they are safe.
//
// The reliable question is not "is the variable set" (it always is) but "did a
// human name this chain, or did it fall out of .env". So: compare. In this repo
// .env names the LIVE deployment by definition, and this script exists to drive
// a TEST one, so inheriting .env's value is precisely the case to refuse.
// Deliberately compares at runtime and names no version — a literal here would
// go stale on the next deploy.
function dotenvAddressesFile() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const m = txt.match(/^\s*ADDRESSES_FILE\s*=\s*(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const REQUESTED   = process.env.ADDRESSES_FILE;
const ENV_DEFAULT = dotenvAddressesFile();

function refuse(lines) {
  console.error("");
  console.error("  REFUSING TO RUN.");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

if (!REQUESTED) {
  refuse([
    "ADDRESSES_FILE is not set.",
    "This script drives performUpkeep with the OWNER key. It will not guess",
    "which deployment that should be. Name it explicitly:",
    '  $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"',
  ]);
}

if (ENV_DEFAULT && REQUESTED === ENV_DEFAULT && process.env.ALLOW_LIVE !== "1") {
  refuse([
    `ADDRESSES_FILE is ${REQUESTED}, which is exactly what .env names.`,
    "That means it was INHERITED, not chosen — and .env names the LIVE",
    "deployment members are registered on. This keeper is for the private",
    "test chain; driving live upkeep from a laptop window is not its job.",
    "",
    "Name the test deployment in this shell:",
    '  $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"',
    "",
    "If you genuinely intend to drive the live chain, say so out loud:",
    "  $env:ALLOW_LIVE=\"1\"",
  ]);
}

const ADDRESSES_FILE = path.join(__dirname, REQUESTED);
const INTERVAL_SECS  = Number(process.env.INTERVAL_SECS || 60);
const MAX_TICKS      = Number(process.env.MAX_TICKS || 0); // 0 = forever
const CSV_PATH       = path.join(__dirname, "..", "logs", "testchain_keeper.csv");

const sleep = s => new Promise(r => setTimeout(r, s * 1000));
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// Read out of MatrixKeeper.sol:130-147. DO NOT edit this map from memory.
//
// The first version of this map was copied from run_keeper.js, which listed only
// 0-5 and had `3: "?"`. Claude filled that gap by GUESSING "FORCE_ROTATE".
// Type 3 is WORK_CHAIN_LINK; FORCE_ROTATE is 8. So chain-link work would have been
// mislabelled in the console AND in the CSV, and types 6-9 printed as bare numbers
// — including WORK_EVICT_PARKED (6), which is the event this whole test is
// watching for. A guessed label is worse than a missing one: a number invites a
// lookup, a wrong word does not.
const WORK_NAMES = {
  0: "VELOCITY",       // WORK_VELOCITY
  1: "GHOST",          // WORK_GHOST
  2: "RECLAIM",        // WORK_RECLAIM
  3: "CHAIN_LINK",     // WORK_CHAIN_LINK
  4: "PARKED_RESCUE",  // WORK_PARKED_RESCUE
  5: "VELOCITY_GATE",  // WORK_VELOCITY_GATE
  6: "EVICT_PARKED",   // WORK_EVICT_PARKED   <- T2/T3 watch for this one
  7: "DISTRIBUTE_CW",  // WORK_DISTRIBUTE_CW
  8: "FORCE_ROTATE",   // WORK_FORCE_ROTATE
  9: "ADVANCE_EPOCH",  // WORK_ADVANCE_EPOCH
};

function csvAppend(row) {
  try {
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH,
        "utc,tick,items,rescued,reclaimed,failed,gasUsed,reverted,note\n");
    }
    fs.appendFileSync(CSV_PATH, row + "\n");
  } catch (e) {
    console.error(`  (csv write failed: ${e.message})`);
  }
}

async function main() {
  const addrs      = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const keeperAddr = addrs.matrixKeeper || addrs.MatrixKeeper;
  if (!keeperAddr) throw new Error(`matrixKeeper not found in ${ADDRESSES_FILE}`);

  const [deployer] = await ethers.getSigners();
  const keeper = await ethers.getContractAt("MatrixKeeper", keeperAddr, deployer);

  // Establish authority BEFORE the loop, so "nothing happens" can never be
  // mistaken for "no work". An unauthorized caller reverts identically to a
  // quiet chain once the error is truncated — which is how the V8.48 deploy
  // day lost time (DEPLOY_V8_48_CARD 1.3c).
  const owner     = await keeper.owner();
  const allowed   = await keeper.upkeepCaller(deployer.address);
  const isOwner   = owner.toLowerCase() === deployer.address.toLowerCase();

  // 41.2: the gas FLOOR, read off the chain once — the ladder below needs it to tell
  // "the estimate priced the work" from "the estimate priced the HALT" without a human
  // remembering to set GAS_LIMIT. Never assume 5M or 7.5M; 40.3 is what assuming cost.
  const minGas    = await keeper.minGasPerItem();

  console.log("");
  console.log(`  addresses file : ${path.basename(ADDRESSES_FILE)}`);
  console.log(`  MatrixKeeper   : ${keeperAddr}`);
  console.log(`  signer         : ${deployer.address}`);
  console.log(`  keeper owner() : ${owner}`);
  console.log(`  signer is owner: ${isOwner}`);
  console.log(`  upkeepCaller   : ${allowed}`);
  console.log(`  minGasPerItem  : ${minGas} (read off THIS chain — the ladder's halt-vs-work line)`);
  console.log(`  interval       : ${INTERVAL_SECS}s   max ticks: ${MAX_TICKS || "unlimited"}`);
  console.log(`  csv            : ${CSV_PATH}`);

  if (!isOwner && !allowed) {
    console.error("");
    console.error("  REFUSING TO RUN: this signer is neither owner() nor allowlisted.");
    console.error("  performUpkeep would revert 'MK: not authorized keeper' on every tick,");
    console.error("  and the keeper would read that as out-of-gas and halve its batch cap");
    console.error("  forever. Nothing damaged, nothing working. See DEPLOY_V8_48_CARD 1.3c.");
    console.error("");
    process.exit(1);
  }
  console.log("");

  let tick = 0, totRescued = 0, totReclaimed = 0, totFailed = 0, totReverts = 0;

  for (;;) {
    if (MAX_TICKS && tick >= MAX_TICKS) break;
    tick++;

    let upkeepNeeded = false, performData = "0x";
    try {
      ({ upkeepNeeded, performData } = await keeper.checkUpkeep("0x"));
    } catch (e) {
      console.log(`[${stamp()}] tick ${tick}  checkUpkeep FAILED: ${e.message}`);
      csvAppend(`${stamp()},${tick},,,,,,0,checkUpkeep failed`);
      await sleep(INTERVAL_SECS);
      continue;
    }

    if (!upkeepNeeded) {
      console.log(`[${stamp()}] tick ${tick}  no work due`);
      csvAppend(`${stamp()},${tick},0,0,0,0,0,0,idle`);
      await sleep(INTERVAL_SECS);
      continue;
    }

    let items = [];
    try {
      [items] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["(uint8 workType,uint8 tierIdx,address addr1,address addr2)[]"], performData);
    } catch { /* keep going; the batch is still sendable */ }

    // ── ONE_ITEM=1 — THE GAS-PRICING MODE (GO_LIVE_RUNBOOK PHASE G, session 28) ──
    //
    // ⛔ WHY THIS EXISTS AND WHY IT IS NOT `maxItemsPerUpkeep = 1`. setMaxItemsPerUpkeep
    //    accepts 5|10|15|20|30|40 and NOTHING ELSE — a cap of 1 is not on the menu, so the
    //    obvious way to price one item does not exist. But performUpkeep decodes its work
    //    list straight from calldata and never checks that the list came from checkUpkeep,
    //    and the owner is always allowlisted. So a driver can simply send ONE item.
    //
    // ⛔ AND `gasUsed / items.length` IS NOT A PER-ITEM COST. The line further down does
    //    exactly that division and it is a fitted number, not a measurement: an eviction
    //    costs 1/18th of a rescue, so the average of a mixed batch describes nothing that
    //    happened. With one item per transaction the division is exact and the figure is
    //    real. That is the whole point of this mode.
    //
    // Takes the FIRST item only; checkUpkeep rediscovers the rest next tick, with fresh
    // state each time. Defect 6 orders discovery to take parked work FIRST, so the first
    // item is usually the dear one — which is the one the gate needs priced.
    // Set INTERVAL_SECS low (2-3) on a private chain, or this is one item per minute.
    if (process.env.ONE_ITEM === "1") {
      if (!items.length) {
        console.log(`[${stamp()}] tick ${tick}  ONE_ITEM: performData did not decode — sending the batch WHOLE.`);
        console.log(`            ⚠ THIS TICK CANNOT PRICE AN ITEM. Do not read its gas as a per-item cost.`);
      } else {
        // ⛔ MEASURED 2026-08-22, AND IT INVALIDATED A WHOLE 60-TICK RUN. The comment
        //    above says "defect 6 orders discovery to take parked work FIRST, so the
        //    first item is usually the dear one". ON THIS CHAIN IT IS NOT: item 0 was
        //    WORK_VELOCITY on all 60 ticks, with 19 PARKED_RESCUE items behind it that
        //    were never reached. Taking items[0] priced the wrong thing 60 times.
        //    ⚠ WHY that item never cleared is NOT the reason to distrust items[0] — on
        //    that run NOTHING was dispatched at all (see the GAS_LIMIT note below), so
        //    no item could clear. Whether WORK_VELOCITY is independently self-renewing
        //    is UNVERIFIED and worth its own measurement; do not assume it here.
        //    Either way the ordering assumption is refuted, so ONE_ITEM_TYPE names the
        //    work type to price instead of trusting the order.
        const want = (process.env.ONE_ITEM_TYPE || "").trim().toUpperCase();
        let pick = items[0], pickIdx = 0;
        if (want) {
          const idx = items.findIndex(i => (WORK_NAMES[Number(i.workType)] || "").toUpperCase() === want);
          if (idx < 0) {
            console.log(`[${stamp()}] tick ${tick}  ONE_ITEM_TYPE=${want}: none in this batch (${items.map(i => WORK_NAMES[Number(i.workType)]).join(",")}) — skipping tick rather than pricing the wrong item.`);
            await sleep(INTERVAL_SECS);
            continue;
          }
          pick = items[idx]; pickIdx = idx;
        }
        performData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["(uint8 workType,uint8 tierIdx,address addr1,address addr2)[]"],
          [[[pick.workType, pick.tierIdx, pick.addr1, pick.addr2]]]);
        const dropped = items.length - 1;
        items = [pick];
        if (dropped > 0) {
          console.log(`[${stamp()}] tick ${tick}  ONE_ITEM: item ${pickIdx} of ${dropped + 1} sent; ${dropped} left for the next tick.`);
        }
      }
    }

    const summary = items.length
      ? items.map(i => WORK_NAMES[Number(i.workType)] || String(i.workType)).join(",")
      : "(undecoded)";
    console.log(`[${stamp()}] tick ${tick}  ${items.length} item(s): ${summary}`);

    // ── estimateGas ladder. A reverting estimate is the contract saying the
    //    call cannot succeed — that is T4's FAIL signal, so capture the reason
    //    rather than burning gas to rediscover it.
    let est;
    try {
      est = await keeper.performUpkeep.estimateGas(performData);
    } catch (e) {
      totReverts++;
      console.error("");
      console.error(`  *** BATCH WOULD REVERT — T4 FAIL SIGNAL (revert #${totReverts}) ***`);
      console.error(`  ${e.message}`);
      console.error("");
      csvAppend(`${stamp()},${tick},${items.length},0,0,0,0,1,"estimate reverted"`);
      await sleep(INTERVAL_SECS);
      continue;
    }

    // ⛔⛔ WHY GAS_LIMIT EXISTS, MEASURED 2026-08-22 — READ BEFORE TRUSTING ANY
    //     estimateGas-SIZED performUpkeep ANYWHERE IN THIS SYSTEM.
    //     performUpkeep checks `gasleft() >= minGasPerItem` (5,000,000) BEFORE it
    //     dispatches an item; below that it emits BatchGasHalted and breaks — cleanly,
    //     SUCCESSFULLY and cheaply. eth_estimateGas binary-searches for the SMALLEST gas
    //     at which a call does not revert, and the halt path does not revert. So the
    //     estimate converges on the price of HALTING (~26k), the ladder rounds it to
    //     30,000, and the transaction is sent with far too little gas to do any work.
    //     It then SUCCEEDS, processes nothing, emits no WorkItemFailed, and leaves the
    //     queue exactly as it found it. Observed: 60 consecutive ticks, gasUsed 30000
    //     every time, status 1, rescued 0.
    //     Set GAS_LIMIT to something above minGasPerItem to price a real item.
    // ⛔ 41.2: WITHOUT GAS_LIMIT SET, THE TRAP DOCUMENTED ABOVE WAS STILL LIVE. Session 41's
    //    first G.4 run drove 120 ticks at gasUsed 30000 — the halt price — with ZERO work
    //    done and zero on-chain events except BatchGasHalted, because this guard only
    //    WARNED when GAS_LIMIT was already set (backwards: the person who set GAS_LIMIT
    //    is the one who already knew). The floor is now enforced by DEFAULT: an estimate
    //    below minGasPerItem (read off the chain at startup, never assumed) can only be
    //    the halt path, so the send is floored at minGasPerItem + 2M dispatch overhead.
    //    GAS_LIMIT still overrides everything, both directions.
    const FORCED = process.env.GAS_LIMIT ? BigInt(process.env.GAS_LIMIT) : null;
    let ladder;
    if (FORCED) {
      if (est < minGas) {
        console.log(`            ⚠ estimate ${est} < minGasPerItem ${minGas} — that is the BatchGasHalted price, not the item's.`);
        console.log(`              Sending GAS_LIMIT=${FORCED} instead so the batch can actually dispatch.`);
      }
      ladder = [ FORCED ];
    } else if (est < minGas) {
      // ⛔ 41.2b: the floor is the full 16.5M DRIVER BUDGET (31.4), NOT minGasPerItem + margin.
      //    First version of this fix floored at 9.5M; the same session then measured a real
      //    13.86M PARKED_RESCUE (tick 93, CSV 2026-08-25 22:05:50). A 9.5M send passes the
      //    7.5M pre-dispatch check, STARTS that item, and dies inside the try/catch as a
      //    reasonless WorkItemFailed — the exact silent failure the floor exists to prevent.
      //    An item that is allowed to start must be given the budget the worst observed item
      //    needs (live baseline max 14.67M; this chain measured 13.86M).
      const floored = 16_500_000n;
      console.log(`            ⚠ estimate ${est} < minGasPerItem ${minGas} — the estimate priced the HALT, not the work.`);
      console.log(`              Flooring the send at ${floored} (the 16.5M driver budget) so a dear item can FINISH. GAS_LIMIT overrides.`);
      ladder = [ floored ];
    } else {
      ladder = [ (est * 115n) / 100n, (est * 105n) / 100n, est ];
    }
    let receipt = null, lastErr = null;
    for (const gasLimit of ladder) {
      try {
        const tx = await keeper.performUpkeep(performData, { gasLimit });
        receipt = await tx.wait();
        break;
      } catch (e) {
        lastErr = e;
        const m = (e.message || "").toLowerCase();
        // Only step DOWN the ladder for an RPC gas-limit refusal. Anything else
        // is a real failure and retrying at a lower limit just buys an
        // out-of-gas revert instead of a clean refusal.
        if (!(m.includes("gas limit too high") || m.includes("-32003"))) break;
      }
    }

    if (!receipt) {
      totReverts++;
      console.error("");
      console.error(`  *** performUpkeep REVERTED — T4 FAIL SIGNAL (revert #${totReverts}) ***`);
      console.error(`  estimate was ${est}`);
      console.error(`  ${lastErr && lastErr.message}`);
      console.error("");
      csvAppend(`${stamp()},${tick},${items.length},0,0,0,${est},1,"send reverted"`);
      await sleep(INTERVAL_SECS);
      continue;
    }

    let rescued = 0, reclaimed = 0, failed = 0;
    const failedDetail = [];
    for (const log of receipt.logs) {
      let parsed = null;
      try { parsed = keeper.interface.parseLog(log); } catch { continue; }
      if (!parsed) continue;
      if (parsed.name === "ParkedRescued") rescued++;
      else if (parsed.name === "SlotReclaimed") reclaimed++;
      else if (parsed.name === "WorkItemFailed") {
        failed++;
        const wt = Number(parsed.args[0]);
        failedDetail.push(`${WORK_NAMES[wt] || wt}/T${Number(parsed.args[1]) + 1}`);
      }
    }
    totRescued += rescued; totReclaimed += reclaimed; totFailed += failed;

    // ── GAS PER ITEM, AND THE CEILING IT IS WALKING TOWARD ───────────────
    // Observed 2026-08-16: cost per rescue rose from ~600k (15 items, 9.0M) to
    // ~2.6M (5 items, 12.9M) as members began completing FULL journeys — pool
    // settlement, five levels of chain pay and a full destination distribution
    // instead of a partial one. At 2.6M/item a full maxItemsPerUpkeep=15 batch
    // projects to ~39M, and KEEPER_VPS_CONFIG puts the practical tx ceiling near
    // 17.8M. That is a batch failure with a GAS cause that would look exactly
    // like a floor failure in the results. Warn before it happens.
    // ⚠ EXACT under ONE_ITEM=1 (one item, one transaction). A FITTED AVERAGE otherwise —
    //   an eviction costs 1/18th of a rescue, so a mixed batch's mean describes nothing
    //   that happened. Only quote this as a per-item cost in ONE_ITEM mode.
    const perItem = items.length ? Number(receipt.gasUsed) / items.length : 0;
    const projected = perItem * 15;   // a full maxItemsPerUpkeep batch
    console.log(`            gas ${receipt.gasUsed}  rescued ${rescued}  reclaimed ${reclaimed}  skipped ${failed}` +
                (failedDetail.length ? `  [${failedDetail.join(" ")}]` : "") +
                (perItem ? `  (${Math.round(perItem / 1000)}k/item${process.env.ONE_ITEM === "1" ? " EXACT" : " avg"})` : ""));
    if (projected > 17_800_000) {
      console.log(`            *** GAS WARNING: ${Math.round(perItem / 1000)}k/item projects to ` +
                  `${(projected / 1e6).toFixed(1)}M for a full 15-item batch, above the ~17.8M`);
      console.log(`            practical tx ceiling. If a batch that size comes due it may fail for a`);
      console.log(`            GAS reason and look like a floor failure. Consider maxItemsPerUpkeep 5 or 10.`);
    }
    console.log(`            running: rescued ${totRescued}  reclaimed ${totReclaimed}  skipped ${totFailed}  REVERTS ${totReverts}`);
    csvAppend(`${stamp()},${tick},${items.length},${rescued},${reclaimed},${failed},${receipt.gasUsed},0,"${failedDetail.join(" ")}"`);

    await sleep(INTERVAL_SECS);
  }

  console.log("");
  console.log(`  stopped after ${tick} tick(s)`);
  console.log(`  rescued ${totRescued} · reclaimed ${totReclaimed} · skipped ${totFailed} · REVERTS ${totReverts}`);
  console.log(`  T4 PASSES only if REVERTS is 0.`);
}

main().catch(e => { console.error(e); process.exit(1); });
