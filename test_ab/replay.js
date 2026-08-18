"use strict";
/**
 * test_ab/replay.js — replays one sequence file against ONE arm and records what happened.
 *
 * Run (control, then subject — same sequence file both times):
 *   $env:AB_SEQ="ab_sequence_s1.json"
 *   npx hardhat run test_ab/replay.js --config hardhat.v849b.config.js
 *   npx hardhat run test_ab/replay.js
 *   Remove-Item Env:\AB_SEQ
 *
 * Optional: AB_EQUALIZE=1 pins maxItemsPerUpkeep to 15 on BOTH arms. See below.
 *
 * ⛔ WHAT IS MEASURED, AND WHY THESE AND NOT TOTALS.
 *   Four of the defects between these builds change KEEPER THROUGHPUT, not economics
 *   (defect 6 reorders discovery, 5 raised the cap, 8 added the floor, 7 stopped batch
 *   truncation). So a raw "rescues completed" or "parks remaining" comparison is part
 *   treatment and part throughput, and there is no way to tell which from the total alone.
 *
 *   Everything below is therefore recorded as COUNTS AND SUMS THAT CAN BE NORMALISED:
 *   loans per rescue, self-funded share of rescues, SF outflow per rescue. Those are
 *   ratios in which a throughput difference largely cancels. Raw totals are recorded too —
 *   but they are the numbers most likely to be quoted wrongly, so read the ratios first.
 *
 *   ⚠ AND ONE METRIC NEEDS NO CONTROL AT ALL: item A's headline claim, "frees the MatA
 *   parkers outright", is `selfFundedRescues / rescues` measured on the V8.50 arm ALONE.
 *   CoPayRescue carries sfShare directly, so sfShare == 0 IS "the fund paid nothing".
 *   Do not reach for the control to establish that one.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployWorld, armOf, FEE } = require("./world");

const REG_GAS = 16_700_000;   // just under the hardhat provider's 2^24 transaction cap

/**
 * ⛔ ONE LOG, ONE PARSE. The first version of this looped over every interface FOR EVERY
 *    LOG and pushed each successful parse — so any event that more than one contract's ABI
 *    declares (and several are declared in the libraries AND the interface file) was
 *    counted once PER INTERFACE. Counts multiplied silently. The ratios would have survived
 *    it, because both arms inflate identically; every raw total would have been wrong and
 *    nothing would have complained.
 *
 *    It surfaced only because a second bug crashed the run: some of those duplicate
 *    declarations have UNNAMED parameters, so `args.shortfall` came back undefined. A crash
 *    was the lucky outcome — the double-count on its own is silent.
 *
 *    Now: iterate the logs, take the FIRST interface that parses, stop. Positional access
 *    is available as a fallback for the unnamed declarations.
 */
function collect(ifaces, rc, into) {
  for (const log of rc.logs) {
    for (const iface of ifaces) {
      let p = null;
      try { p = iface.parseLog(log); } catch { continue; }
      if (!p) continue;
      (into[p.name] ||= []).push(p.args);
      break;                      // <- the fix: never let a second interface see this log
    }
  }
}

