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
 * Optional: AB_GATE_BPS=<n>  session 18. Sets the sponsorship gate's BASE ceiling for a
 *                        member with ZERO directs. Requires `node scripts/fixture_gate_apply.js`
 *                        + `npx hardhat compile` first; without the fixture the run ABORTS
 *                        rather than quietly reporting that the gate did nothing. The value
 *                        is read back off the contract and lands in the result FILENAME, so
 *                        a sweep row can never be mistaken for a baseline. Use 10000 (or
 *                        anything >= insolvencyFloorBps) for the inert control arm.
 * Optional: AB_CENSUS=1  adds the per-member queue census — episodes, exit mechanism,
 *                        time-to-re-park, withdrawable at rescue. Writes to
 *                        ab_result_<arm>_s<seed>_census.json so it cannot overwrite the
 *                        canonical pair. Costs roughly 2x wall clock. See the big comment
 *                        at `doCensus`, and read it before trusting a silent-exit count.
 * Optional: AB_EVICT=1   the ROUTING instrument (session 8). Decodes performData every tick
 *                        — the exact work list discovery produced — and derives, for every
 *                        parked member in it, WHICH of _triageParked's four eviction
 *                        branches fired. Implies AB_CENSUS. Writes to
 *                        ab_result_<arm>_s<seed>_census_evict.json. See `doEvict`.
 *
 * ALWAYS ON (session 18): the LOAN BOOK — every RescueLoanIssued with its amount, its size
 *                        in bps of the ENTRY FEE (the basis `loanHeadroom` uses), and the
 *                        borrower's directCount AT THAT MOMENT, taken from the sequence
 *                        file's referral tree. Plus `fitsUnderBase`, the counterfactual
 *                        "how many of these loans would a base ceiling of X bps still
 *                        grant". Reconciles against raw.loanVolume; a disagreement voids
 *                        both. See the block above `const loanBook` and the one that
 *                        builds `loanBookBlock`.
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
/**
 * WHICH TRANSACTION DID EACH EVENT COME FROM? (added 2026-08-19, session 9)
 *
 * The park bookkeeping above can say HOW MANY of each event fired but not whether two of
 * them fired TOGETHER — and that is the whole question about TierRouter's refusal event.
 * TierRouter:1449-1458 calls `matrixB.parkCycledOut(member, shortfall)` and then emits its
 * own `MemberParked(member, tier, "insufficient funds")`. `parkCycledOut` itself emits the
 * MATRIX `MemberParked` (MatrixLogicLib:1939). So in the normal case ONE member cycling out
 * underfunded produces BOTH events in ONE transaction, and counting them as two independent
 * populations is double-reporting a single park.
 *
 * But not always, and that is why this is measured rather than asserted:
 *   · `parkCycledOut` returns early when `parkedAt[member] > 0` (already parked) — router
 *     event, no matrix event, no NEW queue entry.
 *   · the call is wrapped in `try {} catch {}`, so a revert ("not a member", "still in
 *     matrix") is swallowed — router event, no matrix event, AND NO QUEUE ENTRY AT ALL.
 *     That second case is a member leaving with nothing holding them, which is precisely
 *     what the epilogue's own comment ("NEVER a silent exit") claims cannot happen.
 * Only pairing the two events per transaction can tell those apart.
 *
 * Kept in a WeakMap keyed by the destination bucket so the per-tick census bucket and the
 * cumulative one never mix, and so nothing downstream that iterates `ev` sees a new key.
 */
const TX_OF = new WeakMap();      // into -> { [eventKey]: txHash[] }, index-parallel to into[key]

