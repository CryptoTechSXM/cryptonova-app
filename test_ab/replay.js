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
 * Optional: AB_CAP=<n>   pins maxItemsPerUpkeep to n on BOTH arms (the valid 127 pairs use 5).
 * Optional: AB_CENSUS=1  adds the per-member queue census — episodes, exit mechanism,
 *                        time-to-re-park, withdrawable at rescue. Writes to
 *                        ab_result_<arm>_s<seed>_census.json so it cannot overwrite the
 *                        canonical pair. Costs roughly 2x wall clock. See the big comment
 *                        at `doCensus`, and read it before trusting a silent-exit count.
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
/**
 * ⛔⛔ AND A SECOND, WORSE COLLISION — FOUND SESSION 7, AND IT INVALIDATED A HEADLINE.
 *
 *    TWO DIFFERENT EVENTS SHARE THE NAME `MemberParked`:
 *      FigureEightMatrixV8.sol:98   MemberParked(address indexed member, uint256 shortfall)
 *      TierRouter.sol:372           MemberParked(address indexed member, uint8 tier, string reason)
 *    The first is a member ENTERING THE PARKED QUEUE. The second is TierRouter reporting
 *    that it could not place someone ("insufficient funds", "autoReentry disabled") — a
 *    different thing entirely, emitted at :1458/:1496/:1499.
 *
 *    Different signatures mean different topic0, so neither cross-parses and the "first
 *    interface wins" rule above is not violated. The damage is downstream: keying the
 *    bucket by `p.name` puts BOTH in `ev["MemberParked"]`. And `args[0]` is `member` in
 *    both, so every per-member tally kept working, silently, over a mixture.
 *
 *    WHAT IT COST: session 6 reported 139 park events across 71 distinct members with 86%
 *    of them parking more than once, and wrote it up as the one result CONTRADICTING the
 *    V8.50 scope. The queue census added this session — which reads the parked array
 *    itself — found 71 members, 71 episodes and ZERO re-parks on the same run. Two
 *    instruments, flatly opposed. The name collision is why.
 *
 *    `args[1]` is `shortfall` (6-dec USDC) in one and `tier` (a small uint8) in the other,
 *    so `shortfallVolume` was being summed across both. Small contamination, still wrong.
 *
 *    Buckets are now keyed by NAME PLUS ARITY. Not elegant; unambiguous.
 *
 * ⚠ AND THE MIRROR IMAGE: `MatrixLogicLib:1516` pushes to the parked queue and emits
 *   `SlotParkedIdle`, NOT `MemberParked` — the idle-slot reclaim path. So an event scan for
 *   `MemberParked` alone also MISSES queue entries. Both directions of error, in one
 *   number. Every other matrix push (:527 :879 :906 :936 :977 :1937) is paired 1:1 with an
 *   emit on the very next line, so once SlotParkedIdle is counted the identity is exact:
 *       queue insertions == MemberParked(matrix) + SlotParkedIdle
 */
