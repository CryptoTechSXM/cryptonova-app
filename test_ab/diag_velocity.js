"use strict";
/**
 * test_ab/diag_velocity.js — WHY DOES THE VELOCITY WORK ITEM FAIL?
 *
 * Written session 7 (2026-08-18) for handoff NEXT-ON-THE-A/B item 2:
 *   "68 VELOCITY WorkItemFailed — identical on both arms, every run, so non-confounding
 *    but unexplained. Do not trust the harness further until it is understood."
 *
 * Run (control first, then subject — same script both times):
 *   npx hardhat run test_ab/diag_velocity.js --config hardhat.v849b.config.js
 *   npx hardhat run test_ab/diag_velocity.js
 *
 * WHAT THIS MEASURES, AND WHY IT IS THIS AND NOT A BIGGER FIXTURE.
 *   The replay swallows the reason: MatrixKeeper.sol:796 dispatches VELOCITY through
 *   `try this._doVelocityCheckExternal() {} catch { emit WorkItemFailed(...) }`. A bare
 *   `catch` keeps no reason string, so 68 failures carry exactly zero diagnostic bytes.
 *   `manualVelocityCheck()` (MatrixKeeper.sol:1084, onlyOwner) runs THE SAME internal
 *   `_doVelocityCheck()` with NO catch — so calling it directly is the same code path with
 *   the revert reason still attached. No 288-member sequence needed, no MATRIX_SIZE 127,
 *   seconds not minutes.
 *
 *   The state machine matters to the reproduction, so the loop below is not decoration:
 *   `_doVelocityCheck` only touches the stability layers ON A STATE TRANSITION. With no
 *   registrations, every window is "red" (sysCount 0 < deflationThreshold 10), and the
 *   transition NORMAL -> SLOW needs consecutiveRedWindows >= 2. So call 1 is expected to
 *   pass and the interesting call is the SECOND one onward. A single call would have
 *   measured nothing and looked like a clean bill of health.
 *
 *   Each iteration also reads `lastVelocityCheck` BACK FROM THE CONTRACT. That is the
 *   number that explains the COUNT (68 across 69 ticks) rather than the failure:
 *   `_doVelocityCheck` sets it at line 1090, but a revert rolls the whole external call
 *   back, so it never advances — and MatrixKeeperLib:233 re-queues the item whenever
 *   `block.timestamp >= lastVelocityCheck + velocityWindow`. If the read shows it frozen,
 *   the item is not failing intermittently, it is failing on every tick forever. An intent
 *   flag would not have shown that; reading the value back does.
 *
 * ⛔ RESULTS GO IN THE FILE, NOT ONLY THE CONSOLE. Session 6 lost every keeper-failure
 *    line to a Select-String pattern the console had already mangled.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployWorld, armOf } = require("./world");

const SIZE = Number(process.env.DIAG_SIZE || 7);   // size is irrelevant here; keep it fast
const CALLS = Number(process.env.DIAG_CALLS || 5);

const why = (e) => (e.shortMessage || e.message || String(e)).replace(/\s+/g, " ").slice(0, 220);

async function main() {
  const arm = armOf(hre);
  const { ethers } = hre;
  const out = { arm, sources: hre.config.paths.sources, size: SIZE, calls: [], probes: {} };

  console.log(`\n  VELOCITY DIAGNOSTIC — arm ${arm}, MATRIX_SIZE ${SIZE}`);
  const w = await deployWorld(hre, SIZE);

  // The dials that drive the state machine, read from the contract rather than restated
  // from the source — a hardcoded copy keeps asserting the old value after a default moves.
  const dials = {};
  for (const k of ["velocityWindow", "velocityThreshold", "deflationThreshold",
                   "recoveryThreshold", "lastVelocityCheck", "deflationState",
                   "consecutiveRedWindows", "consecutiveGreenWindows", "configuredTierCount"]) {
    try { dials[k] = String(await w.keeper[k]()); } catch (e) { dials[k] = `ABSENT (${why(e)})`; }
  }
  out.dials = dials;
  console.log(`  dials: ${JSON.stringify(dials)}`);

  // PROBE 1 — does the StabilityFund actually implement what _setStabilityLayers calls?
  //   MatrixKeeper.sol:1128-1129 calls IStabilityFundKeeper(stabilityFund).activateLayer().
  //   That selector is DECLARED in the interface (MatrixKeeperLib.sol:52). Declared is not
  //   implemented. Ask the deployed contract directly instead of reading the source and
  //   believing it: a call to a missing selector on a contract with no fallback reverts,
  //   and the revert here would be indistinguishable from a permissions failure in the
  //   swallowed keeper catch.
  const sfProbe = new ethers.Contract(w.sfAddr,
    ["function activateLayer(uint8 layer, bool active) external"], w.owner);
  try {
    await sfProbe.activateLayer.staticCall(2, true);
    out.probes.activateLayer_staticCall = "SUCCEEDED — the function exists and is callable by owner";
  } catch (e) { out.probes.activateLayer_staticCall = `REVERTED: ${why(e)}`; }

  // And the same question asked a second, independent way: is there any code at that
  // selector at all? Two instruments that agree is the standard this project holds itself
  // to; one that disagrees with the other IS the finding.
  const sel = ethers.id("activateLayer(uint8,bool)").slice(0, 10);
  try {
    await ethers.provider.call({ to: w.sfAddr, data: sel + "0".repeat(128) });
    out.probes.activateLayer_rawSelector = "raw call returned — selector is handled";
  } catch (e) { out.probes.activateLayer_rawSelector = `raw call REVERTED: ${why(e)}`; }

  // PROBE 2 — walk the state machine. The revert is expected on call 2, not call 1.
  for (let i = 1; i <= CALLS; i++) {
    const before = String(await w.keeper.lastVelocityCheck());
    const rec = { call: i, lastVelocityCheckBefore: before };
    try {
      await (await w.keeper.manualVelocityCheck()).wait();
      rec.result = "OK";
    } catch (e) {
      rec.result = "REVERTED";
      rec.reason = why(e);
    }
    // READ BACK. Whether it advanced is the whole point.
    rec.lastVelocityCheckAfter = String(await w.keeper.lastVelocityCheck());
    rec.advanced = rec.lastVelocityCheckAfter !== before;
    for (const k of ["deflationState", "consecutiveRedWindows", "consecutiveGreenWindows"]) {
      try { rec[k] = String(await w.keeper[k]()); } catch { rec[k] = "ABSENT"; }
    }
    out.calls.push(rec);
    console.log(`  call ${i}: ${rec.result}${rec.reason ? " — " + rec.reason : ""} | ` +
      `lastVelocityCheck advanced=${rec.advanced} state=${rec.deflationState} red=${rec.consecutiveRedWindows}`);
    // Push past the window so the next call is a fresh window, exactly as a keeper tick would.
    await hre.network.provider.send("evm_increaseTime", [Number(dials.velocityWindow || 3600) + 60]);
    await hre.network.provider.send("evm_mine", []);
  }

  const failed = out.calls.filter((c) => c.result === "REVERTED").length;
  const everAdvancedAfterFirstFail = out.calls.some((c, i) => i > 0 && c.advanced && out.calls[i - 1].result === "REVERTED");
  out.verdict = {
    callsRun: CALLS,
    callsReverted: failed,
    firstRevertAtCall: (out.calls.find((c) => c.result === "REVERTED") || {}).call ?? null,
    deflationStateEver: [...new Set(out.calls.map((c) => c.deflationState))],
    lastVelocityCheckFrozenAfterFirstFailure: failed > 0 && !everAdvancedAfterFirstFail,
  };
  console.log(`\n  VERDICT: ${JSON.stringify(out.verdict)}`);

  const file = path.join(hre.config.paths.root, `diag_velocity_${arm}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`  written: ${path.basename(file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