async function main() {
  const arm = armOf(hre);
  const seqFile = process.env.AB_SEQ || "ab_sequence_s1.json";
  const seqPath = path.join(hre.config.paths.root, seqFile);
  if (!fs.existsSync(seqPath)) throw new Error(`sequence file not found: ${seqFile} — run gen_sequence.js first`);
  const seq = JSON.parse(fs.readFileSync(seqPath, "utf8"));
  const equalize = process.env.AB_EQUALIZE === "1";

  console.log(`\n  A/B REPLAY — arm ${arm}, seq ${seqFile} (seed ${seq.seed}, ` +
    `${seq.members} members, MATRIX_SIZE ${seq.size})${equalize ? ", DIALS EQUALISED" : ""}`);

  const w = await deployWorld(hre, seq.size);
  const { ethers } = hre;

  // Equalising the cap is how the throughput confound gets separated rather than argued
  // about: run the pair once at release defaults (15 vs 20) and once pinned to 15/15. The
  // DIFFERENCE between those two comparisons is the throughput contribution, measured.
  // AB_CAP pins maxItemsPerUpkeep on BOTH arms. This exists because of what the first
  // MATRIX_SIZE 127 run measured: the CONTROL failed 7-8 keeper ticks and the subject
  // failed none. v849b has NO GAS FLOOR — it attempts all 15 items and runs out of gas, so
  // the transaction reverts outright. That is defect 8's rationale reproduced as an
  // experimental artifact, and it is a real V8.50 benefit — but it also means the control
  // cannot execute the same workload, which voids the pair as a controlled comparison.
  //
  // Pinning both arms to a cap whose batch demonstrably fits (5 items measured at 5.11M at
  // 127) lets BOTH complete every tick, so the economics can be compared on equal footing.
  const cap = Number(process.env.AB_CAP || 0);
  if (cap) await w.keeper.setMaxItemsPerUpkeep(cap);
  else if (equalize) await w.keeper.setMaxItemsPerUpkeep(15);

  // ⛔ RECORD THE DIALS AS THE CONTRACT REPORTS THEM, NOT AS WE INTENDED THEM.
  //    The seed-1 equalised pair came back byte-identical to the default pair, and there
  //    was no way to tell "the cap did not matter" from "the setter never fired" — because
  //    nothing read the value back. A flag recording our INTENT is not evidence about the
  //    contract's STATE.
  const dials = {
    maxItemsPerUpkeep: String(await w.keeper.maxItemsPerUpkeep()),
    minGasPerItem: await (async () => { try { return String(await w.keeper.minGasPerItem()); } catch { return "ABSENT"; } })(),
  };
  console.log(`  dials in force: maxItemsPerUpkeep=${dials.maxItemsPerUpkeep} minGasPerItem=${dials.minGasPerItem}`);

  // ⛔ THE LIBRARY INTERFACES ARE NOT OPTIONAL — THE FIRST RUN MISSED EVERY LOAN WITHOUT THEM.
  //    RescueLoanIssued, SelfRescue and CoPayRescue are all emitted from MatrixLogicLib
  //    (:1611, :1660, :1665, :1756). A library's events execute in the CALLING contract's
  //    context, so the logs carry the matrix's address — but they are NOT in the matrix's
  //    ABI unless separately re-declared there. Parse with contract interfaces alone and
  //    every loan is invisible.
  //
  //    Run 1 did exactly that and reported `loans: 0, coPayRescues: 0, selfRescues: 0`
  //    alongside 17 and 18 completed rescues. Rescues cannot happen with no funding event
  //    of any kind, and that contradiction is the only reason the gap was caught — a
  //    plausible-looking zero would have read as "item A removed all the lending", which
  //    is the exact headline this experiment exists to test. A zero that flatters the
  //    hypothesis deserves more suspicion than a zero that does not.
  const libIfaces = [];
  for (const lib of ["MatrixLogicLib", "MatrixKeeperLib", "TierRouterLib"]) {
    try { libIfaces.push((await ethers.getContractFactory(lib)).interface); }
    catch (e) { console.log(`      ⚠ could not load ${lib} interface: ${(e.message || "").slice(0, 80)}`); }
  }
  const ifaces = [w.keeper.interface, w.matA.interface, w.sf.interface, w.pm.interface,
                  w.tr.interface, ...libIfaces];
  const ev = {};
  const parseAll = (rc) => collect(ifaces, rc, ev);

  const addrOf = (idx) => (idx === -2 ? ethers.ZeroAddress : idx === -1 ? w.W1.address : w.sigs[10 + idx].address);
  const signerOf = (idx) => (idx === -1 ? w.W1 : w.sigs[10 + idx]);

  let registered = 0, keeperTicks = 0, keeperFailures = 0, totalGas = 0n;
  const keeperFailureReasons = [];
  const t0 = Date.now();

  for (const a of seq.actions) {
    if (a.op === "register") {
      const sg = signerOf(a.m);
      await w.usdc.mint(sg.address, FEE);
      await w.usdc.connect(sg).approve(w.pmAddr, FEE);
      try {
        const rc = await (await w.tr.connect(sg).register(addrOf(a.ref), { gasLimit: REG_GAS })).wait();
        parseAll(rc); totalGas += rc.gasUsed; registered++;
      } catch (e) {
        // A registration that cannot complete is a finding about the BUILD, not noise —
        // and if it happens on one arm and not the other the sequence has stopped being
        // identical input, which invalidates the pair.
        console.log(`      ⛔ register m=${a.m} FAILED on ${arm}: ${(e.shortMessage || e.message).slice(0, 120)}`);
      }
    } else if (a.op === "advance") {
      await hre.network.provider.send("evm_increaseTime", [a.secs]);
      await hre.network.provider.send("evm_mine", []);
    } else if (a.op === "keeper") {
      keeperTicks++;
      try {
        const [needed, data] = await w.keeper.checkUpkeep("0x");
        if (!needed || data === "0x") continue;
        const rc = await (await w.keeper.performUpkeep(data, { gasLimit: REG_GAS })).wait();
        parseAll(rc); totalGas += rc.gasUsed;
      } catch (e) {
        // ⛔ INTO THE RESULT FILE, NOT JUST THE CONSOLE. The first 127 run printed these and
        //    they were lost: the driver filtered with Select-String on a non-ASCII pattern
        //    against a console that mangles UTF-8, so the filter silently matched nothing.
        //    A diagnostic that only exists on stdout is one encoding mismatch from gone.
        keeperFailures++;
        const why = (e.shortMessage || e.message || "").slice(0, 160);
        keeperFailureReasons.push({ tick: keeperTicks, why });
        console.log(`      [FAIL] keeper tick ${keeperTicks} on ${arm}: ${why}`);
      }
    }
  }

  const n = (name) => (ev[name] || []).length;
  // Named access first, positional fallback second — the same event is declared with and
  // without parameter names across these ABIs. Throw loudly rather than coercing undefined,
  // because a silently-zero volume reads exactly like "the fund lent nothing", which is the
  // headline this experiment exists to test.
  const field = (a, name, idx) => {
    const v = a[name] !== undefined ? a[name] : a[idx];
    if (v === undefined) throw new Error(`event arg ${name}/[${idx}] missing — the ABI that ` +
      `parsed this log declares it differently; fix the accessor rather than defaulting to 0`);
    return v;
  };
  const sum = (name, fname, idx) =>
    (ev[name] || []).reduce((acc, a) => acc + BigInt(field(a, fname, idx)), 0n);

  // Repeat parking is the loop signature the live chain showed: 773 park events across 339
  // members, only 57 parked once and stayed out. It is a RATIO by construction, so it is
  // one of the few raw comparisons between arms that throughput does not distort.
  const parkers = {};
  for (const a of ev["MemberParked"] || []) { const m = field(a, "member", 0); parkers[m] = (parkers[m] || 0) + 1; }
  const distinctParkers = Object.keys(parkers).length;
  const repeatParkers = Object.values(parkers).filter((c) => c > 1).length;

  // 16 WorkItemFailed on BOTH arms in run 1, unexplained. The event carries the work type
  // (MatrixKeeper:448), so tally it: a cascade of PARKED_RESCUE failures means something
  // very different from a steady drip of RECLAIM ones, and "16 failures" alone cannot tell
  // them apart — which is defect 8's whole complaint about this event.
  const WORK_NAMES = ["VELOCITY", "GHOST", "RECLAIM", "CHAIN_LINK", "PARKED_RESCUE",
                      "VELOCITY_GATE", "EVICT_PARKED", "DISTRIBUTE_CW", "FORCE_ROTATE", "ADVANCE_EPOCH"];
  const failedByType = {};
  for (const a of ev["WorkItemFailed"] || []) {
    const wt = Number(field(a, "workType", 0));
    const k = WORK_NAMES[wt] || `type${wt}`;
    failedByType[k] = (failedByType[k] || 0) + 1;
  }

  const rescues = n("ParkedRescued");
  const loans = n("RescueLoanIssued");
  const coPay = ev["CoPayRescue"] || [];
  const selfFunded = coPay.filter((a) => BigInt(field(a, "sfShare", 1)) === 0n).length;

  // ⛔ THE CoPayRescue ROUTE NEVER FIRES IN THIS FIXTURE — measured, both arms, run 2:
  //    coPayRescues 0 and selfRescues 0 while 17/18 rescues completed. Every rescue takes
  //    the forceCrossKeeper path (MatrixLogicLib:1611). So `selfFundedShareOfCoPay` is
  //    structurally null here and CANNOT carry item A's headline.
  //
  //    The route-independent form is the difference: a rescue that completed WITHOUT a
  //    RescueLoanIssued is one the fund did not pay for. That is item A's claim stated in
  //    the only terms this fixture actually produces, and it needs no control — it is a
  //    within-arm count.
  const unfundedRescues = Math.max(0, rescues - loans);

  const result = {
    arm, seed: seq.seed, members: seq.members, size: seq.size, equalize,
    ran: { registered, keeperTicks, keeperFailures, seconds: Math.round((Date.now() - t0) / 1000) },
    dials,
    keeperFailureReasons,
    raw: {
      parkEvents: n("MemberParked"),
      distinctParkers, repeatParkers,
      rescues, loans,
      selfRescues: n("SelfRescue"),
      coPayRescues: coPay.length,
      coPaySelfFunded: selfFunded,
      unfundedRescues,
      evictions: n("ParkedMemberEvicted"),
      workItemFailed: n("WorkItemFailed"),
      workItemFailedByType: failedByType,
      batchGasHalted: n("BatchGasHalted"),
      loanVolume: sum("RescueLoanIssued", "loanAmount", 1).toString(),
      shortfallVolume: sum("MemberParked", "shortfall", 1).toString(),
      totalGas: totalGas.toString(),
    },
    // ⛔ READ THESE FIRST. The raw block above is what a throughput difference distorts.
    ratios: {
      loansPerRescue: rescues ? +(loans / rescues).toFixed(4) : null,
      selfFundedShareOfCoPay: coPay.length ? +(selfFunded / coPay.length).toFixed(4) : null,
      // The headline. Share of rescues the StabilityFund did not fund at all.
      unfundedRescueShare: rescues ? +(unfundedRescues / rescues).toFixed(4) : null,
      repeatParkShare: distinctParkers ? +(repeatParkers / distinctParkers).toFixed(4) : null,
      parksPerMember: seq.members ? +(n("MemberParked") / seq.members).toFixed(4) : null,
    },
    finalState: {
      sfBalance: (await w.usdc.balanceOf(w.sfAddr)).toString(),
      // getParkedCount is on FigureEightMatrixV8 (:606), NOT on the PairManager — run 1
      // asked the wrong contract and printed "ABSENT", which reads like a missing feature
      // rather than a wrong accessor.
      parkedA: await (async () => { try { return String(await w.matA.getParkedCount()); } catch (e) { return `ERR ${(e.shortMessage || "").slice(0, 40)}`; } })(),
      parkedB: await (async () => { try { return String(await w.matB.getParkedCount()); } catch (e) { return `ERR ${(e.shortMessage || "").slice(0, 40)}`; } })(),
    },
  };

  console.log(JSON.stringify(result, null, 2));
  const out = path.join(hre.config.paths.root,
    `ab_result_${arm}_s${seq.seed}${equalize ? "_eq" : ""}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n  written: ${path.basename(out)}`);
  if (keeperFailures) {
    console.log(`  ⚠ ${keeperFailures} keeper tick(s) FAILED on this arm. If the other arm's count`);
    console.log(`    differs, the two runs did not receive equivalent treatment and the pair is void.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
