"use strict";
/**
 * preflight_v851.js — READ-ONLY GO/NO-GO CHECK FOR THE COMMUNITY V8.51 DEPLOY
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: npx hardhat run scripts/preflight_v851.js --network baseSepolia
 *
 * ⛔ WHY THIS EXISTS. deploy_v8.js has NO deployer-ETH preflight, and a full
 *    127-seat / 10-tier deploy takes 75-90 MINUTES and 40+ transactions. Running
 *    dry at minute 60 leaves a HALF-BUILT CHAIN: contracts deployed, wiring calls
 *    unmade, and no addresses file (deploy_v8.js writes it at the END). Recovering
 *    from that costs more than this check ever will.
 *
 * ⛔ IT IS READ-ONLY AND CANNOT SPEND. It derives the deployer ADDRESS from the
 *    key so it can look up a balance, but it NEVER connects that wallet to a
 *    provider and never builds a transaction — the same discipline
 *    refusal_layer.js documents. Balance lookups are plain view calls.
 */
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDC_ABI = ["function balanceOf(address) view returns (uint256)",
                  "function decimals() view returns (uint8)"];

// A 10-tier 127-seat run has been measured at 75-90 minutes. This floor is a
// JUDGEMENT, not a measurement, and is labelled as such: it is deliberately set
// well above any single observed run so it warns early rather than precisely.
const ETH_FLOOR   = 0.05;   // ⚠ UNVERIFIED as a true minimum — a warning line, not a limit
const ETH_COMFORT = 0.15;

let fail = 0, warn = 0;
const ok   = m => console.log(`  ✓  ${m}`);
const bad  = m => { console.error(`  ✗  ${m}`); fail++; };
const note = m => { console.log(`  ⚠  ${m}`); warn++; };

async function main() {
  console.log("\n══ V8.51 COMMUNITY DEPLOY — PREFLIGHT (read-only) ══\n");

  // ── 1. The addresses file: session variable, and the guard's own condition ──
  const addrFile = process.env.ADDRESSES_FILE || "(unset)";
  console.log(`  ADDRESSES_FILE resolves to : ${addrFile}`);
  if (addrFile === "deployed_addresses_v8_51.json") {
    ok("target is deployed_addresses_v8_51.json");
  } else if (addrFile === "deployed_addresses_v8_50.json") {
    bad("ADDRESSES_FILE is the LIVE V8.50 file — the session variable was NOT set, so .env:69 is being used. Set it in THIS shell (28.2b) before deploying.");
  } else {
    bad(`ADDRESSES_FILE is '${addrFile}' — expected deployed_addresses_v8_51.json`);
  }
  const target = path.join(__dirname, "deployed_addresses_v8_51.json");
  if (fs.existsSync(target)) {
    bad("deployed_addresses_v8_51.json ALREADY EXISTS — guardAddressesFile() will refuse. A previous run may have completed; do not overwrite it blindly.");
  } else {
    ok("deployed_addresses_v8_51.json does not exist yet — the overwrite guard will allow the run");
  }

  // ── 2. Resolved deploy config (defaults, since .env sets neither) ──────────
  const size  = process.env.MATRIX_SIZE || "(default)";
  const tiers = process.env.DEPLOY_TIERS || "(default)";
  console.log(`  MATRIX_SIZE                : ${size}`);
  console.log(`  DEPLOY_TIERS               : ${tiers}`);
  if (process.env.MATRIX_SIZE && process.env.MATRIX_SIZE !== "127") {
    bad(`MATRIX_SIZE is ${process.env.MATRIX_SIZE} — the COMMUNITY deploy must be 127. 15 is the private gate-chain size.`);
  } else {
    ok("matrix size will be 127 (community scale, not the size-15 gate chain)");
  }

  // ── 3. Deployer gas. The reason this script exists. ────────────────────────
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    bad("DEPLOYER_PRIVATE_KEY not set — cannot determine the deployer address");
  } else {
    // Derivation only. This wallet is never given a provider and never signs.
    const deployerAddr = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY).address;
    const bal    = await ethers.provider.getBalance(deployerAddr);
    const eth    = Number(ethers.formatEther(bal));
    console.log(`  Deployer                   : ${deployerAddr}`);
    console.log(`  Deployer ETH               : ${eth.toFixed(6)}`);
    if (eth >= ETH_COMFORT)   ok(`ETH balance ${eth.toFixed(4)} — comfortable for a 40+ tx run`);
    else if (eth >= ETH_FLOOR) note(`ETH balance ${eth.toFixed(4)} is above the ${ETH_FLOOR} warning line but below the ${ETH_COMFORT} comfort line. ⚠ Neither number is a measured minimum. Top up rather than gamble 90 minutes.`);
    else                       bad(`ETH balance ${eth.toFixed(4)} is BELOW the ${ETH_FLOOR} warning line — top up before starting.`);

    // ── 4. USDC reuse: members keep their balances only if this is the same token
    const usdcAddr = process.env.USDC_ADDRESS;
    if (!usdcAddr) {
      bad("USDC_ADDRESS unset — deploy_v8.js would MINT A NEW MOCK USDC, and every member's existing balance would be stranded on the old token.");
    } else {
      const code = await ethers.provider.getCode(usdcAddr);
      if (!code || code === "0x") {
        bad(`USDC_ADDRESS ${usdcAddr} has NO CODE on this network`);
      } else {
        const usdc = new ethers.Contract(usdcAddr, USDC_ABI, ethers.provider);
        const d    = await usdc.decimals();
        const ub   = await usdc.balanceOf(deployerAddr);
        ok(`USDC reused at ${usdcAddr} (code present, ${d} decimals) — members keep their balances, re-registration is approve-and-register`);
        console.log(`  Deployer USDC              : ${(Number(ub) / 10 ** Number(d)).toFixed(2)}`);
      }
    }
  }

  console.log("\n" + "═".repeat(60));
  if (fail) console.error(`  ⛔  ${fail} BLOCKER(S) — DO NOT DEPLOY.${warn ? `  (${warn} warning(s))` : ""}`);
  else if (warn) console.log(`  ⚠️   GO, with ${warn} warning(s) above — read them before starting.`);
  else console.log("  ✅  GO — every preflight check passed.");
  console.log("═".repeat(60) + "\n");
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(1); });