function collect(ifaces, rc, into) {
  let txmap = TX_OF.get(into);
  if (!txmap) { txmap = {}; TX_OF.set(into, txmap); }
  for (const log of rc.logs) {
    for (const iface of ifaces) {
      let p = null;
      try { p = iface.parseLog(log); } catch { continue; }
      if (!p) continue;
      // Disambiguate the one name two contracts both use. Anything else keeps its name.
      const key = p.name === "MemberParked" && p.fragment.inputs.length === 3
        ? "MemberParkedRouter" : p.name;
      (into[key] ||= []).push(p.args);
      (txmap[key] ||= []).push(rc.hash ?? log.transactionHash);
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
    // READ BACK, not recorded from intent — AB_FLOOR_BPS asks the SF to move PARAM 59 and
    // this is the only evidence it did. Same reason the cap is read back: the seed-1
    // equalised pair came back byte-identical and nothing could tell "the dial did not
    // matter" from "the setter never fired".
    insolvencyFloorBps: await (async () => { try { return String(await w.sf.insolvencyFloorBps()); } catch { return "ABSENT"; } })(),
    // ABSENT here is the honest reading of "the gate fixture is not applied", and it is the
    // difference between a sweep row and a baseline row. Never infer it from the env var.
    baseAdvanceBps: await (async () => { try { return String(await w.sf.baseAdvanceBps()); } catch { return "ABSENT"; } })(),
  };
  console.log(`  dials in force: maxItemsPerUpkeep=${dials.maxItemsPerUpkeep} minGasPerItem=${dials.minGasPerItem} ` +
    `insolvencyFloorBps=${dials.insolvencyFloorBps} baseAdvanceBps=${dials.baseAdvanceBps}`);

  /**
   * ══ AB_EVICT=1 — THE ROUTING INSTRUMENT (session 8) ════════════════════════════════════
   *
   * THE QUESTION. The corrected A/B leaves exactly one unexplained anomaly: V8.50 evicts
   * 9/10/10 members per run against the control's 1/1/0. Session 6 guessed defect 6's
   * deadline-ordered discovery was finally reaching eviction work V8.49 starved. That guess
   * is UNVERIFIED and this session must not inherit it — the last three tidy explanations
   * this harness produced were all wrong, and the census that killed them worked because it
   * read STATE instead of reasoning about it.
   *
   * WHY EVENTS CANNOT ANSWER IT. `ParkedMemberEvicted(matrix, member, totalWithdrawn)`
   * carries NO reason. The reason is `_triageParked`'s uint8, which is an INTERNAL return
   * inside a view library — it is never emitted, never stored, and never reaches a log.
   * An event-only instrument can count evictions forever and never say why one happened.
   *
   * WHAT THIS READS INSTEAD, AND WHY IT IS NOT ARCHAEOLOGY.
   *
   *   1. THE DECISION ITSELF, FOR FREE. `checkUpkeep` returns
   *      `performData = abi.encode(WorkItem[])` and `WorkItem` is
   *      `(uint8 workType, uint8 tierIndex, address addr1, address addr2)` — declared
   *      field-order-load-bearing at MatrixKeeperLib:175. The replay already holds that
   *      blob; decoding it costs ZERO chain calls and yields the exact routing discovery
   *      chose: who went to WORK_EVICT_PARKED (6) and who to WORK_PARKED_RESCUE (4).
   *      That half of the answer needs no derivation at all.
   *
   *   2. THE BRANCH, DERIVED FROM THE SAME INPUTS THE CONTRACT USED. `_triageParked` is
   *      four ordered tests over public view functions:
   *         GHOST  isInMatrix(member) OR partner.isActiveInMatrix(member)
   *         RATIO  withdrawn*10_000/(withdrawn+withdrawable) > rescueRatioBps
   *         LADDER rescueBpsFor(thresholds, ladder, reserve+withdrawable, PRICE) == max
   *         FLOOR  advance > 0 AND NOT loanEligibleFor(member, tier, advance)
   *      Every input is readable, and the ladder walk is not re-implemented — it is asked
   *      of the deployed `MatrixKeeperLib.rescueBpsFor`, which is `external pure` on BOTH
   *      arms. Only the ORDER of the four tests is JavaScript, and the order is checked
   *      against the contract's own routing on every single item (see 4).
   *
   *   3. ⛔ THE ONE PLACE THE ARMS DIFFER IS MEASURED, NOT ASSUMED. `PRICE` above is the
   *      denominator, and it is the whole of V8.50 item A inside this function:
   *         v849b  MatrixKeeperLib:432   priceBasis = fee
   *         V8.50  MatrixKeeperLib:429   priceBasis = isMatrixA ? fee*5_000/10_000 : fee
   *      Hard-coding "this arm uses that one" would smuggle a hypothesis into the
   *      instrument. So BOTH are computed for every item and BOTH are scored against the
   *      contract's actual routing. Which basis reconciles is then a READING of the build,
   *      and if the expected one does not reconcile, that is a finding about item A rather
   *      than a silently wrong reason column.
   *
   *   4. ⛔ AND IT PRINTS ITS OWN RECONCILIATION, WHICH IS THE POINT. For every parked work
   *      item the contract produced, the derived reason must agree with the route taken:
   *      routed to EVICT => reason != NONE; routed to RESCUE => reason == NONE. Every
   *      disagreement lands in `mismatches`. A NON-EMPTY mismatch list VOIDS the reason
   *      column — do not quote a single figure out of it until that list is empty. This is
   *      the trap session 7 wrote down: two contaminated numbers that happen to agree read
   *      as a robust result, and nothing catches it unless the instrument is made to check
   *      itself in the file, every run.
   *
   * WHAT IT DOES NOT MEASURE, STATED SO IT IS NOT READ IN. This sees only members
   * discovery REACHED. With `AB_CAP=5` the batch fills, and `_scanParked` walks the queue
   * from index 0 and stops at the cap — so members deeper in the queue were never triaged
   * by the contract and are absent here. That is exactly the queue-position/starvation
   * hypothesis, so it is recorded separately and NOT inferred: `batches` keeps the cap, the
   * item count, the parked-queue lengths and the deepest queue index reached per tick.
   *
   * COST. Two decode-only operations per tick plus roughly six eth_calls per PARKED item in
   * the batch — at most `cap` of them. Reads mine no blocks and move no clock.
   */
  const doEvict  = process.env.AB_EVICT === "1";
  // Indexed BY workType — the constants at MatrixKeeper:155-164. Used by the WorkItemFailed
  // tally at the end AND by AB_EVICT's per-batch histogram, so it is declared before both.
  const WORK_NAMES = ["VELOCITY", "GHOST", "RECLAIM", "CHAIN_LINK", "PARKED_RESCUE",
                      "VELOCITY_GATE", "EVICT_PARKED", "DISTRIBUTE_CW", "FORCE_ROTATE", "ADVANCE_EPOCH"];
  const WORKITEM_ABI = ["tuple(uint8 workType,uint8 tierIndex,address addr1,address addr2)[]"];
  const REASON_NAMES = ["NONE", "GHOST", "RATIO", "LADDER", "FLOOR"];
  const routedItems = [];      // one row per parked work item discovery produced
  const batches     = [];      // one row per tick: what discovery could and could not reach
  const mismatches  = [];      // derived reason vs the route actually taken — MUST stay empty
  const evictCfgErr = [];
  const queueRows   = [];      // the POPULATION census — see below

  /**
   * ⛔ AB_QUEUE_EVERY — WHY THE BATCH IS NOT THE POPULATION, AND WHY THIS EXISTS.
   *
   * Run 1 of the routing instrument answered "why were these nine evicted" and immediately
   * raised a question it structurally CANNOT answer. Discovery reached queue indices 0-2
   * while the queue behind them was 26-31 deep, so the batch rows describe the HEAD of the
   * queue and nothing else. Worse, the two arms park in different halves of the pair — the
   * control's queue ends 41 in MatA / 12 in MatB, V8.50's ends 2 / 24 — and the control's
   * MatB members were never routed at all, so a batch-only instrument has ZERO observations
   * of the one cohort the comparison turns on.
   *
   * Reading a population difference off one arm's head-of-queue would be the session-6
   * mistake exactly: a real number, from a source that cannot see the thing being claimed.
   *
   * So every Nth tick this triages the ENTIRE parked queue of both matrices — the same
   * four-branch walk, on members discovery never looked at. N is a cost dial, not a
   * finding: at cap 5 the queue is ~30 deep and a per-tick full census would be ~6x the
   * run. Sampling every 5th tick is stated here so a count from this block is never quoted
   * as if it were a per-tick total. 0 disables it.
   */
  const queueEvery = doEvict ? Number(process.env.AB_QUEUE_EVERY ?? 5) : 0;

  /** The dials `_triageParked` reads, taken from the contract, tolerantly. */
  let ecfg = null;
  if (doEvict) {
    const readArray = async (fn) => {
      const out = [];
      for (let i = 0; i < 64; i++) { try { out.push(BigInt(await fn(i))); } catch { break; } }
      return out;
    };
    const readOne = async (label, fn, fallback) => {
      try { return BigInt(await fn()); }
      catch (e) { evictCfgErr.push(`${label}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); return fallback; }
    };
    ecfg = {
      fee:               await readOne("ENTRY_FEE", () => w.matA.ENTRY_FEE(), FEE),
      rescueRatioBps:    await readOne("rescueRatioBps", () => w.keeper.rescueRatioBps(), 7_000n),
      crossingBufferBps: await readOne("crossingBufferBps", () => w.keeper.crossingBufferBps(), 0n),
      thresholds:        await readArray((i) => w.keeper.sfRescueThresholds(i)),
      ladder:            await readArray((i) => w.keeper.sfRescueBpsLadder(i)),
      isA: {},
    };
    for (const [addr, m] of [[w.matAAddr, w.matA], [w.matBAddr, w.matB]]) {
      ecfg.isA[addr.toLowerCase()] = await readOne("isMatrixA", async () => (await m.isMatrixA()) ? 1n : 0n, 0n) === 1n;
    }
    console.log(`  evict instrument: fee=${ecfg.fee} rescueRatioBps=${ecfg.rescueRatioBps} ` +
      `buffer=${ecfg.crossingBufferBps} ladderRungs=${ecfg.thresholds.length}` +
      (evictCfgErr.length ? `  ⚠ ${evictCfgErr.length} config read(s) failed` : ""));
  }

  /**
   * `_triageParked` re-walked off-chain under ONE price basis. Returns the branch index,
   * the numbers behind it, and nothing inferred: a call that reverts is recorded as an
   * error, never coerced to a passing test — a silently-zero withdrawable would read as
   * poverty, which is one of the four answers being counted.
   */
  async function deriveReason(matAddr, member, tierIdx, priceBasis) {
    const m = matAddr.toLowerCase() === w.matAAddr.toLowerCase() ? w.matA : w.matB;
    const out = { reason: 0, err: null };
    try {
      if (await m.isInMatrix(member)) { out.reason = 1; return out; }
      const partner = await m.partner();
      if (partner !== hre.ethers.ZeroAddress) {
        const pm2 = w.matA.attach(partner);
        if (await pm2.isActiveInMatrix(member)) { out.reason = 1; return out; }
      }
      const withdrawable = BigInt(await m.withdrawableOf(member));
      const withdrawn    = BigInt(await m.getMemberTotalWithdrawn(member));
      const claimableEver = withdrawn + withdrawable;
      const withdrawRatio = claimableEver > 0n ? (withdrawn * 10_000n) / claimableEver : 0n;
      out.withdrawable = withdrawable.toString();
      out.withdrawn    = withdrawn.toString();
      out.withdrawRatio = Number(withdrawRatio);
      if (withdrawRatio > ecfg.rescueRatioBps) { out.reason = 2; return out; }

      const reserve = BigInt(await m.crossingReserveOf(member));
      const effectiveContrib = reserve + withdrawable;
      out.reserve = reserve.toString();
      out.effectiveContrib = effectiveContrib.toString();
      out.priceBasis = priceBasis.toString();
      out.wBps = priceBasis > 0n ? Number((effectiveContrib * 10_000n) / priceBasis) : null;

      // Asked of the DEPLOYED library, not re-implemented here.
      const sfBps = BigInt(await w.keeperLib.rescueBpsFor(ecfg.thresholds, ecfg.ladder,
                                                         effectiveContrib, priceBasis));
      const MAXU = (1n << 256n) - 1n;
      if (sfBps === MAXU) { out.reason = 3; return out; }
      out.sfBps = sfBps.toString();

      const maxShortfall = priceBasis > effectiveContrib ? priceBasis - effectiveContrib : 0n;
      let sfShare = (priceBasis * sfBps) / 10_000n;
      if (sfShare > maxShortfall) sfShare = maxShortfall;
      out.sfShare = sfShare.toString();

      const advance = sfShare + (ecfg.fee * ecfg.crossingBufferBps) / 10_000n;
      out.advance = advance.toString();
      if (advance > 0n) {
        // ⛔ RECORD WHAT THE FLOOR ACTUALLY COMPARED, NOT JUST THAT IT REFUSED.
        //    loanEligibleFor reduces to `advance <= loanHeadroom(member, tier)`, and
        //    loanHeadroom is `fee * insolvencyFloorBps / 10_000 - memberDebt` — a CEILING
        //    (PARAM 59) minus EXISTING DEBT. Those are two completely different stories
        //    about the same refusal: a ceiling that is structurally below what this class
        //    of member ever needs, versus a member who has borrowed their way up to it.
        //    Reading only the boolean makes them indistinguishable, and picking one to
        //    believe is the thing rule 1 forbids. Both numbers, every time.
        try { out.owed = String(await w.sf.memberDebtOf(member)); } catch { out.owed = null; }
        try { out.headroom = String(await w.sf.loanHeadroom(member, tierIdx)); } catch { out.headroom = null; }
        if (!(await w.sf.loanEligibleFor(member, tierIdx, advance))) { out.reason = 4; return out; }
      }
      return out;                       // EVICT_NONE — discovery should be rescuing them
    } catch (e) {
      out.err = (e.shortMessage || e.message || "").slice(0, 120);
      out.reason = null;                // unknown, and said so
      return out;
    }
  }

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
   * ══ THE LOAN BOOK (session 18) — always on, costs nothing, needs no extra chain read ═══
   *
   * WHY. `raw.loanVolume` is a SUM, and the question the sponsorship gate asks is about the
   * SHAPE: a base ceiling of X bps refuses the loans ABOVE it, so a total says nothing about
   * how many members a given X would refuse. Session 17 measured that the gate FITS (size and
   * gas); nothing has ever measured what it would BITE.
   *
   * ⛔ AND THE UNIT MATTERS. `loanHeadroom` is `fee * insolvencyFloorBps / 10_000 - debt`, so
   *    the ceiling is a fraction OF THE ENTRY FEE, not of the crossing cost — the crossing
   *    cost is what the keeper SIZES the advance against (V8.50 item A), the fee is what the
   *    fund MEASURES it against. Recording dollars alone would force a later session to guess
   *    which basis was meant. Both are written.
   *
   * DIRECTS AT LOAN TIME comes from the sequence file, not from a chain read: `gen_sequence`
   * builds a REAL referral tree (every member picks a referrer already registered), and the
   * actions replay in order, so counting them as they execute gives the sponsor's direct
   * count AT THE MOMENT the loan fired. That is the exact quantity the gate would read.
   * ⚠ It is the FIXTURE's referral distribution, not the live chain's. It prices the
   *   mechanism on a real tree — which is strictly better than session 17's KeeperGas star,
   *   where everyone referred to W1 and the gate refused essentially everybody — but it is
   *   still not a live prediction. Say so wherever these numbers are quoted.
   *
   * ⛔ THE RECONCILE IS THE POINT. The per-loan amounts must sum to `raw.loanVolume`, which
   *    is computed independently from the cumulative `ev` bucket. If they disagree the loan
   *    book has missed a funding path and BOTH numbers are void — it is not a rounding note.
   */
  const directs = new Map();       // sponsor address -> directs registered so far
  const loanBook = [];             // { member, amount(6dp string), bps, directsAtLoan, where }
  // ⛔ KEY ON LOWERCASE. The sponsor key comes from a signer's `.address`, the borrower key
  //    from a decoded event arg. Both are checksummed in ethers v6 TODAY — but a single
  //    case mismatch would make every `directsAtLoan` read 0, which looks exactly like a
  //    real finding ("the gate would refuse everyone") and would never throw.
  const key = (a) => String(a).toLowerCase();
  const bumpDirect = (addr) => {
    if (!addr || addr === ethers.ZeroAddress) return;
    directs.set(key(addr), (directs.get(key(addr)) || 0) + 1);
  };
  /** Append every RescueLoanIssued in ONE receipt, with the directs standing right now. */
  const recordLoans = (rc, where) => {
    const one = {};
    collect(ifaces, rc, one);
    for (const a of one["RescueLoanIssued"] || []) {
      const member = a.member !== undefined ? a.member : a[0];
      const amount = BigInt(a.loanAmount !== undefined ? a.loanAmount : a[1]);
      loanBook.push({
        member,
        amount: amount.toString(),
        bps: Number((amount * 10_000n) / FEE),
        directsAtLoan: directs.get(key(member)) || 0,
        where,
      });
    }
  };

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
  // AB_EVICT needs the pre-tick queue snapshot for queue-position, so it implies the census.
  const doCensus = process.env.AB_CENSUS === "1" || doEvict;
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
          // `idx` is the member's POSITION in that matrix's parked array at this instant.
          // _scanParked walks it from 0 and stops at cfg.maxItems, so position is the whole
          // of the starvation hypothesis and must be recorded, not reconstructed later.
          seen.set(addr, { mat: tag, matAddr: await m.getAddress(), idx: i, count, wd });
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
        // `mat` is carried on the EPISODE — session 8. Without it every withdrawable
        // median here is pooled across two populations that do not overlap, and the
        // pooled median is not a statistic about anybody. See `atRescueByMatrix`.
        const ep = { parkTs: ts, exitTs: null, how: null, mat: info.mat, wdAtPark: info.wd.toString(), wdAtExit: null };
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
        // Bump BEFORE recording: the registration has landed, so on-chain the sponsor's
        // directCount already includes this member for anything later in the same tx.
        bumpDirect(addrOf(a.ref));
        recordLoans(rc, "register");
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
        let preSnap = null;
        if (doCensus) { preSnap = await snapshot(); reconcile(preSnap, await nowTs(), new Set(), new Set()); }

        // ⛔ THE ROUTING CAPTURE. Runs on the SAME pre-tick state discovery ran on — after
        //    the before-snapshot, before performUpkeep. Reading a member's balances AFTER
        //    the tick that rescued or evicted them would describe the outcome and be
        //    written up as the cause.
        if (doEvict) {
          let items = null;
          try { items = hre.ethers.AbiCoder.defaultAbiCoder().decode(WORKITEM_ABI, data)[0]; }
          catch (e) { evictCfgErr.push(`decode performData tick ${keeperTicks}: ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
          if (items) {
            const parked = [];
            for (let k = 0; k < items.length; k++) {
              const wt = Number(items[k].workType);
              if (wt === 4 || wt === 6) parked.push({ k, wt, item: items[k] });
            }
            const hist = {};
            for (const it of items) { const nme = WORK_NAMES[Number(it.workType)] || `type${it.workType}`; hist[nme] = (hist[nme] || 0) + 1; }
            let deepest = -1;
            for (const p of parked) {
              const member  = p.item.addr2;
              const matAddr = p.item.addr1;
              const tierIdx = Number(p.item.tierIndex);
              const pos     = preSnap ? preSnap.get(member) : null;
              if (pos && pos.idx > deepest) deepest = pos.idx;

              // Both price bases, every item. Which one reconciles is a reading of the
              // build, not an assumption about which arm this is — see the header.
              const feeBasis   = ecfg.fee;
              const crossBasis = ecfg.isA[matAddr.toLowerCase()] ? (ecfg.fee * 5_000n) / 10_000n : ecfg.fee;
              const byFee   = await deriveReason(matAddr, member, tierIdx, feeBasis);
              const byCross = crossBasis === feeBasis ? byFee
                            : await deriveReason(matAddr, member, tierIdx, crossBasis);

              const routedEvict = p.wt === 6;
              const agrees = (r) => r.reason !== null && (routedEvict ? r.reason !== 0 : r.reason === 0);
              const row = {
                tick: keeperTicks, batchIdx: p.k, batchLen: items.length,
                route: routedEvict ? "EVICT" : "RESCUE",
                member, matrix: ecfg.isA[matAddr.toLowerCase()] ? "A" : "B", tierIdx,
                queueIdx: pos ? pos.idx : null, queueLen: pos ? pos.count : null,
                reasonByFee:   byFee.reason   === null ? "ERR" : REASON_NAMES[byFee.reason],
                reasonByCross: byCross.reason === null ? "ERR" : REASON_NAMES[byCross.reason],
                agreesByFee: agrees(byFee), agreesByCross: agrees(byCross),
                detail: byCross,
              };
              routedItems.push(row);
              if (!row.agreesByFee && !row.agreesByCross) {
                mismatches.push({ tick: keeperTicks, member, route: row.route,
                                  reasonByFee: row.reasonByFee, reasonByCross: row.reasonByCross,
                                  err: byCross.err || byFee.err || null });
              }
            }
            batches.push({
              tick: keeperTicks, cap: Number(dials.maxItemsPerUpkeep), items: items.length,
              saturated: items.length >= Number(dials.maxItemsPerUpkeep),
              parkedItems: parked.length, deepestQueueIdxReached: deepest,
              queueLenA: preSnap ? [...preSnap.values()].filter((v) => v.mat === "A").length : null,
              queueLenB: preSnap ? [...preSnap.values()].filter((v) => v.mat === "B").length : null,
              byType: hist,
            });
          }

          // THE POPULATION, on the same pre-tick state — including everyone discovery
          // never reached. Crossing basis only: the batch rows above already establish
          // which basis this build prices on, so asking twice here buys nothing.
          if (queueEvery && keeperTicks % queueEvery === 0 && preSnap) {
            for (const [member, info] of preSnap) {
              const isA = ecfg.isA[info.matAddr.toLowerCase()];
              const basis = isA ? (ecfg.fee * 5_000n) / 10_000n : ecfg.fee;
              // tierIdx 0 BY CONSTRUCTION, not by assumption: world.js registers exactly
              // one tier. If this fixture ever gains a second, the queue census needs the
              // member's tier read from the router — the batch rows take theirs from the
              // WorkItem and would stay correct while this block silently would not.
              const d = await deriveReason(info.matAddr, member, 0, basis);
              queueRows.push({
                tick: keeperTicks, member, matrix: isA ? "A" : "B",
                queueIdx: info.idx, queueLen: info.count,
                reason: d.reason === null ? "ERR" : REASON_NAMES[d.reason],
                reserve: d.reserve ?? null, withdrawable: d.withdrawable ?? null,
                effectiveContrib: d.effectiveContrib ?? null, wBps: d.wBps ?? null,
                sfShare: d.sfShare ?? null, advance: d.advance ?? null,
                owed: d.owed ?? null, headroom: d.headroom ?? null,
              });
            }
          }
        }
        const rc = await (await w.keeper.performUpkeep(data, { gasLimit: REG_GAS })).wait();
        parseAll(rc); totalGas += rc.gasUsed;
        recordLoans(rc, "keeper");
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
  // (WORK_NAMES is declared above the replay loop — AB_EVICT's batch histogram needs it.)
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
    const wdAtRescueBy = { A: [], B: [] };   // ...and the same, NOT pooled. See below.
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
        if (ep.how === "rescued") { wdAtRescue.push(wd); if (wdAtRescueBy[ep.mat]) wdAtRescueBy[ep.mat].push(wd); }
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
      /**
       * ⛔⛔ `atRescue` IS A POOLED MEDIAN OVER A BIMODAL MIXTURE. DO NOT QUOTE IT ON THE
       *     V8.50 ARM. Session 8, replicated 3/3:
       *
       *       control  rescues 88/84/86 members and 100% of them are MatA -> ONE mode,
       *                and the median is correspondingly steady: $3.73 / $3.75 / $3.72.
       *       V8.50    rescues a MIXTURE, 40% / 49% / 50% MatA. The two modes are ~$0.25
       *                (MatA, holding a crossing reserve instead of withdrawable) and
       *                ~$7.5 (MatB, holding a carried balance and no reserve). With the
       *                mix sitting on 50%, the 50th percentile FLIPS BETWEEN THE MODES:
       *                $7.43 / $4.45 / $2.15.
       *
       *     That 3.5x spread was open item 2 and it is not variance in member support. It
       *     is a median of a two-humped distribution taken where the humps are equal, and
       *     it describes no member in either hump. The split below is the readable form;
       *     the pooled figure is kept only so the old number stays reconstructable.
       */
      withdrawableUSD: {
        atRescue:     { n: wdAtRescue.length,     median: median(wdAtRescue),
                        WARNING: "POOLED ACROSS MatA+MatB — bimodal on the V8.50 arm. Read atRescueByMatrix." },
        atRescueByMatrix: {
          A: { n: wdAtRescueBy.A.length, median: median(wdAtRescueBy.A) },
          B: { n: wdAtRescueBy.B.length, median: median(wdAtRescueBy.B) },
        },
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

  /**
   * ══ AB_EVICT AGGREGATION ══════════════════════════════════════════════════════════════
   *
   * ⛔ READ `reconciliation` BEFORE ANY OTHER FIELD IN THIS BLOCK.
   *
   * `reasonHistogram` is only worth reading if the derivation agrees with the contract on
   * EVERY item. `agreeByCross` / `agreeByFee` say how many of the N parked work items each
   * price basis explains; `mismatches` lists the items NEITHER explains. A non-empty
   * `mismatches` means the four-branch walk here is not the walk the contract took, and the
   * whole reason column is void — it does not mean "mostly right". Session 6's park table
   * was 95% of a number and 100% wrong.
   *
   * `basisThatReconciles` is the item-A finding stated as a measurement: v849b should be
   * explained by the FEE basis and V8.50 by the CROSSING basis, and the file says which one
   * actually did rather than assuming it from the arm name.
   */
  let evictBlock = null;
  if (doEvict) {
    const evicted  = routedItems.filter((r) => r.route === "EVICT");
    const rescued  = routedItems.filter((r) => r.route === "RESCUE");
    const histOf = (rows, key) => rows.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc; }, {});
    const nums = (rows, f) => rows.map(f).filter((x) => x !== null && x !== undefined);
    const stat = (xs) => xs.length
      ? { n: xs.length, min: Math.min(...xs), max: Math.max(...xs), median: median(xs) }
      : { n: 0, min: null, max: null, median: null };
    const agreeByFee   = routedItems.filter((r) => r.agreesByFee).length;
    const agreeByCross = routedItems.filter((r) => r.agreesByCross).length;
    evictBlock = {
      reconciliation: {
        parkedWorkItems: routedItems.length,
        agreeByFee, agreeByCross,
        basisThatReconciles: routedItems.length === 0 ? null
          : agreeByCross === routedItems.length && agreeByFee === routedItems.length ? "BOTH (indistinguishable in this run)"
          : agreeByCross === routedItems.length ? "CROSSING COST (item A priced)"
          : agreeByFee   === routedItems.length ? "ENTRY FEE (unpriced)"
          : "NEITHER — THE REASON COLUMN IS VOID",
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 20),
        configReadErrors: evictCfgErr.slice(0, 20),
        note: "mismatchCount MUST be 0. Anything else voids reasonHistogram entirely — the " +
              "derived branch order is then not the contract's branch order, and a partly " +
              "correct reason column reads exactly like a correct one.",
      },
      // THE ANSWER, if and only if the reconciliation above is clean.
      routedToEvict: evicted.length,
      routedToRescue: rescued.length,
      reasonHistogram: { byCrossingBasis: histOf(evicted, "reasonByCross"),
                         byFeeBasis:      histOf(evicted, "reasonByFee") },
      // Discovery only triages what it REACHES. These say how much of the queue it reached,
      // so "starved by queue position" is measured rather than argued.
      reach: {
        batches: batches.length,
        saturatedBatches: batches.filter((b) => b.saturated).length,
        parkedItemsPerBatch: stat(batches.map((b) => b.parkedItems)),
        deepestQueueIdxReached: stat(batches.map((b) => b.deepestQueueIdxReached).filter((x) => x >= 0)),
        queueLenAtTick: stat(batches.map((b) => (b.queueLenA || 0) + (b.queueLenB || 0))),
      },
      queuePosition: { ofEvicted: stat(nums(evicted, (r) => r.queueIdx)),
                       ofRescued: stat(nums(rescued, (r) => r.queueIdx)) },
      matrixOfEvicted: histOf(evicted, "matrix"),
      matrixOfRescued: histOf(rescued, "matrix"),

      /**
       * ⛔ THE POPULATION BLOCK. Read `sampledEveryNTicks` before any count here: these are
       * MEMBER-TICK OBSERVATIONS of a sampled queue, not members and not events. The same
       * member sitting in the queue for twenty ticks contributes four rows at N=5. So the
       * shares and the medians are the readable quantities; the raw counts are not a
       * population size and must never be quoted as one.
       *
       * `reserveZeroShare` is the column this exists for. `_triageParked`'s numerator is
       * `crossingReserveOf + withdrawableOf`, and a member holding no crossing reserve is a
       * completely different case from a member holding the carve — but both look identical
       * in every event this system emits.
       */
      population: (() => {
        if (!queueRows.length) return { sampledEveryNTicks: queueEvery, observations: 0 };
        const grp = {};
        for (const r of queueRows) {
          const k = r.matrix;
          (grp[k] ||= { observations: 0, reasons: {}, reserveZero: 0, wBps: [], reserveUSD: [], withdrawableUSD: [] });
          const g = grp[k];
          g.observations++;
          g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
          if (r.reserve !== null) { if (BigInt(r.reserve) === 0n) g.reserveZero++; g.reserveUSD.push(Number(r.reserve) / 1e6); }
          if (r.withdrawable !== null) g.withdrawableUSD.push(Number(r.withdrawable) / 1e6);
          if (r.wBps !== null && r.wBps !== undefined) g.wBps.push(r.wBps);
        }
        const out = { sampledEveryNTicks: queueEvery, observations: queueRows.length, byMatrix: {} };
        for (const [k, g] of Object.entries(grp)) {
          out.byMatrix[k] = {
            observations: g.observations,
            reasons: g.reasons,
            reserveZeroShare: g.reserveUSD.length ? +(g.reserveZero / g.reserveUSD.length).toFixed(4) : null,
            medianReserveUSD: median(g.reserveUSD),
            medianWithdrawableUSD: median(g.withdrawableUSD),
            medianWBps: median(g.wBps),
          };
        }
        return out;
      })(),

      // Every routed item and every batch, in full — a histogram must never be the only
      // record of a decision. These are FILE-ONLY; the console prints counts (see below),
      // because a 1,500-line paste is how a diagnostic gets skimmed instead of read.
      evictions: evicted,
      items: routedItems,
      queueCensus: queueRows,
      batches,
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

  /**
   * ══ LOANS PER MEMBER — THE OWNER'S ACTUAL BAR ═════════════════════════════════════════
   *
   * The design intent, owner-stated 2026-08-19: **members are not meant to cross forever.
   * They are meant to get ONE OR TWO LOANS, and to be evicted if they never invite
   * anyone.** So "how many members were evicted" was never the question. The question is
   * how many loans a member actually receives before that happens — and if the answer is
   * ZERO, the floor is refusing people the system intended to carry, whatever the eviction
   * count looks like.
   *
   * ⛔ WHY NOT JUST READ `owed` AT THE REFUSAL. Session 8 found `owed: 0` on every single
   *    FLOOR refusal across six runs, which LOOKS like "refused their first loan". It is
   *    not evidence of that. Debt is clawed back from earnings, so a member who borrowed
   *    once and repaid also reads `owed: 0`. Those are opposite stories — "never got a
   *    loan" versus "got one and settled it" — and a point-in-time debt reading cannot
   *    separate them. Counting the ISSUANCE can.
   *
   * ⛔ TWO INSTRUMENTS, RECONCILED IN THE FILE. `RescueLoanIssued` comes from
   *    MatrixLogicLib (a LIBRARY event — invisible without libIfaces, the trap already
   *    recorded above). `MemberDebtIncreased` comes from the StabilityFund, which the
   *    handoff establishes has exactly ONE writer of `memberDebt` emitting the same
   *    amount. They are two independent views of one act. If they disagree on the count or
   *    on the set of borrowers, one of them is wrong and neither number should be quoted —
   *    which is the only reason to compute both.
   */
  const perMember = (evName) => {
    const m = {};
    for (const a of ev[evName] || []) {
      const who = field(a, "member", 0);
      m[who] = (m[who] || 0) + 1;
    }
    return m;
  };
  const loansPer = perMember("RescueLoanIssued");
  const debtPer  = perMember("MemberDebtIncreased");
  // ⛔ RESCUES PER MEMBER — ADDED BECAUSE A CONCLUSION WAS WRONG WITHOUT IT.
  //
  // Session 8 measured `maxLoansToOneMember == 1` at PARAM 59 = 3400, 6800 AND 10000, and
  // wrote up "the second loan is refused, here is the headroom arithmetic". The 10000 row
  // refutes that outright: at a $10.00 ceiling a member holding ~$4.00 of debt has ~$6.00
  // of headroom against a ~$4.00 ask, so a refusal is impossible — and 10000 came back
  // BYTE-IDENTICAL to 6800 on every figure. Nothing was refused. Nothing was asked.
  //
  // A second loan requires a second RESCUE, and nothing here counted those. So "the system
  // gives one loan" and "this 69-tick fixture never asks for a second" were indistinguishable,
  // and the arithmetic-flavoured one got written down. `ParkedRescued` carries the member
  // (MatrixKeeper:451, member is the SECOND arg — the first is the matrix), so the count is
  // one map away.
  //
  // ⚠ READ THE ANSWER AGAINST THE FIXTURE LIMITS, NOT AS A SYSTEM PROPERTY:
  //   SELF_RESCUE_RATE 0, one tier, one pair, 69 ticks. If nobody is rescued twice HERE,
  //   that is a statement about this harness first and about V8.50 only second.
  const rescuePer = (() => {
    const m = {};
    for (const a of ev["ParkedRescued"] || []) {
      const who = field(a, "member", 1);
      m[who] = (m[who] || 0) + 1;
    }
    return m;
  })();
  const histOfCounts = (m) => Object.values(m).reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});
  const evictedMembers = doEvict
    ? [...new Set(routedItems.filter((r) => r.route === "EVICT").map((r) => r.member))]
    : [...new Set((ev["ParkedMemberEvicted"] || []).map((a) => field(a, "member", 1)))];
  const loansBeforeEvictionCounts = evictedMembers.map((m) => loansPer[m] || 0);

  const lending = {
    loanEvents: loans,
    distinctBorrowers: Object.keys(loansPer).length,
    loansPerBorrowerHistogram: histOfCounts(loansPer),
    maxLoansToOneMember: Math.max(0, ...Object.values(loansPer)),
    // The denominator for the loan histogram above. A member cannot take a second loan
    // without a second rescue, so `maxRescuesToOneMember == 1` means the loan ceiling was
    // never the constraint and no PARAM 59 value could have changed the answer.
    distinctRescuedMembers: Object.keys(rescuePer).length,
    rescuesPerMemberHistogram: histOfCounts(rescuePer),
    maxRescuesToOneMember: Math.max(0, ...Object.values(rescuePer)),
    secondLoanOpportunities: Object.values(rescuePer).filter((c) => c > 1).length,
    // THE BAR, STATED THE WAY THE OWNER STATED IT.
    evictedMembers: evictedMembers.length,
    loansBeforeEviction: {
      histogram: loansBeforeEvictionCounts.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {}),
      zeroLoanEvictions: loansBeforeEvictionCounts.filter((c) => c === 0).length,
      note: "key = loans that member received before being evicted. A large bucket at 0 " +
            "means the system evicted members it never lent to, which is NOT the designed " +
            "behaviour (owner 2026-08-19: one or two loans, then eviction if no invites).",
    },
    reconcile: {
      rescueLoanIssuedEvents: loans,
      memberDebtIncreasedEvents: (ev["MemberDebtIncreased"] || []).length,
      distinctByLoanEvent: Object.keys(loansPer).length,
      distinctByDebtEvent: Object.keys(debtPer).length,
      borrowerSetsAgree: Object.keys(loansPer).length === Object.keys(debtPer).length &&
                         Object.keys(loansPer).every((k) => debtPer[k] !== undefined),
      note: "two independent views of one act — the matrix library issuing, the fund " +
            "booking. Disagreement voids both counts; it does not average out.",
    },
  };

  /**
   * ══ THE LOAN BOOK BLOCK — the shape of the lending, and what a base ceiling would refuse.
   *
   * `fitsUnderBase` answers the owner's open question from 17.5 directly: at base ceiling X
   * bps, how many of THIS run's loans would still have been granted in full to a member with
   * NO sponsor? A loan is refused/truncated when `amount > fee * X / 10_000`.
   *
   * ⚠ IT IS A COUNTERFACTUAL ON A RECORDED RUN, NOT A REPLAY WITH THE GATE INSTALLED.
   *   Refusing a loan changes what happens next (17.2: the population moves), so these
   *   counts are an UPPER BOUND on how many loans survive, and the eviction consequence is
   *   not in them at all. The binding-fixture sweep is the second instrument and the two
   *   must be compared, not substituted.
   */
  const loanBookBlock = (() => {
    const amts = loanBook.map((l) => BigInt(l.amount)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const bpsArr = loanBook.map((l) => l.bps).sort((x, y) => x - y);
    const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))] : null);
    const usd = (v) => (v === null ? null : +(Number(v) / 1e6).toFixed(4));
    const bookSum = amts.reduce((s, v) => s + v, 0n);
    const rawSum = sum("RescueLoanIssued", "loanAmount", 1);
    const dHist = {};
    for (const l of loanBook) dHist[l.directsAtLoan] = (dHist[l.directsAtLoan] || 0) + 1;
    const zero = loanBook.filter((l) => l.directsAtLoan === 0);
    const some = loanBook.filter((l) => l.directsAtLoan >= 1);
    const fits = {};
    for (const base of [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000]) {
      const cap = (FEE * BigInt(base)) / 10_000n;
      const f = (set) => set.filter((l) => BigInt(l.amount) <= cap).length;
      fits[base] = {
        capUSD: usd(cap),
        allLoansFitting: f(loanBook),
        allShare: loanBook.length ? +(f(loanBook) / loanBook.length).toFixed(4) : null,
        zeroDirectFitting: f(zero),
        zeroDirectRefused: zero.length - f(zero),
      };
    }
    return {
      loans: loanBook.length,
      totalUSD: usd(bookSum),
      // ⛔ THE CROSS-CHECK. Two independent tallies of the same event stream.
      reconcile: {
        loanBookSum: bookSum.toString(),
        rawLoanVolume: rawSum.toString(),
        agree: bookSum === rawSum,
        note: "the per-loan book is built per receipt; raw.loanVolume is summed from the " +
              "cumulative event bucket. Disagreement means a funding path was missed and " +
              "BOTH figures are void.",
      },
      amountUSD: { min: usd(pct(amts, 0)), p25: usd(pct(amts, 0.25)), median: usd(pct(amts, 0.5)),
                   p75: usd(pct(amts, 0.75)), p90: usd(pct(amts, 0.9)), max: usd(amts[amts.length - 1] ?? null),
                   mean: amts.length ? +(Number(bookSum) / 1e6 / amts.length).toFixed(4) : null },
      bpsOfFee: { min: pct(bpsArr, 0), p25: pct(bpsArr, 0.25), median: pct(bpsArr, 0.5),
                  p75: pct(bpsArr, 0.75), p90: pct(bpsArr, 0.9), max: bpsArr[bpsArr.length - 1] ?? null },
      directsAtLoanHistogram: dHist,
      zeroDirectLoans: zero.length,
      zeroDirectShare: loanBook.length ? +(zero.length / loanBook.length).toFixed(4) : null,
      oneOrMoreDirectLoans: some.length,
      byWhere: loanBook.reduce((o, l) => { o[l.where] = (o[l.where] || 0) + 1; return o; }, {}),
      // ⛔ THE INSTRUMENT MUST BE ABLE TO CONTRADICT ITSELF. If the address keys ever stop
      //    matching, every directsAtLoan silently reads 0 and the result looks like the
      //    strongest possible finding rather than a broken join. These three numbers make
      //    that visible: directs must sum to the registrations that carried a referrer.
      directsSanity: {
        sponsorsWithAtLeastOne: directs.size,
        totalDirectsCounted: [...directs.values()].reduce((s, v) => s + v, 0),
        registrationsWithReferrer: seq.actions.filter((a) => a.op === "register" && a.ref !== -2).length,
        note: "totalDirectsCounted counts landed registrations; registrationsWithReferrer " +
              "counts attempted ones, so they differ only by failed registrations.",
      },
      fitsUnderBase: fits,
      loans_detail: loanBook,
    };
  })();

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
      // ⛔ MEASURED 2026-08-19 (session 9), AND THE NAME IS WRONG: these are NOT refusals.
      //    Pairing every router event against the matrix park in the SAME transaction for the
      //    SAME member came back 12/12 on the control and 59/59 on V8.50, with zero orphans
      //    on either arm (see parkRefusalPairing below). So every one of these sits on top of
      //    a park ALREADY COUNTED in parkEventsMatrix. The number is a second label on the
      //    cycled-out-underfunded subset of parking, not an independent population, and
      //    11 -> 59 is not an anomaly to explain — it is the share of parks arriving via
      //    TierRouter's no-strand epilogue rather than via the matrix's own park sites.
      //    The key keeps its old name so results from sessions 6-9 stay comparable. Read it
      //    as "parks that came through the router epilogue".
      parkRefusalsRouter: n("MemberParkedRouter"),
      parkRefusalsRouterNote: "NOT refusals - each pairs 1:1 with a matrix park in the same tx (measured s9); already inside parkEventsMatrix",

      // ⛔ WHY THIS BREAKDOWN EXISTS (added 2026-08-19). Router placement refusals jumped
      //    11 -> 53 on V8.50 and stayed unexplained across three sessions, because only the
      //    COUNT was ever kept — the event's own `reason` string was parsed and thrown away.
      //    TierRouter emits exactly two reasons:
      //        "insufficient funds"   (TierRouter:1458)
      //        "autoReentry disabled" (TierRouter:1496, :1499)
      //    Those have completely different meanings. "insufficient funds" would tie the rise
      //    to item A's repricing; "autoReentry disabled" is a member OPTION and should not
      //    differ between arms at all — if it does, something is setting options differently
      //    and that is a separate defect. A single number cannot tell those apart, which is
      //    exactly why three sessions could look at 11 -> 53 and get no further.
      //    Keyed by TIER as well: a refusal at T1 and one at T3 are not the same event.
      parkRefusalsByReason: (() => {
        const out = {};
        for (const a of (ev["MemberParkedRouter"] || [])) {
          // Named access where the ABI carries names, positional otherwise — this file
          // already warns that the same event is declared both ways across these ABIs.
          const reason = String(a.reason ?? a[2] ?? "UNKNOWN");
          const tier   = Number(a.tier   ?? a[1] ?? 0);
          const k = `T${tier} :: ${reason}`;
          out[k] = (out[k] || 0) + 1;
        }
        return out;
      })(),
      // Many refusals against ONE member is a stuck member; one each against many is a
      // population effect. The count alone cannot distinguish them.
      parkRefusalsDistinctMembers: (() => {
        const set = new Set();
        for (const a of (ev["MemberParkedRouter"] || [])) set.add(String(a.member ?? a[0]).toLowerCase());
        return set.size;
      })(),

      // ⛔ IS A "ROUTER REFUSAL" EVEN A REFUSAL? (added 2026-08-19)
      //    TierRouter:1449-1458 parks the member in matrixB and THEN emits its own event, so
      //    the expected shape is: every router event sits in the same transaction as a matrix
      //    MemberParked for the SAME member. If that holds, `parkRefusalsRouter` is not an
      //    independent population at all — it is a second label on a park already counted in
      //    parkEventsMatrix, and 11 -> 59 tracks how many members reach cycle-out underfunded,
      //    not some new failure the router invented.
      //    The residual is the part that matters:
      //      pairedSameTxSameMember  — normal path, already counted as a queue insertion
      //      sameTxNoMatrixPark      — parkCycledOut no-op'd or REVERTED (try/catch swallows it)
      //      memberNeverParkedAtAll  — that member has no queue entry anywhere in the run.
      //                                Non-zero here contradicts "NEVER a silent exit" and is
      //                                a defect, not a metric. Zero here is the all-clear.
      //    Derived from transaction hashes recorded at parse time; no arithmetic over counts.
      parkRefusalPairing: (() => {
        const txmap = TX_OF.get(ev) || {};
        const rTx = txmap["MemberParkedRouter"] || [];
        const mTx = txmap["MemberParked"] || [];
        const rEv = ev["MemberParkedRouter"] || [];
        const mEv = ev["MemberParked"] || [];
        if (rTx.length !== rEv.length || mTx.length !== mEv.length) {
          return { error: "tx index desynced from event index — do not read these numbers" };
        }
        const lc = (x) => String(x).toLowerCase();
        const sameTxSameMember = new Set();     // "txhash|member" for MATRIX parks
        const everParked = new Set();           // any member with any queue insertion
        for (let i = 0; i < mEv.length; i++) {
          const m = lc(mEv[i].member ?? mEv[i][0]);
          sameTxSameMember.add(mTx[i] + "|" + m);
          everParked.add(m);
        }
        for (const a of (ev["SlotParkedIdle"] || [])) everParked.add(lc(a.member ?? a[0]));

        let paired = 0, sameTxNoPark = 0, neverParked = 0;
        const orphans = [];
        for (let i = 0; i < rEv.length; i++) {
          const m = lc(rEv[i].member ?? rEv[i][0]);
          if (sameTxSameMember.has(rTx[i] + "|" + m)) { paired++; continue; }
          if (everParked.has(m)) { sameTxNoPark++; continue; }
          neverParked++;
          if (orphans.length < 10) orphans.push({ member: m, tx: rTx[i], reason: String(rEv[i].reason ?? rEv[i][2] ?? "?") });
        }
        return {
          routerEvents: rEv.length,
          pairedSameTxSameMember: paired,
          sameTxNoMatrixPark: sameTxNoPark,
          memberNeverParkedAtAll: neverParked,
          orphanSample: orphans,
        };
      })(),
      distinctParkers, repeatParkers,
      rescues, loans,
      selfRescues: n("SelfRescue"),
      coPayRescues: coPay.length,
      coPaySelfFunded: selfFunded,
      unfundedRescues,
      evictions: n("ParkedMemberEvicted"),
      // ⛔ IS ITEM E1 ACTUALLY FIRING IN THIS FIXTURE? Added session 8 because two numbers
      //    disagree and the disagreement is the finding. The handoff records E1's measured
      //    effect as "MatB ledger at the gate $7.66 -> $8.32"; this harness's V8.50 arm,
      //    which contains E1, measures the MatB parked median at $7.66 — the PRE-E1 figure,
      //    to the cent. Either the two are different bases (live V8.48 population vs this
      //    fixture) or E1 never fires here, and in the second case every V8.50 number this
      //    A/B has produced describes a build without its balance carry.
      //    BalanceCarried is emitted from MatrixLogicLib._crossToPartner, so it is a LIBRARY
      //    event — invisible without libIfaces, which is the trap already recorded above.
      //    A zero here must be read against that, not taken at face value.
      balanceCarried: n("BalanceCarried"),
      balanceCarriedVolume: (() => { try { return sum("BalanceCarried", "amount", 3).toString(); } catch (e) { return `ERR ${(e.message || "").slice(0, 60)}`; } })(),
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
    lending,
    loanBook: loanBookBlock,
    ...(censusBlock ? { census: censusBlock } : {}),
    ...(evictBlock ? { evictRouting: evictBlock } : {}),
  };

  /**
   * ⛔ THE CONSOLE GETS A SUMMARY; THE FILE GETS EVERYTHING.
   *
   * Not cosmetics. The full result with AB_EVICT on is ~1,500 lines, almost all of it the
   * per-tick batch table and the queue census, and a diagnostic that long is read by
   * scrolling past it. The bulky arrays are replaced with their lengths here and written in
   * full to the JSON. This is the same rule as "diagnostics go in the RESULT FILE", applied
   * in the other direction: the file must be complete, the console must be legible.
   */
  const slim = JSON.parse(JSON.stringify(result));
  if (slim.loanBook) {
    slim.loanBook.loans_detail = `[${result.loanBook.loans_detail.length} rows — in the JSON file]`;
  }
  if (slim.evictRouting) {
    for (const k of ["items", "queueCensus", "batches"]) {
      slim.evictRouting[k] = `[${(result.evictRouting[k] || []).length} rows — in the JSON file]`;
    }
  }
  console.log(JSON.stringify(slim, null, 2));
  // A censused run writes to its OWN file. The canonical ab_result_<arm>_s<seed>.json is
  // the validated pair the handoff quotes and the thing a no-census run must reproduce
  // byte-for-byte; a censused run must not be able to overwrite it.
  // ⛔ EVERY DIAL THAT CHANGES THE ANSWER GOES IN THE FILENAME. Learned the hard way in
  //    session 8: a re-run with AB_QUEUE_EVERY=0 silently overwrote a censused result and
  //    destroyed one seed's population block, because the two runs shared a name. A sweep
  //    row must never be able to land on top of the canonical pair.
  const floorTag = process.env.AB_FLOOR_BPS ? `_floor${process.env.AB_FLOOR_BPS}` : "";
  // ⛔ TAG FROM THE CONTRACT, NOT THE ENV VAR. Same rule as the dials: if the fixture were
  //    missing the env var would still name a file `_gate3000` that contains an ungated run.
  const gateTag = dials.baseAdvanceBps !== "ABSENT" ? `_gate${dials.baseAdvanceBps}` : "";
  const popTag   = doEvict && !queueEvery ? "_nopop" : "";
  const out = path.join(hre.config.paths.root,
    `ab_result_${arm}_s${seq.seed}${equalize ? "_eq" : ""}${doCensus ? "_census" : ""}${doEvict ? "_evict" : ""}${popTag}${floorTag}${gateTag}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n  written: ${path.basename(out)}`);
  {
    const L = result.lending;
    console.log(`  LENDING: ${L.loanEvents} loans to ${L.distinctBorrowers} distinct members  ` +
      `per-borrower ${JSON.stringify(L.loansPerBorrowerHistogram)}  max ${L.maxLoansToOneMember}`);
    console.log(`  RESCUES: ${L.distinctRescuedMembers} distinct rescued  ` +
      `per-member ${JSON.stringify(L.rescuesPerMemberHistogram)}  max ${L.maxRescuesToOneMember}  ` +
      `members with a 2nd rescue (i.e. a chance at a 2nd loan): ${L.secondLoanOpportunities}`);
    console.log(`  loans received BEFORE eviction (${L.evictedMembers} evicted): ` +
      `${JSON.stringify(L.loansBeforeEviction.histogram)}  ` +
      `zero-loan evictions ${L.loansBeforeEviction.zeroLoanEvictions}`);
    if (!L.reconcile.borrowerSetsAgree) {
      console.log(`  ⛔ LOAN/DEBT BORROWER SETS DISAGREE (${L.reconcile.distinctByLoanEvent} vs ` +
        `${L.reconcile.distinctByDebtEvent}) — both counts are void.`);
    }
  }
  {
    const B = result.loanBook;
    if (!B.reconcile.agree) {
      console.log(`\n  ⛔ LOAN BOOK DOES NOT RECONCILE: book ${B.reconcile.loanBookSum} vs ` +
        `raw.loanVolume ${B.reconcile.rawLoanVolume} — a funding path was missed, BOTH are void.`);
    } else {
      console.log(`\n  LOAN BOOK: ${B.loans} loans, $${B.totalUSD} total, reconciles to raw.loanVolume`);
      console.log(`    size USD  min ${B.amountUSD.min}  p25 ${B.amountUSD.p25}  med ${B.amountUSD.median}  ` +
        `p75 ${B.amountUSD.p75}  p90 ${B.amountUSD.p90}  max ${B.amountUSD.max}  mean ${B.amountUSD.mean}`);
      console.log(`    bps of fee  med ${B.bpsOfFee.median}  p90 ${B.bpsOfFee.p90}  max ${B.bpsOfFee.max}`);
      console.log(`    directs at loan ${JSON.stringify(B.directsAtLoanHistogram)}  ` +
        `zero-direct loans ${B.zeroDirectLoans} (${B.zeroDirectShare})`);
      const S = B.directsSanity;
      console.log(`    directs join: ${S.sponsorsWithAtLeastOne} sponsors, ${S.totalDirectsCounted} directs ` +
        `counted vs ${S.registrationsWithReferrer} referred registrations`);
      if (B.loans > 0 && B.zeroDirectLoans === B.loans && S.totalDirectsCounted > 0) {
        console.log(`    ⚠ EVERY loan reads zero directs while ${S.totalDirectsCounted} directs exist — ` +
          `check the address join before believing this.`);
      }
      const f = B.fitsUnderBase;
      console.log(`    would fit under a base ceiling (all loans / zero-direct refused):`);
      for (const k of Object.keys(f)) {
        console.log(`      ${String(k).padStart(4)} bps = $${f[k].capUSD}  ->  ` +
          `${String(f[k].allLoansFitting).padStart(3)}/${B.loans} fit (${f[k].allShare})  ` +
          `zero-direct refused ${f[k].zeroDirectRefused}`);
      }
    }
  }
  if (doEvict) {
    const r = result.evictRouting.reconciliation;
    console.log(`\n  ROUTING: ${result.evictRouting.routedToEvict} evict / ` +
      `${result.evictRouting.routedToRescue} rescue work items over ${r.parkedWorkItems} total`);
    console.log(`  basis that reconciles: ${r.basisThatReconciles}`);
    if (r.mismatchCount) {
      console.log(`  ⛔ ${r.mismatchCount} MISMATCH(ES) — the reason column is VOID. Do not quote it.`);
    } else {
      console.log(`  reasons (crossing basis): ${JSON.stringify(result.evictRouting.reasonHistogram.byCrossingBasis)}`);
      console.log(`  evicted from matrix: ${JSON.stringify(result.evictRouting.matrixOfEvicted)}` +
                  `   rescued from matrix: ${JSON.stringify(result.evictRouting.matrixOfRescued)}`);
      const p = result.evictRouting.population;
      if (p && p.byMatrix) {
        for (const [k, g] of Object.entries(p.byMatrix)) {
          console.log(`  queue pop Mat${k}: ${g.observations} obs  reserve==0 ${(g.reserveZeroShare * 100).toFixed(0)}%  ` +
            `medReserve $${(g.medianReserveUSD ?? 0).toFixed(2)}  medWd $${(g.medianWithdrawableUSD ?? 0).toFixed(2)}  ` +
            `medWBps ${g.medianWBps}  ${JSON.stringify(g.reasons)}`);
        }
      }
    }
  }
  if (keeperFailures) {
    console.log(`  ⚠ ${keeperFailures} keeper tick(s) FAILED on this arm. If the other arm's count`);
    console.log(`    differs, the two runs did not receive equivalent treatment and the pair is void.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
