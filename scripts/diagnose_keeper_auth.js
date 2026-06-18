"use strict";
/**
 * diagnose_keeper_auth.js
 * Diagnoses why setMatrixKeeper TX confirmed but state stayed at address(0).
 *
 * Checks:
 *  1. Raw storage slot for matrixKeeper (bypasses ABI entirely)
 *  2. getContractAt with compiled Hardhat artifact (vs manual ABI)
 *  3. Recent MatrixKeeperSet events in last 1000 blocks
 *  4. Contract bytecode size (confirms something is deployed at that address)
 *
 * Run: npx hardhat run scripts/diagnose_keeper_auth.js --network baseSepolia
 */
const hre  = require("hardhat");
const path = require("path");
const fs   = require("fs");

const ADDRS_FILE = path.join(__dirname, "deployed_addresses_v8_16.json");

async function main() {
  const provider = hre.ethers.provider;
  const [deployer] = await hre.ethers.getSigners();

  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const tierRouterAddr   = addrs.tierRouter;
  const matrixKeeperAddr = addrs.matrixKeeper;

  console.log(`TierRouter:   ${tierRouterAddr}`);
  console.log(`MatrixKeeper: ${matrixKeeperAddr}`);
  console.log(`Deployer:     ${deployer.address}\n`);

  // ── 1. Bytecode check — confirms a contract is deployed there ────────────
  const code = await provider.getCode(tierRouterAddr);
  console.log(`1. Bytecode at TierRouter address: ${code.length} hex chars (${(code.length - 2) / 2} bytes)`);
  if (code === "0x" || code === "") {
    console.error("   ❌ NO CONTRACT at this address — EOA or empty. Check ADDRS_FILE.");
    return;
  }
  console.log("   ✓ Contract is deployed\n");

  // ── 2. Raw storage read ──────────────────────────────────────────────────
  // Find matrixKeeper's storage slot by reading TierRouter's storage layout
  // from the Hardhat build artifacts.
  console.log("2. Reading storage layout from Hardhat build-info…");
  let keeperSlot = null;
  const buildInfoDir = path.join(__dirname, "../artifacts/build-info");
  if (fs.existsSync(buildInfoDir)) {
    const buildFiles = fs.readdirSync(buildInfoDir).filter(f => f.endsWith(".json"));
    for (const bf of buildFiles.slice(-3)) { // check last 3 build-info files (most recent)
      try {
        const bi = JSON.parse(fs.readFileSync(path.join(buildInfoDir, bf), "utf8"));
        const output = bi.output?.contracts?.["contracts/TierRouter.sol"]?.TierRouter;
        if (!output) continue;
        const layout = output.storageLayout?.storage;
        if (!layout) continue;
        const entry = layout.find(v => v.label === "matrixKeeper");
        if (entry) {
          keeperSlot = entry.slot;
          console.log(`   Found matrixKeeper at storage slot ${keeperSlot} (from ${bf.slice(0,20)}…)`);
          break;
        }
      } catch { continue; }
    }
  }
  if (keeperSlot === null) {
    console.log("   ⚠  Could not find storage layout — will brute-force slots 0-20");
  }

  // Read specific slot or brute-force
  const slotsToCheck = keeperSlot !== null
    ? [Number(keeperSlot)]
    : Array.from({length: 21}, (_, i) => i);

  let foundSlot = null;
  for (const slot of slotsToCheck) {
    const raw = await provider.getStorage(tierRouterAddr, slot);
    // An address in storage is right-padded to 32 bytes
    const addr = "0x" + raw.slice(26); // last 20 bytes
    if (addr.toLowerCase() === matrixKeeperAddr.toLowerCase()) {
      console.log(`   ✓ matrixKeeper FOUND at slot ${slot} = ${addr}`);
      foundSlot = slot;
      break;
    }
    if (addr !== "0x0000000000000000000000000000000000000000") {
      console.log(`   slot ${String(slot).padStart(2)}: ${addr} (not zero, not keeper)`);
    }
  }
  if (foundSlot === null) {
    console.log("   ❌ matrixKeeper NOT found in any slot checked — TX had no effect on state");
    if (keeperSlot !== null) {
      const raw = await provider.getStorage(tierRouterAddr, keeperSlot);
      console.log(`   Slot ${keeperSlot} raw value: ${raw}`);
    }
  }
  console.log();

  // ── 3. Call via compiled Hardhat artifact (getContractAt) ────────────────
  console.log("3. Reading via getContractAt (compiled Hardhat ABI)…");
  try {
    const tr = await hre.ethers.getContractAt("TierRouter", tierRouterAddr);
    const mk = await tr.matrixKeeper();
    const own = await tr.owner();
    console.log(`   matrixKeeper() = ${mk}`);
    console.log(`   owner()        = ${own}`);
    console.log(`   deployer match = ${own.toLowerCase() === deployer.address.toLowerCase()}`);
  } catch (e) {
    console.error(`   ❌ getContractAt call failed: ${e.message.slice(0,120)}`);
  }
  console.log();

  // ── 4. Scan recent blocks for MatrixKeeperSet events ────────────────────
  console.log("4. Scanning last 2000 blocks for MatrixKeeperSet events…");
  try {
    const tr = await hre.ethers.getContractAt("TierRouter", tierRouterAddr);
    const latest = await provider.getBlockNumber();
    const from   = Math.max(0, latest - 2000);
    const filter = tr.filters.MatrixKeeperSet();
    const events = await tr.queryFilter(filter, from, latest);
    if (events.length === 0) {
      console.log(`   ❌ No MatrixKeeperSet events in blocks ${from}–${latest}`);
      console.log("      This means the function body NEVER ran — likely a wrong contract at this address");
    } else {
      for (const ev of events) {
        console.log(`   ✓ MatrixKeeperSet(${ev.args.keeper}) at block ${ev.blockNumber}`);
      }
    }
  } catch (e) {
    console.error(`   ❌ Event query failed: ${e.message.slice(0,120)}`);
  }
  console.log();

  // ── 5. Summary ───────────────────────────────────────────────────────────
  console.log("── SUMMARY ─────────────────────────────────────────────────────────────");
  console.log("If no MatrixKeeperSet events were found AND no storage slot has the");
  console.log("keeper address, the deployed TierRouter bytecode does not match the");
  console.log("current TierRouter.sol. The contract must be redeployed (V8.17).");
  console.log("────────────────────────────────────────────────────────────────────────");
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
