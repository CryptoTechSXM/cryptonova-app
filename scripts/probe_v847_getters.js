// probe_v847_getters.js — does the DEPLOYED V8.47 chain have the getters the
// admin-branch frontend now calls? (V8.48 session, 2026-08-12)
//
// WHY: the admin branch of the Testnet-App was written for V8.48. Two of its
// data sources are V8.48 contract changes awaiting deploy:
//   - CommunityWallet.nextDistributionTime() / distributionDayOfMonth
//     (V8.48 item 41 REPLACED distributeInterval — CommunityWallet.sol:77)
//   - CNOVAToken.epochMembersRemaining/MintRemaining/TimeRemaining/LeadingTrigger
//     (item 42 frontend reads them — unknown whether V8.47 deployed them)
// Members are served MAIN. Before promoting admin -> main, we need to know which
// of these calls REVERT on the deployed contracts, so the frontend can
// feature-detect and fall back to the V8.47 reads instead of rendering unknowns.
// Verify against the CHAIN, not the source tree — the tree is V8.48.
//
// Read-only. No key.
// Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\probe_v847_getters.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const PROBES = [
  // [contract key, human name, abi fragment, method]
  ["cnova", "currentEpochNumber (sanity — should EXIST)", "function currentEpochNumber() view returns (uint256)"],
  ["cnova", "epochMemberLimit",     "function epochMemberLimit() view returns (uint256)"],
  ["cnova", "epochMintLimit",      "function epochMintLimit() view returns (uint256)"],
  ["cnova", "epochTimeLimit",      "function epochTimeLimit() view returns (uint256)"],
  ["cnova", "epochMembersRemaining", "function epochMembersRemaining() view returns (uint256)"],
  ["cnova", "epochMintRemaining",  "function epochMintRemaining() view returns (uint256)"],
  ["cnova", "epochTimeRemaining",  "function epochTimeRemaining() view returns (uint256)"],
  ["cnova", "epochLeadingTrigger", "function epochLeadingTrigger() view returns (uint8)"],
  ["communityWallet", "lastDistributionTime (sanity — should EXIST)", "function lastDistributionTime() view returns (uint256)"],
  ["communityWallet", "distributeInterval (V8.47 original)", "function distributeInterval() view returns (uint256)"],
  ["communityWallet", "distributionDayOfMonth (V8.48 item 41)", "function distributionDayOfMonth() view returns (uint8)"],
  ["communityWallet", "nextDistributionTime (V8.48 item 41)", "function nextDistributionTime() view returns (uint256)"],
  // 2026-08-13: item 43's frontend (governance.html, commit 32f719d) reads the
  // proposal fee. Expected MISSING on V8.47 — the UI feature-detects and shows the
  // no-fee notice; this row exists so the promotion check is a MEASUREMENT, not a
  // memory of how the UI was written.
  ["v8Governance", "quorumBps (sanity — should EXIST)", "function quorumBps() view returns (uint256)"],
  ["v8Governance", "proposalFee (V8.48 item 43 — UI feature-detects)", "function proposalFee() view returns (uint256)"],
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env or pass RPC=..."); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  console.log(`block ${await p.getBlockNumber()}   ·   addresses: v8_47\n`);
  console.log("contract         getter                                            result");
  console.log("─".repeat(100));
  for (const [key, name, abi] of PROBES) {
    const c = new ethers.Contract(A[key], [abi], p);
    const method = abi.match(/function (\w+)/)[1];
    let out;
    try {
      const v = await c[method]();
      out = `EXISTS = ${v}`;
    } catch (e) {
      // Distinguish "function not on contract" from a transport error: a missing
      // selector returns empty data / reverts; a network failure must NOT be
      // reported as "missing" — that would be a fabricated conclusion.
      const msg = (e.shortMessage || e.message || String(e));
      out = /could not decode result data|returned no data|revert|CALL_EXCEPTION|BAD_DATA/i.test(msg)
        ? "MISSING on deployed contract (call failed at the contract, not the network)"
        : `NETWORK ERROR — inconclusive: ${msg.slice(0, 60)}`;
    }
    console.log(`${key.padEnd(16)} ${name.padEnd(49)} ${out}`);
  }
  console.log("\nReading: every MISSING row is a getter the admin frontend must feature-detect");
  console.log("before admin can be promoted to main against the deployed V8.47 chain.");
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
