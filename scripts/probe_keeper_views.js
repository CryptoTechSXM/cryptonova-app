// probe_keeper_views.js - WHICH MatrixKeeper VIEWS ACTUALLY EXIST ON THE DEPLOYED BUILD?
//
// Built 2026-08-19 (session 10). Sibling of probe_sf_views.js, NOT an extension of it, and
// the reason is the finding that produced this file:
//
//   THE SESSION 9 HANDOFF RECORDS "probe_sf_views.js found loanHeadroom AND
//   evictionGracePeriod are the two absent ones". probe_sf_views.js CANNOT HAVE FOUND THAT.
//   Its case list has ten entries and evictionGracePeriod is not one of them - it probes the
//   StabilityFund, and evictionGracePeriod is declared on MatrixKeeper (MatrixKeeper.sol:372).
//   The claim was read off the SOURCE TREE and attributed to an instrument that never made it.
//
// That is the session 9 trap again, one level up: AN INSTRUMENT MUST NOT REPORT THE ABSENCE
// OF WHAT IT CANNOT OBSERVE - and a HANDOFF must not report what the instrument never asked.
// So the keeper half of index.html's parked-badge fallback has never been measured against
// the deployed keeper. This script measures it.
//
// WHAT DEPENDS ON THE ANSWER (index.html renderParkedList, ~line 9837):
//     try { _evictGrace = BigInt(await _k.evictionGracePeriod()); }   // V8.49+
//     catch (_) { _evictGrace = BigInt(await _k.extendedIdleTimeout()); }   // V8.48
// If BOTH are absent or unreachable the countdown line silently disappears from every parked
// row. If the FIRST answers, the countdown is the eviction clock. If only the SECOND answers,
// the countdown is the idle-slot-reclaim clock - and MatrixKeeper.sol:1066 says in terms
// "Do NOT re-point this at extendedIdleTimeout to keep them in step. They are [different]".
// On V8.48 they happen to be equal (both 604_800), which is exactly why this needs measuring
// rather than assuming: equal today is not the same as interchangeable.
//
// HOW THIS ONE REFUSES TO LIE ABOUT ABSENCE:
//   1. CONTROLS FIRST. Views that certainly exist on V8.48 are probed before the questions.
//      If a control fails, the whole run is declared VOID - a flapping endpoint returns the
//      same shape as a missing function, and on 2026-08-19 that cost this project an
//      afternoon. A green control is what makes an ABSENT verdict mean anything.
//   2. A FAILURE IS RETRIED 3x BEFORE IT IS BELIEVED. One successful read proves existence
//      outright; one failed read proves nothing. Same asymmetry the bigfill top-up check got
//      wrong in session 9 (it declared "DID NOT LAND" from a single stale read).
//   3. THE VERDICT IS CLASSIFIED, NOT GUESSED. "empty return / missing revert data" is the
//      contract saying the selector is not there. A network code is the endpoint, not the
//      ABI. They are printed as different words and never merged.
//
// Read-only. No wallet, no keys, nothing is written to any chain.
//   cd C:\CryptoNite-Smart-Contracts\CryptoNova
//   node scripts\probe_keeper_views.js
//
// Output is deliberately ASCII-only (owner request 2026-08-19) - PowerShell 5.1 mangles the
// rest.

const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRFILE = process.env.ADDRESSES_FILE;
if (!ADDRFILE) {
  console.error("\n  ADDRESSES_FILE is not set. Refusing to guess a deployment.\n");
  process.exit(1);
}
const A = require(path.join(__dirname, ADDRFILE));

// label, fragment, args, isControl
const CASES = [
  // -- CONTROLS: present since V8.33/V8.44, long before the live V8.48 build ---------
  ["idleSlotTimeout()",      "function idleSlotTimeout() view returns (uint256)",   () => [], true],
  ["maxItemsPerUpkeep()",    "function maxItemsPerUpkeep() view returns (uint256)", () => [], true],
  ["stabilityFund()",        "function stabilityFund() view returns (address)",     () => [], true],
  ["tierRouter()",           "function tierRouter() view returns (address)",        () => [], true],

  // -- THE QUESTION: the two clocks the badge falls back between ---------------------
  ["evictionGracePeriod()",  "function evictionGracePeriod() view returns (uint256)",  () => [], false],
  ["extendedIdleTimeout()",  "function extendedIdleTimeout() view returns (uint256)",  () => [], false],

  // -- CONTEXT: read while we are here. parkedGracePeriod is the OTHER parked clock and
  //    has been confused with the eviction one before; minGasPerItem is the owner-decided
  //    5M and this is a free chance to confirm the dial is in force on the DEPLOYED build
  //    rather than in source. A dial set is not a dial in force.
  ["parkedGracePeriod()",    "function parkedGracePeriod() view returns (uint256)",    () => [], false],
  ["minGasPerItem()",        "function minGasPerItem() view returns (uint256)",        () => [], false],
];

