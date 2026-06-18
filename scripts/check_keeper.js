/**
 * check_keeper.js — Verify Chainlink Automation upkeep for MatrixKeeper
 *
 * Calls checkUpkeep() off-chain and decodes what work the keeper would do.
 * Optionally simulates performUpkeep to estimate gas.
 *
 * Usage:
 *   npx hardhat run scripts/check_keeper.js --network baseSepolia
 *
 * Env vars (optional):
 *   SIMULATE=1   also simulate performUpkeep (eth_call, no broadcast)
 */
"use strict";

const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_4.json"
);

// Chainlink Automation Forwarder on Base Sepolia (set during registration)
const FORWARDER = "0x0F3D52A70944057F2DBe5240aBCed780b9e0989c";
const UPKEEP_ID = "29802696590350738260077195732332106184812507599584460488978836629170228097183";

const WORK_NAMES = { 0: "VELOCITY_CHECK", 1: "GHOST_ENTRY", 2: "RECLAIM_SLOT", 3: "CHAIN_LINK" };

const fmt6  = n  => "$" + (Number(n) / 1e6).toFixed(2);
const sep   = lbl => lbl
  ? console.log(`\n  ── ${lbl} ${"─".repeat(Math.max(0, 54 - lbl.length))}`)
  : console.log(`  ${"─".repeat(60)}`);

