// diag_frozen_matb.js
// Standalone diagnostic — no hardhat needed.
// Queries Base Sepolia on-chain state for all T1 pairs and captures the
// EXACT revert reason for adminForceRotateRoot on any frozen MatB.
//
// Run (from CryptoNite-Smart-Contracts/CryptoNova/):
//   node scripts/diag_frozen_matb.js
//
// Requires in .env:
//   BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ADDRESSES_FILE (optional)

"use strict";
const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL      = process.env.BASE_SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const ADDRS_FILE   = process.env.ADDRESSES_FILE || "deployed_addresses_v8_39.json";
const TIER_KEYS    = ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"];
const MATRIX_SIZE  = 127;

if (!RPC_URL)      { console.error("ERROR: BASE_SEPOLIA_RPC_URL not set in .env"); process.exit(1); }
if (!DEPLOYER_KEY) { console.error("ERROR: DEPLOYER_PRIVATE_KEY not set in .env"); process.exit(1); }

// ── ABIs ──────────────────────────────────────────────────────────────────────
const PM_ABI = [
  "function pairCount() external view returns (uint256)",
  "function activePairIndex() external view returns (uint256)",
  "function getPairAt(uint256 idx) external view returns (address matA, address matB)",
];

const MATRIX_ABI = [
  "function occupancy() external view returns (uint256)",
  "function nextSlot() external view returns (uint256)",
  "function rotationCount() external view returns (uint256)",
  "function poolAccumulator() external view returns (uint256)",
  "function adminForceRotateRoot() external",    // onlyOwner — may fail for factory-created MatBs
  "function keeperForceRotateRoot() external",   // V8.39: callable by matrixKeeper (preferred)
  "function isMatrixA() external view returns (bool)",
];

