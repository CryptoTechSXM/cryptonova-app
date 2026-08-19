// probe_sf_views.js — WHICH StabilityFund VIEWS ACTUALLY EXIST ON THE DEPLOYED BUILD?
//
// Built 2026-08-19 (session 9). diag_eviction_clock.js could not read loan headroom for
// 107 of 107 parked members. Its V8.48 fallback derives headroom from three views via
// Promise.all — so if ANY ONE of them is missing the whole derivation throws and all three
// look equally broken. This asks each one separately.
//
// WHY IT KEEPS HAPPENING, stated once so the next session does not rediscover it:
// the repo tree is V8.50, the community chain runs V8.48, and a view added in V8.49 reverts
// on V8.48 with "missing revert data" — indistinguishable from a network fault at a glance.
// Already caught today: `evictionGracePeriod` (V8.49 item 1, b14eba7) vs V8.48's
// `extendedIdleTimeout`, and `loanHeadroom` (V8.49 item 1b, 40d7843).
// ⛔ ANY new code that calls the chain must be checked against the DEPLOYED ABI, not the
//    source tree. scripts/probe_v848_getters.js exists for exactly this and should be
//    extended rather than re-invented — this script is the narrow version for the SF.
//
// Read-only.
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\probe_sf_views.js

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) { console.error("\n  ADDRESSES_FILE is not set.\n"); process.exit(1); }
const A = require(path.join(__dirname, ADDRFILE));

// A KNOWN-GOOD member to probe with: any parked member. Falls back to accountOne.
const WHO = process.argv[2] || A.accountOne || A.deployer;
// ⛔ VALIDATE IT. Passing a TRUNCATED address (e.g. copied from a table that abbreviates)
// makes ethers treat it as an ENS name; Base Sepolia has no ENS, so every address-taking
// view fails with "network does not support ENS" and the output looks like the CONTRACT is
// missing five functions. That happened on the first run of this script, 2026-08-19, and
// the wrong conclusion was one step away. Fail loudly on the input instead.
if (!ethers.isAddress(WHO)) {
  console.error(`\n  NOT A VALID ADDRESS: "${WHO}" (${String(WHO).length} chars, need 42).`);
  console.error("  A shortened address makes ethers try ENS, and every address-taking view then");
  console.error("  fails with 'network does not support ENS' — which is NOT the contract missing");
  console.error("  those functions. Pass the full 0x… address.\n");
  process.exit(1);
}

const CASES = [
  ["insolvencyFloorBps()",            "function insolvencyFloorBps() view returns (uint256)",        () => []],
  ["memberDebt(address)",             "function memberDebt(address) view returns (uint256)",         () => [WHO]],
  ["memberDebtOf(address)",           "function memberDebtOf(address) view returns (uint256)",       () => [WHO]],
  ["tierEntryFees(uint256)",          "function tierEntryFees(uint256) view returns (uint256)",      () => [0]],
  ["loanEligible(address,uint8)",     "function loanEligible(address,uint8) view returns (bool)",    () => [WHO, 0]],
  ["loanHeadroom(address,uint8)",     "function loanHeadroom(address,uint8) view returns (uint256)", () => [WHO, 0]],
  ["loanEligibleFor(addr,u8,u256)",   "function loanEligibleFor(address,uint8,uint256) view returns (bool)", () => [WHO, 0, 1000000]],
  ["totalBalance()",                  "function totalBalance() view returns (uint256)",              () => []],
  ["totalRescueLoaned()",             "function totalRescueLoaned() view returns (uint256)",         () => []],
  ["stabilityFloor()",                "function stabilityFloor() view returns (uint256)",            () => []],
];

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });
  console.log("");
  console.log("STABILITY FUND VIEW PROBE — " + new Date().toISOString());
  console.log(`  addresses : ${ADDRFILE}`);
  console.log(`  SF        : ${A.stabilityFund}`);
  console.log(`  probing as: ${WHO}`);
  const code = await p.getCode(A.stabilityFund);
  console.log(`  code size : ${(code.length - 2) / 2} bytes` + (code === "0x" ? "   ⛔ NOTHING DEPLOYED HERE" : ""));
  console.log("=".repeat(92));
  console.log("  " + pad("view", 34) + pad("result", 26) + "note");
  console.log("  " + "-".repeat(88));

  const present = [], absent = [];
  for (const [label, frag, args] of CASES) {
    const c = new ethers.Contract(A.stabilityFund, [frag], p);
    const fn = frag.match(/function (\w+)/)[1];
    try {
      const v = await c[fn](...args());
      console.log("  " + pad(label, 34) + pad(String(v).slice(0, 24), 26) + "EXISTS");
      present.push(label);
    } catch (e) {
      const m = (e.shortMessage || e.message || "").replace(/\s+/g, " ").slice(0, 46);
      console.log("  " + pad(label, 34) + pad("—", 26) + m);
      absent.push(label);
    }
  }

  console.log("\n" + "=".repeat(92));
  console.log(`  present: ${present.length}   absent/failing: ${absent.length}`);
  console.log("");
  console.log("  READ IT THIS WAY:");
  console.log("   · 'missing revert data' = the function is NOT on this deployment. Not a network fault.");
  console.log("   · If insolvencyFloorBps + memberDebt(or memberDebtOf) + tierEntryFees are all present,");
  console.log("     headroom can be derived: fee * bps / 10000 - debt. Point the fallback at whichever");
  console.log("     debt getter actually answered.");
  console.log("   · If the whole probe fails, check the SF address and whether state reads are up at all");
  console.log("     (watch_base_sepolia.mjs) before concluding anything about the ABI.");
  console.log("");
})().catch((e) => { console.error("FAILED: " + (e.stack || e.message || e)); process.exit(1); });
