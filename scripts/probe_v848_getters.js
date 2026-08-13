// probe_v848_getters.js — prove the FRESH V8.48 deployment answers every
// getter/function the frontend feature-detects, and that the declared defaults
// actually shipped. (Deploy card step 1.3b, written on deploy day 2026-08-13.)
//
// Two kinds of rows:
//   VIEW  — call it; success = exists; where an expected value is given,
//           mismatch is a FAILURE (a declared default did not ship).
//   FUNC  — non-view (bulkWithdraw, selfRescueWithPermit): staticCall with dummy
//           args. A revert WITH a reason/error payload = the function EXISTS and
//           ran its body. A revert with EMPTY data = selector not found = MISSING.
//
// Also probes the reused testnet USDC for EIP-2612 (DOMAIN_SEPARATOR + nonces):
// informational only — permit-less USDC just means the two-step fallback fires.
//
// Read-only. No key. Run (contracts repo, Windows):
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\probe_v848_getters.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const A   = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"));

const DAY = 86400n;

// [addr key, label, abi, args, expected (BigInt/bool/null), required]
const VIEWS = [
  ["tierRouter",     "reservedHeldFor(W1)  (item 2)",        "function reservedHeldFor(address) view returns (uint256)", () => [A.accountOne], null, true],
  ["stabilityFund",  "loanEligible(W1,0)  (items 46/47)",    "function loanEligible(address,uint8) view returns (bool)",  () => [A.accountOne, 0], null, true],
  ["stabilityFund",  "insolvencyFloorBps == 3400 (PARAM 59)","function insolvencyFloorBps() view returns (uint256)",      () => [], 3400n, true],
  ["stabilityFund",  "communityOverflowBps == 10000 (PARAM 60)","function communityOverflowBps() view returns (uint256)", () => [], 10000n, true],
  ["stabilityFund",  "sfTargetMultiplier(0) == 10 (item 48)","function sfTargetMultiplier(uint256) view returns (uint256)", () => [0], 10n, true],
  ["v8Governance",   "proposalFee == 100e18 (item 43)",      "function proposalFee() view returns (uint256)",             () => [], 100n * 10n ** 18n, true],
  ["communityWallet","distributionDayOfMonth == 25 (item 41)","function distributionDayOfMonth() view returns (uint8)",   () => [], 25n, true],
  ["communityWallet","nextDistributionTime  (item 41)",      "function nextDistributionTime() view returns (uint256)",    () => [], null, true],
  ["cnova",          "epochMemberLimit == 1000 (item 42)",   "function epochMemberLimit() view returns (uint256)",        () => [], 1000n, true],
  ["cnova",          "epochTimeLimit == 180d (item 42)",     "function epochTimeLimit() view returns (uint256)",          () => [], 180n * DAY, true],
  ["cnova",          "epochMintLimit == 1,000,000e18",       "function epochMintLimit() view returns (uint256)",          () => [], 1000000n * 10n ** 18n, true],
  // informational: permit support on the REUSED testnet USDC (MockUSDC gained
  // ERC20Permit only in V8.44 — an older token here is fine, two-step fallback)
  ["usdc",           "USDC DOMAIN_SEPARATOR (EIP-2612?)",    "function DOMAIN_SEPARATOR() view returns (bytes32)",        () => [], null, false],
  ["usdc",           "USDC nonces(W1) (EIP-2612?)",          "function nonces(address) view returns (uint256)",           () => [A.accountOne], null, false],
];

// Non-view existence probes. Dummy args are DESIGNED to revert inside the body
// with a reason — that reason is the proof the selector resolves.
const FUNCS = [
  ["tierRouter", "bulkWithdraw(uint256)  (item 3)",
    "function bulkWithdraw(uint256)", () => [0]],
  [null /* T1 MatA below */, "selfRescueWithPermit(...)  (item 40)",
    "function selfRescueWithPermit(uint256,uint256,uint8,bytes32,bytes32)",
    () => [0, 0, 0, ethers.ZeroHash, ethers.ZeroHash]],
];

(async () => {
  if (!RPC) { console.log("FATAL: no RPC — set BASE_SEPOLIA_RPC_URL in .env"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  const t1MatA = A.tiers.T1.matA;
  console.log(`block ${await p.getBlockNumber()}   addresses: ${process.env.ADDRESSES_FILE || "deployed_addresses_v8_48.json"}`);
  console.log(`network in file: ${A.network}   deployedAt: ${A.deployedAt || "(not recorded)"}\n`);

  let fail = 0, info = [];

  for (const [key, label, abi, argFn, expected, required] of VIEWS) {
    const c = new ethers.Contract(A[key], [abi], p);
    const method = abi.match(/function (\w+)/)[1];
    try {
      const v = await c[method](...argFn());
      let ok = true, note = `= ${v}`;
      if (expected !== null) {
        ok = (typeof v === "bigint" ? v === expected : String(v) === String(expected));
        if (!ok) note = `= ${v}  EXPECTED ${expected}  <-- DEFAULT DID NOT SHIP`;
      }
      if (!ok && required) fail++;
      console.log(`${ok ? " OK " : "FAIL"}  ${label.padEnd(44)} ${note}`);
    } catch (e) {
      if (required) { fail++; console.log(`FAIL  ${label.padEnd(44)} MISSING/REVERTED: ${(e.shortMessage || e.message).slice(0, 60)}`); }
      else { info.push(label); console.log(`INFO  ${label.padEnd(44)} not supported (two-step fallback will fire — OK)`); }
    }
  }

  for (const [key, label, abi, argFn] of FUNCS) {
    const addr = key ? A[key] : t1MatA;
    const c = new ethers.Contract(addr, [abi], p);
    const method = abi.match(/function (\w+)/)[1];
    try {
      await c[method].staticCall(...argFn(), { from: A.accountOne });
      console.log(` OK   ${label.padEnd(44)} exists (dummy call did not even revert)`);
    } catch (e) {
      const data = e.data || (e.info && e.info.error && e.info.error.data) || "0x";
      const hasReason = data && data !== "0x";
      if (hasReason) {
        let reason = e.reason || e.shortMessage || "";
        console.log(` OK   ${label.padEnd(44)} exists (reverted in body: ${String(reason).slice(0, 50)})`);
      } else {
        fail++;
        console.log(`FAIL  ${label.padEnd(44)} selector NOT FOUND (empty revert)`);
      }
    }
  }

  console.log("\n" + "=".repeat(72));
  if (fail === 0) {
    console.log("ALL V8.48 PROBES PASS" + (info.length ? `  (USDC permit: NOT supported — approve+selfRescue two-step path on testnet, fine)` : "  (USDC permit: SUPPORTED — one-signature self-rescue live on testnet)"));
  } else {
    console.log(`${fail} PROBE(S) FAILED — do NOT proceed to the integrity gate; paste this output to Claude.`);
    process.exit(1);
  }
})().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