const USDC_ABI = [
  "function balanceOf(address) external view returns (uint256)",
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(DEPLOYER_KEY, provider);

  console.log("=".repeat(70));
  console.log("CryptoNova frozen-MatB diagnostic");
  console.log("=".repeat(70));
  console.log(`Deployer  : ${wallet.address}`);

  // -- Deployer ETH balance --
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`ETH bal   : ${ethers.formatEther(ethBal)} ETH`);
  if (ethBal < ethers.parseEther("0.01")) {
    console.warn("⚠️  DEPLOYER ETH BALANCE LOW — may cause gas failures!");
  }

  // -- Block info --
  const block = await provider.getBlock("latest");
  console.log(`Block     : ${block.number}  (${new Date(block.timestamp * 1000).toISOString()})`);
  console.log();

  // -- Load addresses --
  const addrsPath = path.join(__dirname, ADDRS_FILE);
  if (!fs.existsSync(addrsPath)) {
    console.error(`ERROR: ${ADDRS_FILE} not found next to this script`);
    process.exit(1);
  }
  const addrs = JSON.parse(fs.readFileSync(addrsPath, "utf8"));

  // -- USDC address for balance checks --
  const usdcAddr = addrs.usdc || addrs.mockUsdc;
  const usdc = usdcAddr ? new ethers.Contract(usdcAddr, USDC_ABI, provider) : null;
  if (!usdcAddr) console.warn("WARN: no USDC address in addresses file — skipping USDC balance check");

  // -- Scan each tier --
  for (const tierKey of TIER_KEYS) {
    const tierData = addrs.tiers?.[tierKey];
    if (!tierData?.pm) continue;

    const pm = new ethers.Contract(tierData.pm, PM_ABI, provider);
    let pairCount, activeIdx;
    try {
      [pairCount, activeIdx] = await Promise.all([
        pm.pairCount().then(Number),
        pm.activePairIndex().then(Number),
      ]);
    } catch (e) {
      console.log(`${tierKey}: PM read failed — ${(e.message||"").slice(0,80)}`);
      continue;
    }

    if (pairCount === 0) continue;

    console.log(`── ${tierKey} — PairManager ${tierData.pm.slice(0,10)}… ──────────────────────`);
    console.log(`   pairCount=${pairCount}  activePairIndex=${activeIdx}`);

    for (let i = 0; i < pairCount; i++) {
      let matAAddr, matBAddr;
      try {
        [matAAddr, matBAddr] = await pm.getPairAt(i);
      } catch { continue; }

      if (!matAAddr || matAAddr === ethers.ZeroAddress) continue;

      const matA = new ethers.Contract(matAAddr, MATRIX_ABI, provider);
      const matB = new ethers.Contract(matBAddr, MATRIX_ABI, provider);

      let aOcc, aNext, aRot, bOcc, bNext, bRot, bPool;
      try {
        [aOcc, aNext, aRot] = await Promise.all([
          matA.occupancy().then(Number),
          matA.nextSlot().then(Number),
          matA.rotationCount().then(Number),
        ]);
      } catch {
        aOcc = aNext = aRot = "?";
      }

      try {
        [bOcc, bNext, bRot, bPool] = await Promise.all([
          matB.occupancy().then(Number),
          matB.nextSlot().then(Number),
          matB.rotationCount().then(Number),
          matB.poolAccumulator().then(v => Number(v) / 1e6),  // USDC 6 dec
        ]);
      } catch {
        bOcc = bNext = bRot = bPool = "?";
      }

      // USDC balance in each matrix
      let matBUsdc = "?";
      if (usdc) {
        try { matBUsdc = (Number(await usdc.balanceOf(matBAddr)) / 1e6).toFixed(2); } catch {}
      }

      console.log();
      console.log(`   Pair ${i+1} (${i === activeIdx ? "ACTIVE" : "inactive"})`);
      console.log(`     MatA ${matAAddr.slice(0,10)}…  occ=${aOcc}/${MATRIX_SIZE}  nextSlot=${aNext}  rotations=${aRot}`);
      console.log(`     MatB ${matBAddr.slice(0,10)}…  occ=${bOcc}/${MATRIX_SIZE}  nextSlot=${bNext}  rotations=${bRot}  poolAcc=$${bPool}  USDC bal=$${matBUsdc}`);

      // -- Frozen check --
      const frozen = (typeof bOcc === "number" && typeof bNext === "number")
        && bOcc >= MATRIX_SIZE && bNext > MATRIX_SIZE;

      if (frozen) {
        console.log();
        console.log(`     🚨 FROZEN — ${tierKey}.${i+1} MatB is full and stuck (nextSlot ${bNext} > ${MATRIX_SIZE})`);
        console.log(`     Attempting keeperForceRotateRoot() static call to get revert reason...`);
        console.log(`     (V8.39+: use keeperForceRotateRoot — authorized by matrixKeeper, not onlyOwner)`);

        // Static call — captures the revert reason without spending gas
        const iface = matB.interface;
        const calldata = iface.encodeFunctionData("keeperForceRotateRoot", []);
        try {
          await provider.call({
            to:       matBAddr,
            data:     calldata,
            from:     wallet.address,
            gasLimit: 10_000_000,
          });
          // If we get here, the static call SUCCEEDED — no revert
          console.log(`     ✅ Static call SUCCEEDED — no revert on static simulation.`);
          console.log(`        (Live TX may still fail for network-level reasons.)`);
        } catch (e) {
          const raw = e.data || e.info?.error?.data || null;
          console.log(`     ❌ Static call REVERTED`);
          console.log(`        error.message : ${(e.message || "").slice(0, 200)}`);
          console.log(`        error.data    : ${raw || "(null — no revert data returned)"}`);

          if (raw && raw !== "0x") {
            // Try to decode as Error(string)
            try {
              const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ["string"],
                "0x" + raw.slice(10)   // strip 4-byte selector 0x08c379a0
              );
              console.log(`        Decoded reason: "${decoded[0]}"`);
            } catch {}

            // Try to decode as Panic(uint256)
            try {
              const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ["uint256"],
                "0x" + raw.slice(10)
              );
              const PANIC_CODES = {
                1: "assert failed",
                17: "arithmetic overflow/underflow",
                18: "division by zero",
                33: "invalid enum value",
                34: "storage array out of bounds",
                49: "empty array pop",
                50: "array index out of bounds",
                65: "memory overflow (new too large)",
                81: "uninitialised function pointer",
              };
              const code = Number(decoded[0]);
              console.log(`        Panic code ${code}: ${PANIC_CODES[code] || "unknown panic"}`);
            } catch {}
          }

          // Check gas estimate
          console.log();
          console.log(`        Checking gas estimate separately...`);
          try {
            const gasEst = await provider.estimateGas({
              to:   matBAddr,
              data: calldata,
              from: wallet.address,
            });
            console.log(`        Gas estimate: ${gasEst.toLocaleString()} (keeper limit: 8,000,000)`);
          } catch (ge) {
            console.log(`        Gas estimate also failed: ${(ge.message||"").slice(0,100)}`);
          }
        }
      }
    }
    console.log();
  }

  console.log("=".repeat(70));
  console.log("Diagnostic complete");
  console.log("=".repeat(70));
}

main().catch(e => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});
