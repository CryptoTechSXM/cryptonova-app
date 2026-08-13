// probe_base_usdc_permit.js — does NATIVE USDC on Base MAINNET support EIP-2612?
//
// THE ONE UNVERIFIED EXTERNAL CLAIM in the V8.48 scope (item 40): every doc that
// mentions it says "check DOMAIN_SEPARATOR()/nonces() on Base USDC before relying
// on it" and, until this script, nobody had. Testnet does not depend on the answer
// (the deployed token is MockUSDC, which has ERC20Permit — V8.44 G1); MAINNET's
// selfRescueWithPermit / manualUpgradeWithPermit do.
//
// STRICT READS (model_epoch_policy v1 lesson): a failed read prints FAILED with the
// reason and the verdict distinguishes "function absent at the contract" from "the
// network dropped the call" — a transport error must never be reported as absence.
//
// Read-only, no key, MAINNET RPC (not the .env Sepolia one).
// Run (owner, Windows, contracts repo):
//   node scripts\probe_base_usdc_permit.js
// Env: RPC=  override the mainnet endpoint (default https://mainnet.base.org)

const { ethers } = require("ethers");

// Native (Circle-issued) USDC on Base mainnet. Well-known address; the script
// prints symbol/name/decimals first so the identity is CONFIRMED, not assumed.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = process.env.RPC || "https://mainnet.base.org";

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  const c = new ethers.Contract(USDC, ABI, p);
  console.log(`\n  Base MAINNET (chainId 8453) via ${RPC}`);
  console.log(`  probing ${USDC}\n`);

  const results = {};
  for (const m of ["name", "symbol", "decimals", "version", "DOMAIN_SEPARATOR"]) {
    try {
      results[m] = await c[m]();
      console.log(`  ${m.padEnd(18)} ${results[m]}`);
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e);
      const missing = /could not decode result data|returned no data|revert|CALL_EXCEPTION|BAD_DATA/i.test(msg);
      results[m] = missing ? "MISSING" : "NETWORK_ERROR";
      console.log(`  ${m.padEnd(18)} FAILED — ${missing ? "absent at the contract" : "network error"}: ${msg.slice(0, 70)}`);
    }
  }
  try {
    const n = await c.nonces("0x000000000000000000000000000000000000dEaD");
    results.nonces = n;
    console.log(`  ${"nonces(0xdEaD)".padEnd(18)} ${n}`);
  } catch (e) {
    const msg = e.shortMessage || e.message || String(e);
    const missing = /could not decode result data|returned no data|revert|CALL_EXCEPTION|BAD_DATA/i.test(msg);
    results.nonces = missing ? "MISSING" : "NETWORK_ERROR";
    console.log(`  ${"nonces(0xdEaD)".padEnd(18)} FAILED — ${missing ? "absent" : "network error"}: ${msg.slice(0, 70)}`);
  }

  console.log("\n  ── VERDICT ──");
  const net = Object.values(results).includes("NETWORK_ERROR");
  const miss = [ "DOMAIN_SEPARATOR", "nonces" ].filter((k) => results[k] === "MISSING");
  if (net) {
    console.log("  INCONCLUSIVE — at least one call died at the network, not the contract.");
    console.log("  Re-run (or pass RPC=<another Base mainnet endpoint>) before concluding anything.");
  } else if (miss.length) {
    console.log(`  EIP-2612 NOT PRESENT (${miss.join(", ")} absent).`);
    console.log("  selfRescueWithPermit's permit call would revert into its catch on mainnet —");
    console.log("  harmless (falls back to a standing allowance) but the one-signature UX is dead");
    console.log("  there; the frontend must keep the approve path for mainnet.");
  } else {
    console.log("  EIP-2612 PRESENT: DOMAIN_SEPARATOR and nonces() both answer.");
    console.log("  The item-40 claim is now VERIFIED — update the scope row and the handoff's");
    console.log("  'unverified external claim' entries; this was the last one.");
  }
  console.log();
})().catch((e) => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