async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`  ERR  ${ADDRESSES_FILE} not found`);
    process.exit(1);
  }

  const addrs  = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const keeper = await ethers.getContractAt("MatrixKeeper", addrs.matrixKeeper);
  const tr     = await ethers.getContractAt("TierRouter",   addrs.tierRouter);
  const sf     = await ethers.getContractAt("StabilityFund", addrs.stabilityFund);
  const T1     = addrs.tiers.T1;
  const T2     = addrs.tiers.T2;

  sep("MatrixKeeper — Chainlink upkeep health check");
  console.log(`  Keeper:    ${addrs.matrixKeeper}`);
  console.log(`  Forwarder: ${FORWARDER}`);
  console.log(`  Upkeep ID: ${UPKEEP_ID.slice(0, 20)}…`);
  sep();

  // ── Keeper config ────────────────────────────────────────────────────────────
  sep("Keeper config");
  const velWindow    = await keeper.velocityWindow();
  const velThreshold = await keeper.velocityThreshold();
  const defThreshold = await keeper.deflationThreshold();
  const idleTimeout  = await keeper.idleSlotTimeout();
  const maxItems     = await keeper.maxItemsPerUpkeep();
  const lastVelCheck = await keeper.lastVelocityCheck();
  const defState     = await keeper.deflationState();
  const tierCount    = await keeper.configuredTierCount();
  const defStateNames = ["NORMAL", "SLOW", "RECOVERY"];

  console.log(`  Velocity window:     ${velWindow}s (${Number(velWindow)/3600}h)`);
  console.log(`  Velocity threshold:  ${velThreshold} entries/window/tier`);
  console.log(`  Deflation threshold: ${defThreshold} entries/window (system-wide)`);
  console.log(`  Idle slot timeout:   ${idleTimeout}s (${Number(idleTimeout)/3600}h)`);
  console.log(`  Max items/upkeep:    ${maxItems}`);
  console.log(`  Deflation state:     ${defStateNames[Number(defState)] || defState}`);
  console.log(`  Configured tiers:    ${tierCount}`);

  // Last velocity check
  const now = BigInt(Math.floor(Date.now() / 1000));
  const velAge = now - lastVelCheck;
  const nextVelCheck = lastVelCheck + velWindow;
  const velDue = nextVelCheck <= now;
  console.log(`  Last velocity check: ${velAge}s ago ${velDue ? "⚡ DUE NOW" : `(next in ${Number(nextVelCheck - now)}s)`}`);

  // PairManager wiring
  sep("PairManager wiring");
  for (let t = 0; t < 2; t++) {
    const pm = await keeper.pairManagerForTier(t);
    const status = pm === ethers.ZeroAddress ? "❌ NOT SET" : `✓  ${pm}`;
    console.log(`  Tier ${t + 1} PM: ${status}`);
  }

  // ── Velocity data ────────────────────────────────────────────────────────────
  sep("Velocity (last hour)");
  const windowStart = Number(now) - Number(velWindow);
  try {
    for (let t = 0; t < 2; t++) {
      const cnt   = await tr.getTierEntryCount(t, windowStart);
      const green = await tr.tierVelocityGreen(t);
      const mark  = green ? "🟢" : "🔴";
      console.log(`  T${t + 1}: ${cnt} entries  ${mark} ${green ? "green" : "RED"}`);
    }
    const sysCnt = await tr.getSystemEntryCount(windowStart);
    console.log(`  System total: ${sysCnt} entries (deflation threshold: ${defThreshold})`);
  } catch (e) {
    console.log(`  (velocity query failed: ${e.message.slice(0, 60)})`);
  }

  // ── StabilityFund balance ────────────────────────────────────────────────────
  sep("StabilityFund");
  try {
    const sfBal = await sf.totalBalance();
    console.log(`  Total balance: ${fmt6(sfBal)}`);
    const mkAuth = await sf.matrixKeeper ? await sf.matrixKeeper() : "n/a";
    console.log(`  Keeper authorized: ${mkAuth.toLowerCase() === addrs.matrixKeeper.toLowerCase() ? "✓" : "❌ MISMATCH — " + mkAuth}`);
  } catch (e) {
    console.log(`  (SF query failed: ${e.message.slice(0, 60)})`);
  }

  // ── checkUpkeep simulation ───────────────────────────────────────────────────
  sep("checkUpkeep() result");
  let upkeepNeeded = false;
  let workItems    = [];

  try {
    const [needed, performData] = await keeper.checkUpkeep("0x");
    upkeepNeeded = needed;

    if (!needed) {
      console.log(`  upkeepNeeded: false — no work to do right now`);
      console.log(`  (This is normal when matrices are active and velocity window hasn't elapsed)`);
    } else {
      console.log(`  upkeepNeeded: true ✅`);

      // Decode WorkItem[] from performData
      // struct WorkItem { uint8 workType; uint8 tierIndex; address addr1; address addr2; }
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]"],
          performData
        );
        workItems = decoded[0];
        console.log(`  Work items: ${workItems.length}`);
        for (const item of workItems) {
          const name = WORK_NAMES[item.workType] || `TYPE_${item.workType}`;
          const addrStr = item.addr1 !== ethers.ZeroAddress
            ? `  addr1=${item.addr1.slice(0,10)}`
            : "";
          console.log(`    [${item.workType}] ${name}  tier=${item.tierIndex}${addrStr}`);
        }
      } catch (decodeErr) {
        console.log(`  (Could not decode performData: ${decodeErr.message.slice(0, 60)})`);
      }

      // ── Gas estimate for performUpkeep ────────────────────────────────────
      if (process.env.SIMULATE === "1" && workItems.length > 0) {
        sep("performUpkeep gas estimate");
        try {
          // Simulate from forwarder address (Chainlink calls it from the forwarder)
          const gasEst = await keeper.performUpkeep.estimateGas(performData, {
            from: FORWARDER
          });
          console.log(`  Estimated gas: ${gasEst.toLocaleString()}`);
          const gasLimit = 6_000_000;
          const utilPct  = (Number(gasEst) * 100 / gasLimit).toFixed(1);
          console.log(`  Gas limit:     ${gasLimit.toLocaleString()}`);
          console.log(`  Utilization:   ${utilPct}%  ${Number(utilPct) > 80 ? "⚠ HIGH" : "✓ OK"}`);
        } catch (gasErr) {
          console.log(`  Gas estimate failed: ${gasErr.message.slice(0, 100)}`);
        }
      }
    }
  } catch (e) {
    console.log(`  checkUpkeep() failed: ${e.message.slice(0, 100)}`);
  }

  // ── Idle slot scan ───────────────────────────────────────────────────────────
  sep("Idle slot scan (T1 MatA + MatB)");
  const matrices = [
    { label: "T1 MatA", addr: T1.matA },
    { label: "T1 MatB", addr: T1.matB },
    { label: "T2 MatA", addr: T2.matA },
    { label: "T2 MatB", addr: T2.matB },
  ];

  for (const { label, addr } of matrices) {
    try {
      const mat = await ethers.getContractAt("FigureEightMatrixV8", addr);
      const occ = await mat.occupancy();
      const sz  = await mat.MATRIX_SIZE();

      // Check if keeper is set on this matrix
      const mk = await mat.matrixKeeper();
      const mkOk = mk.toLowerCase() === addrs.matrixKeeper.toLowerCase();

      // Find any idle slots (lastActivityTime > idleTimeout ago)
      let idleCount = 0;
      const idleCutoff = Number(now) - Number(idleTimeout);
      // Scan up to occupancy members via posToMember
      const scanCount = Math.min(Number(occ), 20); // cap at 20 to avoid timeout
      for (let pos = 1; pos <= scanCount; pos++) {
        try {
          const member = await mat.posToMember(pos);
          if (member === ethers.ZeroAddress) continue;
          const lastAct = await mat.lastActivityTime(member);
          if (Number(lastAct) > 0 && Number(lastAct) < idleCutoff) {
            idleCount++;
          }
        } catch {}
      }

      const idleNote = idleCount > 0 ? `  ⚠ ${idleCount} idle slot(s) detected` : "";
      console.log(`  ${label}: ${occ}/${sz}  keeper=${mkOk ? "✓" : "❌"}${idleNote}`);
    } catch (e) {
      console.log(`  ${label}: query failed (${e.message.slice(0, 40)})`);
    }
  }

  sep("Summary");
  console.log(`  upkeepNeeded: ${upkeepNeeded}`);
  console.log(`  Work items pending: ${workItems.length}`);
  console.log(`\n  Chainlink will call performUpkeep() when checkUpkeep() returns true.`);
  console.log(`  Velocity check fires every ${Number(velWindow)/3600}h.`);
  console.log(`  Ghost entries fire after ${Number(idleTimeout)/3600}h idle.`);
  console.log(`\n  To simulate performUpkeep gas usage:`);
  console.log(`    SIMULATE=1 npx hardhat run scripts/check_keeper.js --network baseSepolia`);
  sep();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