function collect(ifaces, rc, into) {
  for (const log of rc.logs) {
    for (const iface of ifaces) {
      let p = null;
      try { p = iface.parseLog(log); } catch { continue; }
      if (!p) continue;
      // Disambiguate the one name two contracts both use. Anything else keeps its name.
      const key = p.name === "MemberParked" && p.fragment.inputs.length === 3
        ? "MemberParkedRouter" : p.name;
      (into[key] ||= []).push(p.args);
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

  /**
   * ══ AB_CENSUS=1 — THE PER-MEMBER INSTRUMENT (session 7) ═══════════════════════════════
   *
   * WHY IT EXISTS. The session-6 A/B found the one result that contradicts the V8.50 scope:
   * total park EVENTS are unchanged (~131 both arms) but V8.50 concentrates them onto HALF
   * as many members, 86% of whom cycle, against the control's 10%. Two neat explanations
   * were offered and BOTH were marked UNVERIFIED, correctly — the second ("cheaper rescues
   * return a member with less support, so they re-park sooner") is exactly the kind of story
   * that is easy to believe because it is tidy.
   *
   * ⛔ AND THERE IS AN ARITHMETIC CONTRADICTION IN THE SESSION-6 NUMBERS THAT NOBODY RAN
   *    DOWN. Parks minus rescues minus evictions should approximate the queue left at the
   *    end. Seed 1:
   *        control  136 - 88 - 1 = 47 expected,  53 actual  -> gap 6
   *        V8.50    139 - 47 - 9 = 83 expected,  26 actual  -> GAP 57
   *    Fifty-seven V8.50 members left the parked queue by some route that emits neither
   *    ParkedRescued nor ParkedMemberEvicted. MatrixLogicLib has FOUR exit paths that emit
   *    NOTHING AT ALL (enterMatrix re-entry :400, forceCross :1536, exitSeat :1803,
   *    deductForUpgrade :1913) — the same blind spot that made diag_parked_growth.js read
   *    cumulative-net 212 against a live queue of 105 until it was fixed this session.
   *
   *    So an event-only instrument CANNOT answer this question, and building one would have
   *    produced a confident wrong answer. This reads the QUEUE ITSELF.
   *
   * HOW. Before and after every keeper tick it enumerates both matrices' parked queues via
   * getParkedCount/getParkedMember and records, per parked member, their withdrawable
   * balance and parkedAt stamp. Membership is diffed between snapshots: an address that
   * leaves the queue has EXITED, whether or not anything was emitted. The exit is then
   * attributed to a rescue or an eviction ONLY if a matching event fired in that same tick;
   * everything else is recorded as SILENT rather than guessed at.
   *
   * WHAT IT COSTS AND WHY THE READS ARE SAFE. Two snapshots per tick, each ~|queue| view
   * calls. These are eth_call against a state that is static between transactions — the
   * ARRAY_RANGE_ERROR the handoff records for getParkedMember was a RACE on a live chain
   * during a multi-minute scan, and does not apply in-process between txs. Reads mine no
   * blocks and move no clock, so the replay is unperturbed — which is asserted, not assumed:
   * run once with AB_CENSUS unset and the result file must stay byte-identical.
   */
  const doCensus = process.env.AB_CENSUS === "1";
  const episodes = new Map();      // member -> [{ parkTs, exitTs, how, wdAtPark, wdAtExit }]
  const openEp   = new Map();      // member -> the currently-open episode object
  const censusErr = [];

  const nowTs = async () => (await ethers.provider.getBlock("latest")).timestamp;

  /** Exact membership of both parked queues, with the two per-member numbers we need. */
  async function snapshot() {
    const seen = new Map();
    for (const [tag, m] of [["A", w.matA], ["B", w.matB]]) {
      let count = 0;
      try { count = Number(await m.getParkedCount()); }
      catch (e) { censusErr.push(`getParkedCount(${tag}): ${(e.shortMessage || e.message || "").slice(0, 80)}`); continue; }
      for (let i = 0; i < count; i++) {
        try {
          const addr = await m.getParkedMember(i);
          // withdrawableOf is the "support" figure the UNVERIFIED hypothesis is about.
          // Read it here, BEFORE the tick, so a rescue's reading is genuinely pre-rescue.
          let wd = 0n; try { wd = await m.withdrawableOf(addr); } catch {}
          seen.set(addr, { mat: tag, wd });
        } catch (e) {
          // Do not silently shorten the queue: a truncated snapshot would read as members
          // exiting, which is the exact signal being measured.
          censusErr.push(`getParkedMember(${tag},${i}) of ${count}: ${(e.shortMessage || e.message || "").slice(0, 80)}`);
          break;
        }
      }
    }
    return seen;
  }

  /**
   * Diff one snapshot against the open episodes and close/open as needed.
   * `rescued` and `evicted` are the members named by events in THIS tick; anything leaving
   * the queue without appearing in them is SILENT and is labelled that way, not guessed.
   */
  function reconcile(snap, ts, rescued, evicted) {
    for (const [m, info] of snap) {
      if (!openEp.has(m)) {
        const ep = { parkTs: ts, exitTs: null, how: null, wdAtPark: info.wd.toString(), wdAtExit: null };
        openEp.set(m, ep);
        if (!episodes.has(m)) episodes.set(m, []);
        episodes.get(m).push(ep);
      } else {
        openEp.get(m).wdLast = info.wd.toString();   // latest pre-exit reading
      }
    }
    for (const [m, ep] of [...openEp]) {
      if (snap.has(m)) continue;
      ep.exitTs = ts;
      ep.wdAtExit = ep.wdLast ?? ep.wdAtPark;
      ep.how = rescued.has(m) ? "rescued" : evicted.has(m) ? "evicted" : "silent";
      openEp.delete(m);
    }
  }

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
        // BEFORE. Also catches any parking done by the register txs since the last tick,
        // so an episode that opens and closes off-tick is still seen opening.
        if (doCensus) reconcile(await snapshot(), await nowTs(), new Set(), new Set());
        const rc = await (await w.keeper.performUpkeep(data, { gasLimit: REG_GAS })).wait();
        parseAll(rc); totalGas += rc.gasUsed;
        if (doCensus) {
          // Parse THIS tick's logs separately: `ev` is cumulative, and attributing an exit
          // to a rescue that happened forty ticks ago would manufacture the finding.
          const tickEv = {};
          collect(ifaces, rc, tickEv);
          const namesOf = (evName, argName, idx) =>
            new Set((tickEv[evName] || []).map((a2) => (a2[argName] !== undefined ? a2[argName] : a2[idx])));
          reconcile(await snapshot(), await nowTs(),
            namesOf("ParkedRescued", "member", 1), namesOf("ParkedMemberEvicted", "member", 0));
        }
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
  // A QUEUE INSERTION IS THE THING BEING COUNTED — not "an event with the word parked in
  // its name". Both emitting paths count, and only those two: MemberParked from the matrix
  // (six sites, each paired 1:1 with a parkedMembers.push on the next line) and
  // SlotParkedIdle from the idle-slot reclaim (:1516, the seventh push). TierRouter's
  // same-named event is a placement REFUSAL and is reported separately below, never here.
  const parkers = {};
  const bumpPark = (a) => { const m = field(a, "member", 0); parkers[m] = (parkers[m] || 0) + 1; };
  for (const a of ev["MemberParked"]   || []) bumpPark(a);
  for (const a of ev["SlotParkedIdle"] || []) bumpPark(a);
  const distinctParkers = Object.keys(parkers).length;
  const repeatParkers = Object.values(parkers).filter((c) => c > 1).length;
  const queueInsertions = (ev["MemberParked"] || []).length + (ev["SlotParkedIdle"] || []).length;

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

  /**
   * ══ CENSUS AGGREGATION ════════════════════════════════════════════════════════════════
   * Medians, not means. One member who re-parks in four seconds and one who never returns
   * average to a number describing neither, and this fixture is small enough that a single
   * outlier moves a mean visibly. Counts are reported beside every median so a median over
   * three samples cannot be quoted as if it were over sixty.
   */
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  let censusBlock = null;
  if (doCensus) {
    const exitsByHow = { rescued: 0, evicted: 0, silent: 0 };
    const reParkGaps = [];        // seconds between an exit and that member's NEXT park
    const wdAtRescue = [];        // withdrawable at the tick a rescue took them out
    const wdAtSilentExit = [];
    const wdAtFirstPark = [], wdAtRePark = [];
    const epCounts = [];
    let stillParked = 0;

    for (const [, eps] of episodes) {
      epCounts.push(eps.length);
      eps.forEach((ep, i) => {
        if (ep.exitTs === null) { stillParked++; return; }
        exitsByHow[ep.how] = (exitsByHow[ep.how] || 0) + 1;
        const wd = Number(ep.wdAtExit || 0) / 1e6;
        if (ep.how === "rescued") wdAtRescue.push(wd);
        if (ep.how === "silent")  wdAtSilentExit.push(wd);
        (i === 0 ? wdAtFirstPark : wdAtRePark).push(Number(ep.wdAtPark || 0) / 1e6);
        const next = eps[i + 1];
        if (next) reParkGaps.push(next.parkTs - ep.exitTs);
      });
    }
    censusBlock = {
      membersSeenParked: episodes.size,
      episodes: epCounts.reduce((a, x) => a + x, 0),
      episodesPerMember: { max: Math.max(0, ...epCounts), median: median(epCounts) },
      stillParkedAtEnd: stillParked,
      // ⛔ THE COLUMN THE EVENT-ONLY HARNESS COULD NOT SEE.
      exitsByHow,
      silentExitShare: (() => {
        const t = exitsByHow.rescued + exitsByHow.evicted + exitsByHow.silent;
        return t ? +(exitsByHow.silent / t).toFixed(4) : null;
      })(),
      // The direct test of "cheaper rescues return a member with less support".
      timeToRePark: { n: reParkGaps.length, medianSecs: median(reParkGaps),
                      minSecs: reParkGaps.length ? Math.min(...reParkGaps) : null },
      withdrawableUSD: {
        atRescue:     { n: wdAtRescue.length,     median: median(wdAtRescue) },
        atSilentExit: { n: wdAtSilentExit.length, median: median(wdAtSilentExit) },
        atFirstPark:  { n: wdAtFirstPark.length,  median: median(wdAtFirstPark) },
        atRePark:     { n: wdAtRePark.length,     median: median(wdAtRePark) },
      },
      // A snapshot that failed silently would look like members leaving the queue, which is
      // the signal itself. Any entry here voids the census, not just annotates it.
      snapshotErrors: censusErr.slice(0, 20),
      snapshotErrorCount: censusErr.length,
    };
    /**
     * ⛔ THE TWO INSTRUMENTS MUST BE MADE TO AGREE, IN THE FILE, EVERY RUN.
     *
     * The census reads the queue; the event tally counts insertions. They measure the same
     * thing by different means, so a gap is a defect in one of them and not a nuance to be
     * written up. Session 6 had 139 against a true 71 and nobody could see it, because
     * nothing ever printed the two side by side.
     *
     * The census is a LOWER BOUND by construction: it snapshots either side of a keeper
     * tick, so a member who parks and is rescued INSIDE one performUpkeep is never observed
     * in the queue at all. So `censusMissed` should be small and non-negative. Negative
     * means the census saw entries the events cannot account for — read it before anything
     * else in this file, because it would mean a third insertion path nobody has found.
     */
    censusBlock.reconcile = {
      queueInsertionsFromEvents: queueInsertions,
      episodesFromCensus: censusBlock.episodes,
      censusMissed: queueInsertions - censusBlock.episodes,
      note: "census is a lower bound: park-and-exit inside one performUpkeep is unobservable " +
            "between snapshots. Expect a small non-negative gap. NEGATIVE = undiscovered insertion path.",
    };
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
      // ⛔ `parkEvents` USED TO MEAN "MemberParked logs, both contracts' versions mixed".
      //    It now means QUEUE INSERTIONS and nothing else. The other two are reported
      //    beside it so the old, wrong number is reconstructable and cannot be quoted by
      //    accident: session 6's 139 was parkEventsMatrix + parkRefusalsRouter.
      parkEvents: queueInsertions,
      parkEventsMatrix: n("MemberParked"),
      parkEventsIdleSlot: n("SlotParkedIdle"),
      parkRefusalsRouter: n("MemberParkedRouter"),
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
      parksPerMember: seq.members ? +(queueInsertions / seq.members).toFixed(4) : null,
    },
    finalState: {
      sfBalance: (await w.usdc.balanceOf(w.sfAddr)).toString(),
      // getParkedCount is on FigureEightMatrixV8 (:606), NOT on the PairManager — run 1
      // asked the wrong contract and printed "ABSENT", which reads like a missing feature
      // rather than a wrong accessor.
      parkedA: await (async () => { try { return String(await w.matA.getParkedCount()); } catch (e) { return `ERR ${(e.shortMessage || "").slice(0, 40)}`; } })(),
      parkedB: await (async () => { try { return String(await w.matB.getParkedCount()); } catch (e) { return `ERR ${(e.shortMessage || "").slice(0, 40)}`; } })(),
    },
    ...(censusBlock ? { census: censusBlock } : {}),
  };

  console.log(JSON.stringify(result, null, 2));
  // A censused run writes to its OWN file. The canonical ab_result_<arm>_s<seed>.json is
  // the validated pair the handoff quotes and the thing a no-census run must reproduce
  // byte-for-byte; a censused run must not be able to overwrite it.
  const out = path.join(hre.config.paths.root,
    `ab_result_${arm}_s${seq.seed}${equalize ? "_eq" : ""}${doCensus ? "_census" : ""}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n  written: ${path.basename(out)}`);
  if (keeperFailures) {
    console.log(`  ⚠ ${keeperFailures} keeper tick(s) FAILED on this arm. If the other arm's count`);
    console.log(`    differs, the two runs did not receive equivalent treatment and the pair is void.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