const pad = (s, n) => String(s).padEnd(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Classify a thrown ethers error. The whole point of this script is that these two are
// DIFFERENT ANSWERS and must never be printed as the same word.
function classify(e) {
  const code = e && e.code ? String(e.code) : "";
  const msg = ((e && (e.shortMessage || e.message)) || "").replace(/\s+/g, " ");

  // The contract returned nothing for this selector -> the function is not on this build.
  if (code === "BAD_DATA" && (e.value === "0x" || e.value === undefined)) return ["ABSENT", msg];
  if (code === "CALL_EXCEPTION" && (e.data === null || e.data === "0x" || e.data === undefined)) {
    return ["ABSENT", msg];
  }
  if (/could not decode result data|missing revert data/i.test(msg)) return ["ABSENT", msg];

  // The endpoint, not the ABI.
  if (["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "UNKNOWN_ERROR", "CALL_EXCEPTION"].includes(code)) {
    return ["UNREACHABLE", code + ": " + msg];
  }
  if (/503|502|504|fetch|socket|ECONN|timeout/i.test(msg)) return ["UNREACHABLE", msg];

  return ["OTHER", code + ": " + msg];
}

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });

  console.log("");
  console.log("MATRIX KEEPER VIEW PROBE - " + new Date().toISOString());
  console.log("  addresses : " + ADDRFILE);
  console.log("  keeper    : " + A.matrixKeeper);
  console.log("  RPC       : " + String(RPC).replace(/\/[^/]{12,}$/, "/<redacted>"));

  // Reaching the chain at all is its own precondition. If getCode fails there is no point
  // reading anything below it, and "the keeper has no code" is a very different emergency
  // from "this view is missing".
  let code;
  try {
    code = await p.getCode(A.matrixKeeper);
  } catch (e) {
    console.log("\n  CANNOT REACH THE CHAIN: " + ((e.shortMessage || e.message || e) + "").slice(0, 120));
    console.log("  Nothing below this line would mean anything. Check state reads are up:");
    console.log("     cd C:\\CryptoNova-Testnet-App; node watch_base_sepolia.mjs");
    console.log("");
    process.exit(2);
  }
  const sz = (code.length - 2) / 2;
  console.log("  code size : " + sz + " bytes" + (code === "0x" ? "   *** NOTHING DEPLOYED HERE ***" : ""));
  if (code === "0x") {
    console.log("\n  STOP. There is no contract at that address. Check ADDRESSES_FILE.\n");
    process.exit(2);
  }

  console.log("=".repeat(92));
  console.log("  " + pad("view", 26) + pad("verdict", 14) + pad("value", 22) + "note");
  console.log("  " + "-".repeat(88));

  const results = [];
  for (const [label, frag, args, isControl] of CASES) {
    const c = new ethers.Contract(A.matrixKeeper, [frag], p);
    const fn = frag.match(/function (\w+)/)[1];

    let verdict = null, value = "-", note = "";
    // One good read proves existence. One bad read proves nothing - so only failures retry.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const v = await c[fn](...args());
        verdict = "EXISTS";
        value = String(v);
        note = attempt > 1 ? "(answered on attempt " + attempt + ")" : "";
        break;
      } catch (e) {
        const [kind, msg] = classify(e);
        verdict = kind;
        note = msg.slice(0, 40);
        if (kind === "ABSENT") break;      // a decoded empty return will not change on retry
        if (attempt < 3) await sleep(1500); // transport: give it a moment and ask again
      }
    }

    results.push({ label, verdict, value, isControl });
    console.log(
      "  " + pad(label, 26) + pad(verdict + (isControl ? " [ctrl]" : ""), 14) +
      pad(value.slice(0, 20), 22) + note
    );
  }

  const controls = results.filter((r) => r.isControl);
  const badControls = controls.filter((r) => r.verdict !== "EXISTS");
  const unreachable = results.filter((r) => r.verdict === "UNREACHABLE");

  console.log("\n" + "=".repeat(92));

  if (badControls.length) {
    console.log("  *** THIS RUN IS VOID ***");
    console.log("  " + badControls.length + " of " + controls.length + " CONTROL views failed. Controls are functions that are");
    console.log("  certainly on this build, so their failure means the endpoint is not answering");
    console.log("  properly - it does NOT mean the contract changed. Every ABSENT verdict above is");
    console.log("  unsafe. Re-run after a clean streak:");
    console.log("     cd C:\\CryptoNova-Testnet-App; node watch_base_sepolia.mjs");
    console.log("");
    process.exit(3);
  }

  console.log("  Controls: " + controls.length + "/" + controls.length + " answered, so ABSENT below means the ABI, not the network.");
  if (unreachable.length) {
    console.log("  WARNING: " + unreachable.length + " view(s) came back UNREACHABLE after 3 attempts while the");
    console.log("  controls were green. That is a mixed result - do not read those rows as ABSENT.");
  }

  const grace = results.find((r) => r.label === "evictionGracePeriod()");
  const idle = results.find((r) => r.label === "extendedIdleTimeout()");

  console.log("");
  console.log("  WHAT THIS MEANS FOR THE PARKED-MEMBER BADGE IN index.html:");
  if (grace.verdict === "EXISTS") {
    console.log("   - evictionGracePeriod() ANSWERS (" + grace.value + "s). The badge takes its PRIMARY path.");
    console.log("     The countdown is the real eviction clock. This build is V8.49 or later.");
  } else if (idle.verdict === "EXISTS") {
    console.log("   - evictionGracePeriod() is " + grace.verdict + ", extendedIdleTimeout() answers (" + idle.value + "s).");
    console.log("     The badge takes its FALLBACK path and the countdown comes from the IDLE-SLOT");
    console.log("     RECLAIM clock. On V8.48 that is the value eviction actually enforced, so the");
    console.log("     number is right on THIS chain. It stops being right the moment the chain is");
    console.log("     V8.49+, because there the two are separate dials (MatrixKeeper.sol:1053-1071).");
  } else {
    console.log("   - NEITHER clock answered. Every parked row loses its countdown line entirely.");
    console.log("     The badge still renders its funding verdict; only the time half goes quiet.");
  }
  console.log("");
  console.log("  READ IT THIS WAY:");
  console.log("   - EXISTS      = the function is on the deployed build. Decisive on one read.");
  console.log("   - ABSENT      = the contract returned nothing for that selector. Not a network fault.");
  console.log("   - UNREACHABLE = the endpoint failed 3 times. Says NOTHING about the ABI.");
  console.log("");
})().catch((e) => {
  console.error("FAILED: " + (e.stack || e.message || e));
  process.exit(1);
});
