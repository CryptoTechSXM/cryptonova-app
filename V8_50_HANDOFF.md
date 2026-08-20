# V8.50 HANDOFF — the crossing redesign. READ THIS FIRST.

Written 2026-08-16 at the end of the V8.49 private measurement run.
Sessions 2-10 have appended to it since; read the NEWEST section first — each one
corrects the ones below it, and says so explicitly where it does.
Audience: **the next session of Claude, plus the owner. There is no third party — every
line of this codebase was written by a previous session of Claude and executed by the
owner.** Read section 7a (THE TWO RULES) before doing anything else; it is short, it is
owner-set, and the session that earned it got five things wrong by ignoring what it says.

---

# ⬛ SESSION 11 STATE — 2026-08-20, LATEST. READ THIS FIRST, BEFORE SESSION 10.

## 11.1 ⛔ CLOSED FOR GOOD: "WHY IS T1.2 EMPTY / WHERE DO NEW MEMBERS LAND?"
**DO NOT CHASE THIS AGAIN. Owner instruction 2026-08-20: verify it, write it down, stop.**

**T1.1 (pair 0) is the ONLY place a new member can land, on every tier, permanently.**
`PairManagerV8._findExternalPair()` (:760) is:

```solidity
function _findExternalPair() internal pure returns (uint256) {
    return 0;
}
```

It is `pure`. It cannot read state. **So no threshold, no counter and no configured number
anywhere in the system can change where a new registration goes.** Every registration path and
every upgrade path calls `registerFor(..., 0)`.

**THERE IS NO "MAGIC NUMBER" THAT FLIPS ROUTING TO THE NEXT PAIR, AND THERE MUST NOT BE.**
The owner's intuition on 2026-08-20 — "we get to 254 and we are full, so 255 should be the
number where the other pair starts filling" — describes a mechanism that **existed twice and
was deleted twice**, because it is the direct cause of the worst freeze this project has had:

- `pairExpansionThreshold` — deleted in V8.46 once it was proved inert.
- `deployEntryThreshold` (375) / `routeEntryThreshold` (400/381) — deleted as ROUTING inputs in
  V8.48 (items 10b and 33). Kept only as the deploy trigger, then replaced there too.

Why they had to go, in the source's own words (PairManagerV8:169-186): a cumulative counter only
ever increments, so a pair that passed the threshold was excluded from new registrations FOREVER
— even after its members cycled out and freed seats. **A full MatA only rotates when it RECEIVES
an entry (MatrixLogicLib:407.)** Exclude it and it stops rotating, and every member in seats
2..127 stops moving. `route_rr.js` was written on 2026-07-27 purely to walk the threshold around
the pairs and mask this; when that keeper was switched off on 2026-08-06, **254 members froze in
T1.1 MatA within three days.**

**Concentrating every new entry into pair 0 is the thing that keeps pair 0 rotating.** Diluting
the front door across pairs is what stops it. This is settled design, not an open question.

## 11.2 THE MEASUREMENT THAT REPLACES THE QUESTION — live V8.48, head block 45733042
`diag_pair_chain.mjs`, 2026-08-20 13:59 UTC, against the 2026-08-19 16:57 UTC run (21h apart):

| T1 | occupancy | rotations | totalJoined | parked |
|---|---|---|---|---|
| pair 0 MatA | 127/127 (=) | 599 → **924** (+325) | 364 → **387** (+23) | 26 → **45** |
| pair 0 MatB | 126 → **127** | 447 → **773** (+326) | 352 → **370** (+18) | 81 → **83** |
| pair 1 MatA | 0 → **4** | 0 | 0 → **4** | 0 |
| pair 1 MatB | 0/127 | 0 | 0 | 0 |

Chain wiring verified correct on T1 (2 pairs) and T2 (3 pairs): every MatB's `chainNext` is the
next pair's MatA and the last MatB closes the circle back to pair 0 MatA. **Not a wiring defect.**

**THE TWO NUMBERS THAT DISAGREE — THIS IS THE FINDING:**

- **T1** pair 0 MatB: **773 lifetime rotations → 4 members have EVER reached T1.2.** 83 parked in it.
- **T2** pair 0 MatB: **75 lifetime rotations → 37 members reached T2.2** (and 3 more reached T2.3).

Same code, same wiring, ~100x difference in how many graduates come out the far end. T1.2 is not
starved of a routing rule. **T1.2 is starved of members who can afford to leave T1.1 MatB.**

## 11.3 THE GATE IS A PRICE, NOT A COUNT — `MatrixLogicLib._crossToPartner`
This is the mechanism, read off the source (MatrixLogicLib:~926-980):

```solidity
address destination = (!cfg.isMatrixA && self.chainNext != address(0))
    ? self.chainNext          // from MatB  -> the NEXT pair's MatA
    : self.partner;           // from MatA  -> this pair's MatB
uint256 reentryFee  = destination.ENTRY_FEE();
uint256 crossingCost = cfg.isMatrixA ? _crossingPrice(reentryFee) : reentryFee;
```

- **MatA → MatB** costs `_crossingPrice(fee)` — the discounted crossing, pre-funded by the 50%
  crossing reserve carved at MatA entry.
- **MatB → next pair's MatA** costs the **FULL ENTRY FEE**, because it is a NEW CYCLE, not a
  crossing — and the member's crossing reserve was already spent on the A→B hop.

Funding order is `crossingReserve` first, then `withdrawable`. If `withdrawable` is short:

```solidity
self.parkedMembers.push(member);
emit MemberParked(member, shortfall);
return;
```

**So graduating forward out of MatB costs a T1 member a fresh $10 of EARNED withdrawable, with
zero reserve behind it. That is the wall. 83 of them are stacked against it in T1.1 MatB right
now, and 4 have ever cleared it.**

Corollary for V8.50 item A: item A makes the A→B hop reserve-funded and removes mid-cycle
parking, which is real — but **it does not touch this hop.** The owner already accepted that
("they only need a loan when the full A+B cycle is completed", 2026-08-16). This measurement is
what that sentence looks like on live chain.

## 11.4 ⛔ THE OPEN QUESTION — NOW ANSWERED. MEASURED 2026-08-20.
"What number makes the loop self-sustaining?" is **not** a routing number. There is no
routing number (11.1). It is this, and it has now been measured, not reasoned about:

> **What does a member with NO referral income earn across one full A+B cycle, against the
> full entry fee they must pay to graduate forward out of MatB?**

**INSTRUMENT: `test/V8_50_CycleEconomics.test.js` (written session 11).** One pair, size 127,
every member registering with `referrer = address(0)` so nobody has referral income. It
censuses EVERY cycle-out at the forward hop. Run it with:
`$env:CYCLE_SIZE=127; npx hardhat test test/V8_50_CycleEconomics.test.js`

### THE RESULT — 485 cycle-outs at the forward hop, MATRIX_SIZE 127

| | |
|---|---|
| A→B crossing price | **$5.00**, funded $5.00 from reserve + **$0.00** from earnings |
| forward hop price (MatB → next MatA) | **$10.00**, full entry fee, no reserve behind it |
| **GRADUATED forward** | **0** — 0.00% |
| **PARKED, could not afford it** | **485** — 100.00% |
| PARKED, shortfall 0 (seat guard / deferral) | **0** — 0.00% |

**ZERO OF 485.** Without referral income the forward hop does not merely cost a lot — it
**never succeeds, not once.**

The zero-shortfall bucket being empty is what makes the affordability claim legitimate.
`MemberParked` is emitted from three places and only one means "could not afford it"; the
other two (duplicate-seat guard, `crossingInProgress` deferral) both emit shortfall 0. They
are counted separately on purpose. **All 485 were real shortfalls.** Do not merge these
buckets in any future counter — a merged count would claim an affordability result the run
did not observe.

### WHAT THE MEMBER ACTUALLY ARRIVES HOLDING
Shortfall across the 485, straight from `MemberParked(member, shortfall)`:

| | shortfall | so they arrive holding | as % of the fee |
|---|---|---|---|
| best case | **$0.0782** | $9.9218 | 99.2% |
| **median** | **$4.4084** | **$5.5916** | **55.9%** |
| worst case | **$5.0808** | $4.9192 | 49.2% |

**THE MEDIAN NO-REFERRAL MEMBER FINISHES A FULL A+B CYCLE HOLDING ~56% OF ONE ENTRY FEE AND
NEEDS 100%.** That ~44% gap is the system's own take. It is the whole answer.

⚠ **AND IT GETS WORSE AS THE SYSTEM MATURES — this is the part worth acting on.** The
earliest cycle-outs nearly made it and later ones did not. Directly observed in the first
twelve parked members, in order: $9.30, $9.35, $9.40, $9.45, then $6.66, $6.71. The reason is
structural: a member who rode MatA while it was FILLING was paid out of 127 full $10 entry
fees, while a member in steady state is paid out of $5.00 crossings. **Startup economics
flatter the model. Do not generalise any early-life number to steady state.**
`min $0.0782` deserves one look on its own: a member completed an entire A+B cycle and
missed the next step **by eight cents.**

### ⚠ TWO THINGS IN THAT RUN'S OUTPUT THAT ARE NOT RESULTS
1. **`median lifetime earnings across the sample: $6.9748` IS BIASED — DO NOT QUOTE IT.**
   The sample is the FIRST 12 parked members, i.e. the earliest and richest cycle-outs, and
   the decline above is exactly why that is not the population. THE BATCH IS NOT THE
   POPULATION — already in the traps list, walked into anyway. The trustworthy figure is the
   **median shortfall**, which is computed over all 485 and comes straight off the contract's
   own event. Fix by sampling evenly across the run, or delete the line.
2. **CLOSED, NOT A DEFECT — and the OWNER closed it, 2026-08-20.** Claude flagged the
   identical MatA/MatB `totalEarned` as an anomaly on the grounds that "MatB is funded by
   $5.00 crossings while MatA is funded by $10.00 entries, so MatB should earn half." **That
   reasoning was wrong.** The owner's correction: *"only $5 is distributed which is the
   crossing fee as well so it should be the same not half... $10 goes in but only $5 is
   distributed and $5 laced for crossing which in turn is distributed then."*

   Verified in source, `MatrixLogicLib._distributePayments` (:1121-1156) and the item A
   docblock (:193-215):
   - `payBase = cfg.entryFee` — **the FULL entry fee, in BOTH halves.** Splits are absolute
     BPS of the entry fee, never of a sub-pool.
   - MatA entry: carve 5000 reserve, then distribute `250 + 4750 = 5000` bps = **$5.00**.
   - MatB crossing entry: `skipReserveCarve = true` (no second carve), then distribute the
     same `250 + 4750 = 5000` bps = **$5.00**, which is exactly the crossing price received.
   - The docblock states the invariant plainly: *"The destination is made whole because it
     skips its own reserve carve: direct 250 + splits 4750 = 5000 = exactly this price...
     NOT ONE SPLIT BPS CHANGES."*

   **So both halves distribute $5.00 and identical per-member earnings is the CORRECT
   result.** THIRD TIME THE OWNER HAS CORRECTED A CLAUDE FINDING ON MECHANISM AND BEEN
   RIGHT. Recorded as a working pattern: when he pushes back on how the money moves, read
   the code before defending the finding.

### ⛔ THE GAP IS NOW FULLY ACCOUNTED FOR — CLOSED FORM, AND IT MATCHES THE MEASUREMENT
Because both halves distribute 5000 bps of the entry fee, **a full A+B cycle distributes the
ENTIRE $10.00.** Nothing is retained. Doubling each split across the two halves:

| destination | bps per cycle | per $10 cycle | who gets it |
|---|---|---|---|
| pool (seats 2..127) | 3136 | **$3.136** | members |
| chain pay (6 levels) | 1900 | **$1.900** | members |
| direct earn | 500 | **$0.500** | the entrant themselves |
| **L1 referral** | 1900 | **$1.900** | the referrer — **or accountOne if orphaned** |
| **system** (treasury 1426, SF 476, dev 286, ops 190, community 96, buyback 90) | 2564 | **$2.564** | not members |
| | **10000** | **$10.00** | |

A no-referral member in a uniform population collects pool + chain + their own direct =
**$5.536 per cycle.** **MEASURED MEDIAN HOLDING AT THE HOP: $5.5916.** The structure and the
census agree to within six cents. The gap is therefore exactly the two leaks:

> **$2.564 system take + $1.900 orphaned L1 = $4.464 short.**
> **MEASURED MEDIAN SHORTFALL: $4.4084.** Same number.

**THE DECISIVE CONSEQUENCE — this is conservation of money, not a tuning problem:**
since a cycle distributes exactly 100% of the fee, a zero-referral member can only reach
100% if BOTH leaks go to zero. **So long as the protocol takes ANY fee at all, a member who
never recruits can NEVER self-fund the forward hop.** No split table, no loan ceiling and no
threshold changes that. It is arithmetic.

### ⚠ AND THE REFERRAL BAR IS LOWER THAN FIRST STATED — L1 PAYS IN BOTH HALVES
Claude first put break-even at ~4.6 invitees by counting L1 once at 950 bps. **Wrong for the
same reason as the "half" error above:** L1 is paid in BOTH halves, so a referrer earns
**1900 bps = $1.90 per invitee per invitee-cycle**, not $0.95.

`$4.464 / $1.90` ≈ **2.35 invitees per cycle.** ⚠ UNVERIFIED — arithmetic over measured
numbers, and it EXCLUDES chain pay from a growing downline, which pushes the true bar LOWER.
Measure it, do not quote it.

⚠ **AND IT IS A RATE, NOT A TOTAL.** ~2.35 invitees *per cycle the member takes*, not 2.35
ever. Recruit once and you fund one cycle. Whatever is said to members must not blur that.

### ⚠ ITEM A IS ALREADY IN THIS TREE, AND IT DOES NOT FIX THIS HOP
The fixture ran against the V8.50 source, so **item A was in force** — confirmed by its own
output: the A→B hop cost $5.00 funded **100% from reserve, $0.00 from earnings**. Item A
works exactly as designed and kills mid-cycle parking at the A→B crossing. **It still ends
0 for 485 at the forward hop.** Item A was never aimed here; do not let a future session
report it as the fix for the graduation chain. LIVE V8.48 does not have item A at all.

### THE DECISION THIS PUTS IN FRONT OF THE OWNER — HIS CALL, NOT CLAUDE'S
The gap is real, measured, and closes only three ways:
- **A. Accept it.** Matches his standing framing: "members are EXPECTED to take loans and be
  evicted if they never invite anyone." The cost is that T1.2 fills at ~0 without referrals,
  and the parked queue is the product for anyone who does not invite.
- **B. Lend it.** The SF covers the ~44%. Bounded by `insolvencyFloorBps` (PARAM 59, now
  5000). Note the live T1 loan ceiling is **$3.40** and the median shortfall is **$4.41** —
  **the current ceiling cannot cover the median member.** That is a new, concrete fact.
- **C. Change the splits** so one A+B cycle pays for the next entry. Structural, needs
  modelling against the live population before any contract code is written.

**DO NOT DECIDE THIS FROM THE CODE. It is an economic and product trade-off.**

---

## 11.5 THE REFERRAL BREAK-EVEN SWEEP — INSTRUMENT BUILT, ANSWER NOT YET TAKEN
**File: `test/V8_50_ReferralBreakeven.test.js`. THREE VERSIONS, THREE DIFFERENT FAULTS. The
current file is v4 and has NOT yet produced a trustworthy row. Do not quote any number from
sessions 11's runs of it.**

The question: the 11.4 census proves a ZERO-referral member never graduates. How many
invitees per cycle does it take before they do? That number is what goes to members.

| version | what it did | why it was wrong |
|---|---|---|
| v1 | R-ary referral tree over the whole population | Later invitees joined AFTER their referrer had crossed to MatB, so their L1 landed in a MatA the referrer had left. R=2,3,5 came back **identical to R=0 to the cent**; only R=1 differed, because in a chain the invitee always arrives before the referrer leaves. The harness conflated referral RATE with referral TIMING. |
| v2 | interleaved — each subject's invitees registered immediately after them | Fixed the timing, but then **reported "stranded L1 = zero" as a finding.** It is zero BY CONSTRUCTION: no invitee CAN arrive late in this design. An instrument must not report the absence of what it cannot observe. Also fixed-budget starved the high rates — R=5 had TWO subject hops and duly broke the trend. |
| v3 | budget scaled with R to even out subject counts | **Traded a small-sample problem for a far worse confound.** Shortfall grows with system maturity (11.4), so scaling the budget measured each rate at a different point in the system's life. Result was flatly non-monotonic with 100+ hops per row: R=0 $3.2390, R=1 $2.5096, R=2 $0.6472, **R=3 $3.3812 (worse than R=0)**, R=4 $1.6212. Two effects fighting inside one column. |
| **v4 (current)** | **budget FIXED across all rates**; L1 split into @entry vs @crossing; thin rows labelled | **NOT YET RUN.** |

### WHAT IS NEVERTHELESS ESTABLISHED FROM THOSE RUNS
- ✅ **CONTROL REPRODUCES EVERY TIME.** R=0 graduated 0 of 105 at size 127 and 0 of 28 at
  size 7, matching 11.4's 0 of 485. The baseline is solid.
- ✅ **EACH INVITEE IS WORTH EXACTLY $1.90** — 950 bps at the invitee's MatA entry plus 950
  bps again when that invitee crosses to MatB. Seen cleanly in the size-7 v2 run:
  $5.128 → $3.228 → $1.328 as invitees went 0 → 1 → 2. **L1 pays in BOTH halves;** counting
  it once at $0.95 was Claude's error and doubled the apparent referral bar.
- ✅ **AN INVITEE'S SECOND $0.95 ARRIVES MUCH LATER** — only when that invitee themselves
  crosses. A referrer who reaches the forward hop early collects only the first half of
  their newest invitees. The size-7 third invitee was worth $0.95, not $1.90, for exactly
  this reason. v4 splits the two buckets so this is visible, not inferred.
- ✅ **STRANDED L1 IS REAL — CONFIRMED, AND SMALL.** v3 measured it NON-ZERO even under
  interleaving: $9.50 / $13.30 / $15.20 / $16.15 at R=1..4, against ~$2,500 of L1 paid.
  **~0.6%.** Real behaviour, not a rounding artefact, but far too small to explain anything
  in 11.4. Do not promote it to a headline.
- ⛔ **ZERO GRADUATIONS AT EVERY RATE TESTED, 0 THROUGH 4** — 1,120 subject hops and 2,495
  invitee hops, not one forward crossing. Even where the median subject was **65 cents**
  short. **THIS IS THE THING TO CHASE NEXT** (see below).

### ⛔ THE OPEN ANOMALY — NOBODY EVER REACHES THE FEE, EVEN WHEN CLOSE
At R=2 the median parked subject was $0.6472 short, and the 11.4 census found a minimum
shortfall of **$0.0782**. Members get to within eight cents and stop. Across thousands of
hops the distribution never crosses $10.00. A graduating member would leave the shortfall
sample and appear in FORWARD, and FORWARD is 0 everywhere — **so this is not a sampling
artefact, nobody has ever had enough.**

**TWO CANDIDATE CAUSES ALREADY RULED OUT — do not re-chase these:**
- ❌ *Lazy pool settlement leaving earned-but-uncredited money out of the affordability
  check.* **REFUTED:** `_cycleOutRoot` calls `_settlePool(self, cfg, root)` at
  MatrixLogicLib:805, BEFORE the crossing logic at :900+. The pool is settled first.
- ❌ *An earnings or payout cap.* **REFUTED:** no cap exists in MatrixLogicLib; `_settlePool`
  computes an exact rational share `(k*dA1 - dAr) / W` with no ceiling.

**STILL OPEN.** Next session: take ONE parked member at the hop and account for their
withdrawable to the cent against every credit they ever received — pool, chain, direct, L1,
carried balance — and find what the distribution is bounded by. Do not reason about it.

### HOW TO RUN v4
```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:CYCLE_SIZE=127
npx hardhat test test/V8_50_ReferralBreakeven.test.js
Remove-Item Env:\CYCLE_SIZE
```
~17 minutes at size 127. Dials: `CYCLE_REFS` (default `0,1,2,3,4`), `CYCLE_BUDGET`
(default 6 x SIZE — **fixed across rates on purpose**), `CYCLE_MIN_HOPS` (default 10).

⚠ **NOTHING WAS DEPLOYED AND NO CONTRACT FILE WAS TOUCHED IN SESSION 11.** Two new test
files only: `V8_50_CycleEconomics.test.js` and `V8_50_ReferralBreakeven.test.js`. The owner
stated 2026-08-20: *"we are not changing code yet just discussing until we come to a
conclusion."* Honour that — the decision in 11.4 is his and is still open.

---

# ⬛ SESSION 10 STATE — 2026-08-19/20, LATEST. READ THIS FIRST, BEFORE SESSION 9.

**THE HEADLINE: THE PARKED-MEMBER BADGE WAS REACHING NOBODY — 0 OF 107 PARKED MEMBERS COULD
SEE IT — AND ITS V8.48 FALLBACK DISAGREED WITH THE CONTRACT ON TWO OF FIVE CASES. Both fixed,
both shipped ALL THE WAY TO MAIN (owner decision). The bug-report form's advertised-but-missing
fields are fixed and it now takes screenshots. Nothing was deployed, no chain was written to,
`.env` line 69 is unchanged, NO CONTRACT OR TEST FILE WAS TOUCHED, and the suite is untouched
at 611 passing / 7 pending / 0 failing (not re-run — nothing it covers moved).**

| repo | branch | at session end |
|---|---|---|
| `C:\CryptoNite-Smart-Contracts\CryptoNova` | `v8.1` | **`917b105`** — two new instruments + the session-10 docs |
| `C:\CryptoNova-Testnet-App` | `admin` = `preview` = `main` | **`74a1588`** — badge fix + bug form. **THE LADDER IS LEVEL; members have everything.** |

---

## 1. ⛔ THE BADGE WAS INVISIBLE. 107 OF 107 PARKED MEMBERS COULD NOT SEE IT.

`renderParkedList()` opened with `if (cands.length < 2) { box.style.display='none'; return; }`.
Measured on live V8.48 with the new `scripts/diag_badge_preview.js`:

| | |
|---|---|
| parked positions | 107 |
| distinct parked members | **107** |
| members holding 2+ positions (badge RENDERS) | **0** |
| members holding exactly 1 (badge HIDDEN) | **107** |
| **share of parked members who could see the feature** | **0.0%** |
| of those positions, gap a loan CANNOT cover | 37 |

The whole of session 9's badge work reached nobody, while 37 members sat on an uncoverable gap.

**THE GATE'S REASONING WAS HALF RIGHT AND THAT IS WHY IT SURVIVED.** "One position is the
existing card's job" is TRUE OF THE ACTION — the single-position card's Self Rescue and Copay
buttons work fine. It was NEVER TRUE OF THE STATUS: that card renders label, withdrawable,
reserve, fee and shortfall, and says nothing about the eviction clock or whether the fund can
cover the gap. Verified by reading the card's own render path (`index.html` ~5752-5807).

**FIXED:** the list now renders STATUS-ONLY for a single position — badge and clock line, no
per-row buttons, no bulk bar, no header — and does NOT hide the card's own buttons the way the
multi-row path does. It reuses `_evictInfo` rather than forming a second verdict.

⚠ **COST STATED SO IT IS NOT DISCOVERED LATER:** single-position members now also pay the
status reads, ~5 extra `eth_call`s per dashboard load. The wallet-balance read was moved BELOW
the status-only return so it is not paid by members who never see a button. If it ever needs
cutting, cache the two chain-wide reads (grace period, SF balance) across the page — those are
the part that does NOT differ per member.

---

## 2. ⛔ THE V8.48 HEADROOM FALLBACK DID NOT MATCH `loanHeadroom`. IT INVERTED THE VERDICT.

`StabilityFund.sol:956-964` has **THREE** outcomes. The shipped fallback implemented **one**:

| condition | contract returns | old fallback computed |
|---|---|---|
| `insolvencyFloorBps == 0` | `type(uint256).max` — **unlimited** | `fee * 0 / 10000` = **0** |
| `tierEntryFees[t] == 0` | `type(uint256).max` — **unlimited** | **0** |
| otherwise | `fee*bps/10000 - debt` | same ✅ |

A zero ceiling reads as zero headroom, which renders **PENDING EVICTION on every parked row** —
the exact INVERSE of the truth, and it fires at the moment PARAM 59 is set to 0, which is the
documented ESCAPE HATCH for disabling the floor. **Measured, not argued:** old and new run
against the contract's own logic, **old disagreed on 2 of 5 cases**. It was right on live only
because the chain happens to read 3400 and a $10.00 fee — right by luck, not by construction.
This is the "two models of one rule, drifting" failure `StabilityFund.sol:938` names by hand.

**ALSO FIXED IN THE SAME BLOCK:**
- **The clock fallback no longer fires on a FAILED read.** `evictionGracePeriod` (V8.49+) and
  `extendedIdleTimeout` (V8.48) are SEPARATE DIALS — `MatrixKeeper.sol:1066` says in terms
  "Do NOT re-point this at extendedIdleTimeout to keep them in step." On V8.48 both are 604800
  so substituting is correct THERE; the substitution used to happen on ANY failure of the first
  call, so on a V8.49+ chain one transient RPC hiccup would silently render a countdown from the
  IDLE-SLOT RECLAIM clock and look healthy doing it. Now gated on the chain reporting the
  function ABSENT (empty return / missing revert data), never on a read that merely failed.
- **The three derivation reads are no longer `Promise.all`.** That all-or-nothing shape is
  exactly what made `diag_eviction_clock.js` report 107 of 107 unknown; that script was rebuilt
  for it in session 9 and `index.html` still carried the original. Read separately, an
  unreadable `memberDebt` leaves the ceiling standing as an UPPER BOUND — so "a loan cannot
  cover this" stays sound while "you are fine" correctly downgrades to CHECKING.
- **A `Symbol` sentinel now carries "unlimited",** and it is caught BEFORE any `<` comparison.
  JavaScript throws a TypeError on `Symbol < BigInt`, which would have taken the whole parked
  list down rather than mislabelling one row.

✅ **REFUTED, SO NOBODY RE-RAISES IT:** the badge does NOT consult `loanEligible`, which exists
on V8.48 — and it does not need to. `StabilityFund.sol:988` is literally
`loanHeadroom(member, tierIdx) > 0`. It carries nothing the badge does not already have.
Separately, `loanEligibleFor` IS the enforcement rule (`advance <= loanHeadroom`), and the
badge's `headroom < shortfall` test is that rule reproduced correctly.

---

## 3. ⛔ A HANDOFF CORRECTION — SESSION 9 CREDITED AN INSTRUMENT WITH A RESULT IT NEVER PRODUCED

Session 9 records "`probe_sf_views.js` found `loanHeadroom` AND `evictionGracePeriod` are the
two absent ones". **It cannot have.** Its case list has ten entries and `evictionGracePeriod`
is not one of them — it probes the **StabilityFund**, and `evictionGracePeriod` is declared on
**MatrixKeeper** (`MatrixKeeper.sol:372`). The claim was read off the SOURCE TREE and attributed
to an instrument that never asked the question, so the keeper half of the badge's fallback had
**never been measured against the deployed keeper**.

**THIS IS THE SESSION 9 TRAP ONE LEVEL UP: an instrument must not report the absence of what it
cannot observe — AND A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER ASKED.**
(To session 9's credit, `diag_eviction_clock.js:66-76` records the SF probe results correctly
and in full. The sloppiness was only in the summary.)

Now measured, `scripts/probe_keeper_views.js`, live V8.48 keeper `0x9Ade59F9` (20,211 bytes),
**4 of 4 controls green so these are statements about the ABI and not the network**:

| view | verdict | value | note |
|---|---|---|---|
| `idleSlotTimeout()` | EXISTS [ctrl] | 259200 | |
| `maxItemsPerUpkeep()` | EXISTS [ctrl] | **15** | ⛔ source default is 20 |
| `stabilityFund()` | EXISTS [ctrl] | `0xeb36ee74…` | matches the addresses file |
| `tierRouter()` | EXISTS [ctrl] | `0xD78eD884…` | |
| `evictionGracePeriod()` | **ABSENT** | — | V8.49+; badge takes its fallback |
| `extendedIdleTimeout()` | EXISTS | 604800 | the fallback answers |
| `parkedGracePeriod()` | EXISTS | **86400** | ⚠ source default is 6 hours |
| `minGasPerItem()` | **ABSENT** | — | ⛔ not on live at all |

SF probe re-run the same minute: `insolvencyFloorBps` **3400**, `tierEntryFees(0)` **$10.00**,
`memberDebt` and `memberDebtOf` both present, `loanEligible` true, `loanHeadroom` and
`loanEligibleFor` ABSENT, `totalBalance` $486.66, `totalRescueLoaned` $1,375.43. **Live T1
ceiling = $3.40**, exactly as predicted.

### ⛔ TWO BACKLOG ITEMS ARE STATED AGAINST THE WRONG NUMBER — FIX THE ITEMS, NOT THE CHAIN
1. **"`maxItemsPerUpkeep` is still vestigial at 20"** describes the SOURCE default. **The live
   chain runs 15.** Restate the item against the real number before deciding whether to lower
   it to 10. There is a `scripts/set_max_items.js`, so it was set deliberately at some point.
2. **`minGasPerItem` DOES NOT EXIST ON LIVE V8.48.** The measured 5M owner decision is a
   V8.49+/V8.50 property and is **NOT in force on the community chain** — consistent with the
   live keeper scripts still carrying `GAS_PER_ITEM_DEFAULT = 3_500_000`, which the guardrails
   say was left alone deliberately. Do not quote 5M as a live figure.
3. Minor, same class: `parkedGracePeriod` is 86400 on live against `6 hours` in source.

---

## 4. ✅ THE PARKED POPULATION MOVES ON A SCALE OF SECONDS — SO MOST OF ITS NUMBERS ARE SNAPSHOTS

`diag_badge_preview.js` first reported 37 uncoverable of 107; `diag_eviction_clock.js`, run
3m40s later, reported 41 of 108. Two instruments, one population, different answers — treated as
the finding rather than averaged.

**On every member both instruments list, they agree TO THE CENT** — gap, headroom and verdict
(`0xAdf9C692CB` $1.36/$0.00, `0xA9B019e7` $4.39/$3.40, `0x396DFA14` $5.00/$2.90, `0x7e323C4d`
$5.00/$2.96). So the rules are the same rule.

**PROVED WITH ONE INSTRUMENT INSTEAD OF TWO:** `diag_badge_preview.js` run twice, **20 seconds
apart, scanned 109 then 110 positions.** Population drift is demonstrated outright; no
cross-instrument comparison was ever needed.

⚠ **AND A SECOND RESULT FELL OUT OF IT.** Across four readings the counts went
**37/107, 41/108, 40/109, 40/110** — the uncoverable count moves MORE SLOWLY than the
population. That is what you would expect if **new parkers arrive rescuable** and the
uncoverable set is the accumulated hard cases. Consistent with the 20-second pair, where the
population moved and the uncoverable count did not.

⛔ **THEREFORE: `44 -> 41 -> 37` IS NOT A TREND.** It is snapshots of a population being churned
by bigfill. Any parked-population figure taken while the loop runs is a snapshot with a
timestamp, not a measurement of a stable quantity. **To compare the two instruments honestly,
stop the bigfill loop first, or compare only the PER-MEMBER rows** — that check has no drift in
it. Written into `diag_badge_preview.js`'s own output so it is not rediscovered.

⚠ **AND THE DIRECTION IS WORTH WATCHING:** across this session the SF climbed
**$486.66 -> $507.13 -> $517.20 -> $529.20** while the parked queue grew **107 -> 110**.
**Parking is currently outrunning rescue even as the fund recovers.** Neither number alone says
that; both together do.

---

## 5. ✅ BUG-REPORT FORM — @bevmawire WAS RIGHT AND THE BUG WAS THE WORDING

Reported 2026-08-19: *"Additional notes (optional) tab does not seem to be giving access to
'Steps to reproduce, screenshot filename, error message'... it does not seem to have facility
for uploading screenshots either."*

There was **one** free-text box whose PLACEHOLDER listed three things, so it read as a section
that should open up three fields. It never had them. **A form must not advertise what it cannot
accept.** Fixed by giving him the fields it promised rather than deleting the promise.

- **Steps to reproduce** — new optional textarea, threaded form -> `/api/submit-bug` ->
  `BUGS.md`, rendered as a fenced block (multi-line by nature; a newline on the bullet line
  breaks the markdown list). **Optional server-side on purpose:** a cached `bug-report.html`
  keeps not sending it, and output for an old client is byte-identical to before.
- **Screenshot upload** (owner decision: *"build it in the repo, keep it simple, if anything in
  the future could be an issue we revert"*). Downscaled IN THE BROWSER to ~1200px JPEG q0.82
  (~200-400KB) because a phone screenshot is 2-5MB and Vercel caps a serverless body at 4.5MB.
  Committed to `bug-screenshots/` through the same GitHub Contents API the reports already use,
  and **linked, not embedded** — `![](...)` would render every screenshot full-size inline and
  make `BUGS.md` unscrollable within a dozen reports.
- ⛔ **THE REPORT SURVIVES A FAILED UPLOAD.** The image is written BEFORE `BUGS.md` is touched
  and that path never throws; any failure becomes a `screenshotError` and the report is filed
  anyway **with a line saying a screenshot was attached and did not upload**. Worst case is an
  orphaned image, which is cheap and obvious. The other order loses reports.
- **iPhone HEIC is handled out loud** — most browsers will not decode it into a canvas, so the
  picker says so and says what to do, rather than failing silently.
- `resetForm()` clears steps, the file input, the status line and the in-memory base64 —
  without it the NEXT report from the same page load carries the PREVIOUS member's screenshot.

✅ **VERIFIED END TO END 2026-08-20**, owner filed a real report from a real browser:
`bug-screenshots/2026-08-20T01-54-38-741Z-bugtest.jpg` — a valid JPEG (magic `ff d8 ff e0`),
**50,123 bytes**, so the client-side downscale worked. `BUGS.md` carries the fenced
**Steps to reproduce** block and a resolving **Screenshot:** link, inserted at the top of Open
Issues. **And the commit order is right: `97e2d6e` (image) lands BEFORE `4e038ef` (report)**,
which is the ordering that keeps a report alive when an upload fails.

⚠ **AND THE UNDERLYING COMPLAINT IS NOT CLOSED.** @bevmawire's actual problem was "Couldn't
find your status" on the Dashboard at **13:50 GMT**; the Base Sepolia state-read outage ran
**15:54-16:39**. **His report PREDATES the outage and has a different cause.** The likeliest
candidate is the `LOGS_DEPLOY_FLOOR` load problem now shipped at `9d0940f`. **Ask him to retry
— do not assume it is fixed.** (Session 9's commit `1aa9ce8` had already spotted this class.)

---

## 6. BIGFILL — ALIVE, AND THE OFFSET QUESTION IS CLOSED

Three runs all logged `HDR_OFFSET=289` and the second registered **0 of 1**, its own NEXT RUN
HINT saying the wallet was already registered. Not a loop defect: **the owner restarted the loop
three times, each with `-StartOffset 289`** (confirmed by him and by the process list — PID 2836
started 18:58:37 with `-StartOffset 289`, which is run 3's own timestamp). Left alone the loop
does its own `$offset++` and the next log should be named `...offset290.log`.

⚠ Worth keeping: those three runs registered **nobody** and the fund still climbed. That
isolates the sweep-only inflow by accident and is the cleanest evidence yet that **the SWEEPS,
not the registrations, feed the fund** — which is what `BIGFILL_RULES.md` already says. Not a
designed experiment; do not quote a rate from it.

---

## 7. ⛔ BIGFILL — TWO FIXES, ONE COSMETIC AND ONE THAT WAS HIDING A BROKEN SWEEP

### 7a. "T1 total registered" WAS A PEOPLE LABEL ON AN ENTRY COUNTER
Owner spotted it: the snapshot printed **895** while the site's Live Stats read **370** all-time
joins. Both numbers were correct; the LABEL was wrong. `PairManagerV8.sol:86` says so itself —
`totalRegistrations` "increments on EVERY routing — register, rescue re-entry, MatB placement,
doubles — so it is an ENTRY counter". With 597 system cycles the same people are routed over and
over, so it climbs far past the headcount and reads like runaway growth.
**This has bitten the codebase twice before**, which is why V8.48 item 7 added `uniqueMembers`:
the treasury's early-exit penalty ladder was reading 0, and Universe Mode's 500-MEMBER gate would
have opened on entry CHURN (~12 real members' worth of re-entries). The snapshot now prints both,
each named for what it counts. The `uniqueMembers` read is GUARDED — `pm1` is the local V8.50 ABI
pointed at a live V8.48 chain — and prints "unavailable", never 0, if it fails.

### 7b. ⛔ STALE-NONCE FAILURES WERE COUNTED AS MEMBER REFUSALS — HH110 IN A NEW HAT
A post-registration sweep logged `nonce too low` on **16 of 16** wallets and printed
**"Self-rescues: 0 succeeded - 16 skipped"**. Those members were never asked. Worse than the
original HH110 case, because the `else` branch also does `consecutiveTransport = 0`, so **every
stale-nonce failure RESET the 5-in-a-row abort guard** — the sweep could fail indefinitely
without tripping it, and `run_bigfill_loop.ps1` (which only looked for `NETWORK FAILURES`) judged
the run GOOD and advanced the offset.

**CAUSE, BY ELIMINATION RATHER THAN ASSUMPTION:** member wallets are plain
`w.connect(ethers.provider)` with **no NonceManager** (deliberate — see the funder comment), so
ethers fetches the count itself at send time; a process check found **exactly one** bigfill
running, ruling out a concurrent sweep; and each wallet was behind by roughly the number of
transactions it had already sent earlier in that same run. That is a load-balanced RPC answering
`getTransactionCount` from a replica that had not caught up — the same lag this file already
sleeps 90s for after funding, and the same class as session 9's stale top-up read.

**FIXED:** stale-nonce errors are classified separately, **retried once with an explicitly
re-fetched nonce**, counted in their own bucket, reported in the summary as
`STALE-NONCE FAILURES ... treat this sweep as INCOMPLETE`, and they no longer reset the transport
counter. `run_bigfill_loop.ps1` now treats that marker as a bad run, so two in a row stop the
loop. ⚠ **The loop change only takes effect when the LOOP restarts** (PowerShell has already read
the script); the bigfill change lands on the next run, since node re-reads it each time.

✅ **7a CONFIRMED AGAINST LIVE 2026-08-20**: the next snapshot read `T1 unique members: 370`
(exactly the site's Total Registered) against `T1 entries (all routings): 904`. That also settles
the guarded question — **`uniqueMembers` DOES exist on the deployed V8.48**, measured not assumed.
⚠ **7b IS NOT CONFIRMED.** That run's sweep was clean (18 succeeded) and printed no
`(recovered - stale nonce, resent at N)` line, so **the retry path was never exercised**. A quiet
run is not a passing test. Its first real test is the next time the RPC lags.

### 7c. THE SNAPSHOT WAS PRINTING AN **ARCHIVED** PAIR AS BARE "T1"
Same run's header: `T1 factory: 2 pairs. T1.1 archived (127/127). Active: T1.2`. **T1.1 has
filled both halves and the factory has moved on** — which is exactly what session 9 predicted
would happen via `chainNext` and asked the next session to verify. It happened.
But `matA1`/`matB1` are bound ONCE from the addresses file, so they are pair 0 forever, and the
snapshot was printing `T1 MatA occupancy: 127 / 127` with no pair name. **That number is now
frozen at full permanently** and will keep reading healthy while the pair actually taking entries
fills unwatched. Session 9 logged this as cosmetic; it stopped being cosmetic the moment the pair
archived. Fixed by NAMING the pair and printing the active one beside it — `matA1`/`matB1` were
deliberately NOT re-pointed, because 28 other sites use them.
⚠ **T2 has the same latent shape** — one pair today, so it has not bitten yet.
⚠ **STILL TO WATCH: does T1.2's MatA actually start filling?** That is the confirmation of
session 9's chainNext prediction, and it needs a few runs of observation.

### 7d. REGISTRATION NONCE COLLISIONS WERE "GENUINE FAILURES" AND THE LOOP WALKED PAST THEM
A later run failed registration with `replacement transaction underpriced` — a transaction with
that nonce already in the mempool, i.e. **the wallet was never asked**. It was counted under a
heading that literally read `Genuine failures`, and because the loop only greps for its own abort
markers, the run was judged GOOD and **the offset advanced over a wallet that never registered**.
Unattended overnight that quietly scatters gaps through the wallet range.
**FIXED:** registration failures are split into genuine on-chain reverts and nonce/transport
failures; the latter emit the same `STALE-NONCE FAILURES` marker the loop treats as a bad run, so
the offset holds. **THIS IS THE THIRD INSTANCE OF ONE MISTAKE IN ONE EVENING** — 7a, 7b and 7d are
all an infrastructure condition presented as a statement about members or about the chain's
answer.

### 7e. ⛔ OVERNIGHT RESULT 2026-08-19/20 — 15 RUNS, OFFSETS 294 -> 309, LOOP STILL ALIVE

✅ **THE CLASSIFIER AND THE LOOP HOLD ARE PROVEN IN PRODUCTION, NOT JUST IN THEORY.** The 00:58
run hit **24 STALE-NONCE FAILURES** in its post-registration sweep, `run_bigfill_loop.ps1` judged
the run BAD, **held the offset at 297 and re-ran it** — the log directory shows `offset297` twice,
which is the mechanism working. Before last night that run would have been judged GOOD, the
offset would have advanced, and 24 members would have been recorded as having declined.

⛔ **BUT THE RETRY DOES NOT WORK, AND THE SAME RUN PROVES IT: 24 of 24 RETRIES FAILED.**
`Self-rescues: 0 succeeded - 1 skipped - ! 24 STALE-NONCE FAILURES`. A 3-second sleep and one
re-fetch is not enough for the replica lag. **The ACCOUNTING is right and the RECOVERY is not** —
do not read 7b as closed. Note the shape, which repeats: the PRE-run sweep in that same run
succeeded 24/24 and the POST-registration sweep failed 24/24. The lag appears only after those
wallets have just transacted, which is consistent with a load-balanced replica and points at a
longer backoff (or several attempts with growing gaps) rather than a different mechanism.

⛔ **AND THE OPEN QUESTION THE NIGHT PRODUCED — TWO NUMBERS THAT DISAGREE:**

| | 00:58 | 09:33 |
|---|---|---|
| `T1 unique members` | 374 | **386** |
| `T1 ACTIVE pair: T1.2 MatA` | 4 / 127 | **4 / 127** |

**SIXTEEN NEW MEMBERS JOINED OVERNIGHT AND THE ACTIVE PAIR DID NOT MOVE.** T1.1 is archived and
full on both halves; T1.2's MatA has sat at 4/127 for nine hours across ~13 runs while
`T1 entries (all routings)` climbed 1000 -> 1079. **This is exactly session 9's "if T1.2 stays
empty, chase it" condition.** Where new registrations are actually landing is now the clearest
open question in the system, and the pair labelling added in 7c is what made it visible at all.
⚠ Do not theorise the mechanism — measure where a registration lands. `diag_pair_chain.mjs`
(frontend repo) reports every tier's pairs with occupancy, rotations, parked and `chainNext`.

✅ Fund: **$555 -> $1,041.60 overnight**, nearly doubled, on ~15 runs of sweeps.

---

## TRAPS ADDED THIS SESSION

- **A HANDOFF MUST NOT REPORT WHAT THE INSTRUMENT NEVER ASKED.** Session 9's summary credited
  `probe_sf_views.js` with an `evictionGracePeriod` verdict it has no case for. The detailed
  write-up in `diag_eviction_clock.js` was correct; the SUMMARY drifted. **When a handoff
  attributes a result to a named script, the cheapest possible check is to open the script and
  look for the case.** It took one grep and it was wrong.
- **A FALLBACK MUST REPRODUCE THE WHOLE DEFINITION, NOT THE ARITHMETIC.** `loanHeadroom` has two
  early returns before its formula and the frontend copy had neither, which inverted the verdict
  in exactly the configuration an operator would reach for in an emergency.
- **"THE FUNCTION IS ABSENT" AND "THE READ FAILED" ARE DIFFERENT ANSWERS.** Any fallback gated
  on a bare `catch` will substitute during an outage. Gate on the error SHAPE.
- **A FEATURE THAT RENDERS FOR NOBODY STILL PASSES EVERY CODE REVIEW.** The badge was correct,
  tested, committed — and gated behind a condition no live member satisfied. **Before shipping a
  conditional feature, measure how many real users meet the condition.**
- **A POPULATION THAT MOVES IN SECONDS CANNOT BE CROSS-CHECKED BY TWO SCRIPTS RUN MINUTES
  APART.** Compare per-member rows, or stop the thing that is changing it.
- **`Symbol < BigInt` THROWS IN JAVASCRIPT.** A sentinel added to a value that is later compared
  with `<` must be caught before the comparison or it takes out the whole render.
- **A NEW FORM FIELD NEEDS THREE EDITS, NOT ONE:** the input, the payload, and `resetForm`.
  Missing the third silently carries one member's data into the next member's report.
- **"INFRASTRUCTURE FAILURE DRESSED AS MEMBER BEHAVIOUR" IS THIS PROJECT'S RECURRING BUG.**
  Four instances now: `HH110` counted as refusals (session 9), stale nonces counted as `skipped`,
  nonce collisions counted as `Genuine failures`, and an entry counter labelled as people. The
  question to ask of EVERY counter: *if the chain never answered, which bucket does this land in,
  and does that bucket's NAME claim something the run did not observe?*
- **A QUIET RUN IS NOT A PASSING TEST.** The stale-nonce retry shipped and the next sweep was
  clean — but it printed no recovery line, so the retry never ran. Confirm a fix by observing the
  fix's own output, not by the absence of the symptom.
- **"COSMETIC" HAS A SHELF LIFE.** The snapshot printing pair 0 as bare "T1" was harmless for
  weeks and became actively misleading the hour T1.1 archived. A label that is merely ambiguous
  today is a wrong answer waiting for a state change.
- **`git commit` CAN FAIL ON A STALE `.git/index.lock` FROM A CRASHED EARLIER PROCESS.** Check
  `Get-Process git` FIRST — if none is running the lock is debris and its `CreationTime` tells
  you which session left it. (One was found here dated 18:49:54, from session 9.)

---

## STATE OF THE TREE

**Contracts (`v8.1`, `917b105`, pushed):** `scripts/probe_keeper_views.js` and
`scripts/diag_badge_preview.js`, both NEW, both ASCII-only with no BOM, both `node --check`
clean. **No contract file, no test file, no `.env` change.** Suite untouched at 611/7/0.
⚠ Still untracked and unexplained: `scripts/bigfill_v8.js.bak_ascii`, `test_ab/replay.js.bak_s9b`,
`test_ab/replay.js.bak_s9c` — session 9 leftovers. House pattern is to move strays into
`archive/`, not delete them.

**Frontend (`admin` = `preview` = `main`, `74a1588`, pushed):** `index.html` (badge visibility +
headroom + clock gating), `bug-report.html` and `api/submit-bug.js` (steps field + screenshots).
⚠ `COMMIT_MSG_s10.txt` is untracked debris in BOTH repos — delete it.
⚠ **Local `preview` and `main` are 30 commits behind their remotes.** Not touched, because the
ladder was pushed as `git push origin admin:preview` / `admin:main` (both fast-forwards —
`origin/main` and `origin/preview` were strict ancestors of `origin/admin`). **A future session
that checks out local `preview` and merges will make a mess.** Fix them or delete them.

---

## NEXT, IN ORDER

1. ~~Verify the screenshot upload end to end~~ — **DONE 2026-08-20, see section 5.**
   Instead: **confirm the two bigfill fixes actually took.** The next run's snapshot should read
   `T1 unique members: 370` (matching the site) rather than a 900-ish entry count, and no
   `STALE-NONCE FAILURES` line should appear. If it says "unavailable on this build",
   `uniqueMembers` is not on the deployed V8.48 and the people count must be derived another way.
2. **Ask @bevmawire to retry the Dashboard.** His fault predates the outage and the block-floor
   fix has now shipped to main. Either it is fixed or we have a second, still-unidentified cause.
3. **Restate the `maxItemsPerUpkeep` item against 15, not 20**, then decide.
4. ⛔ **MEMBER-CALLABLE RE-ENTRY AFTER EVICTION** — V8.50 scope, owner decision 2026-08-19.
   Unchanged from session 9; nothing this session touched it. `_recordJoin` is already
   idempotent, preserve `memberReferrer`, put any new loop in TierRouterLib (EIP-170 pressure).
5. **Eviction end to end in the V8.50 private deploy** — recipe in session 9's late addendum.
   The cohort must be left UNFUNDED or it self-rescues and never reaches the valve.
6. **Model self-rescue at a non-zero rate.** Still the headline caveat on the PARAM 59 basis,
   the eviction answer and the loans-per-member result.
7. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
8. **The open owner decision on live V8.48** (leave organic / bigfill / fund the SF) is STILL
   OPEN. ⚠ Re-measure before deciding — and note this session's finding that the parked queue is
   GROWING (107 -> 110) while the fund recovers ($486 -> $529). The bracket from session 9
   (-$136/day stopped vs +$111/day running) is unchanged but its inputs have moved again.

---

# ⬛ SESSION 9 STATE — 2026-08-19, LATEST. READ THIS FIRST, BEFORE SESSION 8.

**THE HEADLINE: PARAM 59 IS DECIDED AND LANDED (3_400 -> 5_000). THE SUITE HAS NOT BEEN RUN
YET — that is the first thing to do. Most of this session was spent on a LIVE CUSTOMER-FACING
INCIDENT on V8.48 which turned out to be an UPSTREAM BASE SEPOLIA OUTAGE and NOT our code, and
on an owner-raised routing concern which is now CLOSED — nothing reverted, nothing is skewed.
Nothing was deployed. No chain was written to. `.env` line 69 is unchanged.**

Contracts changed: `StabilityFund.sol` (the default + its full measured basis),
`V8Governance.sol` (param 59 docs only). Tests touched: six files that pinned or described the
old ceiling. **NONE of it is committed yet — see STATE OF THE TREE.**

---

## 1. ⛔ PARAM 59 — OWNER DECISION TAKEN 2026-08-19: **5_000**

Session 8 left this open with a measured curve and a recommendation. The owner chose **5000**.
Landed in source the same turn:

- `contracts/StabilityFund.sol:844` — `insolvencyFloorBps = 5_000`, with the whole basis
  written at the declaration: the AB_FLOOR_BPS curve, why 5000 and not the saturation point
  4500, what it costs, and the carried `SELF_RESCUE_RATE = 0` caveat.
- `contracts/V8Governance.sol` — PARAM 59 docs. **No menu change was needed**; 5000 was
  already in `_allowedValues[59]`. Same as `minGasPerItem`.
- `test/V8_49_InsolvencyFloor.test.js` — `FLOOR_BPS_DEFAULT` 3400n -> 5000n (CEIL derives
  from it, so the boundary tests follow automatically).
- `test/V8_48_GhostFloor.test.js` — GF-F1's declared-default assert 3400n -> 5000n.
- `test/CycleOutDebug.test.js`, `test/stress_test_full.js`, `test/V8_49_CrossingBuffer.test.js`
  — prose and assertion messages that described the old $3.40 ceiling. No logic changes; every
  one of those assertions holds at any on-menu ceiling.

⚠ **`V8_48_KeeperScan.test.js`'s PARAM 59 sweep STILL PROBES 3_400 AND THAT IS DELIBERATE.**
The variable was renamed `shipping` -> `cliff` and the reasoning written at the point of the
change. That row tests the SHAPE of the item-A divergence, and 3400 is the value where the
divergence is known to exist. Retargeting it at 5000 would assert a flip count nobody has
measured, and a zero there would go red for a reason unrelated to what the test is about. The
sweep prints every row, so what the shipped 5000 does is READABLE without being asserted.

⚠ **ONE DISAGREEMENT IS LOGGED, NOT RESOLVED.** `model_item_a.js` PHASE 7 measured 3400 and
5000 as refusing THE SAME ONE MEMBER of 40 — "identical outcome". The A/B curve measures them
as clearly different (9 -> 3 evicted-never-lent-to; 7/6/5 -> 0/0/0 floor evictions). Different
populations on different bases (40 live V8.48 MatB parkers projected post-E1, vs 288 members
inside a running V8.50 build) is a reason they COULD differ, not a measurement that they DO
differ for that reason. Written into StabilityFund.sol as UNRECONCILED. The instrument if it
matters again is phase 7 re-run against a private V8.50 chain.

**⛔ NOT DONE: THE SUITE HAS NOT BEEN RUN SINCE THE CHANGE.** Expected 611 passing / 7 pending
/ 0 failing. Anything red is a test that pinned the old ceiling and was missed.

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath suite_after_param59.txt
```

---

## 2. 🚨 THE LIVE V8.48 INCIDENT — UPSTREAM BASE SEPOLIA, PROVEN WITH A CONTROL

Owner reported the community site erroring, "ongoing for a while, getting worse". Symptoms:
dashboard "Couldn't load your status", Live Stats all `—`, Matrix Tree View
`missing revert data (data=null, reason=null)` on `0x3f728455`, Status page
`0/127 · MatA 0%` and "Could not read keeper this poll" while showing 109 parked and $87.50 SF.

**WHAT IT WAS: Base Sepolia stopped serving STATE READS while still producing blocks.**

| method | Base Sepolia | Base mainnet | Ethereum Sepolia |
|---|---|---|---|
| `eth_blockNumber` | ok, advancing | ok | ok |
| `eth_getCode` | **HTTP 503** | ok | ok |
| `eth_call` | **HTTP 503** | ok | ok |

Five QuickNode endpoints AND Coinbase's `sepolia.base.org` failed identically; two other
chains answered fine **from the same machine in the same minute**. Base's status page said
"all operational" throughout — it was wrong, or lagging. Timeline: healthy at 15:20 UTC
(`occupancy()` = 127), hard down 15:54, intermittent 16:14–16:38, stable from 16:39.
`base_sepolia_watch.csv` in the frontend repo is the timestamped record.

**ONE UPSTREAM CAUSE PRODUCED ALL FOUR SYMPTOMS**: `occupancy()` fails -> ethers reports
`missing revert data` (Matrix view); the same failure inside `rpc()` loses its 8-second race
and `.catch(()=>null)` discards it -> cards paint `—`; the keeper reads state the same way ->
"could not read keeper". **Parked rescues stall for the duration** — expect a backlog after any
future outage.

**THE INSTRUMENTS BUILT (all in `C:\CryptoNova-Testnet-App`, read-only, no keys):**
- `check_rpc.ps1` — per-endpoint health. ⚠ **ITS FIRST VERSION ONLY TESTED `eth_chainId` AND
  `eth_blockNumber` — the two methods that never broke — and reported "all six endpoints
  healthy" during a live outage.** See the traps section.
- `measure_page_rpc.mjs` — page workload + true contract creation blocks. Reads
  `LOGS_DEPLOY_FLOOR` BACK out of index.html rather than restating it.
- `check_matrix_calls.mjs` — every endpoint asked the same call, side by side.
- `repro_page_load.mjs` — reproduces the page's load shape (pooled provider, batching on).
- `check_chain_scope.mjs` — **the one that settled it.** Other chains, same machine.
- `watch_base_sepolia.mjs` — recovery sampler; calls recovery only on a 3-sample streak on
  BOTH operators, because a flapping service returns single green reads (it did, at 16:14).

---

## 3. ⛔ FRONTEND FINDING — `LOGS_DEPLOY_FLOOR` WAS 588,000 BLOCKS TOO LOW. FIXED, **UNPUSHED**.

Found while chasing the incident; **it is NOT the incident's cause** and must not be quoted as
one. It is real on its own measured merits.

`index.html` floored every lifetime log scan at block **44,840,000** (a V8.46-era number) and
walked back to it in 9,000-block windows. Measured 2026-08-19 with `measure_page_rpc.mjs`:

| | block | windows per lifetime scan |
|---|---|---|
| chain head | 45,691,990 | — |
| old floor | 44,840,000 | **95** |
| cnova created | 45,428,148 | 30 |
| tierRouter created | 45,428,223 | 30 |
| communityWallet created | 45,430,266 | 30 |

**65 of every 95 windows — 68% of ALL lifetime history reading the site does — scanned blocks
that provably contain nothing**, because they predate the creation of every contract queried.
Six call sites do a floor-bound scan. Measured 103 ms/window, **0 failed windows, 0 retries** —
the endpoints were never refusing us, the page was simply asking ~3.2x more than it needed to.

Changed to **45,428,000** (148 blocks below the earliest creation, as slack against an
off-by-one in the search). Safety is a property, not an estimate: a contract cannot emit an
event before the block it was created in. All five inline script blocks pass `node --check`.

⚠ **THE REAL DEFECT IS THAT THIS CONSTANT GOES STALE BY DESIGN.** The head moves ~43,200
blocks/day and the floor does not, so every scan grows ~4.8 windows/day — ~29 more requests per
dashboard load per day, forever. Raising it buys ~4 months and then the same curve resumes.
Structural fixes, in order of value: (1) `safeGetLogs` already takes `opts.fromBlock` so a deep
history could be paid ONCE per wallet and cached — no call site passes it; (2) per-contract
floors instead of one global one.

**STATUS: edited in the working tree of `C:\CryptoNova-Testnet-App`, NOT committed, NOT
pushed.** Backup at `index.html.bak_session9`. Held deliberately so it would not be deployed
mid-incident and confuse the before/after.

---

## 4. ✅ THE OWNER'S T2 ROUTING CONCERN — CLOSED. NOTHING REVERTED.

Owner: *"T2.2 opened and started filling before T2.1 was completely filled, and T1.1 is still
taking members and cycling while T1.2 is on standby like it should — so something got skewed in
that deploy, maybe something reverted."* Then, from memory: *"we opened a pair in the event a
member has double entry enabled and cannot seat in the existing pair — a new pair opens up to
accommodate them vs parking them silently."*

**Measured on the live chain (`diag_pair_chain.mjs`, `diag_pair1_occupants.mjs`,
`diag_pair_birth.mjs`, all in the frontend repo):**

| | T1 | T2 |
|---|---|---|
| pair0 MatA | 127/127, rot 599, parked 26 | 127/127, rot 124, parked 4 |
| pair0 MatB | 126/127, rot 447, parked 81 | 118/127, **rot 0**, parked 0 |
| pair1 MatA | 0/127 | **5/127** |
| MatB % at pair1's birth | **92.1%** | **90.6%** |

**THE ANSWER IS TWO ANSWERS, AND CONFLATING THEM IS WHAT MADE IT LOOK WRONG:**

1. **WHAT CREATED EACH PAIR: the routine trigger.** Both births were above
   `factoryExpandThresholdBps` (9000). `_forceExpand()` never fired, and could not have — it is
   only reached when `_freePairFor()` returns `type(uint256).max`, and `_tryAdvancePair()` runs
   FIRST on every entry path, so the fresh empty pair always gives it somewhere to point. **The
   "normally unreachable" comments at :351 and :569 STAND — do not weaken them.**
2. **WHAT FILLED T2.2: the double-entry accommodation, exactly as the owner remembered.** All
   **5 of 5** occupants already hold a seat in T2.1's **MatB**. They could not take a second
   seat in the same pair (universal pair guard, `MatrixLogicLib:278` rejects a seat in EITHER
   half), so `registerFor` (:561) routed them forward. Joined 00:55–03:45 the same morning at a
   ~50-minute cadence — **bigfill wallets, not organic members.**

Both mechanisms fired in the same transaction, in that order, which is precisely why it looks
from outside like the double created the pair.

**ALSO CLOSED, AND IT CORRECTS SOMETHING THIS SESSION SAID FIRST:**
- **CHAIN WIRING IS CORRECT ON EVERY TIER.** Each MatB's `chainNext` is the next pair's MatA;
  the last MatB points back to pair 0's MatA. The circle closes on T1 and T2. No deploy defect.
- **T1.2 BEING EMPTY IS NOT STARVATION.** This session first suggested T1's graduates were
  parking instead of graduating. The simpler explanation is right: **before T1.2 existed,
  `chainNext` pointed T1.1's MatB back at its OWN MatA** — the self-sustaining loop, which is
  why MatA has 599 rotations against MatB's 447. T1.2 was wired in only when MatB crossed 90%,
  so it is empty because MatB has not rotated SINCE. Meanwhile 249 have joined T2's MatA — the
  ladder is absorbing people.
- **T2.1's MatB has NEVER rotated (rot 0)**, so it has produced zero graduates. Any future
  claim that "pair 1 is receiving graduates" must check the SOURCE's rotation count first.

**STILL TRUE AND STILL THE REAL NUMBER: 107 of 111 parked members sit in T1** (81 in MatB, 26
in MatA). That is the crossing-cost problem V8.50 item A + E1 exist to fix. It is not a routing
fault and no routing change touches it.

---

## TRAPS ADDED THIS SESSION — ONE TRAP, **THREE** INSTANCES IN ONE AFTERNOON

**AN INSTRUMENT MUST NOT REPORT THE ABSENCE OF SOMETHING IT CANNOT OBSERVE.** Already on the
list from session 8 ("testing the wrong slice looks like a refutation"). It was walked into
three more times today, so it is restated with all three:

1. **`check_rpc.ps1` reported "all six endpoints healthy" DURING A LIVE OUTAGE** — it only sent
   `eth_chainId` and `eth_blockNumber`, the two methods that never broke. It never sent an
   `eth_call`. That reading sent the session down a load/latency detour.
2. **`diag_pair_chain.mjs` reported "pair 1 IS receiving graduates"** from the fact that pair 1
   had members — without checking that pair 0's MatB had ever rotated. It had not. Zero
   rotations means zero graduates; the members came from somewhere else entirely.
3. **`diag_pair_birth.mjs` reported "no registration in this tx"** because its hand-written ABI
   guesses did not match the deployed signatures, so every event decoded as `unknown(0x...)`.
   Fixed by building the topic0 dictionary from the repo's own `artifacts/` — **227 signatures
   instead of 9 guesses.**

**AND A FOURTH, WORSE, WHICH THE ABI FIX WOULD NOT HAVE CAUGHT: A DISCRIMINATOR THAT CANNOT
DISCRIMINATE.** `diag_pair_birth.mjs` v1 was built on "a registration tx means the routine
trigger, a cycle-out tx means the on-demand spawn". That premise is FALSE — `_tryAdvancePair()`
is the first statement of `registerDirectFor`, `registerFor` AND `registerForMatB`, so it runs
on every entry path and the transaction type carries NO information about which created the
pair. The script decoded real events into a conclusion the data could never support. **Before
building a discriminator, prove the two cases actually differ in what it measures.**

**WHEN TWO DISCRIMINATORS DISAGREE, ONE OF THEM IS BROKEN — GO FIND OUT WHICH.** v1 printed
92.1% and 90.6% (both above the trigger) in one column and "PATH B" in the next. The
disagreement was the finding, exactly as rule 1 says, and it was the instrument.

**A STATUS PAGE IS NOT A MEASUREMENT.** status.base.org said "All Systems Operational, 100%
uptime" throughout a total state-read outage.

**AND THE CONFOUND THAT NEARLY LANDED: SIX ENDPOINTS ON ONE NETWORK PATH ARE NOT SIX
INDEPENDENT OBSERVATIONS.** Every reading came from the owner's machine. A middlebox inspecting
POST bodies would pass `eth_blockNumber` and fail `eth_call` and look identical to an upstream
outage. `check_chain_scope.mjs` (other chains, same machine) is what made the conclusion safe.

---

## STATE OF THE TREE — ⚠ NOTHING FROM THIS SESSION IS COMMITTED

**Contracts repo (`v8.1`), all UNCOMMITTED working-tree edits:**
- `contracts/StabilityFund.sol`, `contracts/V8Governance.sol`
- `test/V8_49_InsolvencyFloor.test.js`, `test/V8_48_GhostFloor.test.js`,
  `test/V8_48_KeeperScan.test.js`, `test/CycleOutDebug.test.js`, `test/stress_test_full.js`,
  `test/V8_49_CrossingBuffer.test.js`
- Last commit remains `c177938`. **Run the suite BEFORE committing.**

**Frontend repo (`C:\CryptoNova-Testnet-App`), all UNCOMMITTED:**
- `index.html` — `LOGS_DEPLOY_FLOOR` 44840000 -> 45428000 + both stale comments corrected.
  Backup `index.html.bak_session9`.
- NEW diagnostics: `check_rpc.ps1`, `measure_page_rpc.mjs`, `check_matrix_calls.mjs`,
  `repro_page_load.mjs`, `check_chain_scope.mjs`, `watch_base_sepolia.mjs`,
  `diag_pair_chain.mjs`, `diag_pair1_occupants.mjs`, `diag_pair_birth.mjs`
- Result files: `rpc_health_*.json`, `page_rpc_workload_*.json`, `matrix_call_probe_*.json`,
  `repro_page_load_*.json`, `pair_chain_*.json`, `pair1_occupants_T2_*.json`,
  `pair_birth_*.json`, `base_sepolia_watch.csv`
- `INCIDENT_2026-08-19_BASE_SEPOLIA.md` — the incident write-up.
- ⚠ Remember the push ladder: `git push origin admin` — admin -> preview -> main, and MEMBERS
  SEE MAIN ONLY.

---

## NEXT, IN ORDER

1. **RUN THE SUITE** after the PARAM 59 change (command in section 1). Nothing else in the
   release is blocked on it, but nothing should be committed before it.
2. **Commit both repos** — explicit paths only. ⛔ NEVER `git add -A` from the device side
   (core.autocrlf unset there shows 31 files modified on line endings alone).
3. **Ship the `LOGS_DEPLOY_FLOOR` fix** to admin and re-run `measure_page_rpc.mjs` against the
   healthy chain to confirm 95 -> 30 windows end to end. It reads the constant back, so the
   re-run verifies the SHIPPED value.
4. **Owner decision 2 is STILL OPEN — live V8.48: leave organic, bigfill, or fund the SF?**
   ⛔ **SESSION 8'S "BIGFILL DOES NOT REPLENISH" IS WITHDRAWN — the owner corrected it
   2026-08-19 and he is right on mechanism.** It rested on one bps figure the same document
   flagged as unconfirmed, and missed three inflows: registrations (1-5 new wallets per run),
   UPGRADES to the highest eligible tier (a $25 T2 or $50 T3 fee carries a proportionally
   larger stability split than a $10 registration), and SELF-RESCUES (the crossing fee is
   still distributed so the SF gains its split, AND no SF loan is drawn).
   **The third dominates, and it is avoided OUTFLOW, not income:** a wallet that self-rescues
   does not draw the $3.42-$4.52 SF share and still pays in — roughly a $4 swing per event
   against the passive case, an order of magnitude above the $0.238-$0.30 that session 8
   reasoned from.
   ⛔ **THEREFORE THE DRAIN SERIES IS CONTAMINATED AND "PRESERVE THE BEFORE-PICTURE" IS DEAD
   AS AN ARGUMENT.** The bigfill wallets stay seated whether bigfill runs or not: with it
   stopped they still cycle out, park and get SF-rescued, but no longer register, upgrade or
   self-rescue. Stopping bigfill removed the income and kept the liability — the population is
   100% PASSIVE BY CONSTRUCTION, the same pathological extreme as `SELF_RESCUE_RATE = 0`.
   The ~$125/day drain may be an artifact of the regime, not a property of the economics.
   ✅ **MEASURED 2026-08-19 — OWNER RIGHT, ON GROUND-TRUTH USDC.** `scripts/diag_sf_flows.js`
   and `scripts/diag_sf_usdc_ledger.js` (both new). The USDC ledger reconciles EXACTLY
   (in $1,401.79 / out $1,364.86 / balance $36.94 = balanceOf = totalBalance) so there is NO
   LEAK. Daily net separates perfectly by regime: bigfill days 08-13..08-16 **+$72.87 /
   +$75.82 / +$81.39 / +$214.74**, quiet days 08-17..08-19 **-$114.31 / -$185.02 / -$108.55**.
   **+$111/day running vs -$136/day stopped, no overlap.** The -$136 matches the ~$125/day
   drain previously recorded — that series measured the passive regime, nothing more.
   Mechanism: stopping bigfill took keeper rescues 11.5 -> 44.3/day and SF lending
   $76.72 -> $345.68/day while self-rescues fell 73.5 -> 16.0/day.
   ⚠ `diag_sf_flows.js`'s `net/day` column is VOID (double-counts repayments, treats
   FundDeposit events as cash — they overstate real inflow ~$300 over this range) and its
   inflow ATTRIBUTION is misleading ("keeper-rescue 58.6%" is the fund's largest COST, not
   its largest source). Its OUTFLOW column is sound — it reconciles to the contract counter.
   ⚠ Neither regime is the real world (~100% vs 0% self-rescue) — read them as a BRACKET.
   This is the best empirical anchor yet for the open self-rescue-rate item.
   ⚠ Still also true: the figures are days old and the SF has moved ($212.35 -> $87.50 on the
   status page 2026-08-19), and `diag_parked_growth.js` with `WINDOW=3000` is still owed.
   ⚠ Operational: restarting bigfill collides with a future V8.50 private deploy on wallet
   nonces. Sequence them, never overlap.
5. ⛔ **NEW V8.50 SCOPE ITEM — MEMBER-CALLABLE RE-ENTRY AFTER EVICTION.** Owner decision
   2026-08-19. Verified in the contracts that day: eviction does NOT clear `globalJoined`,
   `register()`/`registerWithCoupon()` revert `TRState()` for anyone who has ever joined,
   and `autoReentryEnabled`/`doubleReentryEnabled` are read inside the CYCLE-OUT handler
   (TierRouter:1338/:1342) so they need a seat an evicted member no longer holds.
   **AN EVICTED MEMBER CANNOT RETURN ON THEIR OWN — the only door is the onlyOwner
   `setGlobalJoined(member,false)`.** That contradicts the owner's stated intent that
   evicted members come back and pay their fees. Bigfill now simulates it via the owner
   override (see BIGFILL_RULES.md action 4) as an INTERIM measure with a stated expiry;
   the contract path is what makes the test honest. Design notes: `_recordJoin` is already
   idempotent so a return does not double-count `uniqueMembers` or reset the join clock;
   preserve `memberReferrer` so referral history is not rewritten; TierRouter is under
   EIP-170 pressure so put any new loop in TierRouterLib from the start.
5. ~~Router placement refusals, 11 -> 53~~ — **CLOSED 2026-08-19, they were never refusals.** See the addendum section below; the metric is a second label on parks already counted, and the no-strand epilogue measured clean (0 orphans, both arms).
6. **Model self-rescue at a non-zero rate.** Still the headline caveat on sections 2, 5 and 6 of
   session 8 and on the PARAM 59 basis.
7. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
8. **`maxItemsPerUpkeep`** — still vestigial at 20. Confirm deliberately or lower to 10.

---

## ⛔ LATE-SESSION ADDENDUM (2026-08-19, after the write-up above)

### THE TRAP THAT COST THE MOST: **V8.49/V8.50 NAMES CALLED AGAINST THE V8.48 CHAIN**
The repo tree is V8.50. **The community chain is V8.48.** A view added after V8.48 reverts
there with `missing revert data`, which looks exactly like a network fault and is not one.
Caught THREE times in one hour:
| called | added in | V8.48 has instead |
|---|---|---|
| `evictionGracePeriod()` | V8.49 item 1 (`b14eba7`) | `extendedIdleTimeout()` — same 604_800 |
| `loanHeadroom(addr,u8)` | V8.49 item 1b (`40d7843`) | derive: `fee*insolvencyFloorBps/10000 - memberDebt` |
| (same, in the new dashboard code) | | would have made every badge read CHECKING on live |
**RULE: any new code that calls the chain must be checked against the DEPLOYED ABI, not the
source tree.** `scripts/probe_v848_getters.js` exists for this; `scripts/probe_sf_views.js`
(new) is the narrow SF version. Extend them rather than re-inventing.

### EVICTION HAS NEVER FIRED ON LIVE V8.48 — AND CANNOT WHILE BIGFILL RUNS
`MemberEvicted` events: **0**, on a chain live since 2026-08-13. Not a broken valve — the
mechanism has never had an opportunity. Eviction needs BOTH the 7-day clock AND a non-NONE
`_triageParked` reason, and bigfill self-rescues at 100%, so parked members are rescued long
before the clock expires (54 of 57 in one run). Measured: soonest clock of ANY parked member
**5.41 days**; eviction candidates **not determinable** on V8.48 (see the ABI trap above).
**RECOMMENDATION, owner to confirm: do NOT test eviction on live V8.48.** It means racing a
5-day clock the sweep keeps resetting, and a V8.50 deploy resets the chain anyway. Test it in
the V8.50 private deploy with a cohort deliberately parked, UNFUNDED and EXCLUDED from the
sweep. Shortening the grace period on live is the only faster lever and it moves the deadline
for every real member — an owner policy call, not a test convenience.

### ⛔ EVICTION TEST — OWNER DECISION 2026-08-19: **NOT ON LIVE. DO IT IN THE V8.50 PRIVATE DEPLOY.**
Owner, verbatim in substance: *"we are definitely not going to make the 6 days, we will have
a deploy before that."* So the natural test on live V8.48 is dead — the soonest candidates
were ~146h out and the deploy lands first. **Stop holding anything back for them; bigfill may
self-rescue freely.**

✅ **AND THE PRIVATE CHAIN REMOVES THE TIMING PROBLEM ALTOGETHER — THIS IS THE UNLOCK.**
`evictionGracePeriod` is DAO param 62 with a setter. On live it is untouchable because it
moves the deadline for every real member. **On a private chain with no members, set it to
MINUTES.** The 7-day wait was never a property of the mechanism; it was a property of having
customers on the chain. The whole test collapses from 6 days to one coffee.

**THE RECIPE, so this is not re-derived:**
1. Deploy V8.50 privately. Confirm PARAM 59 = 5_000 on the deployed SF (`insolvencyFloorBps()`),
   not just in source — a dial set is not a dial in force.
2. `setEvictionGracePeriod(<minutes>)` on the keeper. **READ IT BACK.**
3. Seat a small cohort, cycle them out so they park, and leave them UNFUNDED — a funded
   wallet self-rescues and never reaches the valve, which is exactly why live V8.48 has
   produced ZERO `MemberEvicted` events in 6 days of running.
4. Run the keeper. Assert on `ParkedMemberEvicted` / `MemberEvicted`, and check the member
   keeps their withdrawable, the crossing reserve is RELEASED (`EvictionReserveReleased`),
   and the debt stays booked — the valve is supposed to remove them, not confiscate.
5. Then re-run with PARAM 59 at 3_400 as the control. On live V8.48 the T1 ceiling is
   $10.00 x 3400/10000 = **$3.40**, and parked gaps of $4.39 / $5.00 / $5.00 were measured
   sitting ABOVE it — uncoverable by any loan. At 5_000 the ceiling is $5.00 and all three
   are covered. That is the A/B curve's 9 -> 3 result reproduced from live data, and it is
   worth asserting end to end rather than trusting twice-derived numbers.
6. Also exercise the V8.50 member-callable re-entry (scope item above) — an evicted member
   returning under their own power is the half bigfill currently fakes with an owner override.

### BIGFILL — CHANGED, WORKING, AND THE FUND RECOVERED
`-Count` 127 -> **1** (owner rule; sweeps feed the fund, not bulk registration), plus the new
`reinstateEvicted()` phase (owner override — see BIGFILL_RULES.md action 4 for why that
simulates something production cannot do). Two robustness fixes, both measured not guessed:
- **Transport errors are no longer counted as refusals.** A run logged `HH110` on 31
  consecutive wallets and still printed "17 succeeded - 36 skipped" — a measurement of the
  NETWORK read as a measurement of MEMBERS. Now classified, counted separately, and 5 in a
  row ABORTS the sweep rather than producing a partial result that looks whole.
- **The USDC top-up verification read stale state.** Two runs PROVED it: `0xaFF03A85` was
  topped +$4.00, reported "DID NOT LAND [still $3.00]", and turned up next run holding
  exactly $7.00; `0x0f822360` +$2.11 -> $5.11. The transfers landed; the CHECK was wrong.
  Now retries the balance read 3x with 3s gaps before declaring failure.

**RESULT, on ground-truth USDC: SF $36.94 -> $352.58 in one afternoon.** Combined with the
regime table above (bigfill days +$111/day, quiet days -$136/day), the owner's correction is
confirmed twice over — by history and by live recovery.

### FRONTEND — PARKED-MEMBER STATUS BADGE (BUILT, **UNPUSHED**)
`index.html` `renderParkedList()` now labels each parked position **IN RESCUE QUEUE** /
**WAITING ON FUND** / **PENDING EVICTION** / **CHECKING**, with the eviction countdown. It
does NOT re-implement `_triageParked` (its reason is an internal uint8, never emitted) — it
compares two exact figures, `loanHeadroom` (with the V8.48 derivation above) against the
member's own gap, and reads the grace period from the keeper rather than hardcoding it.
Failed reads render CHECKING, never "fine". All 5 inline script blocks pass `node --check`.
⚠ Not tested against a live chain yet — do that before it goes past `admin`.

### ⛔ ROUTER PLACEMENT REFUSALS — **CLOSED 2026-08-19. THEY ARE NOT REFUSALS.**
Supersedes "explain the router placement refusals, 11 -> 53" in the session 8 and session 7
NEXT lists. Do not reopen it from those.

**What the code does.** `TierRouter:1449-1458`, the V8.44 no-strand epilogue: when a member
cycles out with re-entry ON and cannot fund it, the router calls
`matrixB.parkCycledOut(member, shortfall)` and THEN emits its own
`MemberParked(member, tier, "insufficient funds")`. `parkCycledOut` (MatrixLogicLib:1939)
emits the MATRIX `MemberParked` on its own line. **One underfunded cycle-out therefore
produces two differently-shaped events in one transaction**, and the harness was counting
them as two independent populations.

**Why that could not just be asserted.** Two branches break the pairing, and both matter:
`parkCycledOut` returns early if `parkedAt[member] > 0` (router event, no new queue entry),
and the call sits inside `try {} catch {}`, so a revert is SWALLOWED — router event, no park
anywhere, i.e. a member leaving with nothing holding them. That last case is exactly what the
epilogue's own comment ("NEVER a silent exit") claims is impossible. A count cannot tell the
three apart.

**Measured.** `test_ab/replay.js` now records the transaction hash of every parsed event (a
`WeakMap` keyed by the destination bucket, so the per-tick census bucket cannot contaminate
the cumulative one) and pairs each router event against a matrix park **in the same tx for
the same member** — `raw.parkRefusalPairing`. Seed 1, 288 members, MATRIX_SIZE 127, AB_CAP 5:

| | control v849b | V8.50 |
|---|---|---|
| router events | 12 | 59 |
| paired, same tx + same member | **12** | **59** |
| same tx, no matrix park | 0 | 0 |
| member never parked at all | **0** | **0** |

**Two conclusions, and only these two.**
1. `parkRefusalsRouter` is a MISLABEL. Every one of these sits on top of a park already
   counted in `parkEventsMatrix`. It is not an independent population and 11 -> 59 is not an
   anomaly — it is the share of parks arriving through the router epilogue rather than
   through the matrix's own park sites. The key keeps its name so sessions 6-9 results stay
   comparable; `raw.parkRefusalsRouterNote` now says this inside every result file.
2. **The no-strand epilogue holds.** Zero orphans on both arms is the all-clear on V8.44's
   central claim. If this number is ever non-zero it is a defect, not a metric.

⚠ ONE SEED, ONE SEQUENCE. The pairing is structural (it follows from the emit order) so a
second seed would be confirmation rather than discovery — but it has not been run, and
"12/12 and 59/59" is a statement about seed 1.

⚠ AND WHAT IS **NOT** CLOSED: the two arms differ on `insolvencyFloorBps` (3400 vs 5000) as
well as on build, so the CHANGE IN COMPOSITION of parking between them is confounded and is
not a finding. Only the pairing is.

### BIGFILL OUTPUT IS NOW ASCII-ONLY (owner request 2026-08-19)
Run logs were mangling dashes and arrows. Two causes, both fixed:
`scripts/bigfill_v8.js` had 171 non-ASCII characters in code and string literals — every one
that can reach the console is now ASCII (`-`, `->`, `!`, `...`, `ok`, `X`). **Comment banners
keep their box-drawing** — they never print, and flattening them would have made a 1,600-line
diff out of a cosmetic fix. The rewrite used a state machine over the file (code / line
comment / block comment / each quote type) rather than a blind replace, so nothing inside a
comment moved and no string was half-converted. Second, both `run_bigfill_rr.ps1` and
`run_bigfill_loop.ps1` now set `[Console]::OutputEncoding` and `$OutputEncoding` to UTF-8
before launching node: PowerShell 5.1 decodes a child process's stdout with the ANSI code
page otherwise, which is what produced the mojibake. That belt still matters for hardhat and
ethers messages, whose text we do not control. **Both .ps1 files are now pure ASCII (0
non-ASCII bytes)** — they have no BOM, and a non-ASCII byte in executable code broke a run on
2026-08-19.

**⚠ AND THE VERIFICATION OF THIS HAS ITS OWN TRAP.** `logs\bigfill_loop\*.log` are written
by `Tee-Object`, which on PowerShell 5.1 writes **UTF-16LE**. `Select-String` and
`Get-Content` decode it correctly; a byte-level `grep` does not, and returns "0 matches" for
every pattern — which reads exactly like "the log is clean". The first check run against the
ASCII fix came back 0 for that reason before it came back 0 for the right one. Decode the
file (or use `Select-String`) before believing any count taken from these logs. Confirmed
clean afterwards on positive evidence, not absence: the banner prints as 60 ASCII hyphens and
the header reads `bigfill_v8.js - 1 wallets - batch 1`. Note the self-rescue and CNOVA
buy-sweep lines were converted in source but had not printed yet in that run.

### STILL OPEN AT SESSION END
1. ~~The suite has still not been run~~ — **DONE**: 611 passing, committed and pushed as
   `e404d70` on `v8.1`. The ASCII + pairing work of the late session is a separate commit.
2. ~~`probe_sf_views.js`~~ — **DONE**: 8 of 10 views present on V8.48; `loanHeadroom` and
   `evictionGracePeriod` are the two absent ones, exactly as predicted, and the fallbacks in
   `diag_eviction_clock.js` and `index.html` are pointed at what answered.
3. T1.1 is now FULL on both halves (127/127). **Prediction to verify:** its MatB rotations
   should now graduate into T1.2's MatA via `chainNext`. If T1.2 stays empty, chase it.
4. Bigfill's batch line prints the ACTIVE pair's occupancy while the snapshot prints T1.1 —
   two different "T1" numbers in one output. Same class as the dashboard pill fixed with
   "Pair N of M". Cosmetic, but it has already caused confusion once.
5. `FUND_AMOUNT $11.00` is below the T2 ($25) upgrade fee, so members reach MatB and cannot
   climb — 6 wallets stuck on that in the last run. Raise it if you want the ladder exercised.

---

# ⬛ SESSION 8 STATE — 2026-08-19. READ AFTER SESSION 9, BEFORE SESSION 7.

**THE HEADLINE: THE ~10x EVICTIONS ARE EXPLAINED, REPLICATED 3/3, AND THEY ARE NOT A DEFECT.
They are three measured factors, and the largest of them is that V8.50 moves the parked
population out of MatA and into MatB. Session 7's open item 2 (the withdrawable variance) is
also CLOSED — the statistic was invalid, not the system. Nothing was deployed, no chain was
written to, `.env` line 69 is unchanged, and NO CONTRACT FILE WAS TOUCHED THIS SESSION.**

Changed: `test_ab/replay.js`, `test_ab/world.js`. That is the whole diff.

⛔ **OWNER FRAMING GIVEN THIS SESSION, 2026-08-19 — IT CHANGES WHAT IS A DEFECT.**
Recorded verbatim in substance because two sessions have now spent effort on the wrong bar:
- **Members are NOT meant to cross forever.** The bar is that they can get **one or two
  loans**, not that everyone crosses indefinitely.
- **Nobody can get stuck at the A→B crossing — everyone crosses on the reserve.**
- **Members are EXPECTED to take loans and to be evicted if they never invite anyone.**
So "V8.50 evicts 10x more" was never, on its own, a finding about a defect. The question is
only ever whether the eviction is the *designed* one.

---

## 1. THE INSTRUMENT — `AB_EVICT=1`, AND WHY IT IS NOT EVENT ARCHAEOLOGY

`ParkedMemberEvicted(matrix, member, totalWithdrawn)` carries **no reason**. The reason is
`_triageParked`'s `uint8` — an internal return inside a view library. Never emitted, never
stored, never in a log. An event-only instrument can count evictions forever and never say
why one happened. So this reads two other things:

1. **THE DECISION ITSELF, FOR FREE.** `checkUpkeep` returns `performData =
   abi.encode(WorkItem[])`, `WorkItem` is `(uint8 workType, uint8 tierIndex, address addr1,
   address addr2)` (field order declared load-bearing at MatrixKeeperLib:175), and the
   replay already holds that blob. Decoding costs ZERO chain calls and gives the exact
   routing: who went to `WORK_EVICT_PARKED` (6) and who to `WORK_PARKED_RESCUE` (4).
2. **THE BRANCH**, re-walked off-chain from the same public views the contract used. The
   ladder walk is **not re-implemented** — it is asked of the deployed
   `MatrixKeeperLib.rescueBpsFor`, which is `external pure` on BOTH arms. Only the ORDER of
   the four tests is JavaScript.

**IT RECONCILES ITSELF, IN THE FILE, EVERY RUN.** Routed to EVICT ⇒ derived reason ≠ NONE;
routed to RESCUE ⇒ reason == NONE. Disagreements land in `mismatches`, and a non-empty list
**VOIDS the entire reason column** — it does not mean "mostly right". Measured:
**`mismatchCount` 0 on every run this session** (429 routed items on the first six alone).

**THE ONE PLACE THE ARMS DIFFER IS MEASURED, NOT ASSUMED.** The price basis is the whole of
item A inside this function (v849b `fee`; V8.50 `isMatrixA ? fee/2 : fee`). Hard-coding
"this arm uses that one" would smuggle a hypothesis into the instrument, so BOTH bases are
scored against the contract's actual routing every run. Result: control reconciles on ENTRY
FEE, V8.50 on CROSSING COST. **Item A confirmed live inside discovery by reading, not by
assuming from the arm name.**

**AND IT HAS A BLIND SPOT, STATED SO IT IS NOT READ INTO.** Discovery reaches queue indices
0-2 while the queue behind runs 26-31 deep, so batch rows describe the HEAD only. Hence
`AB_QUEUE_EVERY` (default 5): every Nth tick it triages the ENTIRE parked queue of both
matrices, including members discovery never looked at. Those rows are **member-tick
observations of a sampled queue** — not members, not events. Never quote a raw count from
`population`; quote the shares and medians.

---

## 2. THE ~10x EVICTIONS — THREE FACTORS, ALL REPLICATED 3/3

### FACTOR 1 (LARGEST) — WHERE MEMBERS PARK

| parked queue, sampled | v849b (s1/s2/s3) | V8.50 (s1/s2/s3) |
|---|---|---|
| share of queue in MatB | .23 / .20 / .19 | **.95 / .96 / .97** |
| MatA observations evictable | **0** of 81 / 83 / 88 | **0** of 4 / 3 / 2 |
| MatB observations evictable | 5/24, 4/21, 4/21 | 18/72, 20/74, 21/75 |

**A PARKED MatA MEMBER WAS NEVER EVICTABLE, IN EITHER BUILD, IN 258 OBSERVATIONS.** All
eviction risk in this system lives in MatB. The control's queue is three-quarters MatA;
V8.50's is almost entirely MatB. ~4.5x on its own. **This also confirms the owner's
statement that nobody gets stuck at the A→B crossing** — median MatA reserve $5.00, median
wBps 10500 against a ladder whose bottom rung is 4000.

### FACTOR 2 — WHETHER DISCOVERY REACHES PARKED WORK (defect 6)

- **v849b: 25-26% of ticks with a NON-EMPTY parked queue produced ZERO parked work items**,
  all three seeds. The batch was full of VELOCITY + GHOST + RECLAIM. ~390 member-ticks per
  run went unscanned.
- **V8.50: 0%. All three seeds.**

⛔ **CORRECTION — SESSION 6'S GUESS WAS RIGHT AND SESSION 8 CALLED IT WRONG FIRST.** On seed
1 this session wrote "session 6's starvation guess does not survive", on the basis that
evicted and rescued members had identical queue positions (median 1, range 0-2). **That was
the wrong test.** Queue position INSIDE a batch that was reached cannot see a batch that was
never reached at all. Measured properly, defect 6's reordering is a real contributor, worth
~1.35x. The UNVERIFIED session-6 hypothesis is now VERIFIED.

### FACTOR 3 — THE RESERVE, VIA ONE THRESHOLD IDENTICAL ON BOTH ARMS

A member fails the floor when effective contribution < **$6.60** (price $10.00 − the $3.40
ceiling at PARAM 59 = 3400). The census lands on it exactly:

- v849b MatB — rescuable ≥ $6.65, floor-refused ≤ $6.02
- V8.50 MatB — rescuable ≥ $6.61, floor-refused ≤ $6.40

**Same rule, same place.** The difference is that a control MatB parker gets **$5.00 of that
$6.60 free** from the crossing-reserve carve (`reserveZeroShare` 0.00, all seeds), while
**every V8.50 MatB parker holds zero reserve** (1.00, all seeds, 221 observations). ~1.35x.

⛔ **$6.60 IS NOT A NEW NUMBER.** The phase-6 section already measured it on live V8.48
(2026-08-17, n=70, min = median = max = $6.60). This session reproduced the same boundary in
a fresh LOCAL fixture, different population, different build. **Two independent instruments
to the cent.** The evictions are not a new phenomenon — they are the known PARAM 59 /
MatB-ledger problem surfacing as evictions because V8.50's queue is 96% MatB.

**The three factors multiply to ~8x against an observed ~10x. THAT MULTIPLICATION IS
ARITHMETIC OVER MEASURED FACTORS, NOT AN INDEPENDENT MEASUREMENT** — independence was never
tested. Do not quote "8x" as a result.

---

## 3. ✅ OPEN ITEM 2 CLOSED — THE WITHDRAWABLE VARIANCE WAS AN INVALID STATISTIC

| | rescued MatA / MatB | pooled `atRescue` median |
|---|---|---|
| v849b | 88/0, 84/0, 86/0 — **100% MatA** | $3.73 / $3.75 / $3.72 |
| V8.50 | 19/28, 23/24, 23/23 — **40% / 49% / 50% MatA** | $7.43 / $4.45 / $2.15 |

The parked population holds two clusters that do not overlap: a MatA parker sits at **$0.25**
withdrawable (their money is in the crossing reserve), a MatB parker at **$7.38-$7.66**
(carried balance, no reserve). **The MatB medians are TIGHTER across seeds than the
control's.**

The control rescues one cluster only, so its median is steady. V8.50 rescues a near-50/50
mixture, so the 50th percentile lands wherever the mix falls and **flips between humps**.
The "3.5x spread straddling the control" is a pooled median of a bimodal distribution taken
exactly where the two humps are equal. **It describes no member in either hump and is not
evidence about member support in any direction.** Session 7 was right to refuse to write it
up.

`withdrawableUSD.atRescue` now carries a `WARNING` field and `atRescueByMatrix` beside it.
**Never quote the pooled figure on the V8.50 arm again.**

---

## 4. ✅ ITEM E1 IS FIRING — CONFIRMED, NOT ASSUMED

The handoff records E1's effect as "MatB ledger at the gate $7.66 → $8.32". This harness's
V8.50 arm measures the MatB parked median at **$7.66** — the PRE-E1 figure, to the cent. Two
numbers disagreeing is a finding, so it was measured rather than explained:
**`balanceCarried` 201 / 198 / 198 events, $913.10 / $909.99 / $904.80 carried.** E1 fires.
The $7.66 match was two different bases landing on the same number (live V8.48 population vs
this fixture). Counter is permanent in `raw`.

---

## 5. ⛔ THE PARAM 59 CURVE — MEASURED, 5 VALUES × 3 SEEDS, V8.50 ARM

| PARAM 59 | evictions | FLOOR | LADDER | **evicted having NEVER been lent to** | rescues | loanVol $ | SF end $ |
|---|---|---|---|---|---|---|---|
| 3400 | 9/10/10 | 7/6/5 | 2/4/5 | **9/9/9** | 47/47/45 | 40.02/38.98/47.29 | 96.54/97.82/88.80 |
| 4000 | 4/3/7 | 1/0/2 | 3/3/5 | 3/3/6 | 51/53/48 | 58.66/47.35/57.29 | 80.04/91.83/81.17 |
| **4500** | 4/3/5 | **0/0/0** | 4/3/5 | **3/3/3** | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 5000 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 6800 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |
| 10000 | 4/3/5 | 0/0/0 | 4/3/5 | 3/3/3 | 51/53/50 | 58.15/47.35/63.36 | 80.55/91.83/77.25 |

**THE CURVE SATURATES AT 4500. The `raw` block at 4500, 5000, 6800 and 10000 is BYTE-IDENTICAL
on all three seeds.** Above 4500 the floor does not bind at all. This is why the sweep was
run rather than argued: an earlier turn this session asserted from headroom arithmetic that
higher ceilings would keep helping. They do nothing.

⛔ **BUT 4500 IS TWO CENTS SHORT, AND ONLY THE POPULATION CENSUS SEES IT.** Across the 3400
runs the observed FLOOR ask (`advance`) ranges **$3.42 to $4.52**, n=55. A $4.50 ceiling is
**−$0.02 against the worst observed ask**; it measures identically to 6800 only because that
one member was never routed. **$5.00 gives $0.48 of margin at ZERO measured cost.** The ask
is structurally `crossingCost − effectiveContrib`, so a thinner population asks more.
**RECOMMENDATION: 5000, not 4500** — same measured outcome, real margin instead of a
rounding error. ⚠ OWNER DECISION STILL OPEN as of session end.

⛔ **AND THIS REVERSES THE PHASE-6 REVERSAL — CORRECTLY, BECAUSE E1 CHANGED THE INPUT.** The
phase-6 section measured **5000 as rescuing ZERO members** and said "DO NOT DEPLOY 5000".
That was **before E1**, when a MatB parker reached the gate holding $3.40 and asked $6.60.
Post-E1 they hold $7.4-7.7 and ask $3.42-$4.52. **The earlier reversal was right on the
evidence it had; E1 is what makes 5000 viable.** Do not read the phase-6 section as still
binding without carrying E1 with it.

**What 5000 costs and what it does NOT cost:** ~$11-16 of ending fund balance (SF ends
$77-92 vs $89-98), still **4-6x the control's $13-25**. `loansPerRescue` stays ~0.5 and
`unfundedRescueShare` ~0.39-0.51. **Item A's fund claims are untouched by the change.**

---

## 6. ✅ LOANS PER MEMBER — THE OWNER'S ACTUAL BAR, AND A THIRD ANSWER

Two independent views, reconciled every run: `RescueLoanIssued` (MatrixLogicLib) and
`MemberDebtIncreased` (StabilityFund, one writer). **They agreed on count AND on borrower
set in every run.**

- **159 loans across six runs, 159 distinct members, `max 1`. Not one second loan, at ANY
  ceiling value.**
- **7 / 11 / 10 members per run ARE rescued a second time** (`maxRescuesToOneMember` 2).
- Rescued-from-MatA (20/27/23) ≈ fund-free rescues (20/27/22).

⛔ **SO THE SECOND LOAN IS NEITHER REFUSED NOR UNREQUESTED — THE SECOND RESCUE IS FREE.**
Session 8 asserted "refused" (headroom arithmetic — killed by the 10000 row) and then
"never requested" (killed by the rescue counter). Both were wrong. The cycle:
- **MatB re-entry** — full fee, no reserve, needs the fund → **one loan.**
- **A→B crossing** — the reserve covers it → **free, no loan, no debt.**

That is item A's headline claim measured within-arm, exactly as `replay.js`'s own header says
it must be. **Against the owner's bar, a member takes one loan and then crosses on their own
money.** The "two" never arises because the second crossing was already paid for.

⚠ **FIXTURE LIMIT ON THAT CONCLUSION:** `SELF_RESCUE_RATE = 0`, one tier, one pair, 69 ticks,
288 members. Section 8 has called this a pathological extreme since before session 6.

---

## TRAPS ADDED THIS SESSION

- **ARITHMETIC OVER MEASURED NUMBERS IS NOT A MEASUREMENT.** Twice this session a correct
  input produced a confident wrong mechanism: "the floor refuses the second loan" (the 10000
  row disproved it — nothing changed) and "the second loan is never requested" (the rescue
  counter disproved it — 7-11 members ARE rescued twice). Both READ like results. Rule 2
  covers derivations from measured values, not just guesses.
- **TESTING THE WRONG SLICE LOOKS LIKE A REFUTATION.** Queue position *inside* reached
  batches said starvation was not happening. It cannot see a batch that was never reached.
  Before writing "X does not survive", check that the instrument can observe X's absence.
- **A POOLED MEDIAN OVER A BIMODAL POPULATION DESCRIBES NOBODY.** V8.50's rescued members
  are two non-overlapping clusters ($0.25 and ~$7.5). At a ~50/50 mix the median flips
  between humps and reads as 3.5x "variance". Split by population before quoting a median.
- **THE BATCH IS NOT THE POPULATION.** Discovery reached indices 0-2 of a 31-deep queue, and
  the CONTROL'S ENTIRE MatB COHORT — the one the comparison turns on — was never routed at
  all. A head-of-queue instrument has zero observations of it and will not say so.
- **A RE-RUN THAT SHARES AN OUTPUT FILENAME DESTROYS THE EARLIER RESULT.** A run with
  `AB_QUEUE_EVERY=0` silently overwrote a censused file and lost one seed's population
  block. Every dial that changes the answer is now in the filename (`_nopop`, `_floor<n>`).
- **A DIAL SET IS NOT A DIAL IN FORCE.** `insolvencyFloorBps` is read BACK into `dials` on
  every run. Same lesson as the cap, restated because the sweep would be void without it.
- **THE CONSOLE MUST BE LEGIBLE OR IT IS NOT READ.** The full AB_EVICT result is ~1,500
  lines. Console now prints a summary; the file keeps everything. Complement to "diagnostics
  go in the RESULT FILE", not a contradiction of it.

---

## STATE OF THE TREE

- **NO CONTRACT FILE CHANGED.** Suite untouched at 611 passing / 7 pending / 0 failing (not
  re-run this session — nothing it covers moved).
- **Committed and pushed as `51c57fd` on `v8.1`** — three explicit paths: `test_ab/replay.js`,
  `test_ab/world.js`, `V8_50_HANDOFF.md`. (Hash added in a follow-up commit; it did not exist
  when this section was written, and amending a pushed commit is worse than the gap.)
- `test_ab/replay.js` — `AB_EVICT`, `AB_QUEUE_EVERY`, `AB_FLOOR_BPS` plumbing, loans and
  rescues per member, per-matrix rescue medians, slim console, dial-encoded filenames.
- `test_ab/world.js` — returns the already-deployed `keeperLib`; optional
  `setInsolvencyFloorBps` from `AB_FLOOR_BPS`. No extra deployment, no extra transaction.
- Result files: `ab_result_v850_s{1,2,3}_census_evict[_floor{4000,4500,5000,6800,10000}].json`
  plus the v849b censused trio. The canonical no-census pair is untouched.

---

## NEXT, IN ORDER

1. **OWNER DECISION — PARAM 59.** Curve above; recommendation 5000. Nothing else in the
   release is blocked on it.
2. **⚠ OWNER QUESTION RAISED AT SESSION END, NOT YET ANSWERED — WHAT TO DO WITH LIVE V8.48:
   leave organic, bigfill to replenish the SF, or fund the SF directly.** Reasoning is in
   the session-8 write-up below this list. **The figures it would rest on ($212.35 balance,
   $518.24 outstanding, ~$125/day drain) ARE DAYS OLD AND ITEM 7 BELOW SAYS THEY ARE IN
   TENSION.** Re-measure before deciding.
3. **Router placement refusals, 11 → 53** on V8.50. Still unexplained. Untouched this
   session. Note they rose further under the floor sweep (57 → 59 at 6800), which is a clue
   that they track rescue throughput rather than being independent.
4. **Model self-rescue at a non-zero rate.** Now blocking more than before: sections 2, 5 and
   6 above all carry `SELF_RESCUE_RATE = 0` as their headline caveat.
5. **Gate measurements 3 and 4** — need a running system; that is what the private chain is for.
6. **`maxItemsPerUpkeep`** — still vestigial at 20. Confirm deliberately or lower to 10.
7. **Re-run `diag_parked_growth.js` with `WINDOW=3000`.** Unchanged from session 7 and now
   also a prerequisite for item 2.

---

# ⬛ SESSION 7 STATE — 2026-08-18. READ AFTER SESSION 8, BEFORE SESSION 6.

**THE HEADLINE: SESSION 6'S ONE RESULT THAT "CONTRADICTS THE SCOPE" WAS AN INSTRUMENT
ARTIFACT. IT IS WITHDRAWN. Corrected and replicated 3 of 3 seeds: V8.50 CUTS TOTAL PARKING
BY ~42% AND HALVES DISTINCT EXPOSURE. Do not quote session 6's park table again — it is
struck through below.**

Also: the 68 VELOCITY `WorkItemFailed` are explained, fixed and gone (68 -> 0). Suite
606 -> 611 passing / 7 pending / 0 failing. Both pre-session-6 loose ends closed. Nothing
deployed, no chain written to, `.env` line 69 unchanged.

Commits: `8c60b64` (velocity), `e9d32b1` (diag_parked_growth), plus this session's harness
commit. Pushed to `v8.1`.

## ⛔ 1. THE 68 VELOCITY FAILURES — CAUSE FOUND, FIXED, CONFIRMED END TO END

`MatrixKeeper._setStabilityLayers` called `activateLayer(uint8,bool)` on the StabilityFund.
**That function was declared in `IStabilityFundKeeper` and implemented nowhere.**
`git log -S activateLayer -- contracts/StabilityFund.sol` returns **zero commits** — the
fund has never had it, in any version, since `a06aad4 V8.1 Elevator` introduced the caller.
The fund's layer model is 1, 3 and 5 (`receiveLayer` requires exactly those). Layers 2 and 4
do not exist in it. It was a call into a design V8.7 removed.

Measured (`test_ab/diag_velocity.js`, both arms, byte-identical): call 1 OK, calls 2-5
REVERTED "function selector was not recognized", `lastVelocityCheck` frozen from call 2,
`deflationState` never leaving NORMAL on any call.

**THE FAILED EVENT WAS NOT THE DAMAGE.** The revert discarded the whole of
`_doVelocityCheck`, including the `tierVelocityGreen` writes that run BEFORE the deflation
block. Harm band, per window: entries at/above `deflationThreshold` take the green branch and
pass; entries below `velocityThreshold` are correctly red anyway; **entries BETWEEN the two
mean the tier qualified for a green velocity gate and could not be given one.** That flag
throttles auto-upgrades and is read by index.html, status.html, gate_status.js, rr_keeper.js
and system_keeper.js.

Deleted rather than implemented: `deflationState` is read by NOTHING — no contract branches
on it, and there are zero hits for it, `DeflationStateChanged`, `activateLayer` or
`STATE_SLOW` across the frontend, keeper and mainnet repos.

**A/B re-run confirms it: V8.50 `workItemFailed` 68 -> 0, control unchanged at 68, and every
other figure byte-identical to session 6. Only `totalGas` moved, down 8,868,812.** So the
velocity bug was never confounding the park numbers — something else was.

⚠ **LIVE V8.48 STILL HAS THIS.** Caller since V8.1, implementation never. Every deployment
ever made carries it. Fixed for V8.50 only. Regression test: `test/V8_50_VelocityCheck.test.js`
(G5 is a tripwire that goes red if the fund ever gains an `activateLayer`).

## ⛔⛔ 2. THE PARK NUMBERS WERE WRONG. TWO DEFECTS, BOTH IN COUNTING, PULLING OPPOSITE WAYS.

**DEFECT A — TWO DIFFERENT EVENTS SHARE THE NAME `MemberParked`.**
`FigureEightMatrixV8.sol:98` — `MemberParked(address indexed member, uint256 shortfall)` —
a member ENTERING THE PARKED QUEUE.
`TierRouter.sol:372` — `MemberParked(address indexed member, uint8 tier, string reason)` —
TierRouter reporting it could NOT PLACE someone ("insufficient funds", "autoReentry
disabled"), emitted at :1458/:1496/:1499.

Different signatures, so different topic0, so the "first interface that parses wins" rule was
never violated — the damage was keying the bucket by `p.name`. Both landed in
`ev["MemberParked"]`. `args[0]` is `member` in both, so every per-member tally kept working,
silently, over a mixture. `args[1]` is `shortfall` in one and `tier` in the other, so
`shortfallVolume` was summing across both.

**DEFECT B — A QUEUE INSERTION THAT EMITS NO `MemberParked` AT ALL.**
`MatrixLogicLib:1516` (idle-slot reclaim) pushes to `parkedMembers` and emits
`SlotParkedIdle`, not `MemberParked`. The other six pushes (:527 :879 :906 :936 :977 :1937)
are each paired 1:1 with an emit on the next line, so the exact identity is:

> **queue insertions == MemberParked(matrix) + SlotParkedIdle**

Defect A inflated V8.50 (57 router refusals per run); defect B deflated the control (18-20
idle-slot parks per run). Opposite directions, different sizes per arm — which is the worst
possible shape, because it manufactures a difference between arms out of nothing.

### HOW IT WAS CAUGHT — THE QUEUE CENSUS, AND IT DISAGREED IMMEDIATELY

`test_ab/replay.js` now takes `AB_CENSUS=1`: it enumerates both matrices' parked arrays
before and after every keeper tick and diffs membership, so a member leaving the queue is
observed **whether or not anything was emitted**. Exits are attributed to a rescue or an
eviction only if a matching event fired in that same tick; everything else is recorded
SILENT rather than guessed.

First censused run: events said 139 park events / 71 distinct / 86% repeat. The census said
71 members, 71 episodes, **max 1 episode per member, ZERO re-parks.** Two instruments,
flatly opposed, same run. That contradiction was the whole finding — it was not explained,
it was measured.

⚠ It also refuted the guess this session STARTED with. Session 6's arithmetic gap
(139 - 47 - 9 = 83 expected vs 26 actual) looked like ~57 silent exits through the four
unemitting paths. **Measured `silentExitShare`: 0.0 on BOTH arms, all seeds.** The gap was
never exits. It was the park count itself. Predicting the answer before the instrument ran
would have sent the next session hunting a phantom.

### ✅ THE CORRECTED NUMBERS — 3 OF 3 SEEDS, `AB_CAP=5`, `MATRIX_SIZE` 127, 288 members

| | v849b (s1/s2/s3) | V8.50 (s1/s2/s3) |
|---|---|---|
| **queue insertions** | 142 / 140 / 142 | **82 / 82 / 80** |
| — of which idle-slot | 18 / 20 / 20 | **0 / 0 / 0** |
| router placement refusals | 12 / 11 / 11 | 57 / 51 / 51 |
| distinct parkers | 130 / 129 / 132 | **71 / 67 / 64** |
| repeat parkers (absolute) | 12 / 11 / 10 | 11 / 13 / 15 |
| repeat-park share | .092 / .085 / .076 | .155 / .194 / .234 |
| rescues | 88 / 84 / 86 | 47 / 47 / 45 |
| evictions | 1 / 1 / 0 | **9 / 10 / 10** |
| census episodes | 142 / 140 / 142 | 71 / 67 / 64 |
| censusMissed | **0 / 0 / 0** | 11 / 15 / 16 |

**READ IT THIS WAY:**

1. **Total parking is NOT unchanged. It falls ~42%** (141 avg -> 81 avg). Session 6's
   "~131 on both arms, every seed" was the artifact, and it was the entire basis for
   "V8.50 does not fix the loop".
2. **Distinct exposure halves** (130 avg -> 67 avg). That part session 6 had right.
3. **V8.50 eliminates idle-slot parking outright** — 18-20 per run on the control, ZERO on
   V8.50, all three seeds. Not previously noticed, and it is a real chunk of the reduction.
4. **The repeat-park "inversion" is mostly a denominator effect.** The ABSOLUTE number of
   repeat parkers is ~11 on the control and ~13 on V8.50 — the same handful of members. The
   SHARE rises from 8.4% to 19.4% because the base halved. That is a far weaker claim than
   "10% vs 86%", and it does not support "V8.50 concentrates parking onto repeat members".
5. **The census/event reconciliation is now printed every run.** Control reconciles EXACTLY
   (censusMissed 0). V8.50's gap of 11-16 is members who park and are rescued inside a single
   `performUpkeep`, invisible between snapshots — a lower-bound artifact of the census, and it
   tracks the repeat-parker count as it should. A NEGATIVE gap would mean an undiscovered
   insertion path; treat it as a stop-work signal.

### WHAT STILL STANDS, AND WHAT IS NOW OPEN

- **The fund claims are untouched** — loans per rescue, loan volume, SF balance, all
  unchanged by this correction. Item A holds.
- **Evictions ~10x, replicated 3/3 (9/10/10 vs 1/1/0), STILL UNEXPLAINED.** This is now the
  only surviving anomaly from session 6's list and it is the next thing to measure.
- ⛔ **`withdrawableOf` at rescue DOES NOT REPLICATE, and the failure to replicate is itself
  the observation.** Control: **$3.73 / $3.75 / $3.72** — remarkably tight. V8.50:
  **$7.43 / $4.45 / $2.15** — a 3.5x spread across seeds, straddling the control.
  Seed 1 alone would have read as "V8.50 rescues members with twice the support", which is
  the tidy refutation of session 6's UNVERIFIED hypothesis and was nearly written up as one.
  **It is not a result. Rule 5 caught it.** The variance itself needs explaining; sample
  sizes (29-36 vs 84-88) are smaller but not small enough to obviously account for it.
- **Router placement refusals jumped 11 -> 53** on V8.50. Unexplained, new, and it is the
  number that was polluting the park count — so it deserves a look on its own terms rather
  than as an accounting nuisance.

## TRAPS ADDED THIS SESSION

- **TWO CONTRACTS CAN DECLARE THE SAME EVENT NAME WITH DIFFERENT SIGNATURES, AND NOTHING
  WILL TELL YOU.** Bucketing parsed logs by `p.name` merges them. It is the sibling of the
  already-recorded double-count trap and it is harder to see, because the per-member
  accessors keep working. Key by name PLUS arity, or by topic0.
- **A NUMBER THAT LOOKS LIKE AN ANSWER, TWICE, FROM THE SAME BAD SOURCE.** Session 6 read
  139 park events on V8.50 and 136 on the control and concluded "unchanged". Both were wrong,
  by different amounts, and their agreeing was the artifact — two contaminated numbers that
  happen to be close read as a robust null result.
- **A DECLARED-BUT-UNIMPLEMENTED INTERFACE FUNCTION IS NOT A COMPILE ERROR.** Solidity
  compiles it and it fails at the one moment the branch is reached. `activateLayer` survived
  from V8.1 to now this way.
- **CHECK EVERY WRITER OF A QUEUE, NOT EVERY EMITTER OF AN EVENT.** `grep "push"` on the
  array found the seventh insertion path in one command; no amount of event archaeology would
  have. Same lesson as `diag_parked_growth.js` this session — count the state change, not the
  announcement of it.
- **THE INSTRUMENT MUST PRINT ITS OWN RECONCILIATION.** The census and the event tally are
  now compared in the result file on every run. Session 6 had both numbers available and no
  line that put them side by side, so a 2x discrepancy sat in plain sight.
- **`Select-String` filters are fine when the full result also lands in a FILE.** Used
  deliberately this session for the seed 2/3 runs; the JSON was written regardless.

## LOOSE ENDS — BOTH CLOSED

- **`scripts/diag_parked_growth.js`** — the uncommitted change was a previous session's
  finished work: it added `ParkedRescued` (the keeper's rescue, emitted by MatrixKeeper not
  the matrix, and the DOMINANT exit) and `GhostDequeued` to the exit accounting. Verified all
  three of its assumptions against the contracts before committing, then RAN it: **cumulative
  net 108 vs live queue 106.** Section 6f's "212 against a live queue of 105" is explained and
  closed. Committed as `e9d32b1`, plus it now REFUSES to start without `ADDRESSES_FILE` rather
  than defaulting to the dead V8.47 addresses — that standing trap is closed too.
  ⚠ That run reported **9 failed ranges** ("event-derived numbers are FLOORS"), while the SF
  section reconciled EXACTLY against the contract counters. Those two statements are in
  tension. Re-run with `WINDOW=3000` before quoting its park figures.
- **Eight stray `.txt` captures** — moved to `archive/captures/`, not deleted. Root is clean;
  `git status` shows only that untracked folder.

## STATE OF THE TREE

- `contracts/MatrixKeeper.sol` — `_setStabilityLayers` and its two call sites deleted, header
  corrected, full write-up left where the function was. 21,377 bytes, 3,199 headroom.
- `contracts/MatrixKeeperLib.sol` — the dead `activateLayer` declaration removed.
- `test/V8_50_VelocityCheck.test.js` — NEW, G1-G5. Red before the fix for the right reason.
- `test_ab/diag_velocity.js` — NEW, the velocity instrument, runs on both arms in seconds.
- `test_ab/replay.js` — event-name collision fixed, `SlotParkedIdle` counted, `AB_CENSUS=1`
  per-member queue census, census/event reconciliation printed every run. **Verified
  UNPERTURBED: a no-census run reproduces the canonical result byte-for-byte ignoring wall
  clock.** Censused runs write to `*_census.json` so they cannot overwrite the canonical pair.
- `scripts/diag_parked_growth.js` — committed, plus the addresses-file guard.
- `ab_results_session6/` — session 6's original result files, preserved before any re-run.

## NEXT, IN ORDER

1. **Explain the ~10x evictions (9/10/10 vs 1/1/0).** The last surviving session-6 anomaly.
   The census already records every eviction with its member and tick; extend it to record
   WHY discovery routed them to `WORK_EVICT_PARKED` rather than `WORK_PARKED_RESCUE` —
   `loanEligible` false, deadline order, or queue position. Session 6's UNVERIFIED guess
   (defect 6's deadline ordering reaching starved eviction work) is still unmeasured.
2. **Explain the withdrawable-at-rescue variance** ($2.15-$7.43 across seeds against a
   control that sits at $3.73 +/- $0.02). Until this is understood, no claim about member
   "support at rescue" is safe in either direction.
3. **Explain the router placement refusals, 11 -> 53.**
4. **Model self-rescue at a non-zero rate.** `SELF_RESCUE_RATE = 0` is still the pathological
   extreme by construction, and section 8 has said so since before session 6.
5. **Gate measurements 3 and 4** — MatA parkers freed outright, E1 base coincidence. These
   genuinely need a running system; that is what the private chain is FOR.
6. **`maxItemsPerUpkeep`** — still vestigial at 20; the floor halts the batch first. Confirm
   deliberately or lower to 10 on GAS-7's measured curve.

---

# ⬛ SESSION 6 STATE — 2026-08-18, LATER. ⚠ ITS PARK/LOOP TABLE IS WITHDRAWN — SEE SESSION 7.

**GATE MEASUREMENTS 1 AND 2 ARE ANSWERED. `minGasPerItem` MOVED 3_500_000 -> 5_000_000 ON
MEASUREMENT. NOTHING IS DEPLOYED, NO CHAIN WAS TOUCHED, `.env` LINE 69 IS UNCHANGED.**

Files changed: `contracts/MatrixKeeper.sol` (the value + its write-up),
`contracts/V8Governance.sol` (param 63 docs), `test/V8_50_KeeperGas.test.js` (six new
instruments). **Suite 602 -> 606 passing / 7 pending / 0 failing**, run in full after the
change (`npx hardhat compile --force` first). That file went 6 tests -> 10.

## ⛔ THE v8.49b vs V8.50 A/B — RUN, REPLICATED 3 SEEDS, AND IT CONTRADICTS PART OF THE SCOPE

**Harness:** `test_ab/` — one deterministic sequence file replayed on BOTH arms.
`contracts_v849b/` is `git archive de27329` (the V8.49 private-deploy commit); a second
hardhat config (`hardhat.v849b.config.js`) builds it into `artifacts_v849b/` so the V8.50
tree cannot be perturbed. `git log de27329..HEAD -- contracts/` = SIX commits, all V8.50, so
the A/B isolates exactly the release: item A + B + E1 + defects 2,4,5,6,7,8,9.

**Conditions:** 288 members, `MATRIX_SIZE` 127, seeds 1/2/3, `AB_CAP=5` on BOTH arms, all
grace periods 0, single tier, single pair. Validity gate passed on all three: 289 registered
and 0 keeper failures on both arms.

### ✅ THE FUND CLAIMS HOLD — 3 of 3 SEEDS, SAME DIRECTION

| | v849b | V8.50 |
|---|---|---|
| loans per rescue | 0.98 / 1.00 / 0.99 | **0.57 / 0.48 / 0.50** |
| loan volume | $106.91 / $96.23 / $108.19 | **$40.02 / $36.01 / $45.06** |
| SF balance at end | $20.23 / $24.97 / $13.28 | **$96.54 / $99.12 / $90.31** |
| distinct members who ever parked | 112 / 109 / 112 | **71 / 65 / 62** |

**Half of all rescues stop touching the fund. Lending volume falls ~60%. The fund ends 4-6x
healthier. ~40% fewer members are ever exposed to parking at all.** That is item A, measured
against a running control rather than projected onto V8.48 data.

### ⛔⛔ WITHDRAWN 2026-08-18 BY SESSION 7 — EVERY NUMBER IN THIS SUBSECTION IS WRONG.
###
### The park counts below came from a bucket that merged TWO DIFFERENT EVENTS both named
### `MemberParked` (the matrix's queue insertion, and TierRouter's placement REFUSAL), while
### missing a third insertion path that emits `SlotParkedIdle` instead. The errors run in
### OPPOSITE directions on the two arms, so the difference between them was manufactured.
###
### Corrected and replicated 3/3 seeds: queue insertions 142/140/142 (control) vs 82/82/80
### (V8.50) — a ~42% REDUCTION, not "unchanged". Repeat-park share .092/.085/.076 vs
### .155/.194/.234 — and the ABSOLUTE repeat-parker count is ~11 vs ~13, i.e. the same
### handful of members over a halved base. See SESSION 7 at the top of this file.
###
### KEPT BELOW UNALTERED because the reasoning is the record of how it went wrong, and
### because the FUND table above it is unaffected and still holds. Do not quote this table.

### ~~AND THE LOOP CLAIM DOES NOT HOLD. DO NOT QUOTE THE SCOPE ON THIS.~~

**~~TOTAL PARK EVENTS ARE UNCHANGED~~** — ~131 on both arms, every seed. What changes is who
they land on:

| | v849b | V8.50 |
|---|---|---|
| park events | 136 / 131 / 133 | 139 / 128 / 128 |
| distinct parkers | 112 / 109 / 112 | 71 / 65 / 62 |
| parked MORE THAN ONCE | 12 / 11 / 11 | **61 / 54 / 55** |
| repeat-park share | 0.11 / 0.10 / 0.10 | **0.86 / 0.83 / 0.89** |
| evictions | 1 / 1 / 0 | **9 / 11 / 10** |
| rescues | 88 / 84 / 86 | 47 / 44 / 44 |

**V8.50 HALVES THE NUMBER OF MEMBERS WHO EVER PARK, AND THE ONES WHO DO PARK CYCLE.**
Session 5's problem statement for live V8.48 was "83.2% came back". V8.50 shows **86%** here.
On this evidence V8.50 does not fix the loop — it reduces exposure to it.

**AND V8.50 EVICTS ~10x MORE** (≈10 vs ≈1 per run). Members removed rather than helped. It
performs HALF as many rescues yet ends with HALF as many parked; the arithmetic only closes
via those evictions plus repeat-rescues of the same members.

### WHAT IS HYPOTHESIS HERE, MARKED AS SUCH

- **UNVERIFIED:** that the extra evictions are defect 6's deadline-ordered discovery finally
  reaching eviction work V8.49 starved. Plausible and tidy; not measured.
- **UNVERIFIED:** that item A's cheaper rescues return a member with less support, so they
  re-park sooner. This is the obvious story for the repeat-park inversion and it is exactly
  the kind of explanation that is easy to believe because it is neat. **Measure it before
  building on it** — the instrument would be per-member: time-to-re-park and withdrawable
  balance at the moment of rescue, by arm.

### FIXTURE LIMITS — READ BEFORE GENERALISING ANY OF THE ABOVE

- `WorkItemFailed` is **68 VELOCITY on every run, both arms, identical**. Non-confounding
  (identical across arms) but unexplained. Worth a look before this harness is trusted further.
- **NO SELF-RESCUE IS MODELLED.** Section 8 already says `SELF_RESCUE_RATE = 0` is a
  pathological extreme, not a population — real members top up and pay. This harness is that
  extreme by construction, so the repeat-park figures are an upper bound on churn.
- Single tier, single pair, grace periods 0, cap pinned to 5 on both arms.

### ⛔ WHY THE CAP HAD TO BE PINNED — A REAL V8.50 BENEFIT, FOUND BY ACCIDENT

The first 127 run came back VOID: the CONTROL failed 7-8 keeper ticks, V8.50 failed none.
v849b has **no gas floor**, so with `gasLimit` 16.7M it attempts all 15 items, runs out of
gas and the transaction REVERTS. That is defect 8's rationale reproducing itself as an
experimental artifact — and it means **the control cannot execute the same workload the
subject can**. Pinning both arms to cap 5 (measured to fit at 5.11M) made the pairs valid.

Worth keeping: a whole class of V8.50 benefit is invisible in the valid runs precisely
BECAUSE the cap had to be pinned to make the comparison fair.

### HARNESS TRAPS — ALL FOUND BY THE INSTRUMENT CONTRADICTING ITSELF

- **Library events are not in a contract's ABI.** `RescueLoanIssued`, `SelfRescue` and
  `CoPayRescue` are all emitted from `MatrixLogicLib` (:1611/:1660/:1665/:1756). Parsing with
  contract interfaces alone reported **`loans: 0` alongside 18 completed rescues** — which
  would have read as "item A removed ALL the lending", the exact headline under test. **A
  zero that flatters the hypothesis deserves more suspicion than one that does not.**
- **Parsing one log with five interfaces double-counts.** The first version pushed every
  successful parse, multiplying every count. Ratios would have survived it; raw totals would
  have been silently wrong. It surfaced only because a second bug crashed the run.
- **A test's own leftover state is not a fact about the contract.** Record dials by READING
  THEM BACK; an intent flag proves nothing. The seed-1 equalised pair came back byte-identical
  to the default pair and there was no way to tell "the cap did not matter" from "the setter
  never fired".
- **`Select-String` with a non-ASCII pattern silently matches nothing** against a console that
  mangles UTF-8. It hid every keeper-failure line. Diagnostics go in the RESULT FILE.
- **A VOID pair is not a seed.** `compare.js` printed "3 seeds ✅" directly beneath three VOID
  banners before that was fixed.

### NEXT ON THE A/B

1. **Explain the repeat-park inversion** — per-member time-to-re-park and withdrawable-at-rescue,
   by arm. This is the one result that contradicts the scope and it should not stay a story.
2. **Explain the 68 VELOCITY failures.**
3. **Model self-rescue** at a non-zero rate; the current figures are the pathological extreme.
4. Only then treat the loop numbers as anything more than directional.

---

## ⛔ THE OWNER DECISION — `minGasPerItem` 3.5M -> 5M, TAKEN 2026-08-18

**The basis:** a cold SF-funded rescue at the live `MATRIX_SIZE` 127 measures **4.37M**.
3.5M sat below it, so the floor's own invariant — "the floor must exceed the worst single
item" — was violated. 5M is the smallest DAO menu value that clears it (15% headroom).

**The throughput cost, MEASURED after the change, not projected:**

| | floor 3.5M | floor 5.0M |
|---|---|---|
| GAS-1 cap 20 at 127 | 9 items, 12.22M | **8 items, 10.81M** |
| GAS-8 halt points across 6M..16M budgets | 2/4/6/6/8/9 | **1/3/5/6/7/8** |

About ONE item per batch — cheaper than the ~2 rescues/tick projected when the decision was
put to the owner. Deferred work is not lost; the next tick takes it.

**Why not keep 3.5M:** no cascade could be reproduced under it (GAS-8, zero
`WorkItemFailed` across every budget), because of a COUPLING — walking gas down to the floor
requires running rescues, and running rescues warms the path. But that is an ARGUMENT, it
holds only WITHIN ONE TIER, and per defect 8 the failure does not announce itself. **Why not
7.5M:** it costs roughly half the rescue throughput for headroom nothing measured needs.

⚠ **The live keeper scripts still carry `GAS_PER_ITEM_DEFAULT = 3_500_000`**
(`direct_keeper.js:27`, `direct_keeper_vps.js:26`). LEFT ALONE DELIBERATELY — they run
against **live V8.48**, which has neither item A nor E1, and editing them is a live change
on the community chain. Revisit them with the V8.50 deploy, not before.

## THE METHOD CHANGE THAT MADE THIS POSSIBLE — READ FIRST

**`MATRIX_SIZE` IS A CONSTRUCTOR ARGUMENT, NOT A COMPILE-TIME CONSTANT.**
`FigureEightMatrixV8.sol:43` declares it `immutable`; `:167` assigns it from `_matrixSize`.
`V8_50_KeeperGas.test.js`'s `deployWorld(size)` ALREADY took it as a parameter — the only
thing pinning the whole file to 7 was one line, `const SIZE = 7`.

So **live-size gas is measurable in-process, with no deploy and no chain**, in ~15 seconds
per run. The gate was scoped as "private chain, bigfill, hours not days" because nobody had
noticed that. The private chain is still needed for gate measurements 3 and 4 — those need
a running system — but the number the gate was BUILT for did not need it.

`SIZE` and the population are now env knobs (`GAS_MATRIX_SIZE`, `GAS_POP`), **defaulting to
exactly the old fixture**, so the suite result is unmoved. Run the gate measurement with:

```powershell
$env:GAS_MATRIX_SIZE=127; npx hardhat test test/V8_50_KeeperGas.test.js
Remove-Item Env:\GAS_MATRIX_SIZE
```

## ⛔ GATE MEASUREMENT 1 — ANSWERED, AND IT IS NOT ONE NUMBER

**AN SF-FUNDED RESCUE HAS THREE DIFFERENT PRICES AT `MATRIX_SIZE` 127, AND WHICH ONE
APPLIES DEPENDS ENTIRELY ON WHERE IT SITS IN THE BATCH.** This is the single most important
thing in this section; every wrong turn below came from collapsing them into one figure.

| when it runs | cost | how it was measured |
|---|---|---|
| **item #1, all storage cold** | **4.37M** | GAS-2 isolated AND GAS-7 curve k=1 — two independent methods, agreeing to 0.1% |
| **first SF item mid-batch** (shared state warm, fund state cold) | **2.83M** | GAS-7, 2 self-funded first then +1 SF-funded |
| **fully warm, mid-batch** | **1.43M** | GAS-7 curve steps: 1.46 / 1.43 / 1.43 / 1.41 |

Self-funded (item A's shape): **2.38M cold, 0.84M marginal.**

`minGasPerItem = 3.50M` sits BETWEEN the mid-batch price and the cold price.

### THE SCALING NOBODY HAD EVER MEASURED

| | size 7 | size 31 | size 127 |
|---|---|---|---|
| worst SF-funded rescue (cold) | 1.76M | 2.16M | **4.37M** |
| self-funded (cold) | 0.93M | 1.24M | 2.38M |
| worst `register` | 2.00M | 2.62M | **7.50M** |
| SF ÷ self ratio | 1.61x | 1.72x | **1.83x** |

Roughly linear, ~23k gas per matrix position. **`_distributeChainPay` is why**
(`MatrixLogicLib:1317`): it walks the MATRIX POSITION tree (`parentPos = myPos / 2`), so
depth is set by `MATRIX_SIZE`. At 7 it reaches 2 levels; at 127 all 6 `CP_BPS` levels fire.

**ITEM A'S GAS DIVIDEND GROWS WITH MATRIX SIZE — 1.61x -> 1.72x -> 1.83x.** Item A is worth
more at live scale than any measurement before this showed.

## ⛔ GATE MEASUREMENT 2 — ANSWERED. THE GUARD WORKS.

`BatchGasHalted` fires at live matrix size, halts cleanly, and defers rather than drops.
Under the SHIPPED 3.50M floor, swept across six transaction budgets (GAS-8):

| budget | gasUsed | halted at | `WorkItemFailed` |
|---|---|---|---|
| 6M | 2.76M | 2/20 | **0** |
| 8M | 4.31M | 4/20 | **0** |
| 10M | 7.96M | 6/20 | **0** |
| 12M | 7.96M | 6/20 | **0** |
| 14M | 10.81M | 8/20 | **0** |
| 16M | 12.23M | 9/20 | **0** |

**ZERO items failed at any budget.** The floor halted first, every time.

### ✅ CLOSED BY MEASUREMENT — the 10M/12M rows were never an anomaly

Both halted at 6/20 with the same 7.96M `gasUsed`, but `gasRemaining` differs exactly as it
should: **1.43M at a 10M budget, 3.43M at 12M** — 2M apart, the budget difference. Overhead
is identical to the gas unit: `10.00 − 7.96 − 1.43 = 0.61M` and `12.00 − 7.96 − 3.43 = 0.61M`.

Both halted at the same item because both fell below the floor; the 12M case only *just*
did. **The refund hypothesis was unnecessary** — printing `gasRemaining` from the event made
the real answer obvious. Note how tight the guard runs at its boundary: **3.43M against a
3.50M floor is 70k of margin, and the 8M row halts at 3.48M — 20k under.**

## ⛔ THE FLOOR DECISION IS NOT YET SAFE TO TAKE — ONE MEASUREMENT SHORT

GAS-6 currently FAILS at 127: floor 3.50M vs worst item 4.37M. **That failure is honest and
it stays red until this is settled** — but the comparison may be the wrong one, and the
reason matters:

- The floor asks *"can I afford ONE MORE item?"*. It only ever answers for an item arriving
  **late**, when gas is scarce. At item #1 `gasleft` is the whole budget, ~15M, nowhere near
  any floor. **So the 4.37M cold price may be one the floor never has to cover.**
- Against the mid-batch price it actually covers — 2.83M — the 3.50M floor has 24% headroom,
  and GAS-8 measured zero failures across every budget.

**THE ONE THING THAT WOULD OVERTURN THAT: THIS FIXTURE HAS ONE TIER.** The cold premium is
paid by whichever item touches a given tier's storage FIRST. With one tier that is always
item #1, when gas is plentiful. **With two tiers, the first item touching tier 2 pays it
LATE, with gas scarce.** Decomposing the measured numbers: 4.37M cold − 2.83M first-touch =
~1.53M of shared/tier cold state. A cross-tier first touch mid-batch would plausibly cost
~2.83M + ~1.53M ≈ 4.36M, arriving when only ~3.5M remains.

**THAT IS A PROJECTION, MARKED UNVERIFIED. DO NOT SET THE FLOOR ON IT.** Live T2 exists
($25.00, per session 5), so multi-tier batches are reachable and this is not hypothetical.

### ⛔ GAS-9 — ARRIVAL CONTEXT SETTLES IT: THE INVARIANT IS GENUINELY VIOLATED

The 2.83M mid-batch figure was measured after a prefix of **self-funded rescues**, and a
self-funded rescue crosses A->B — it warms both matrices and most of the crossing path
before the SF item runs. That is a generous prefix and it flattered the floor.

Priced against three arrival contexts (GAS-9, `MATRIX_SIZE` 127):

| prefix | prefix gas | the SF rescue costs |
|---|---|---|
| item #1, nothing warm | — | **4.36M** |
| after 6 cheap items (evict/reclaim) | 0.37M | **4.31M** |
| after 2 self-funded rescues | 3.24M | 2.83M |

**CHEAP HOUSEKEEPING WARMS NOTHING THAT MATTERS.** An SF rescue after six evictions still
costs 4.31M — 99% of the full cold price. The smallest DAO menu value that clears it is
**5M**. So `minGasPerItem = 3.5M` does violate its stated invariant, and GAS-6 is right to
be red.

### ⚠ BUT A VIOLATED INVARIANT IS NOT A REACHABLE FAILURE — AND THAT DISTINCTION IS THE
### WHOLE ARGUMENT, SO DO NOT SKIP IT

For the cascade to actually fire, `gasleft` must be near the floor **at the moment a COLD
4.31M item starts**. In a SINGLE-TIER world those two cannot co-occur:

- burning ~12M of budget REQUIRES running rescues;
- running rescues WARMS the expensive path, after which the next one costs 1.43M;
- cheap items cost ~0.12M, so a cap-20 batch of nothing but evictions burns ~2.4M total —
  it can never walk gas down to the floor while leaving anything cold.

**GAS-8 measured exactly that: zero `WorkItemFailed` at every budget from 6M to 16M.**
The floor is currently saved by a COUPLING between "burning gas" and "warming state".

### ⛔ A SECOND TIER BREAKS THAT COUPLING. THAT IS NOW THE ONLY QUESTION LEFT.

Tier-1 rescues burn gas while **tier-2 storage stays cold**. That is the one shape where a
cold ~4.3M item can arrive with ~3.5M remaining — and it is the shape a live multi-tier
chain produces naturally. Live T2 exists ($25.00, session 5), so this is not hypothetical.

**DO NOT SETTLE `minGasPerItem` UNTIL THIS IS MEASURED.** If the coupling holds, 3.5M ships
and GAS-6 gets rebased with the reasoning written at the point of the change. If it breaks,
the answer is 5M, and GAS-8's table is the tool for costing the throughput given up.

### ⛔ THE CHEAP SHORTCUT IS DEAD — A SECOND *PAIR* CANNOT BE REACHED BY A RESCUE

A second matrix PAIR in the same tier looked like a free stand-in for a second tier: different
contracts, therefore cold storage, reachable without the upgrade gate. **It is not reachable
at all.** `PairManagerV8.rescueReentry` (V8.48 item 10):

```solidity
uint256 destPair = fromPairIndex;          // a rescued member ALWAYS returns to their own MatA
if (isActiveInMatrix(member) ...) { destPair = _freePairFor(...); }   // duplicate guard only
```

The second-pair branch fires ONLY for a member already seated in that pair. A PARKED member
holds no seat, so `destPair` is always the pair they came from. GAS-10 measured exactly this:
**`matA2 0 -> 0, matB2 0 -> 0`, `pair2 seats 0` on every row.**

That routing is CORRECT and deliberate — it fixed a measured live loop (2026-08-09: 65% of
parked members sitting in MatB, MatA rotating 9.8x slower). Do not "fix" it.

**THE LESSON IS THE INSTRUMENT, NOT THE ROUTING.** GAS-10 v1 had no occupancy check and
printed **"NO CASCADE"** — a clean pass over an experiment that never once touched cold
storage. It also swept five budgets in ONE world (snapshots undo deployments), so each row
tested a more depleted world than the last: the 16M row, nominally the strongest, burned
0.59M and rescued NOBODY, and was counted as a pass. Two independent ways of reporting a
false negative in one test. It now reads matA2/matB2 occupancy, prints a `pair2 seats`
column per row, rebuilds a FRESH world per budget, and says INCONCLUSIVE rather than passing
when the cold pair was never touched.

### BUILDING THE TWO-TIER FIXTURE — WHAT IT COSTS, MEASURED BEFORE STARTING

`PairManagerV8.registerFor` is gated (`require(msg.sender == tierRouter)`, `:529`) and
`TierRouter._manualUpgrade` (`:922`) requires `_requireUpgradeEligible`. **The gate has an
open door**: `_upgradeEligible` (`:888`) returns true for any member ACTIVE IN A MatB of the
previous tier, and this fixture has ~127 of those — no cycles or unlocks needed.

**The real cost is POPULATION, not the gate.** Tier 1 needs its own ~254 members to fill and
produce parked work, against 300 accounts configured in `hardhat.config.js` of which 298 are
already spent. That means impersonated accounts inside the test (`impersonateAccount` +
`setBalance`) — test-local, no shared config change — plus ~250 more registrations.

**⚠ AND IT IS ONLY NEEDED IF 3.5M IS KEPT.** Setting the floor to 5M satisfies the invariant
against the measured 4.37M worst item regardless of how many tiers exist, which makes this
whole build unnecessary for the FLOOR decision. It would remain interesting for the CAP.

### THE NEXT MEASUREMENT, AND IT IS THE LAST ONE BEFORE THE FLOOR CAN BE CHOSEN

Build a **TWO-TIER** fixture in `V8_50_KeeperGas.test.js` and measure the cost of the first
item touching tier 2 mid-batch. Then:

- if it stays under 3.50M — the shipped floor holds, and GAS-6 should be REBASED onto the
  mid-batch price with the reasoning written at the point of the change;
- if it exceeds 3.50M — the floor moves. Menu is 2.5M / 3.5M / 5M / 7.5M (DAO param 63);
  5M clears the 4.37M cold price by 15%, 7.5M by 72%, and GAS-8's table is the tool for
  costing the throughput each choice gives up.

## THE CAP — `maxItemsPerUpkeep` 20 IS FINE, AND GAS-4'S MODEL WAS WRONG

GAS-4 projected a saturated batch as `worst single rescue x cap` and concluded NOTHING fits
at 127 — not even a cap of 5 (21.83M vs the 17.80M ceiling). **GAS-1 measured a batch
containing 8 rescues at 12.22M on the same world in the same run.** Both cannot be true.

The projection multiplies a COLD-START cost by every slot. Slots 2..n find warm storage.
GAS-7 now measures cold and marginal separately, and a saturated SF-funded batch costs
`4.36M + (n−1) × 1.43M`:

| cap | projected | |
|---|---|---|
| 5 | 10.10M | fits |
| 10 | 17.27M | fits |
| 15 | 24.44M | EXCEEDS |

GAS-4's hard assertion is **demoted to a report off-baseline** — failing on a model this
file has itself disproved is the definition of crying wolf. It still guards the original
claim at size 7.

## TWO CORRECTIONS TO THINGS PREVIOUSLY WRITTEN DOWN

1. **`MatrixKeeper.sol:236` says the V8.49 chain "measured ~2.6M for the same item at the
   live 127". It did not.** `testchain_keeper.js:285` records the provenance: *"cost per
   rescue rose from ~600k (15 items, 9.0M) to ~2.6M (5 items, 12.9M)"* — **2.6M was a BATCH
   PER-ITEM AVERAGE**, 12.9M ÷ 5, not an isolated item cost. The comparable V8.50 figure is
   12.22M ÷ 9 = **1.36M per item**, i.e. V8.50 batches are CHEAPER per item than V8.49.
   This session initially claimed the estimate was "68% low" by comparing it against the
   4.37M isolated cost — two unlike quantities. **Fix the comment when the floor is settled.**
2. **The 17.8M CEILING is an RPC limit, not a registry setting.**
   `V8_46_CascadeGas.test.js:57`: *"public Base Sepolia rejects above ~17.8M (-32003)"*.
   `system_keeper.js:582` sends overflow batches with `gasLimit: 15_000_000`.

## TRAPS ADDED THIS SESSION

- **The hardhat provider caps ONE transaction at 2^24 = 16,777,216 gas.** The original
  `16_000_000` register limit sits just under it. A 29M limit is refused outright.
  **It is below the 17.8M ceiling**, so an in-process run CANNOT observe a batch costing
  between 16.78M and 17.80M — the tx is refused and reports no gas at all. Unhandled, that
  refusal reads as "the item did not complete", identical to a floor refusal. That is defect
  8's failure mode inside the instrument built to detect it. Every catch in the gas file now
  identifies the cap error explicitly; capped batch rows report UNMEASURABLE, never zero.
- **A cost curve that mixes rescue KINDS produces a number describing no item that exists.**
  GAS-7's first version reported "cold 2.38M, marginal 1.47M" — the 2.38M was the
  *self-funded* median, because discovery happened to hand it self-funded items first. The
  giveaway was the step column: 0.86 / 0.83 / **2.83** / 1.43 / 1.42. Curves are per-kind now.
- **A TEST THAT MUTATES A CONTRACT VALUE MUST RESTORE BEFORE REPORTING IT.** GAS-9's first
  version set `minGasPerItem` to 2.5M so the guard could not interfere with its measurement,
  then read the value back afterwards and printed **"shipped floor 2.50M"** — its own
  leftover state, reported as a fact about the contract. It now `snap.restore()`s before
  reading. A wrong figure printed confidently into a captured artifact is worse than none.
- **A deep-referral fixture would have been WASTED WORK.** Chain pay walks matrix POSITION
  (`myPos / 2`), not the referral graph. Referral depth changes one L1 credit slot from warm
  to cold — tens of thousands of gas, not millions. One grep, not a fixture.

## STATE OF THE TREE

- `contracts/MatrixKeeper.sol` — `minGasPerItem` 3_500_000 -> **5_000_000**, plus the
  measured write-up and the ~2.6M provenance correction.
- `contracts/V8Governance.sol` — param 63 docs corrected; allowed-values array already
  contained 5_000_000, so no menu change was needed.
- `test/V8_50_KeeperGas.test.js` — size/population knobs (`GAS_MATRIX_SIZE`, `GAS_POP`),
  GAS-7 (per-kind cost curves + mid-batch first touch), GAS-8 (floor sufficiency sweep),
  GAS-9 (cost by arrival context), GAS-10 (cold-pair coupling test — INCONCLUSIVE by
  construction, see above), cap-error handling throughout, and `ok` / `halted` /
  `gasLeft@halt` / `pair2 seats` reporting. `LIVE_WORST_COLD_RESCUE = 4_366_374n` is the
  named basis for GAS-6's live check.
- **`GAS-8` reads the shipped floor FROM THE CONTRACT** rather than restating it — a
  hardcoded copy would have kept asserting the old value's sufficiency after the default
  moved, passing while measuring a floor nobody ships.
- Baseline at size 7 re-verified byte-identical after every edit: 1.23/4.52/4.67/4.72/4.90/
  4.90M, 0.93/1.49/1.76/0.10/0.04M, 1.61x, `9 of 20`, `6.47M left`.
- Captures: `gas_size7_baseline.txt`, `gas_size31.txt`, `gas_size127*.txt` (all UTF-8, not
  `Tee-Object`).

## NEXT, IN ORDER

1. **Gate measurements 3 and 4** — MatA parkers freed outright (PHASE 2 projects 67 of 67)
   and E1 making the aggregate and ledger bases coincide. These DO need a running system,
   so they are what the private chain is now FOR. Measurements 1 and 2 are done and the
   private chain no longer has to discover them.
2. **Re-run `model_item_a.js`** against the private V8.50 chain and re-check PARAM 59 and
   the ladder rung on a running system. Expected to hold — which is a hypothesis, so rule 2.
3. **Two-tier fixture — NO LONGER BLOCKING.** 5M clears the measured worst item whatever
   the tier count, so this is now a CAP question, not a floor question. Worth doing before
   `maxItemsPerUpkeep` is revisited; not worth delaying the deploy for.
4. **`maxItemsPerUpkeep` is unfinished business.** GAS-7's measured curve says a saturated
   SF-funded batch fits the 17.8M ceiling at cap 10 (17.27M) and EXCEEDS at 15 (24.44M).
   The shipped cap is 20. It has never bitten because the floor stops the batch first — but
   the cap is now doing nothing the floor does not already do better, and that should be
   either confirmed deliberately or the cap lowered to 10 on this measurement.

---

# ⬛ SESSION 5 STATE — 2026-08-18. READ THIS FIRST, BEFORE SESSION 4.

**V8.50 IS CODE-COMPLETE ON EVERYTHING FOUND SO FAR. NOTHING IS DEPLOYED. NO CHAIN WAS
TOUCHED. `.env` line 69 is unchanged.** Suite: **602 passing / 7 pending / 0 failing**
after `npx hardhat compile --force`. Branch `v8.1`, pushed.

## BUILT AND TESTED THIS SESSION

| item | what it is |
|---|---|
| **E1** | the crossing carries the member's balance across — closed the LEDGER SPLIT that stranded journey-A earnings where the re-entry gate could not see them |
| **defect 2** | deleted `DIRECT_EARN_BPS` (public, and wrong since V8.32) |
| **defect 4** | `totalEarnedOf` added; keeper deliberately NOT repointed — renamed to `claimableEver` |
| **defect 5** | `maxItemsPerUpkeep` 15 -> 20, measured not estimated |
| **defect 6** | discovery ordered by DEADLINE — parked work no longer starves behind ghost/reclaim |
| **defect 7** | the KeeperScan pins never collapsed anything; a 4th pin stops the batch truncating |
| **defect 8** | **the gas floor.** An OOG batch does NOT revert — it cascades WorkItemFailed and looks like a refusal |
| **defect 9** | `MemberEntered` fired for members who were PARKED, not seated |

## CLOSED BY MEASURING — NO CODE CHANGE

- **PARAM 59 stays 3400.** 5000 refuses the identical member. Replicated across 3 samples.
- **Ladder stays preset 1.** Nobody below the 4000 rung; presets 2/3 rescue 0 more.
- **Tier-gate recalibration: nothing to recalibrate.** Live T2 is $25.00; 0 of 38 upgrade
  at cycle-out in EITHER world. The acceleration was V8Elevator's fixture ladder.
- **Item D: does not occur.** 0 shallow seats in 1412 real seatings, 0 reclaims.

## THE OPERATIONAL FINDING THAT MATTERS MOST

**The self-sustaining loop is real, and the fund is underwater.** 773 park events across
339 members — only **57 parked once and stayed out**; 83.2% came back. SF outstanding
**$509.46** against a balance of **$192.99**, draining all session. **Item A removes
62-65% of ALL funding parks (~$724 of lending) and frees 67-75 of 67-75 MatA parkers
outright.** On these numbers V8.50 is not an improvement, it is the fix.

## OPEN — NOTHING BLOCKING

1. **Nothing is deployed.** The scope's plan is V8.50 -> private chain -> measure -> the
   one member-facing deploy the community re-registers into. Both owner decisions and the
   PHASE 7 tables are PROJECTIONS onto V8.48 data; **re-run the model after a private
   deploy before treating them as settled for a running system.**
2. **Four exit paths emit nothing** (`enterMatrix` re-entry, `forceCross`, `exitSeat`,
   `deductForUpgrade`). `diag_parked_growth`'s `net` is an upper bound; `getParkedCount`
   is exact. Not a defect — a documented limit.
3. **The ACCELERATING/LINEAR rate label is noise** at current precision (crossed its
   threshold by 0.2 parks/day). The loop conclusion rests on the repeat share and the
   climbing SF outstanding, not on that label.
4. **Four commit bodies have mangled dollar figures** (`fe3f594`, `da622c1`, `56140d3`,
   `2011eed`). Not rewritten; **this document is the record.** Use `git commit -F` — see 6g.

## ⛔ THE V8.50 DEPLOY GATE — DECIDED 2026-08-18

**The question asked:** ship V8.50 to the community and measure it live, simultaneously?
**The answer: no — private chain first, but a SHORT one with a closed list.**

### WHY NOT STRAIGHT TO THE COMMUNITY

The economics are measured to exhaustion and are NOT the risk. Item A frees 67 of 67 MatA
parkers, removes 62-65% of funding parks, and both owner decisions replicated across three
independent samples. **The risk is one number and one untested path:**

1. **EVERY GAS FIGURE WE HAVE IS `MATRIX_SIZE` 7. LIVE IS 127.** `minGasPerItem = 3.5M` is
   a SAFETY mechanism, and its only live-size input is a ~2.6M ESTIMATE carried from V8.49.
   Set it too low and the batch enters work it cannot finish — which, per defect 8, does
   **not revert loudly**. It degrades into a cascade of `WorkItemFailed` indistinguishable
   from a floor refusal. **A wrong value here hides itself.**
2. **Defect 9's code path has NO test coverage** — stated in the contract at
   `MatrixLogicLib:543`. No fixture builds a cascade that refills every seat.
3. **Defect 8's gas floor has never run on a real chain.**
4. **PHASE 7/8 are PROJECTIONS onto V8.48 data.** E1 is not deployed anywhere.

And re-registration is something you do to a community **once**. A private failure costs a
redeploy; a community failure costs the one member-facing event the scope has been
protecting since it was written.

### THE GATE — FOUR MEASUREMENTS, THEN SHIP

Private chain at **`MATRIX_SIZE` 127**, bigfill to force real rescues. Hours, not days.
The community stays on V8.48 throughout — that IS the "simultaneous", with the risk on our
side of the line.

| # | measure | against |
|---|---|---|
| 1 | gas per SF-funded rescue at 127 | 1.76M measured at size 7; ~2.6M assumed at 127 |
| 2 | `BatchGasHalted` fires, and at what batch size | `GAS-5` halted 9 of 20 at size 7 |
| 3 | MatA parkers freed outright | PHASE 2 projects 67 of 67, 100% |
| 4 | E1 makes aggregate and ledger bases coincide | PHASE 6 claims it "by construction" |

**If (1) lands above 3.5M, `minGasPerItem` is wrong and must move BEFORE the community
deploy.** That single number is the whole reason this gate exists.

**THEN re-run `model_item_a.js` against the private V8.50 chain** and re-check PARAM 59 and
the ladder rung on a RUNNING system rather than a projection. Both are expected to hold —
they held across three samples — but "expected to hold" is a hypothesis, and rule 2 applies.

### AND RUN THE FRONTEND ABI AUDIT BEFORE THE ADDRESSES CHANGE

`scripts/audit_frontend_abi.js` (new, read-only). Walks EVERY ABI fragment the frontend
declares and diffs it against the compiled V8.50 artifacts. Two failure modes:

- **MISSING** — the frontend calls something V8.50 does not have. Breaks on deploy. Loud.
- **SHAPE DRIFT** — selector matches, OUTPUTS differ. The call succeeds and decodes to the
  **wrong value**. Silent, and the reason this is a tool rather than a grep.

A 2026-08-18 spot-check of the eight surfaces V8.50 changes came back clean: the frontend
does not read `DIRECT_EARN_BPS` (deleted in defect 2), does not consume `MemberEntered`
(defect 9), and its crossing hold at `index.html:7509` (`ENTRY_FEE - crossingReserve`)
matches `MatrixLogicLib:715`, which holds the FULL fee under item A **deliberately** — it
is the savings lock for the re-entry, not the crossing price. **Reassuring, not conclusive.
Run the full differ.**

### ✅ THE DIFFER RAN — V8.50 PASSES. 7 findings, ZERO of them V8.50's.

241 fragments across 23 frontend files against 106 compiled contracts.

**Every finding predates V8.50 and none blocks the deploy:**

| finding | verdict |
|---|---|
| `getMember` x2 (SHAPE DRIFT) | **V8.50 never touched it** — the only `getMember` in the diff is `getMemberTotalWithdrawn`, a substring. The live site runs this exact contract TODAY. All fields static, so the frontend's 9 decode positionally correct against the contract's 10; it reads `crossingReserve` separately via `crossingReserveOf`. Works, and is tech debt not a break. |
| `topUpAndCross` | **REMOVED AT V8.32** (`1e28ae9`), four versions ago. `api/rescue.js:131` still CALLS it. **The admin rescue endpoint is dead and has been since V8.32.** |
| `hasEverJoined` | never existed as a function — it is a FIELD of the `getMember` tuple. Frontend error. |
| `usdcBalance`, `distributeInterval`, `getFloorPrice` | never present in `contracts/`. `CryptoNovaLP.sol` and `CNOVADirectSale.sol` both exist, so these are functions the frontend invented. |

**THE ANSWER TO THE QUESTION ASKED: nothing V8.50 changes breaks the frontend.** The eight
V8.50-changed surfaces are clean and the full differ confirms it across all 241 fragments.

**SEPARATELY, FIX WHEN CONVENIENT — these are broken NOW, on V8.48:** the dead
`/api/rescue` endpoint is the only one with teeth; the other four are declarations the
frontend never successfully calls.

### ⛔ AND THE DIFFER'S FIRST RUN WAS WRONG — WHICH IS WHY IT GOT FIXED BEFORE USE

It reported **23 problems**. Seventeen were noise:

- **Output comparison used `format("full")`, which includes the PARAMETER NAME.** So
  `returns (uint256)` vs `returns (uint256 locked)` — identical types — read as drift.
  ~15 false alarms. Now compares TYPES only (`sighash`).
- **It assumed every fragment the frontend declares is ours.** Multicall3's `aggregate3`
  was reported as "MISSING from V8.50", which is true and irrelevant. Now reported as
  EXTERNAL, against a deliberately tight allowlist.

**A tool that cries wolf gets skimmed, and a skimmed tool is worse than none.** The report
was NOT handed over at 23; the instrument was fixed first and re-run. 23 -> 7 -> 0 that
matter.

⚠ **THE DIFFER CHECKS THE INTERFACE, NOT THE MEANING.** A function can keep its exact
signature and change what its number MEANS — item A halved the crossing price without
touching a single selector. Semantic drift needs reading, and the crossing-hold check above
is the shape of that reading.

---

## READ NEXT, IN THIS ORDER

**7a (THE TWO RULES)** — owner-set, and the session that earned them got five things wrong
by ignoring what they say. Then 6f (the loop and the fund), then 6d (the two decisions).

---

# ⬛ SESSION 4 STATE — 2026-08-16, LATE. READ THIS FIRST, BEFORE SESSION 3.

Session 3's "NEXT, IN ORDER" list is DONE, items 1–3. Nothing below this section is
contradicted; two things are **extended** and one **sharpened**, each marked.

## WHAT SHIPPED — SIX TEST FILES RE-FIXTURED, NO CONTRACT CHANGED

**Not one line of `contracts/` was touched this session.** Every change is in `test/`.
That is the headline: the 9 new failures session 3 attributed to item A were all
fixtures encoding pre-item-A economics, exactly as it said, and none of them was a
defect in the item A code.

| file | was | now |
|---|---|---|
| `V8_48_SplitGrace.test.js` | 3 failing | 0 |
| `V8_48_GhostFloor.test.js` (GF-D1) | 1 of its 3 | 0 of that 1 |
| `V8_49_InsolvencyFloor.test.js` (IF-7, IF-10) | 2 failing | 0 |
| `V8_49_EvictionClock.test.js` (EC-1/2/4) | 3 failing | 0 |
| `V8_48_RescueSurplus.test.js` | 3 failing | 0 |
| `V8_48_KeeperScan.test.js` | 9 failing | 0, **plus one new test** |

## ⛔ EXTENSION 1 — STEP 1 WAS SIX TESTS. IT IS NINE, AND THEY ARE ONE BUG.

Session 3's step 1 named `SplitGrace ×3, GF-D1, IF-7, IF-10`. Its own effect-(a)
paragraph also lists **the floor legs of EC-1/EC-2/EC-4**, and the run confirms those
three fail for the identical reason and are fixed by the identical edit. The "6 of 9" in
that paragraph is a slip: the list under it has nine entries and all nine are effect (a).

**All nine have ONE root cause and ONE fix.** Every one of them builds its parked member
on the `MockKeeperScan` harness with `MockMatrixK(FEE, true)` — a **MatA**. Under item A
a MatA crossing costs the reserve carve, and every one of those fixtures gives the member
a $5.00 reserve, so all nine members became SELF-FUNDED, `sfShare` went to 0, and the
ladder, the floor and the loan-grace window all stopped being reachable. The failures say
so literally: `expected [ 4 ] to deeply equal [ 6 ]` — RESCUE where the test wanted EVICT.

**THE FIX, AND WHY IT PRESERVES EVERY NUMBER.** Each member moved to the pair's MatB —
`MockMatrixK(FEE, false)` — where a cycle-out re-enters a MatA at the FULL fee and the
loan path still exists. Their money moved with them: **withdrawable becomes the old
(withdrawable + reserve), reserve becomes 0**, because item A leaves a MatB member holding
no reserve; it was spent getting them there.

That substitution is exact. `effectiveContrib` is unchanged, the price basis is back to
the full fee, so **every wBps, every shortfall and every sfShare in all nine tests is the
same number it was before item A**. Not one assertion's expected value was edited. The
fixtures changed matrix and pocket; the rules under test did not move.

- ONE EXCEPTION, and it is the rule not an exception to it: EvictionClock's **RATIO**
  member keeps `withdrawable $2.00`. `rescueRatioBps` is `withdrawn/(withdrawn +
  withdrawable)` and never looked at the reserve — folding it in would have moved that
  member from 8000 bps to 5333 and quietly retired the case. Noted in the file.
- Flipping the B-half's flag does NOT admit the frozen-MatB scan into these batches:
  `_isFrozenMatB` returns on `occupancy() < MATRIX_SIZE()` and `MockMatrixK.occupancy` is
  always 0 (there is no setter). Checked in source before relying on it.

## ⛔ SHARPENING — THE POPULATION NUMBER IN SplitGrace WAS PRE-ITEM-A AND IS NOW RE-MEASURED

`"the 84% member — the live median"` was 50% reserve + ~34% earnings at an A->B crossing,
measured 2026-08-11. **Item A retired that member.** The population it represents moved to
the MatB re-entry, so the test was re-pointed at where that population now lives and
renamed **"the MEDIAN re-entry member"**: `$7.29` of a `$10.00` re-entry, from
`model_item_a.js` on live V8.48 (n=63, median ask **$2.71**). Every other fixture amount
in these files was checked against that same measured band — a member arrives at a $10
re-entry holding **$5.72 to $10.00** — and all of them sit inside it.

## ⛔ CORRECTION TO SESSION 3'S CHARACTERISATION OF THE CLIFF — IT IS THE FLOOR, NOT THE LADDER

Session 3: *"an early-MatB member reads ~3,400 bps against preset 1's bottom rung of 4,000
and falls off it."* **Reproduced, and it is one rung further along than that.** The two
members that actually diverge in `KeeperScan` read **4,120 and 4,875 bps** — both ABOVE
the 4,000 rung. They get a ladder rung; what kills them is what the rung then asks for.

Losing the carve does not change the ladder arithmetic, it changes the **shortfall**:
`$0.88 -> $5.13` for those two. That ask is then refused by the **insolvency floor**.
Same family, same cause, but the lever is PARAM 59 and not `sfRescueThresholds` — which
matters, because the two are different owner decisions and session 3 pointed at the
second one. The ladder can still bite a poorer member; it is not what bit here.

## THE KeeperScan DECISION — SCOPED, NOT RETIRED, AND THE DIVERGENCE IS NOW PINNED

Session 2 and 3 both said the byte-identical premise is *structurally* incompatible with
item A, because item A is not a parameter and `MatrixKeeperPrev` will never know about it.
**That reading was wrong, and the run says so.**

Item A reprices a crossing out of a **MatA**. Out of a MatB, `_crossingCost` returns the
full entry fee — the same number the frozen keeper uses. And under item A a MatA parker's
reserve covers their crossing outright, so **MatA parks nobody for funding and the whole
parked queue this fixture builds lives in the MatB.** Both keepers ask the same question
about the same members. Measured across every scenario in the file:

```
insolvencyFloorBps      0 -> 0 slots differ   (BYTE-IDENTICAL)
insolvencyFloorBps   1700 -> 2 slots differ
insolvencyFloorBps   2500 -> 2
insolvencyFloorBps   3400 -> 2      <- the shipping value
insolvencyFloorBps   5000 -> 2
insolvencyFloorBps   6800 -> 0      (BYTE-IDENTICAL)
insolvencyFloorBps  10000 -> 0      (BYTE-IDENTICAL)
```

**The divergence is one-shaped and lives in one governed parameter.** Every differing slot
is OLD=`PARKED_RESCUE`, NEW=`EVICT_PARKED`, a MatB member, reserve 0 — never the reverse.

So the decision, recorded with its reason as session 2 asked:

1. **`insolvencyFloorBps` is pinned to 0 in `deployBoth()`**, a THIRD pin alongside item
   12's `selfFundedGracePeriod` and item 1's `evictionGracePeriod`. It is the same move
   for the same reason and it obeys the file's own doctrine — *"every pin here is an item
   that DID [change behaviour]."* It hides no keeper difference: both keepers call the
   same `loanEligibleFor`, and this suite was green at the shipping 3400 before item A.
   It neutralises the one INPUT item A moved.
2. **The divergence is asserted, not swept away**, by a new test at the bottom of the
   file: at floor 0 byte-identical; at the shipping floor every flip is RESCUE->EVICT, in
   the MatB, on a member holding no reserve; at floor 10000 identical again — which is
   what proves the cause is the floor and not the ladder.

Net: the file covers MORE than it did. The extraction is still pinned byte-for-byte, and
the economic change now has a test that fails if it ever stops happening.

## RescueSurplus — THE QUEUE MOVED, AND THAT IS ITEM A'S THESIS REPRODUCED LOCALLY

*"Fixture produced no parked member"* was the right failure to see. Measured on this
fixture's own world (`world(7)`, 41 registrations), stepping the count as it grows:

```
regs=10   matA.parked 0   matB.parked 0
regs=20   matA.parked 0   matB.parked 7
regs=40   matA.parked 0   matB.parked 27     every one at wd $2.436 / rs $0.00
regs=70   matA.parked 0   matB.parked 57
```

**MatA parks NOBODY. Not one, at any population size.** The entire queue is the MatB
cycle-out. That is the whole V8.50 argument, reproduced in a local fixture in seven
seconds, and it is worth more than the three tests it was found while fixing.

The file now builds its member in MatB, and asserts MatA's emptiness explicitly rather
than ignoring it — if a funding park ever appears in a MatA again, item A has regressed
and that is the cheapest line in the suite to find it on.

**ONE NEW FIXTURE STEP, AND IT IS NOT A FUDGE.** A journey earns at most ~34% of a fee, so
the only way past 100% is referral income — the member must be a referrer, and their
downline keeps crossing into MatB paying them `l1Bps` each time. Left alone, the RESCUE
TRANSACTION ITSELF pays them another $0.95 mid-flight and the post-rescue balance reads
`surplus + $0.95`. The fixture now drains that first: register outside their downline
until their withdrawable stops moving, measured, not counted. Then the surplus assertion
is exact — **verified delta $0.000000**. The comment says in the file: do not replace this
with a tolerance; the drain is what keeps the assertion sharp.

**MUTATION-CHECKED.** `_selfRescue`'s `withdrawable = surplus` was flipped back to
`withdrawable = 0` — the original V8.48 defect — recompiled, and the REGRESSION test
fails. The re-fixtured test still catches the bug it was written for.

## TEST STATE — AND HOW IT WAS MEASURED, WHICH YOU NEED TO KNOW BEFORE TRUSTING IT

⚠️ **THESE NUMBERS COME FROM A SANDBOX REPRODUCTION OF THE REPO, NOT FROM THE OWNER'S
MACHINE.** Contracts + tests were copied into a clean Linux container with a fresh
`npm install` and solc 0.8.26 from npm. It is a faithful reproduction — it reproduced
every one of the 12 target failures with byte-identical assertion messages before the fix
— but it is NOT the owner's environment and it **drifts by about two tests**: it shows 7
`KeeperScan` failures where the owner's `test_v850_task1b.txt` recorded 9, and it does not
show `V8.46-B cascade gas` (the known inherited `TypeError`). **The owner's run is the
authoritative one. Treat the prediction below as a prediction.**

| | passing | failing |
|---|---|---|
| session 3, owner's machine (`test_v850_task1b.txt`) | 534 | 60 |
| session 4, sandbox, six files re-fixtured | **555** | **40** |
| session 4, sandbox, + the `V8Elevator` fc() guard | **567** | **28** |
| **OWNER'S MACHINE, MEASURED** (`test_v850_task2.txt`) | **574** | **21** |

**60 -> 21. Thirty-nine tests went green.** The prediction was ~568/~27 and was BEATEN, not
missed — the sandbox over-predicted the remainder by 6 because several `V8.35` factory
tests and `V8.46-B cascade gas` fail there and pass on the owner's machine. **Read that as
the sandbox being pessimistic, not as a surprise: every one of the 24 re-fixtured tests and
every test the `fc()` guard was meant to reach went green exactly as predicted.** The
KeeperScan PARAM 59 sweep printed identically on both machines, to the row.

Predicting the ASSERTION and not the test, per session 3's own method note: **33 failing
tests should go green and 1 new test should appear**, and no test that was passing should
start failing. If the owner's run lands anywhere else, the diff — not the total — is the
thing to read.

**THE 40 THAT REMAIN ARE NOT OURS TO FIX THIS SESSION.** Every one was already in session
2's 51: real-pair fixtures that encode a full-fee A->B crossing (`V8.35` factory ×10,
`V8.39` ×5, `V8.38` ×3, `V8.44` ×5, `V8Elevator` ×4, `V8.10` ×4, and so on), plus
`GhostFloor`'s GF-V1 and GF-V3. They are the same class of work as this session's, at
larger scale.

**GF-V3 is worth naming because it is the cleanest statement of the remaining work:**
`precondition: cycle-out park must keep the crossing reserve: expected 0 to equal 5000000`.
Its precondition is now false BY DESIGN. Item A is the reason, and the fixture is right to
say so loudly rather than adapting quietly.

# ✅ ITEM E1 IS BUILT — AND THE SUITE IS GREEN FOR THE FIRST TIME THIS RELEASE

**595 passing / 7 pending / 0 failing.** Session 4 opened at 60 failing.

## WHAT E1 IS

`MatrixLogicLib._crossToPartner`, at the very end and **after** the SF debt clawback: the
member's remaining withdrawable moves with them. `forceApprove` to the destination, then a
partner-only `creditCarriedBalance(member, amount)` on the far side — the same door
`addRescueDebt` has used since V8.28 (`FigureEightMatrixV8:629`), not a new one.

- **NOT routed through `_credit()`.** A transfer is not an earning. Crediting it would
  inflate the member struct's `totalEarned` — the field defect 4 exists to clean up — and
  double-count in anything summing `EarningsCredited`, `model_item_a.js` included.
- **Emits `BalanceCarried(member, from, to, amount)`** so the movement is visible. The
  crossing buffer's sin at `:1368` is moving money into `withdrawable` invisibly; this must
  not repeat it.
- **AFTER the clawback, deliberately.** Debt settles from this ledger first and only the
  remainder travels. Carrying first would move money out from under `:882-897`.
- **ONE DIRECTION ONLY.** My own design note said it had to be symmetric. Wrong: a member
  cycling out of MatB leaves their remainder in MatB, re-enters their OWN pair, and returns
  to that same contract — so it waits for them and the next gate already reads it.

**Measured effect:** MatB ledger at the gate $7.66 -> **$8.32**, gate-basis ask
$2.34 -> **$1.68**.

## THE VALIDATION THAT MATTERS

**E1 fixed all three remaining walk-through items with no fixture change at all** —
the 15-registration re-entry-priority test, `V8_44_Overflow` O1+O2, and `V8.35` G4. Those
were the three I could not resolve and had planned to re-state. **They were failing because
of the defect.** Fixing the root cause turned them green untouched. Nothing else in this
session came close to that as evidence.

## THE FIXTURES E1 THEN BROKE, AND WHAT THEY TAUGHT

E1 took the suite 3 -> 8 failing, every one the same shape: *"precondition: shortfall
cycle-out must PARK the root in MatB"*. The fixtures could no longer make a poor member.

**The cause was the same in three files, and it was a fixture lie of long standing.**
`driveW1IntoMatB`, `parkW1InMatB` and `seedAndParkW1` all referred **fifteen fillers to
W1**, handing the fixture's "underfunded" member $14.25 of L1 and making them the richest
wallet in the pair. It only ever read as underfunded because that money sat in the MatA
ledger where the gate could not see it. **The fixtures were relying on the defect.** They
now chain the referrals, so W1 is the passive no-referral member the precondition always
described.

**Two more corrections came out of `V8_48_RescueSurplus`, both mine:**

1. **"MatA must park nobody" was too strong.** E1 changes cascade timing, so the mid-cascade
   DEFERRAL park (`:906`) now fires — measured: 2 MatA parkers, both holding a reserve of
   exactly $5.00, the full crossing price. They are not stuck; a deferral park hands them to
   the standard machinery for a later transaction and bounds recursion depth. Item A's claim
   is about FUNDING, so the test now asserts funding: **no MatA parker may hold less than
   the crossing price.** Stronger than a count, and it survives future cascade changes.
2. **The settle loop was replaced by accounting.** A rescue re-seats the member, which
   cascades, which can pay them L1 in the SAME transaction. The old fix quiesced their
   downline first; E1 changed the timing and a credit slipped back in. It now SUMS
   `EarningsCredited` from the receipt — with two traps recorded in the file, because both
   produced confident wrong answers: the event must be parsed from an EXPLICIT interface
   (solc does not copy a library's events into the using contract's ABI, and parsing
   through `matB.interface` silently returned zero), and it must be FILTERED BY EMITTER
   (credits are per-ledger — a rescue pays $0.95 L1 on the matrix being left and $0.25
   direct-earn on the one being entered; counting both over-states by exactly the
   direct-earn, the same error as summing both halves in phase 5).

## ⚠️ CONTRACT SIZE IS NOW A LIVE CONSTRAINT ON THE REST OF V8.50

```
  MatrixPairFactory   24,444   headroom   132     <- embeds the matrix init code
  MatrixLogicLib      24,274   headroom   302
  TierRouter          23,910   headroom   666
```

E1 cost MatrixPairFactory 216 bytes and MatrixLogicLib 261. **Defect 4 wants to ADD a
getter to the matrix, which grows the factory again.** With everything landing in V8.50 and
nothing deferring, size has to be managed deliberately from here — budget it before writing,
and `node scripts\sizes.js` after every contract change, not just at the end.

## NEXT

1. **Re-run `scripts/model_item_a.js` phase 6.** It now measures a fixed system. PARAM 59
   should finally be chosen against a basis that is true — the expectation is that the ask
   returns toward the scope's ~$3.20 and 3400 clears the population, but that is a
   prediction and the script is the answer.
2. Defects 2 and 4, within the size budget above.
3. `maxItemsPerUpkeep` 15 -> 5 or 10.
4. Item D and the organic growth reading. (The tier-gate recalibration is CLOSED — PHASE 8 measured it as fixture-specific; live T2 is $25 and nobody upgrades at cycle-out in either world.)

# ⛔⛔ OWNER DIRECTIVE, 2026-08-17: NOTHING DEPLOYS, NOTHING DEFERS

> *"we fix everything, deploy nothing until we have a solid ground to stand on. also would
> like everything we find to be in v8.50, nothing deferred to 8.51"*

**This supersedes every "ship it / defer it" recommendation elsewhere in this document,
including my own from earlier today.** V8.50 is now a FIX-EVERYTHING release. No partial
deploy, no interim PARAM value chosen to unblock a deploy that is no longer happening.

**Practical consequence: PARAM 59 does not need an interim answer.** The 6800 recommendation
existed only to unblock a deploy. With the deploy held, the right sequence is: fix the
ledger split FIRST, then re-measure, then choose the floor against the fixed system. A
floor chosen against the broken basis would be a number nobody could defend later.

## THE REAL V8.50 SCOPE, AS IT NOW STANDS

**Contract work — money path**
- **E1. CARRY THE MEMBER'S BALANCE WHEN THEY CHANGE MATRIX.** The headline fix. See the
  design fork below. Everything else on this list is small by comparison.
- **E2.** Correct the conservation comment in `TierRouter.handleCycleOut` — it currently
  asserts an equality that does not hold at that gate and is the most authoritative-looking
  place anyone will read.
- **E3.** `_executeAdditive`'s re-entry/upgrade fall-through: independent `if`s, not
  `else`. Unreachable on the real ascending ladder ($10 -> $25 -> $50), so the CODE is
  safe; the doc comment claiming "re-enter or PARK" is not. Comment fix at minimum.
- **E4.** Revisit the MatA withdraw lock. Session 2 kept it at the FULL fee on the
  reasoning that "a MatA member WILL need it for the re-entry, and this lock is what
  accumulates it". **The lock accumulates money in MatA and the re-entry gate reads MatB.**
  The lock and the gate are on different ledgers — the same defect from another angle. If
  E1 lands, the lock's premise becomes true for the first time.
- **Defect 2.** `MatrixKeeper.DIRECT_EARN_BPS = 500` — dead, public, and wrong (real value
  250). Delete it.
- **Defect 4.** No getter exposes the true `totalEarned`; `MatrixKeeperLib:426`
  reconstructs it as `withdrawn + withdrawable`, which includes crossing-buffer money, and
  the keeper's withdraw-ratio EVICTION test runs on the contaminated figure.

**Parameters — all decided AFTER E1, not before**
- PARAM 59 `insolvencyFloorBps`. With E1 the ask returns to ~$3.20 and 3400 clears
  everyone; without it, 6800 is the floor. **Do not fix this number until E1 is settled.**
- `crossingBufferBps` -> 0. Already governed in V8.49; confirm in predeploy.
- `maxItemsPerUpkeep` 15 -> 5 or 10 (scope §6: gas per rescue rose 600k -> 2.6M; a full
  15-item batch projects ~39M against a ~17.8M ceiling).

**Tests — 3 red, and 2 of them wait on decisions**
- 15-registration re-entry priority (waits on E3)
- `V8_44_Overflow` O1+O2 (needs a rule re-stated, not a fixture moved)
- `V8.35` G4 — FIXED in the sandbox, not yet committed
- New coverage for E1 will be needed and does not exist yet.

**Still unmeasured, and now in scope because nothing defers**
- **Item D, shallow seating.** T5 has never been able to fire. A member seated at seat 2
  pays a full fee and collects $0.25. If E1 lands, that member's balance travels — which
  changes item D's severity but not its existence.
- **The organic growth rate.** `logs/parked_baseline.csv` and `diag_parked_growth.js` —
  parks vs rescues vs EVICTIONS per day, still never run.
- ~~**Tier-gate recalibration** after the acceleration finding.~~ **CLOSED 2026-08-18.** `model_item_a.js` PHASE 8: live T2 is $25.00 and 0 of 39 can upgrade at cycle-out under EITHER V8.48 or item A. The acceleration was V8Elevator's fee ladder, not this chain's. No recalibration, no contract change.

## 🚨🚨 MEASURED ON CHAIN 2026-08-17: PARAM 59 = 5000 RESCUES **ZERO** MEMBERS

**THIS REVERSES THE OWNER DECISION TAKEN EARLIER TODAY. DO NOT DEPLOY 5000.**

`scripts/model_item_a.js` phase 6 (added for this question) computes the re-entry ask two
ways: the AGGREGATE across both halves — phase 5's basis, and what the 5000 decision was
made on — and the **MatB LEDGER alone**, which is the basis `handleCycleOut` and
`_triageParked` actually use. Live V8.48, block 45588411, n=70:

```
  ask, AGGREGATE (both halves)      min $1.23   median $1.90   max $2.58
  ask, MatB LEDGER (the real gate)  min $6.60   median $6.60   max $6.60
  MEDIAN UNDERSTATEMENT             $4.70

  PARAM 59 sweep on the LEDGER basis — rescued of 70:
     3400 bps  ceiling $3.40    aggregate 70    LEDGER   0
     5000 bps  ceiling $5.00    aggregate 70    LEDGER   0     <- THE DECISION WE TOOK
     6800 bps  ceiling $6.80    aggregate 70    LEDGER  70     <- first value that works
    10000 bps  ceiling $10.00   aggregate 70    LEDGER  70
```

**$6.60 for every single member, min = median = max.** That uniformity is itself the
proof: journey B earns the structural $3.40, a re-entry costs $10.00, the ask is $6.60,
and every one of these 70 is a no-referral member. It matches the hand-derivation exactly.

### WHAT THIS ACTUALLY MEANS — AND IT IS NOT "ITEM A IS BROKEN"

Item A's headline win is untouched and confirmed again this run: **40 of 40 MatA parkers
freed, 100%**, $48.93 of live shortfall to zero, 64.0% of all funding parks removed. Nobody
is evicted mid-cycle. **That is item B delivered and it does not depend on any of this.**

What is broken is the SECOND half of the story — the claim that the member arrives at
re-entry holding $6.80 and asks $3.20. They DO hold $6.80. It sits in two ledgers, $3.40
each, and the re-entry gate can only spend the MatB one.

**So at that gate item A makes the ask WORSE than V8.48, not better:**

```
  V8.48  MatB reserve $5.00 + earnings $1.80 (post-clawback) = $6.80  ->  ask $3.20
  V8.50  MatB reserve $0.00 + journey-B earnings     $3.40  = $3.40  ->  ask $6.60
```

The member is not poorer — their journey-A $3.40 is real, withdrawable, and usable for a
MANUAL `selfRescue` (which pulls a shortfall from the WALLET). **Item A moved money from
the automatic path to the manual path.** For a passive member, who is exactly who item A
exists for, the automatic path is the only one they use.

### THE THREE WAYS OUT

1. **PARAM 59 = 6800 and ship.** Clears all 70. Defensible framing, and better than the one
   it replaces: 3400 was "never lend more than one JOURNEY's earnings"; 6800 is "never lend
   more than one full A+B CYCLE's earnings" — which is exactly what a member at re-entry
   has completed. No code change. But it doubles the fund's per-rescue exposure against a
   balance that fell $451.66 -> $329.29 in one day.
2. **CARRY THE BALANCE ACROSS THE CROSSING.** At the A->B hop, move the member's remaining
   MatA withdrawable into their MatB ledger. They then reach the gate holding $6.80 and ask
   $3.20 — the scope's model, restored — and 3400 would clear everyone with room.
   **NOT A ONE-LINER:** withdrawable is backed by USDC held in the MatA contract, so the
   claim and the tokens must move together, across contracts, in the money path. Needs its
   own scope item and its own tests.
3. **BOTH** — do 2, keep the floor low, and treat 6800 as the interim while 2 is built.

**RECOMMENDATION: 1 now, 2 scoped for V8.51.** 6800 is honest, on the DAO menu, reversible
by vote, and unblocks the deploy. Option 2 is the real fix and should not be rushed into a
release whose test suite is still being re-fixtured.

### SECONDARY OBSERVATIONS FROM THE SAME RUN

- **The population has fully turned over to organic no-referral members.** One completed
  journey now earns min $3.40 / median $3.40 / **max $3.40** — the whole distribution has
  collapsed onto the structural minimum (it was min $3.40 / median $4.83 / max $6.34 on
  2026-08-16). The bigfill-era members with referral income have cycled out.
- **MatB parkers carrying debt: 0 of 70**, down from 23 of 72 yesterday. The clawback
  concern (scope defect 3) has no live population right now.
- **The Stability Fund fell $451.66 -> $329.29 in a day** while the queue drained 133 -> 110.
  Worth watching before committing to a higher lending ceiling.

## 🚨 THE CONSERVATION ARGUMENT HAS A HOLE — MEASURED 2026-08-17, READ BEFORE DEPLOY

**This contradicts a conclusion session 3 committed to source, and it bears on PARAM 59.**

### WHAT SESSION 3 WROTE, IN THE HANDOFF AND IN `TierRouter.handleCycleOut`

> V8.48  reserve $5.00 + earnings $3.40 - $1.60 crossing debt = **$6.80**
> V8.50  reserve $0.00 + earnings $3.40 (journey A, **KEPT**) + $3.40 = **$6.80**
> "The same $6.80 against the same $10 re-entry, so every funding gate below decides
> identically... that is why item A needed NO code change in this contract."

### WHY IT IS WRONG

Journey A's earnings are kept — **in the MatA ledger.** `handleCycleOut(member, tierIndex,
escrow, withdrawable)` receives ONLY the cycling matrix's two buckets, passed by
`MatrixLogicLib._cycleOutRoot` from **MatB**. There is no cross-matrix lookup. So the
"+$3.40 (journey A, KEPT)" term is real money that this gate never sees.

**MEASURED on `deployV8Fixture`, W1 at the MatB cycle-out:**

```
  MatA ledger  $7.31   <- STRANDED from this decision
  MatB ledger  $7.66   <- ALL that handleCycleOut receives
  aggregate   $14.97   <- what scripts/model_item_a.js sums
  T1 re-entry needs $10.00
```

The member holds $14.97 and the contract sees $7.66. Under V8.48 the same member reached
this gate with **$12.66**, because the $5 arrived as a carved MatB reserve. **Item A leaves
that money behind in MatA.** The member is not poorer overall — they are poorer AT THIS
GATE, which is the only place it matters for an automatic re-entry.

### THREE CONSEQUENCES, IN ORDER OF IMPORTANCE

1. **`model_item_a.js` IS OPTIMISTIC FOR THE POST-ITEM-A POPULATION.** Phase 5 computes
   holdings as *"credits across BOTH halves"*. That is CORRECT for the members it measured
   — today's V8.48 parkers, whose MatA money was already spent on their full-fee crossing,
   so aggregate ≈ MatB ledger. It is **wrong as a projection**, because under item A the
   money splits across two ledgers and only one funds the re-entry. **The measured median
   ask of $1.90 and "15 of 72 refused at 3400" are both understatements.** PARAM 59 at 5000
   still looks like the right call — the direction does not change — but the headroom it
   buys is smaller than the sweep suggested.

2. **A MEMBER CAN NOW UPGRADE INSTEAD OF RE-ENTERING, AND THE CODE PERMITS IT.**
   `_executeAdditive` (`:1351`, `:1362`) tries re-entry first, gated on
   `escrow + withdrawable >= curFee`, then tries the upgrade in an INDEPENDENT `if` —
   not an `else`. The doc comment says *"auto-reentry ON → member NEVER graduates:
   re-enter or PARK"*, and the code does not enforce the "or PARK". Under V8.48 the
   divergence was invisible: a member who could afford a $7 upgrade had almost always
   cleared the $10 re-entry first, because the $5 reserve got them there. **Item A opens a
   band — funds between the next-tier fee and the current-tier fee — where the member
   leaves T1 rather than completing another cycle.** Observed: W1 at $7.66 skipped a $10
   re-entry and took a $7 T2 upgrade.

3. **IT INTERACTS WITH ITEM B.** "No member evicted mid-cycle" is satisfied by item A at
   the A->B crossing. This is a different thing: a member who does not re-enter has not
   been evicted, but they have not continued either.

### WHAT IS *NOT* WRONG — CHECKED, SO NOBODY RE-OPENS IT

- **`disableUpgrade` is NOT being ignored.** `_executeAdditive:1336-1341` applies a
  member's options only once `cycles >= reentryMinCycles` / `autoUpgradeCycleThreshold`;
  below that the system default governs. That is V8.44 design (`V8_44_CycleOut` sets
  `setReentryMinCycles(1)` explicitly for exactly this reason). A first cycle-out ignoring
  the member's own toggle is intended, not a defect.
- **The member does not LOSE the MatA money.** It is withdrawable, and `selfRescue` pulls
  a shortfall from the WALLET, so a member can move it manually. **Item A moves money from
  the automatic path to the manual path** — that is the honest one-line summary.

### WHAT TO DO NEXT — NOT YET DONE

1. **Add a phase to `scripts/model_item_a.js` that splits holdings BY LEDGER** and reports
   the re-entry ask on the MatB balance alone. That is the basis the contract uses. Re-run
   PARAM 59's sweep on it. **Until then, treat the $1.90 median and the 5000-clears-all-72
   result as an upper bound on how good things are.**
2. **Decide whether the `_executeAdditive` fall-through is wanted.** Options: leave it (a
   member progressing a tier is not a bad outcome), or make the upgrade an `else` so
   "re-enter or PARK" means what it says. **This is an owner decision and a contract
   change, so it does not belong in a test fix.**
3. **Correct the comment in `TierRouter.handleCycleOut`** — it currently asserts a
   conservation that does not hold at that gate, and it is the most authoritative-looking
   place anyone will read.

**The 15-registration test stays RED until 2 is decided.** It was left failing on purpose
rather than being written around behaviour that is not yet understood.

## ⛔ THE 40 WERE TRIAGED, AND HALF OF THE BIGGEST CLUSTER WAS ONE LINE

Grouping the remaining failures by revert signature rather than by file: **20 of them —
by far the largest cluster — fail on `F8V8: already in matrix`**, which is the
duplicate-seat guard at `MatrixLogicLib:255` and has a history in this repo as a real
pair-wide DoS. That warranted looking at before any more re-fixturing.

**It is not a regression. It is item A succeeding where a fixture expected it to fail.**
The trace runs `test helper -> matA.forceCross -> _finalizeCrossing -> seat in MatB ->
require(!isInMatrix)`. `V8Elevator.test.js` has ONE shared `fc()` helper used at 21 call
sites, and the helper's own comment states the dead assumption outright:

```
// 7 registrations each trigger a MatA rotation; fc() pushes each parked root to MatB
```

Under item A **the root does not park** — its reserve pays the crossing, so it crosses
itself during the rotation and is already seated by the time `fc()` runs. The helper's
real contract was always "ensure this member is in MatB"; only the world made the two
readings identical. **One guard in the helper, and that file went from 22 failing to 10:**

```js
if (await matB.isActiveInMatrix(memberAddr)) return;   // item A got there first
```

The pattern was not invented here — `V8_48_KeeperScan.test.js` already guards its own
force-cross loop exactly this way, and so does `V8_47_UpgradeGate.test.js` at its call
site. This is that pattern hoisted into the helper.

**THREE MORE FILES CARRY THE SAME `ownerForceCross` IDIOM** (`V8_44_CycleOut`,
`V8_47_UpgradeGate`, `V8_44_Overflow`) **and the same guard was applied to them, measured,
and REVERTED: it fixed nothing.** Their 6 failures are the other family — a fixture that
needs a parked member item A no longer produces — and V8_47's call site was already
guarded. The guard would have been correct-by-design and dead in the diff, so it went
back out. Recorded because "it looked like the same bug and was not" is worth one line to
the next session.

**Where the remaining work stands after that:** sandbox **28 failing**, predicted **~27**
on the owner's machine. Two shapes, and neither is mysterious:

1. **The parked-member family** — `V8.10` ×4, `V8.44` ×5, `V8.47` G3, `V8.35` G4,
   `V8.38` L1/L2/L4, `GhostFloor` GF-V1/GF-V3, `CycleOutDebug`, whale gate. Each needs
   what `RescueSurplus` needed: build the member at the MatB cycle-out instead of the MatA
   crossing. **`RescueSurplus` and `GF-V3` are the two worked examples; the rest is that
   job repeated.**
2. **`stress_test_full.js` ×2** — `Expected 'F8V8: already in matrix' but got
   'F8V8: sfContribution exceeds fee'`. Session 3 already named these two as the bug that
   was sitting in plain sight in the 51, and they are now asserting the OLD revert string
   against a keeper that prices correctly. Fixture, one line each.

## ✅ BOTH OWNER DECISIONS ARE SETTLED — 2026-08-17, MEASURED THEN DECIDED

**Superseding the "STILL OPEN" section below, which is kept for its reasoning.**

### ⚠️ DECISION 1 — PARAM 59 3400 -> 5000 — **SUPERSEDED, SEE THE PHASE 6 SECTION ABOVE.**
### (original reasoning kept below; it was correct on the basis it had)

The owner's instinct was **4000**. A sweep added to `scripts/model_item_a.js` measured what
each ceiling actually buys, against the live population (n=72, block 45578581):

```
    0 bps  ceiling  $0.00   rescued   6/72   refused 66
 1700 bps  ceiling  $1.70   rescued  12/72   refused 60
 2500 bps  ceiling  $2.50   rescued  44/72   refused 28
 3400 bps  ceiling  $3.40   rescued  57/72   refused 15     <- today
 4000 bps  ceiling  $4.00   rescued  60/72   refused 12     <- OFF the DAO menu
 5000 bps  ceiling  $5.00   rescued  72/72   refused  0     <- DECIDED
 6800 bps  ceiling  $6.80   rescued  72/72   refused  0
10000 bps  ceiling $10.00   rescued  72/72   refused  0
```

**4000 was rejected on the data, not on taste. It buys THREE members** (57 -> 60) and still
refuses 12, because **12 of the 15 refused sit in a $0.28 band between $4.00 and $4.28** —
a $4.00 ceiling lands just underneath the cluster it was meant to catch. The tail is a
cliff, not a slope, and the sweep is the only thing that could have shown that; min/median/
max cannot answer "how many clear at X" for an X between them.

**AND 4000 IS SETTABLE BUT NOT VOTABLE.** `StabilityFund.setInsolvencyFloorBps` accepts any
bps <= 10_000 (a free range, not an enum), so it CAN be deployed — but `V8Governance.sol:496`
enumerates `[0, 1700, 2500, 3400, 5000, 6800, 10000]` and 4000 is not on it. Set it and the
DAO could never vote back to it. That is CLAUDE.md's `375/400` trap in a new costume:
on-chain state drifting from the source default with nothing keeping them equal. Deploying
4000 honestly would mean moving the source default, the DAO menu and the `GF-G1`
menu-discipline test together — three files, to buy three members.

**THE JUSTIFICATION IS NOT THE MEDIAN ANY MORE, AND THAT MATTERS.** Session 2 argued from
*"one completed journey earns min $3.40 / median $4.83 / max $6.34"*. The 2026-08-17 run
reads **min $3.40 / median $3.40 / max $5.93** — the median IS the structural no-referral
minimum now.

⛔ **I FIRST CALLED THIS "ONE OF THE TWO RUNS IS WRONG". THAT WAS WRONG, AND THE TELL WAS
IN THE NUMBERS I ALREADY HAD.** The MAXIMUM fell, $6.34 -> $5.93. A completed journey's
earnings cannot decrease for a member who stays, and adding members cannot lower a maximum.
**So the population TURNED OVER between the two readings — it did not merely grow.** The
$6.34 member left the MatB queue (rescued or evicted) and new ones arrived. Both runs are
correct; they measure different populations nine hours apart. The degraded reconciliations
(chain pay 97.3% -> 92.6%, pool 77.7% -> 50.2%) are separately explained: pool settles per
ROTATION and the chain has been organic and quiet since bigfill stopped, so more of it sits
unsettled in the accumulator. Neither needed to be a fault.

**AND THE TURNOVER SAYS SOMETHING WORTH KEEPING.** The queue is churning, and the member who
left was the RICHEST one — which is what you would expect, because the richest ask the least
and are the ones the fund can afford. **A queue that keeps losing its wealthiest members
gets poorer, and its median ask rises over time.** That is one observation, not a trend, and
it must not be quoted as one until a third reading exists. But it points the same way the
decision went.

**THE STANDING LESSON, because I nearly filed a false alarm as a finding:** two runs
disagreeing is not evidence that an instrument is broken. Check first whether they measured
the same thing. And it is the reason PARAM 59 is anchored to `CROSSING_RESERVE_BPS` and not
to a median — **a median over a churning queue is a snapshot, not a property of the system.**

The decision does not rest on it. **The operative number is the max ask, $4.28 — measured
twice, on two population sizes, identical to the cent.** And the defensible anchor is
structural rather than statistical:

> **5000 bps IS `CROSSING_RESERVE_BPS`. The fund lends at most what the system itself
> reserves for a crossing.**

That does not drift between runs, it is already on the DAO menu, and it reads honestly in
member comms — better than either "a median" or "one full journey's earnings", which was
the 3400 framing and is now contradicted by its own data.

**COST, BOUNDED:** the 15 extra members each ask between $3.40 and $4.28, so the entire
marginal exposure of 3400 -> 5000 is **$51.00 to $64.20**, against a fund holding $451.66
which item A simultaneously relieves of $96.70. Absolute worst case across all 72 is $308
if every member asked the maximum; none do, the median ask is $1.90.

**⛔ AND THE CORRECTION THAT SHOULD HAVE COME FIRST: PARAM 59 IS NOT REQUIRED BY ITEM B.**
Session 2 wrote that 5000 is needed *"so all 63 members at re-entry are rescued and item B's
promise holds."* **That is wrong.** Item B is about members evicted **MID-CYCLE**, and every
one of those is a MatA parker — all 61 of whom item A frees outright, 100%, measured twice.
The members the floor refuses are MatB parkers **at re-entry, having COMPLETED a full
cycle**. Evicting them does not violate item B. **Item A alone satisfies item B.** PARAM 59
is a purely economic generosity choice and was decided as one. Anyone re-opening it should
argue it on cost and member lifetime, never on item B.

**SECOND-ORDER EFFECT, ACCEPTED WITH EYES OPEN:** 23 of 72 re-entry members carry SF debt,
and `_crossToPartner` sweeps all remaining withdrawable to repay it (`:882-897`). Under item
A they arrive holding MORE, so an indebted member is clawed back HARDER, not spared. Raising
the ceiling means more members borrow, so that group grows next cycle. This is scope defect
3 and it is not fixed by this decision.

### DECISION 2 — THE SF RESCUE LADDER: **KEEP PRESET 1. NOTHING MOVES.**

Measured, and it closes the question session 3 opened: **the poorest live member at re-entry
holds $5.72 — 5,720 bps against preset 1's 4,000 bottom rung.** Not one member of the live
population falls off the ladder. Derived from the sweep: the largest ask is $4.28, so the
smallest holding is $10.00 - $4.28.

The ~3,400 bps case session 3 worried about belongs to a member **mid-journey-B**, and under
item A those never park — there is nothing to pay until cycle-out — so **they never meet the
ladder at all.** The cliff that showed up in `V8_48_KeeperScan.test.js` was the FLOOR, not
the ladder (see the correction above), and it is bought back by decision 1.

**Revisit only if item D (shallow seating) turns out to be real**: a member seated at seat 2
collects $0.25 of a journey and could arrive at re-entry far below anything on chain today.
That frequency is still unmeasured — it is test T5, and `scripts/diag_seating_depth.js`
exists but has never been able to fire.

### ✅ FINALISED IN SOURCE — NOT LEFT AS A DEPLOY STEP

- **`StabilityFund.sol` `insolvencyFloorBps` default is now `5_000`.** Done in source, not
  deferred to a setter call, and that choice is the point: **V8.50 is a fresh deployment, so
  the source value IS the live value from block one.** Leaving `3_400` would have needed a
  runbook step that can be forgotten, with the community's fund silently on the old ceiling
  until someone ran it — which is `375/400` in CLAUDE.md, exactly. 5_000 is already on the
  governance menu (`V8Governance.sol:496`), so the DAO retains full control.
- **The change cost six test edits and every one of them made the suite better.** Two
  "declared default" pins moved 3400n -> 5000n deliberately (they exist to catch accidental
  drift; this drift was chosen). Four boundary tests — `GF-F1`, `IF-1`, `IF-3`, `IF-5` — had
  the $3.40 ceiling HARD-CODED and silently became change detectors the moment the default
  moved. They now DERIVE the ceiling from `insolvencyFloorBps`, so the rule under test is
  "headroom == ceiling - debt" rather than a number. That is this suite's own item-42
  lesson, applied to itself.
- **VERIFIED, NOT ASSUMED: the change has ZERO net effect on the suite.** Full run before
  and after, same sandbox: **574 passing / 21 failing, and the failing SET is identical
  member-for-member.** Nothing else in the codebase keyed off 3400. (The same sandbox now
  matches the owner's machine exactly, 574/21 — the earlier "drifts by two tests" note was
  an artefact of running `KeeperScan` ALONE rather than in suite order. Worth knowing before
  trusting a single-file run again.)
- ⚠️ `contracts/StabilityFund.sol` is the FIRST contract file touched since `24c193c`. One
  constant plus comments, so bytecode is unmoved. **Sizes run, all watched contracts fit:**

```
  TierRouter        23,910  (666 spare)      MatrixLogicLib   24,013  (563)
  MatrixPairFactory 24,228  (348)            MatrixKeeper     21,229  (3,347)
  StabilityFund     15,063  (9,513)
```

  **THE BUILD REPRODUCES ACROSS TWO MACHINES BYTE-FOR-BYTE** — the sandbox container and the
  owner's Windows box produce identical deployed sizes on all five. That is a stronger
  statement than "it fits" and it retires the earlier worry about sandbox drift entirely.

- 🔎 **ONE UNEXPLAINED NUMBER, LOGGED RATHER THAN IGNORED: `MatrixKeeper` reads 21,229 here
  and session 3 recorded 21,282 — 53 bytes SMALLER now.** Nothing in this session touched
  `MatrixKeeper.sol` (mtime unchanged since session 3), and TierRouter, MatrixLogicLib and
  MatrixPairFactory all match session 3's figures EXACTLY, which rules out a toolchain or
  optimiser difference. The likely cause is mundane: session 3 ran `sizes.js` before its
  final edit to that file and recorded the earlier figure. **Direction is benign — headroom
  went UP, 3,294 -> 3,347 — so nothing is at risk.** Recorded because an unexplained number
  is an incomplete handoff, and 21,229 is now the figure to check future runs against.
- `sfRescueLadderPreset` stays **1**. No action.
- **The crossing buffer is the third lever and it is already decided by V8.49:** live V8.48
  hardcodes `CROSSING_BUFFER_BPS = 3600` and the model's Phase 1 warns about it every run —
  every rescue seeds 36% of the fee into withdrawable as SF money without passing through
  `_credit()`. V8.49 made it a governed param defaulting to **0**, and V8.50 carries that.
  Confirm it ships at 0 in the predeploy checks; it is worth more to the live fund's
  solvency than either decision above.

## ~~THE TWO OWNER DECISIONS — STILL OPEN~~ — SUPERSEDED BY THE SECTION ABOVE, KEPT FOR ITS REASONING

**1. PARAM 59 `insolvencyFloorBps` 3400 -> 5000.** Decided in session 2, still not applied.
**A new measurement complicates it and must be read before it is applied.** In the
`KeeperScan` world, 5000 does NOT close the cliff — those two members ask **$5.13** against
a $5.00 ceiling and are still evicted. Parity only returns at **6800**.

⚠️ **DO NOT CARRY THAT NUMBER TO THE LIVE CHAIN.** That world is `MATRIX_SIZE 7`, where one
journey earns **$2.44 (24%)** against the structural **$3.40 (34%)** at 127. Those members
are POORER than any real member and their ask is correspondingly larger. Live, `n=63`, the
maximum ask is **$4.28** — which 5000 clears with room, which is exactly why session 2
chose it. **The fixture measures the SHAPE of the cliff, not its live depth.** What it
does add, honestly: 5000 is not a large margin, the live max is 86% of the way to that
ceiling, and if journeys ever earn less than they do today the ceiling bites first.

**2. The SF rescue ladder's bottom rung.** Session 3 framed this as the lever. **The
reproduction says the floor is what bit, not the ladder** (see the correction above), so
the honest form of decision 2 is now: *is there a population that falls off the 4,000 rung
at all?* In the fixture, no — the poorest divergent member read 4,120. `model_item_a.js`
against the live population is what answers it.

**NEITHER IS SETTLED HERE, AND NEITHER SHOULD BE SETTLED FROM THE FIXTURES.** The command
is still the one session 3 gave, and it needs the owner because neither sandbox can reach
Base Sepolia:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\model_item_a.js
```

## PROGRESS ON THE 21 — DOWN TO 3

Nine more closed after the owner's `test_v850_task2.txt` run. Every one was a fixture; no
contract logic changed (the only contract edit this session is the PARAM 59 default).

| what | tests | the fix |
|---|---|---|
| `V8.10` parkedAt / evictParked | 4 | new `parkOneAtReentry()` helper — follow the park to MatB |
| `V8.38` L1 / L2 / L4 | 3 | ensure-not-shove on `forceCross`; L1's precondition re-stated |
| `stress_test_full` S2 x2 | 2 | `sfContribution` = CROSSING_PRICE, not the full fee |

**`V8.10` x4 is the one worth reading**, because it is the template for most of what is
left. The fourteen-registration sequence used to leave `s0` parked in MatA. Measured now on
that exact fixture:

```
  matA  parked 0   occupancy 7   rotationCount 8     <- everyone crossed themselves
  matB  parked 1   [w1]          rotationCount 1     <- the one real park
```

So the tests follow the park to MatB via a shared helper that ASSERTS the precondition
loudly. They were never about which half the park happened in — they are about `parkedAt`
and `evictParked` mechanics — and saying so in the helper is most of the work.

**`stress_test_full` x2 is session 3's "bug sitting in plain sight", closed.** They passed
`sfContribution = T1_FEE` to `forceCrossKeeper` to make `memberShare` 0 and isolate the
seat guard. Under item A the whole crossing IS half a fee, so the full fee trips
`sfContribution <= crossingCost` FIRST and the seat guard was never reached. Now
`CROSSING_PRICE`, mirrored from `MatrixLogicLib`'s `internal` constant with its source
named — the same way `V8_48_SplitGrace.test.js` mirrors it.

### ✅ CLOSED 2026-08-18 ON MEASUREMENT — THE CLAIM BELOW IS FIXTURE-SPECIFIC

**READ THIS BEFORE THE SECTION IT PRECEDES.** Everything below was measured on
`V8Elevator`'s fixture, which picks its own tier fees. `scripts/model_item_a.js` PHASE 8
(added for this) reads the REAL ladder off each tier's MatA and asks the same question:

    THE LIVE FEE LADDER   T1 $10   T2 $25   T3 $50   T4 $100   T5 $250 ... T10 $10,000

    HOLDINGS AT THE MatA CYCLE-OUT, n=39 members who completed a journey
      V8.48 (crossing ate $5.00 of earnings)   min $0.00  median $0.00  max $5.90
      item A (reserve paid it in full)         min $3.40  median $3.40  max $10.90

    T2 ENTRY FEE $25.00 — who can upgrade at cycle-out?
      under V8.48    0 of 39
      under item A   0 of 39

**THE LOGGED CLAIM IS FALSE ON THIS CHAIN.** Nobody reaches T2 at their first cycle-out
in either world, so **T2's whale gate does not trip sooner, `tierGateThreshold` needs no
recalibration, and there is no contract change.** The `$7.66 against a $7 T2 fee` figure
below is the fixture's ladder; the live T2 fee is $25.00. **The open scope item is
CLOSED — measured, not real here.**

### ⛔ BUT THE REAL FINDING IS BIGGER THAN THE ONE THAT WAS LOGGED

Read the two holding rows again. **Under V8.48 the median member holds $0.00 after their
crossing.** A completed journey earns $3.40 and the crossing demands $5.00 of earnings on
top of the reserve — so the median member cannot fund the crossing at all. They park, or
they borrow. That is the 68 MatA parkers and the $727.05 of lending, seen from the
member's side rather than the fund's.

Under item A the same member keeps **$3.40 every cycle**.

So item A's effect on progression is not "T2 arrives one cycle sooner". It is that **T2
becomes reachable AT ALL for the median member** — roughly eight cycles of accumulation
at $3.40, against a V8.48 per-cycle balance of zero and no upward path whatsoever.

**Correct the framing wherever it appears.** This document has said "the benefit arriving
faster than predicted". It is not faster. It is **existing where it previously did not**.
That is a stronger claim, it is measured, and it is the one to use with members.

⚠ NOT MODELLED: multi-cycle accumulation. PHASE 8 answers only "does item A move the
FIRST cycle-out across the T2 line", which is the specific claim that was logged. The
eight-cycle figure above is arithmetic on the median, not a simulation. A real
progression model would simulate repeated cycles and is a separate piece of work.

---

### THE ORIGINAL ENTRY, KEPT VERBATIM — ⛔ ITS NUMBERS ARE THE FIXTURE'S, NOT THIS CHAIN'S


**Two failing tests turned out to be one finding, and it is not a test problem.**

At a MatA cycle-out under V8.48 the crossing consumed a full fee — $5 reserve + $5
earnings — leaving a T1 member $2.66 against the $7 T2 fee, so the additive cycle-out's
UPGRADE leg could not fire. Item A charges that crossing $5 and leaves **$7.66**. Measured
on `V8Elevator`'s own fixture: W1 now reaches **tier 2 inside nine registrations**, seated
in MatB and MatA2 at once.

**Nothing new fires and nothing leaked.** The additive cycle-out is V8.43 behaviour that
merely became AFFORDABLE; the T2 whale gate stays shut; and cycle-completed eligibility
bypassing a closed gate is deliberate and pinned by V8.44 UX3/C2. The member did not skip
MatB — they hold both seats.

**THE CONSEQUENCE IS ECONOMIC AND IT IS LIVE.** `tierGateThreshold` and
`whaleGateThreshold` were calibrated in a world where members could not afford to upgrade
at their first cycle-out. **T2's whale gate will now trip sooner than V8.48 modelled**,
because members reach the tier one cycle earlier. Owner decision 2026-08-17: **ACCEPT it —
this is the "more completed rotations, more tiers, more CNOVA" benefit the scope promised,
arriving faster than predicted — and log the threshold recalibration as an OPEN SCOPE
ITEM.** No contract change; nothing blocks the deploy.

**The two tests were asserting POVERTY, not the rule they were named for.**
`tierFirstEntries(2) == 0` was only ever true because nobody could afford to move. The
whale-gate test now asserts what it was always about — the gates are per-tier, and
tripping T1's does not trip T2's. **DONE.** The 15-registration test is NOT done and is a
walk-through item below, because its assertion pins a different rule.

**STILL OPEN, for whoever picks this up:** re-measure when T2's gate trips under item A
against the live population before the thresholds are trusted. `scripts/model_item_a.js`
does not model tier progression today; it would need a new phase.

### ⛔ NEW SCOPE FINDING: `EvictionReserveReleased` IS NOW ALL BUT UNREACHABLE

Found while walking GF-V3, and it is worth more than the test fix it came from.

Releasing a crossing reserve on eviction needs a member who is **(a) parked, (b) holding a
reserve, and (c) NOT seated in the partner half** — because a holder seated in the partner
is a GHOST, and the valve dequeues those without touching a balance. Every park site in
`MatrixLogicLib` was walked against that three-part test:

| park site | holds a reserve? | a ghost? | reachable under item A |
|---|---|---|---|
| `:947` funding shortfall | yes | no | **NO — item A deleted this park** |
| `:876` duplicate seat | yes | **YES, by construction** | dequeue-only, releases nothing |
| `:1461` `softParkIdle` | no — releases it itself at `:1447-1450` | no | n/a |
| MatB, any cause | no — item A spent it | no | n/a |
| `:906` mid-cascade deferral | yes | no | yes |
| `:523` cascade-refill on entry | yes | no | yes |

**Only the last two survive, and no test in this suite constructs either deliberately.**
Measured, not reasoned: a duplicate holder parked in MatA was built and evicted — the
contract emitted `GhostDequeued`, not `MemberEvicted`, and released nothing. Correct
behaviour, and it closes off the one path that looked promising.

**So on the live chain, eviction will essentially never release a reserve under item A:
the members who still hold one when they park are ghosts, and ghosts are dequeued.** That
is not a bug — it is item A removing the poverty park, which was the only common way to be
parked while still holding a carve.

**WHAT NEEDS DECIDING (not urgent, not deploy-blocking):** whether the release path is
still worth carrying. It is live code with a live event and near-zero reachability. GF-V3
now pins the behaviour that actually ships — a MatB eviction releasing nothing — and
asserts `EvictionReserveReleased` count is **0**, which will fail loudly if anything ever
starts carving a MatB reserve again. That makes it a regression guard for item A rather
than coverage of the release.

### ⛔ WALK-THROUGH ITEMS — 3 LEFT OF 6

**DONE:** GF-V1 and GF-V3 (below), on the owner's go-ahead 2026-08-17.

**GF-V1 — SOLVED BY MOVING TO A CONSTRUCTION THAT STILL WORKS.** It swung *MatA's* partner
to the decoy and seated through `_enterMatrix` into a FULL MatA, which under item A
cascades a real cycle-out into an unwired decoy. `V8_46_PairGuard` G2's construction was
adopted instead — swing *MatB's* partner, seat both halves through the PairManager BEFORE
anything is full, restore — so nothing cascades and the decoy never has to accept a
crossing. Hoisted into shared `forceSeat()` / `seatBothHalves()` helpers in that file.

**GF-V3 — RESOLVED AS A FINDING, see above.**

**`CycleOutDebug` — REBUILT, NOT RETIRED, AND THE FIRST CALL ON IT WAS WRONG.** It was
triaged as "retire it, the behaviour is covered by `V8_44_CycleOut` and
`V8_48_RescueSurplus`". **That was judged from the filename and the error message, not
from reading the file, and it was wrong.** Those two cover `selfRescue` and `coPayRescue`
— the member paying for THEMSELVES. Checked properly: only two files call both
`payForceCross` and `forceCrossKeeper`, this one and `stress_test_full`, and
`stress_test_full` only exercises the REVERT paths. `V8_44_Keeper` covers force-rotation
and epochs, not member rescues.

**So this is the ONLY test in the suite where the Stability Fund successfully rescues
anybody** — and this handoff's own open-items list already says *"no end-to-end test that
a real rescue books shortfall and nothing more"*. Deleting it in the same release that
REPRICES rescues would have thinned a known-thin area at exactly the wrong moment.

It moved instead: members now park at the MatB cycle-out, where re-entry costs a full fee,
and that is where the live keeper will find them. The rebuilt flow asserts MatA parks
NOBODY, the member holds no reserve, the floor refuses a full-fee advance at the NEW $5.00
ceiling (PARAM 59 = 5000), the floor is raised, SF funds, `forceCrossKeeper` completes it,
and the member re-enters MatA **with a fresh $5.00 reserve carved**.

Two assertions were tried and abandoned on the way, both recorded in the file: "the queue
is empty" and "the count dropped by one". Both are wrong for the same reason — the rescue
re-seats the member, which cascades, which cycles ANOTHER member into their own re-entry
park. One out, one in, net zero. **That churn is item A's thesis showing up as a side
effect, not a fault.** The test scans for the rescued member's ABSENCE instead, which says
what the rescue promised and nothing about the fixture's shape.

**STATUS: 592 passing / 7 pending / 3 failing** (was 60 failing at the start of session 4).
Remaining: the 15-registration re-entry-priority test, `V8.35` G4, and `V8_44_Overflow`
O1+O2 — items 1, 6 and 4 of the walk-through list.

### ⛔ THE ORIGINAL SIX, FOR REFERENCE

**Owner instruction 2026-08-17: walk through each before changing anything.** They were
triaged as "the same fixture shape" and they are NOT. Every one asks what the test should
now MEAN, and each answer is a small policy decision. **The mechanical tail is finished;
this is the judgement tail.**

1. **`V8Elevator` — 15-registration re-entry priority** (`expected 2 to equal 1`).
   Pins the V8.44 rule *re-entry has priority over upgrade at a MatB cycle-out*. Item A
   moves the upgrade EARLIER — to the MatA cycle-out — so W1 is already T2 before the
   moment this test examines. The rule is still real; the fixture no longer isolates it.
   Complication: proving "funds went to re-entry, not upgrade" needs a tier ABOVE the
   member's current one to be available, and T3 is not deployed in this fixture.

2. **`GF-V1` — the ghost can no longer be constructed.** It swings MatA's partner to a
   decoy, seats W1 through the decoy, restores the pair. Under item A that entry cascades
   a REAL cycle-out; the root can now afford to cross; it crosses into the unwired decoy
   and dies on `F8V8: not authorized`. Under V8.48 the root was underfunded and simply
   parked, so the cascade never reached the partner. **Recommendation: build the ghost at
   a moment the matrix cannot cascade — do NOT wire the decoy, because a decoy that
   accepts crossings has stopped being a decoy.**

3. **`GF-V3` — eviction's reserve release may now be DEAD CODE, and that is the real
   question.** It asserts a cycle-out park keeps its $5 reserve, then that `evictParked`
   emits `EvictionReserveReleased` and folds it into withdrawable. Under item A a MatB
   parker holds $0.00, so nothing is released and the event does not fire
   (`releaseReserve` guards `r > 0`). **And a MatA parker — the only member who still
   holds a reserve — no longer exists: MatA parks nobody.** So before re-fixturing, answer
   the real question: **is `EvictionReserveReleased` reachable at all under item A?** If
   not, that is a scope finding, not a test edit.

4. **`V8_44_Overflow` O1+O2 — needs a member who no longer exists.** Requires a parked
   MatA member to `selfRescue` into a full MatB. The invariant it protects (own members
   return to their OWN pair, never a later one) is worth keeping, but re-pointing it at a
   MatB parker breaks one assertion outright: *"own MatB must rotate from the rescue
   entry"* stops being true, because a MatB parker re-enters MatA and does not rotate
   MatB. Something must be re-stated, not re-pointed.

5. **`CycleOutDebug` — its entire premise is what item A deletes.** The test is *"W1 parks
   on cycle-out (insufficient funds), keeper rescues to MatB"*. Item A means W1 crosses
   itself; there is no park and no rescue. **Recommendation: this one is a genuine
   RETIRE-or-repoint decision, and retiring it is defensible** — it is a diagnostic
   harness, its behaviour is covered by `V8_44_CycleOut` and `V8_48_RescueSurplus`, and
   keeping it means inventing a scenario item A worked to prevent.

6. **`V8.35` G4 — a member count moved** (`expected 9 to equal 8`). FIFO placement after a
   factory expansion. Item A changed who is seated where at the moment the factory fires,
   so the count shifted. **Needs reading before touching: this is the only one of the six
   where the FACTORY, not the parked queue, may be what moved.**

### THE 6 THAT REMAIN

- **9 of one shape — a fixture that needs a parked member item A no longer produces:**
  `V8_44_CycleOut` T1-T4, `V8_44_Overflow` O1+O2, `V8_47_UpgradeGate` G3, `CycleOutDebug`,
  `GhostFloor` GF-V3, `V8.35` G4. Four of them announce it outright with
  `expected 0 to equal 5000000` — a fixture asking for a $5 reserve item A no longer
  carves. `V8_48_RescueSurplus.test.js` and the `V8.10` helper are the two worked examples.
- **3 odd ones, each needing to be READ rather than pattern-matched:** `V8Elevator`'s
  15-registration re-entry count (`expected 2 to equal 1`), the `V8.21` whale gate
  (`expected 1 to equal 0` — a first-entry counter, possibly a genuine behaviour question
  rather than a fixture), and `GhostFloor` GF-V1 (`F8V8: not authorized` inside `seatVia`,
  a different failure entirely). **Do not assume these are the same job as the nine.**


## STATE OF THE TREE

**No chain was touched. No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test —
and every test ran in a sandbox container, never against a chain.

**`contracts/` is UNCHANGED from `24c193c`.** Seven files in `test/` are modified, plus `scripts/model_item_a.js` (the PARAM 59 sweep), and
nothing is staged. Git is the owner's to run:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
git status
git add test/V8_48_SplitGrace.test.js test/V8_48_GhostFloor.test.js test/V8_49_InsolvencyFloor.test.js test/V8_49_EvictionClock.test.js test/V8_48_RescueSurplus.test.js test/V8_48_KeeperScan.test.js test/V8Elevator.test.js scripts/model_item_a.js V8_50_HANDOFF.md
git commit -m "V8.50: re-fixture the 24 tests that encoded pre-item-A economics; scope the KeeperScan equivalence premise and pin its one divergence"
git push origin v8.1
```

**Before the run whose numbers you intend to trust** — session 3's rule, unchanged:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
npx hardhat compile --force
npx hardhat test 2>&1 | Tee-Object -FilePath test_v850_task2.txt
```

…and remember that capture will be **UTF-16**. Decode before searching it.

## NEXT, IN ORDER

1. **The owner runs the suite** and the diff is taken mechanically against
   `test_v850_task1b.txt` — failure titles as sets, both files decoded first. The
   prediction above is 21 green and 1 new.
2. ~~`model_item_a.js`, then the two decisions~~ — **DONE, both settled above.**
3. **The remaining 12**, listed above. Nine are one shape with two worked examples; three
   need reading rather than pattern-matching.
4. **Defects 2 and 4** from the scope (`DIRECT_EARN_BPS = 500`, `totalEarnedOf`).

## METHOD NOTE FROM THIS SESSION

**A sandbox reproduction of the repo paid for itself many times over, and its limits are
the first thing to state about it.** Building the project in a clean container turned a
four-minute owner round-trip into a seven-second loop, and three of this session's results
could not have been reached without iteration: the RescueSurplus queue measurement, the
$0.95 commission that was silently corrupting an exact assertion, and the PARAM 59 sweep
that overturned session 3's reading of the cliff. It also **drifts from the owner's
machine by two tests**, which is exactly why every number above says where it came from.
The repo's own standing rule applied to itself: give every instrument something to check
itself against, and say which instrument produced which number.

---

# ⬛ SESSION 3 STATE — 2026-08-16, EVENING. READ THIS FIRST, BEFORE SESSION 2.

Session 2's plan is still the plan. This section says what happened building step 1 of it,
**corrects two things session 2 got wrong**, and names the one decision that is the owner's.

## THE HEADLINE NUMBERS — MEASURED, NOT ESTIMATED

| | passing | failing |
|---|---|---|
| baseline, item A stashed (session 2) | 593 | 1 |
| item A only (session 2, `after.txt`) | **543** | **51** |
| + session 3 keeper fix (`test_v850_task1b.txt`) | **534** | **60** |

**9 new failures, 0 fixed, every one attributed below.** The diff was taken mechanically
against `after.txt`, not by eye — decode, slice from the `N failing` line, compare failure
titles as sets. Do that again rather than reading 60 stack traces.

⚠️ **`after.txt` AND EVERY `Tee-Object` CAPTURE IS UTF-16.** `grep` finds nothing in them and
exits 0, which reads exactly like "no failures". Decode before believing any search of these
files. Windows PowerShell 5.1's `Tee-Object` has **no `-Encoding` parameter** (that is
PowerShell 7+), so this cannot be fixed at the capture site — fix it at the read site.

## WHAT SHIPPED (branch `v8.1`, compiles, sizes checked)

**`MatrixKeeperLib.sol` + `MatrixKeeper.sol` — the keeper now prices a rescue at what the
crossing COSTS, not at the entry fee.** New `_crossingCost(mat, fee)` mirrors
`MatrixLogicLib._crossingPrice` and the `cfg.isMatrixA ? … : …` line that appears in six
places there. It feeds three things in BOTH discovery (`_triageParked`) and execution
(`_doParkedRescue`): the ladder's denominator, `maxShortfall`, and `sfShare`.

**This half is load-bearing, not polish.** `forceCrossKeeper` REQUIRES
`sfContribution <= crossingCost`; a keeper still computing against the full fee hands it up
to 2x that and reverts its own rescue. `stress_test_full.js` proves it — two tests there fail
with `'F8V8: sfContribution exceeds fee'`, and they failed that way in session 2's run too,
before any keeper change. That was the bug sitting in plain sight in the 51.

**`MatrixKeeper.sol:722` zero-balance trap is now gated on `isMatrixA()`.** `reserve == 0`
was evidence of destitution only while every seated member was guaranteed to hold one. Under
item A it is the normal healthy state for every MatB member. In a MatA the old evidence still
holds, and those members keep V8.48 behaviour exactly.

**`TierRouter.sol` — COMMENTS ONLY, no executable change. See correction 1.**

**Sizes (`node scripts\sizes.js`): MatrixKeeper 21,282 (3,294 spare) · TierRouter 23,910
(666) · MatrixLogicLib 24,013 (563) · MatrixPairFactory 24,228 (348).** All fit.

## ⛔ CORRECTION 1 — SESSION 2'S TASK 2 WAS A FALSE ALARM. NO CODE CHANGE WAS NEEDED.

Session 2 wrote: *"`TierRouter` escrow-zero … makes the `escrow > 0` graduation branch at
`TierRouter.sol:1428` unreachable and dropping members into a park labelled 'autoReentry
disabled' — a misleading reason for a healthy member."* Checked against the source:

1. **Nothing is lost.** That branch's only work is releasing an UN-CONSUMED reserve. At
   escrow 0 there is nothing to release, and `releaseReserve()` guards on `r > 0` anyway. A
   member who entered a MatB at full fee still trips `escrow > 0` and is still released — so
   the test stays rather than being deleted.
2. **No healthy member is mislabelled.** The underfunded member is caught by the FIRST
   branch, `!anySeat && reentryOn`, evaluated BEFORE escrow is read, emitting "insufficient
   funds". "autoReentry disabled" is only reachable when re-entry genuinely is disabled.

**And every funding gate decides identically, because the conservation is exact.** At a T1
MatB cycle-out with no referrals: V8.48 = $5.00 reserve + $3.40 earnings − $1.60 crossing
debt = **$6.80**; V8.50 = $0.00 + $3.40 (journey A, KEPT) + $3.40 = **$6.80**. Same money,
same $10 re-entry. The V8.48 member just borrowed twice and parked mid-cycle to get there.

**WHERE THE MISREADING CAME FROM, closed rather than left open:** neither graduation branch
calls `parkCycledOut`. They emit `MemberParked` and park nobody — the member GRADUATED. The
event name is V8.44 legacy and reads like an eviction in the logs. **That is a real naming
defect**, frontend-and-tooling scope, deliberately not dragged into the item A diff.

## ⛔ CORRECTION 2 — SESSION 2'S ATTRIBUTION WAS WRONG, AND SO WAS ITS PRESCRIPTION

Session 2 said *"`V8_48_KeeperScan.test.js` (~44)"* of the 51. **That suite has 13 tests and
9 of them fail.** The other ~42 were never attributed. Do not trust "each is attributed" —
the run itself is the list.

More importantly, session 2's prescription — *"the ladder must stop reading a spent reserve
as poverty"* — was **built, tested, and reverted the same hour.** The full write-up sits at
the top of `MatrixKeeperLib._triageParked` so the next session does not rebuild it:

- The credit was `withdrawable + max(reserve, carve)`. For a MatA member the DENOMINATOR is
  the carve, so `wBps >= 10_000` always: **it made `EVICT_LADDER` unreachable for everyone,
  in every matrix.** A member holding nothing read as a top-rung self-funder, the keeper
  queued a rescue `forceCrossKeeper` refuses, swallowed as `WorkItemFailed`, retried every
  tick. **An eviction traded for an infinite loop.**
- The premise double-counted borrowed money. The only position where V8.48 reads higher is
  mid-journey in a MatB ($6.70 vs $5.10), and that gap **is** the $1.60 SF loan that funded
  the old full-fee crossing and got carved into a reserve. V8.48's number was inflated by
  debt; "restoring" it restores an artefact of the double-lending item A exists to remove.

**PROOF THE BACK-OUT DID WHAT IT CLAIMS**, because "it feels right" is not evidence: `EC-1`
and `EC-4` name their failing leg. With the credit in they failed on **`ladder:`**; with it
out they fail on **`floor:`**. The ladder behaviour is restored; what remains is a different
cause.

## THE 9 NEW FAILURES — TWO EFFECTS, BOTH INTENDED, NEITHER A BUG

**(a) ADVANCES GOT SMALLER, so the insolvency floor stops refusing — 6 of 9.**
`GF-D1`, `IF-7`, `IF-10`, the floor legs of `EC-1`/`EC-2`/`EC-4`, and the three
`V8_48_SplitGrace` fixtures ("ONE UNIT SHORT is a loan", "the 84% member … is unaffected",
"a LOAN rescue does NOT fire when the fund cannot cover it"). **The 84% member is exactly who
item A is for** — they need $5, hold $5, borrow nothing. These encode the pre-item-A
economics and must be RE-FIXTURED, not fixed.

**(b) THE LADDER CLIFF IS REAL AND IS NOW REPRODUCED — the owner's decision.**
Inside the already-failing `KeeperScan` diffs, this code now **evicts** in slots where the
frozen V8.48 copy rescued. Honest arithmetic: an early-MatB member reads ~**3,400 bps**
against preset 1's bottom rung of **4,000** and falls off it — debt-free, where V8.48 kept
them on it owing $1.60. **This was analysis in session 3 and is now a fixture result.**
Deliberately NOT fixed in code: the lever is `sfRescueThresholds`, a governed preset (presets
2 and 3 reach 3,000 and 1,000). It is an economic trade-off, not an arithmetic one.

## ⛔ TWO OWNER DECISIONS, TAKEN TOGETHER, BEFORE THE RE-FIXTURE IS FINISHED

1. **PARAM 59 `insolvencyFloorBps` 3400 -> 5000** — decided in session 2, still not applied
   (a deploy-time setting, not code).
2. **The SF rescue ladder's bottom rung.** Keep preset 1 (bottom 4,000) and accept that
   early-MatB members fall off it, or move to preset 2 (3,000) / preset 3 (1,000). Framing:
   under item A these members carry NO debt where V8.48 gave them one, so falling off the
   ladder is not the same event it was.

**Do not settle 2 from the fixtures alone** — run `scripts/model_item_a.js` against the live
population the way session 2 did, so the answer is measured on real members.

## NEXT, IN ORDER

1. **Re-fixture the 6 old-economics tests** (`SplitGrace` ×3, `GF-D1`, `IF-7`, `IF-10`) at a
   MatB re-entry, where a full fee is still charged, instead of a MatA crossing.
2. **`V8_48_RescueSurplus.test.js` (3)** — still "fixture produced no parked member", still
   item A working, same re-fixture. Unchanged since session 2.
3. **Decide the `KeeperScan` premise.** It pins the keeper byte-identical to a frozen
   `MatrixKeeperPrev`; item A changes the WORLD, so the premise is structurally incompatible.
   Session 2's advice stands: decide deliberately, record which and why.
4. **Then** the two owner decisions, then defects 2 and 4 from the scope.

## METHOD NOTES FROM THIS SESSION

- **A prediction at the wrong granularity is not a wrong diagnosis.** I predicted 60 -> 57
  and got 60. The diagnosis was right — `EC-1`/`EC-4`'s ladder leg DID recover — but these
  are MULTI-ASSERTION tests and fixing one leg does not turn a test green. Predict the
  assertion, not the test.
- **`npx hardhat compile` printed "Nothing to compile" for a file that HAD changed.** The
  cache's `contentHash` matched the on-disk md5, so Hardhat had seen it — but stale-artifact
  risk under a 594-test run is not worth reasoning about. `npx hardhat compile --force`
  settles it in 90 seconds. Do that before any run whose numbers you intend to trust.
- **Verify a write landed via `device_bash`, not the upload cache** — `wc -c` plus a `grep`
  for a string you just wrote. The cache served a stale file earlier in this project and cost
  an hour.
- **Two orphaned docstrings found and closed**, both the same shape: a comment left behind
  when its function moved, silently re-attaching to the next function.
  `MatrixKeeper.pendingChainLinkCount()` carried the SF-ladder docstring (stranded by V8.48
  item 12a); `TierRouter` had `reservedFor`'s sitting above `setGlobalJoined`. Worth a sweep —
  this repo has moved a lot of code between files.

## STATE OF THE TREE

No chain was touched. **No transaction sent, nothing deployed, no parameter set, the VPS
keeper untouched, live V8.48 exactly as it was.** `.env` line 69 is still
`deployed_addresses_v8_48.json`. Every command run was a read, a local build, or a test.

Session 3's work is COMMITTED AND PUSHED to `v8.1` as **`24c193c`** (4 files, +500/-68):
`contracts/MatrixKeeperLib.sol`, `contracts/MatrixKeeper.sol`, `contracts/TierRouter.sol`
(comments only), and this file — this line was corrected in a follow-up commit, so the
handoff itself is one commit later than the code. New
scratch captures in the repo root: `test_v850_task1.txt` (ladder-credit run, superseded) and
`test_v850_task1b.txt` (current). Both redundant once the numbers above are read; session 2's
`after.txt`/`before.txt` are still the baseline and should be kept until the re-fixture lands.

---

# ⬛ SESSION 2 STATE — 2026-08-16, LATER THE SAME DAY.

Everything below section 1 is still the plan. This section says what
happened when we started building it, and **it contains one finding that reorders the work.**
**Read session 3 above first — it corrects this section's task 2 and its failure attribution.**

Read `V8_50_SCOPE.md`'s "⬛ MEASURED ON THE LIVE V8.48 COMMUNITY CHAIN" section next — it
carries the numbers, the five source defects, and the two wrong turns the new instrument
took before it was right.

## WHAT IS DONE

- **Item A modelled against the real population.** New tool `scripts/model_item_a.js`.
  Note the handoff's own pointer was wrong: `model_insolvency_floor.js` does NOT model
  item A, it models the three floor POLICIES. Item A is confirmed and sized — frees
  **76 of 139** parked members outright, premise holds **100%** on chain, removes
  **63.7%** of all funding parks. Re-entry ask afterwards: median **$2.71**, better than
  the $3.20 the plan predicted.
- **ITEM C IS DECIDED BY THE OWNER: `insolvencyFloorBps` 3400 -> 5000.** Measured, not
  asserted: the rule *"never lend more than one full journey's earnings"* was calibrated
  on the STRUCTURAL no-referral minimum, but one completed journey actually earns
  **min $3.40 / median $4.83 / max $6.34**. At 5000 the maximum measured ask ($4.28)
  clears, so **all 63 members at re-entry are rescued** and item B's promise holds.
  NOT YET APPLIED — it is a PARAM 59 setting, not a code change.
- **Item A's contract core is written and COMPILES** — `contracts/MatrixLogicLib.sol` on
  branch `v8.1`, one file. See "WHAT THE CODE DOES NOW". It is NOT deployed anywhere and
  **must not be** until step 1 below is done — see the finding immediately after this list.

## ⛔ THE FINDING THAT REORDERS THE WORK

**Item A creates a member state that has never existed before: a live mid-cycle member
holding a ZERO crossing reserve.** Every MatB member is now in that state, because their
reserve was spent getting them there and no new one is carved.

The keeper is not ready for it, and the failure is not benign:

```
MatrixKeeperLib._triageParked:432   effectiveContrib = reserve + withdrawable
MatrixKeeperLib._rescueBpsFor:359   wBps = effectiveContrib * 10_000 / entryFee
```

With `reserve == 0` a MatB member's `effectiveContrib` roughly HALVES, `wBps` drops, and
they fall off the bottom of the SF rescue ladder — which routes to **EVICT_LADDER**.
`MatrixKeeper.sol:722`'s `withdrawable == 0 && reserve == 0 && debt > 0` trap is a second
door to the same place.

**So item A shipped WITHOUT the keeper change does not merely fail to help members at
re-entry — it evicts members the old code would have rescued. That is the exact opposite
of item B.**

**THE KEEPER CHANGE IS LOAD-BEARING FOR ITEM A'S SAFETY, NOT POLISH. THEY SHIP TOGETHER
OR NOT AT ALL.** The ladder must stop reading a spent reserve as poverty: what matters is
what the member needs NEXT (a full fee at re-entry) against what they hold, not a reserve
that item A deliberately consumed.

## TEST STATE — MEASURED BOTH WAYS. DO NOT GUESS AT THIS.

| | passing | failing |
|---|---|---|
| baseline (item A stashed) | **593** | **1** |
| with item A | **543** | **51** |

**All 50 new failures are ours.** A confident prediction in this session that
`V8_48_KeeperScan.test.js` used mock matrices was WRONG — it deploys real
`FigureEightMatrixV8` with the real `MatrixLogicLib` at test:152-157. Caught only because
the baseline was actually run instead of reasoned about.

- **The 1 pre-existing failure is inherited debt and is a TEST bug, not a contract bug:**
  `V8.46-B — cascade gas versus ladder depth`, `TypeError: Cannot read properties of
  undefined (reading 'worst')`. Log it; do not let it confuse a future run.
- `V8_48_RescueSurplus.test.js` (3) fails with *"fixture produced no parked member"* —
  **that is item A working.** The fixture parks someone at a crossing they cannot afford;
  under item A their reserve covers it and they cross. Re-fixture at a MatB re-entry,
  where a full fee is still charged.
- `V8_48_KeeperScan.test.js` (~44) asserts the refactored keeper is byte-identical to the
  frozen `MatrixKeeperPrev` (a V8.48 artifact). **The file states its own doctrine at
  test:190-199: every later item that deliberately changes behaviour gets PINNED, and
  "every pin here is an item that DID."** Item A cannot be pinned that way — it changes
  the WORLD, not a keeper parameter, and `MatrixKeeperPrev` will never know about item A.
  **This suite's premise is structurally incompatible with V8.50.** Do NOT delete it
  reflexively; decide deliberately (retire with a note / re-baseline the frozen copy /
  scope it to untouched behaviours) and record which and why.

## WHAT THE CODE DOES NOW — `contracts/MatrixLogicLib.sol`

The discriminator is **`cfg.isMatrixA`, the matrix's own immutable flag**. Crossing out of
a MatA means crossing into a MatB, which is the hop the reserve pre-funded. Everything
else enters a MatA and begins a new cycle at full fee. No interface change, and no
cross-contract read added to the money path.

**This decides the tier-upgrade question the scope told us to decide deliberately:**
upgrades arrive via the PairManager, never as the partner, so they take the full-fee
branch automatically and fund their own reserve. It cannot fall out of the diff wrongly.

- `_crossingPrice(entryFee)` — new helper, `entryFee * CROSSING_RESERVE_BPS / BPS_DENOM`
- `_crossToPartner` — charges `crossingCost`; `CrossingFunded` now reports the real total
- `enterMatrix` — pulls the crossing price on a crossing. `isCrossingEntry` is the
  destination-side twin of the source's price decision and **the two must agree or the
  transferFrom reverts on allowance.**
- `_distributePayments(..., bool skipReserveCarve)` — **the other half of item A. THE
  CARVE AND THE PRICE MUST MOVE TOGETHER:** carve on + full fee in = 10_000; carve off +
  50% in = 5_000. Either alone breaks the contract's cash balance.
- `_finalizeCrossing` — same price rule, and **now emits `CrossingFunded` (defect 5)** so
  rescued crossings stop being invisible to event tooling
- `forceCross` — **BUG FIXED:** pulled a full fee for an A->B hop, stranding 50% in the
  matrix as unattributed surplus
- `forceCrossKeeper` — **BUG FIXED:** unconditionally zeroed the reserve, erasing anything
  above the crossing price. Harmless while reserve == fee; not any more.
- `coPayRescue` / `_selfRescue` — priced at `crossingCost`, so an A->B hop needs no loan
  and no out-of-pocket payment at all
- **DELIBERATE NON-CHANGE:** the withdraw lock (`crossNeeded`, at :686 and :1345) stays at
  the FULL fee. A MatA member no longer needs it for the hop but WILL need it for the
  re-entry, and this lock is what accumulates it. Measured: **0 of 63** members at
  re-entry had withdrawn to wallet — the lock is doing all of that work. Repricing it
  would send members into MatB with nothing. The code says so; do not "simplify" it.

## NEXT, IN ORDER

1. **`MatrixKeeperLib` + `MatrixKeeper` for the zero-reserve state.** Load-bearing, see
   above. The keeper interface already has `isMatrixA()` (`MatrixKeeperLib.sol:89`, used
   at `:342`), so it can discriminate without new plumbing.
2. **`TierRouter` escrow-zero.** `MatrixLogicLib:775` passes the reserve as `escrow` to
   `handleCycleOut`; at MatB cycle-out that is now always 0, making the `escrow > 0`
   graduation branch at `TierRouter.sol:1428` unreachable and dropping members into a park
   labelled "autoReentry disabled" — a misleading reason for a healthy member.
3. **Re-fixture the tests**, and decide the `KeeperScan` question above.
4. **Scope defects 2 and 4** — `MatrixKeeper.DIRECT_EARN_BPS = 500` (dead but public, and
   wrong) and `totalEarnedOf` (the true earnings field has no getter, and the keeper's
   withdraw-ratio eviction test runs on a reconstruction that includes buffer money).
   Defect 1, the stale split comments, is DONE.
5. **Set PARAM 59 to 5000** at deploy, per the owner's decision.
6. **Second organic reading** — `logs/parked_baseline.csv` has one row for this
   deployment; a growth RATE needs two, and bigfill restarting ends the window forever.

## STATE OF THE WORKING TREE AND EVERY LOOSE END

Nothing in this session touched a chain. **No transaction was sent, nothing was deployed,
no parameter was set, the VPS keeper was never touched, and live V8.48 is exactly as it
was.** Every command run was a read or a local build/test.

**Files changed or added by session 2** (all on branch `v8.1`, contracts push to `v8.1`):

| file | what |
|---|---|
| `contracts/MatrixLogicLib.sol` | item A core. Compiles. Not deployed. |
| `V8_50_HANDOFF.md` | this file |
| `V8_50_SCOPE.md` | the measured findings section |
| `scripts/model_item_a.js` | new read-only instrument |

**Scratch files left in the repo root, safe to delete, deliberately NOT deleted here:**

- `after.txt` / `before.txt` — the two test runs behind the 593/1 vs 543/51 table above.
  Both counts are recorded in this document, so the files are redundant once read.
- `predeploy_A.txt`, `predeploy_B.txt` (2026-08-16 early), `predeploy_out.txt`
  (2026-08-13) — **these predate session 2 and are NOT ours.** They are predeploy_check
  output from the V8.49 and V8.48 deploy days. Left alone deliberately: an unexplained
  file is an incomplete handoff from an earlier session, and deleting one to tidy up
  destroys the record rather than closing the loop. Someone should confirm what they were
  for and then either log or remove them.

**Open, and each one is written up above rather than left implicit:**

1. The keeper's zero-reserve handling — **blocking, and the reason item A must not ship
   alone.**
2. `TierRouter` escrow-zero at MatB cycle-out.
3. 50 failing tests, all attributable, none mysterious.
4. The `KeeperScan` premise decision.
5. Defects 2 and 4 from the scope's list.
6. PARAM 59 -> 5000 at deploy (decided by the owner, not yet applied).
7. **The second organic reading is DONE — and it raised a question. See below.**

## ⛔ THE ORGANIC READING: 41 MEMBERS LEFT THE QUEUE AND THE FUND DID NOT MOVE

Two `diag_floor_halt.js` readings on live V8.48, 2.0 hours apart, both fully organic
(no bigfill since 03:30:44 -04:00):

```
parked          139 -> 98     (-41)
SF totalBalance $458.35 -> $458.35   (UNCHANGED, to the cent)
debtors         29 -> 23      debt total $32.74 -> $28.20
```

`logs/parked_baseline.csv` now has 2 rows for this deployment and the script printed a
trend: **"-496.1/day"**.

**DO NOT QUOTE THAT NUMBER AS THE QUEUE DRAINING.** It is the first organic trend this
project has ever had and it is almost certainly not what it looks like:

- **A rescue costs the Stability Fund money. The fund did not move by one cent.** So
  whatever removed 41 members, it was not the rescue path.
- **Debt-carrying members left too** (29 -> 23, $32.74 -> $28.20) **and the fund did not
  RISE either** — so their debt was not repaid on the way out.
- The remaining top-20 are the same addresses with the same balances, 2.0h older. The 41
  came from elsewhere in the queue.

Three candidate mechanisms, none confirmed, and they mean completely different things:

1. **Eviction.** `evictParked` releases the reserve to withdrawable, removes the member,
   leaves the debt on the SF ledger, and costs the fund nothing. If this is it, **41
   community members were evicted in two hours** — which is precisely what item B exists
   to prevent, and it makes V8.50 more urgent, not less.
2. **Ghost / residue dequeue.** The V8.48 item 45 `clearParkRecord` and item 47 valve
   remove queue entries for members who are actually seated. `diag_ghost_parked.js`
   measured **41 ghosts** on 2026-08-13 — the same number, which is either a strong hint
   or a coincidence worth ruling out. If this is it, no member was harmed and the queue
   never really held 139.
3. **Self-rescue** from members' own wallets — costs the fund nothing, but bigfill is
   stopped and these are bigfill wallets, so this is the weakest of the three.

**Do not reason further about this — measure it.** `scripts/diag_parked_growth.js` exists
and answers exactly this question: parks vs rescues vs **evictions** per day, the
repeat-park loop signature, and the SF debt financing. It is read-only:

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
Remove-Item Env:ADDRESSES_FILE -ErrorAction SilentlyContinue
node scripts\diag_parked_growth.js
```

Until that runs, treat "-496.1/day" as **an unexplained observation, not a trend**, and do
not let it into member comms or into any V8.50 justification.

One more thing the pair of readings says on its own: **the fund being unchanged to the
cent over two hours means there were essentially no new entries either** (the SF takes a
split of every entry fee). "Purely organic" may be measuring a very quiet chain. That is
worth knowing before anyone extrapolates a growth rate from it in either direction.

**Nothing else from session 2 is in flight.** No half-finished edit, no script waiting on
an answer, no chain state expecting a follow-up.

## STANDING LESSON FROM THIS SESSION

Three confident, plausible claims turned out wrong, and all three were caught the same
way — by rerunning or reading the source instead of reasoning from a convenient proxy.
A median ask 7x better than predicted (buffer money counted as member earnings). A control
that refused a verdict for an "impossible" condition that was actually normal. A
prediction that a test suite used mocks when it deploys the real library. **The pattern is
always substituting an easy observable for the question actually being asked, and the fix
is always the same: go and look.**

**This replaces `V8_49_HANDOFF.md` as the entry point.** That file is still the record of
V8.49 — what it built, what the private test measured, and the traps from deploy day.
Read it for "why is V8.49 like this"; read THIS for "what am I building now".

## READING ORDER

1. **this file**
2. **`V8_50_SCOPE.md`** — items A, B, C, D, plus the **"⬛ MEASURED ON THE V8.49 PRIVATE
   CHAIN"** section at the top. That section is data, not plan; trust it over any
   derivation elsewhere.
3. `V8_49_HANDOFF.md` — for V8.49's own history and the deploy-day mechanics
4. `V8_49_TEST_PLAN.md` — how the private test was run, and its CORRECTIONS section
   (the cohort bleed, the offsets, why sequential)

---

# 1. WHERE THINGS STAND

## Two chains exist. Do not confuse them.

| | **LIVE — V8.48** | **TEST — V8.49** |
|---|---|---|
| who is on it | **the community** | owner + bigfill only |
| addresses file | `deployed_addresses_v8_48.json` | `deployed_addresses_v8_49.json` |
| how scripts reach it | **`.env` line 69 (the default)** | **shell override ONLY** |
| MatrixKeeper | (see the v8_48 file) | `0x03Ff2184Afa458eE743c123bdb93D7804953F49D` |
| StabilityFund | (see the v8_48 file) | `0x9b3EbdE821DE116cF338021D0Ab46590ed066CF8` |
| keeper driving it | the VPS (`167.99.0.250`) | `scripts/testchain_keeper.js` on Windows |
| frontend points at it | **yes** | **no — and that is what keeps it private** |

**`.env` line 69 must STAY `deployed_addresses_v8_48.json`.** Every live diagnostic
resolves through it. The test chain is reached by `$env:ADDRESSES_FILE=...` in the shell,
which wins because `hardhat.config.js:2` calls `dotenv.config()` with no override
(verified, not assumed — `probe_addrs_env.js` is the measurement).

**Both chains are Base Sepolia.** A "private deploy" is a private DEPLOYMENT, not a
private network: the same BIP-44 index is the same address, nonce and ETH balance on
both. Two bigfills running at once will collide.

## What is running right now

- **The VPS keeper drives live V8.48 and was never touched.** It has no authority on the
  test chain — `setUpkeepCaller` was deliberately never called there, and
  `testchain_keeper.js` signs as the deployer, which `performUpkeep` accepts as `owner()`.
- **The live bigfill was STOPPED 2026-08-16 03:30:44 -04:00** and has not restarted. So
  **live V8.48 is now running PURELY ORGANIC.** This project has never measured organic
  growth — every previous rate was bigfill's. **One `diag_floor_halt.js` run against the
  v8_48 addresses is worth taking early, before anything restarts it.**
- The test chain may still have a keeper and a traffic bigfill running. Both are safe to
  stop; every figure is already in `logs/testchain_keeper.csv` and
  `logs/parked_baseline.csv` (the latter now keyed by MatrixKeeper address, so trends
  never span two deployments again).

## Branches

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.
Everything from the V8.49 run is committed through **`394c35e`**.

---

# 2. WHAT V8.50 IS

**The version the community re-registers into.** V8.49 was a private measurement and the
community never saw it. V8.50 carries the economics change, and it is ONE member-facing
deploy, not four.

Owner's framing, and the reason V8.49 stayed private:

> *"every version is a fresh deployment members must re-join, and v8.47/v8.48/v8.49/v8.50
> in four days spends all their trust."*

---

# 3. ITEM A — THE CROSSING IS PAID BY THE RESERVE

## The owner's idea, in his words

> *"the crossing fee should be used for the crossing, so no reserve fee is required at
> crossing — that makes the 50% crossing fee pay 100% crossing, which covers all the fees
> required except the reserve. The reserve is only at the beginning. So entering A costs
> 100%, 50% reserve; entering B costs 50% only, that was reserved at A. They only need a
> loan when the full A+B cycle is completed and they are short to enter A again."*

## The defect it fixes, now MEASURED not derived

`MatrixLogicLib._crossToPartner` charges the **full** destination entry fee:

```solidity
uint256 reentryFee = IFigureEightMatrixV8Cross(destination).ENTRY_FEE();
```

So a member needs **50% of the fee from earnings at every crossing**, and a member with no
referrals earns **34%** per journey (`250 direct + 1800 pool + 1350 chain = 3400 bps`).

**Observed on the test chain, thirteen members simultaneously, to the cent:**

```
reserve $5.00   withdrawable $3.40   effective $8.40   shortfall $1.60
```

That is the "84% member" — 50% reserve + 34% earnings = 84% of a $10 fee. It appears
**only once members complete FULL journeys**; earlier parkers had partial pool weight and
scattered shortfalls. **The clean number is the steady state.** 84% of cycle-outs parked
(MatA rotations 51 = 43 parked + 8 crossed); only the earliest roots, carrying the most
pool weight, funded their own crossing.

## Why it works with no re-tuning — the constants already say so

```
CROSSING_RESERVE_BPS 5000  +  DIRECT_EARN_BPS 250  +  splits 4750  =  10000
```

**The distributions consume exactly 50% of a fee. The other 50% is the member's own
reserve.** A crossing paid entirely from the $5 reserve funds the destination's L1, chain
pay, pool, treasury, SF, dev, ops, community, buyback and liquidity **identically to
today — the same dollars to every destination**. Not one split BPS changes. The owner's
instinct that *the reserve IS the crossing* is correct in the constants.

## What it changes, at T1 ($10 fee, no referrals)

| | today | with item A |
|---|---|---|
| enter MatA | $10 → $5 reserve + $5 distributed | unchanged |
| cross A → B | **$10** — reserve $5 + **$5 from earnings** → short **$1.60** → PARK | **$5 from reserve. No shortfall. No park.** |
| reserve held in B | $5 (freshly carved) | **$0 — spent on the crossing** |
| journey in B | earns 34%, **clawback eats it repaying the A→B loan** | earns 34%, **kept** |
| cycle out of B → re-enter A | $10 needed, short again → **second loan → REFUSED** | $10 needed, holds **$6.80** → short **$3.20** |
| loan events per full cycle | **2** | **1** |
| mid-cycle parking | **yes — this is the queue** | **none** |

## ⛔ THE MEASUREMENT THAT MAKES ITEM A THE RIGHT FIX

The V8.49 run found **why** the second loan is refused, and it is not what
`V8_50_SCOPE.md` item C assumed.

**14 members were refused by the insolvency floor. Every one read `memberDebt $0.00`.**
The event log (150 loans / $195.78, 65 repayments / $47.95, both matching the contract's
own `totalRescueLoaned` / `totalRescueRepaid`) shows each **borrowed exactly once and was
repaid IN FULL by the clawback**:

```
outstanding debt $0.00  -> RESCUED BEFORE x1  (lifetime borrowed $2.12, repaid $2.12)
repayments : $0.71@blk45558974  $1.41@blk45558974
```

**`0 of 14 were refused on a first loan.`**

So the causal chain is:

> loan 1 (~$1.4–2.1) granted → **clawback takes the MatB earnings that would have funded
> the next crossing** → member reaches crossing 2 with those earnings gone → asks
> **$3.43–4.06** → exceeds the **$3.40** floor → **refused and evicted**.

**Item A removes the first loan, therefore removes the clawback, therefore the member
arrives at re-entry with the full $6.80 and asks $3.20 — under the ceiling.** That is the
whole argument, and every link in it is measured except the last, which is arithmetic.

**T3's boundary is exactly 66%**, confirmed:

| effective | % of fee | advance | verdict |
|---|---|---|---|
| $6.61 | **66.1%** | $3.39 | rescued |
| $6.57 | **65.7%** | $3.43 | **refused** |

$6.60 effective produces precisely a $3.40 advance.

## ⛔ WHAT ITEM A DOES *NOT* FIX — READ BEFORE BUILDING

Per full A+B cycle a no-referral member earns **68%** of a fee and needs **100%** to start
the next one. **That 32% gap is the system's own take** — L1, treasury, SF, dev, ops,
community, buyback, liquidity — about 16% per seat, twice per cycle. **Loans defer that
gap; nothing closes it except referral income.** `CLAUDE.md` already states this is the
design.

Carried one cycle further with today's numbers: the $3.20 loan is itself clawed back, so
the member reaches the NEXT re-entry holding ~$3.60 against $10 — asking **~$6.40, far
above the floor**. **Item A roughly DOUBLES member lifetime (a full cycle instead of half)
and does not fix solvency.**

**That doubling is the real prize and it is worth stating positively:** a member who today
dies at their first crossing would complete both matrices — more pool weight, more chain
pay, more CNOVA minted, and a materially better experience for the fully passive member.
That is the owner's argument and the data supports it.

## ⚠️ THE MARGIN IS THIN — MODEL BEFORE WRITING CONTRACT CODE

$3.20 against a $3.40 floor. **That fits, barely.** Measured lifetime earnings on the test
chain ran **$2.27–$2.92**, so members below the structural $3.40 fall outside it anyway.

**THE FIRST THING TO DO IS NOT TO WRITE CODE:**

```powershell
cd C:\CryptoNite-Smart-Contracts\CryptoNova
$env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
node scripts\model_insolvency_floor.js
```

Model item A's economics against the population that actually exists on the test chain.
**The $3.20 figure is Claude's arithmetic, not a measurement.** If the model says the
post-item-A ask clusters above $3.40, item C has to move WITH item A and they ship
together.

---

# 4. TOUCH POINTS

From the scope, plus what the V8.49 run added. **Expect more; the plan is always short.**

## Contract

- **`MatrixLogicLib._crossToPartner`** — charge the reserve amount, not `reentryFee`
- **the destination's entry accounting** — accept a 50% payment and **skip the reserve
  carve**
- **`MatrixKeeperLib._triageParked` / `MatrixKeeper._doParkedRescue`** — `effectiveContrib`
  and the shortfall maths both assume a full-fee crossing
- **`exitSeat` and `evictParked` reserve release** — a member mid-cycle now holds **$0**
  reserve. Every path that releases or refunds a reserve needs to handle zero.
- **the tier-upgrade path needs its own answer** — is upgrading a NEW CYCLE (full fee) or a
  CROSSING (reserve only)? **Decide deliberately; do not let it fall out of the diff.**

## Newly identified by the V8.49 run

- **`crossingReserveOf` reads $0 for a mid-cycle member.** The frontend reserve badge
  (V8.48 item 2, `reservedHeldFor`) will show $0 to a member who is perfectly healthy.
  **That is a member-facing change and needs copy, not just code.**
- **Every diagnostic computes `effective = reserve + withdrawable`.** Under item A a
  mid-cycle member has reserve 0, so "effective" means something different.
  `diag_floor_halt.js`, `diag_seating_depth.js`, `diag_cohort_split.js` and
  `v849_watch.html` all need revisiting — and `v849_watch.html` **already under-reports**
  once the factory deploys a second pair, because it reads fixed addresses.
- **`maxItemsPerUpkeep = 15` may be unsafe.** Gas per rescue rose from **600k to 2.6M** as
  members began settling full journeys. A full 15-item batch projects to **~39M against a
  ~17.8M practical ceiling**. **A batch that fails for GAS is indistinguishable, in the
  results, from a floor failure.** Consider 5 or 10.

## Tests

**Every fixture asserting a full-fee crossing.** V8.49's much smaller change predicted 2
breakages and had 4, three of them the same hidden assumption. **Grep the suite for the
OLD justification, not just the identifier.**

---

# 5. ITEMS B, C, D

## ITEM B — no member evicted mid-cycle. SHIPS WITH A, NOT SEPARABLE.

> *"I do not want any member evicted mid cycle — they should complete their cycle before
> being evicted."*

A member parked at the A→B crossing **is** mid-cycle, and that is the main parked
population — now confirmed: 84% of cycle-outs parked there. Honouring this without item A
means either lending at every A→B crossing (what the floor exists to prevent) or leaving
them parked forever. **Item A is what makes this rule free.**

## ITEM C — LADDER VS FLOOR. ⛔ ITS STATED MECHANISM IS WRONG.

The scope describes it as a guard that arms **as debt accumulates**. **Debt never
accumulates** — the clawback repays each loan in full. Policy B refuses on **the size of a
single advance**.

So the question is not "how much debt should we tolerate" but **"how large a single ask
should the fund absorb"** — and it must be calibrated against **post-item-A asks (~$3.20,
then ~$6.40)**, never against today's $3.43–4.06, which describe a world with a first loan
and a clawback in it.

Options unchanged in form: accept / trim the ladder / raise `insolvencyFloorBps`
(PARAM 59, menu `0/1700/2500/3400/5000/6800/10000`). Note `3400` was derived as the
~34% median per-cycle earnings AND equals exactly one full journey's earnings — *"never
lend more than one full journey's earnings"* is a far more defensible way to say it in
member comms than "a median".

## ITEM D — SHALLOW SEATING. STILL UNDECIDED.

`scripts/diag_seating_depth.js` exists and its scan self-test passes exactly. **It was run
and produced no answer**, because the mechanism could not fire: idle reclaim needs
`extendedIdleTimeout` (7 days) and the test chain was six hours old, and
`MemberExitedSeat` needs a voluntary early exit bigfill never performs. **Zero backfills
was guaranteed before the first block.** The script now refuses to give a verdict in that
situation.

To settle it, one of: run a chain past 7 days · lower `extendedIdleTimeout` on a TEST
chain (as we lowered `parkedGracePeriod`) · drive early exits deliberately.

---

# 6. TRAPS — DO NOT REPAY THESE

## From the V8.49 run (all cost time on 2026-08-16)

**Nine instruments returned confident, plausible, wrong answers in one day.** Every one
substituted an easy observable for the question actually being asked:

- `predeploy_check:289` asserted a SOURCE FILE MENTIONS a filename, standing in for "the
  deploy writes the right file" — it forbade the env-override workflow outright
- a guard testing *"is the variable set"* standing in for *"did a human choose this chain"*
  — `dotenv` satisfies the former for free, so it never fired under `npx hardhat run`
- `check_nonce.js` reported *a* signer's nonce (Hardhat account #0, in-memory chain) as
  "the deployer is quiet", three times, immediately before a live deploy
- an absent-constant probe INFERRING absence from an error shape
- `-Offset` looking like cohort isolation when `SCAN_FROM` defaults to 0
- T5's spec naming `SlotReclaimed`, an event the keeper stopped emitting
- a work-type map with `3` GUESSED as `FORCE_ROTATE` (it is `CHAIN_LINK`; 6 is
  `EVICT_PARKED`)
- event signatures written from memory — wrong arity, and `args[1]` was the TIER, which
  would have been read as a dollar amount
- a baseline CSV that differenced rows ACROSS TWO DEPLOYMENTS and printed "-156/day"

**The ones that caught themselves were the ones wired to something they could reconcile
against:** `totalRescueLoaned`, `loanEligibleFor`, `occupancy()`, and a bytecode scan with
a positive control. **Give every V8.50 tool something to check itself against.**

**And the specific rule that keeps recurring:** `memberDebt` is a **BALANCE, not a
LEDGER**. A member who borrowed and repaid reads $0.00 and is invisible to every snapshot.
Use `diag_loan_history.js` (event-sourced, self-testing) for any claim about history.

## Standing repo traps

- **Claude's device-bridge git is NOT trustworthy in these mounted folders** — it cannot
  unlink `.git/index.lock` and will report a working tree that is not the real one.
  **Claude may READ files through the bridge; every git verdict comes from the owner
  running the command.** Never `git add -A`; stage by explicit path.
- **`MatrixKeeper` is a LINKED contract** — `getContractFactory` needs
  `{ libraries: { MatrixKeeperLib: <addr> } }` or it throws before any test body runs.
  `V8Governance` and `StabilityFund` are NOT linked.
- **A clock or a gate is TWO gates** — discovery (`checkUpkeep` / `MatrixKeeperLib`) and
  execution (`performUpkeep` / `MatrixKeeper._do*`). Find both before believing any
  "X happens after N". *(Checked this run: for parked RESCUE the grace is a single gate,
  in `_checkParked:560`. For EVICTION it is genuinely two.)*
- **Never draw a negative conclusion from a truncated search.** Verify the premise, rerun
  rather than assert.
- **Do not hard-code emergent numbers.** Growth rate is a dial the owner controls.
- **When a check and a setter disagree, read the setter** — it is the one the chain
  enforces.
- **A write that reads back wrong is usually a STALE READ.** `KEEPER_VPS_CONFIG.md`
  recorded this for `set_entry_thresholds.js`; it recurred on `set_parked_grace.js` this
  run. **Re-read after ~20s. NEVER re-run a state-changing command on that warning alone.**

---

# 6c. DEFECT 6 — PARKED WORK IS STARVED IN DISCOVERY (found session 5, OPEN)

**`MatrixKeeperLib.discover` fills the batch in a fixed order and `_scanParked` runs
FIFTH**, after:

1. `WORK_VELOCITY` (at most 1)
2. `WORK_CHAIN_LINK` (one per pending link)
3. the frozen-MatB sweep -> `WORK_FORCE_ROTATE`
4. `_scanMatrix` -> `WORK_GHOST` / `WORK_RECLAIM`, **walked over every position of every
   matrix of every pair of every tier**
5. `_scanParked` -> `WORK_PARKED_RESCUE` / `WORK_EVICT_PARKED`   <- here

So **parked work is only reached when the WHOLE SYSTEM has fewer than
`maxItemsPerUpkeep` ghost/reclaim items pending.** `WORK_RECLAIM` has no rate limit;
`WORK_GHOST` at least has `lastGhostTime[matrix]`.

**This was observed live and then worked around, not diagnosed.** `scripts/set_max_items.js`
exists for exactly this: *"Currently: 14 Reclaim + 1 Velocity = 15, filling the cap and
leaving zero slots for WORK_PARKED_RESCUE (type 4)."* The operator's fix was to **raise**
the cap. `contracts/test/MatrixKeeperPrev.sol` orders it the same way, so this predates
the V8.48 item-12a extraction — it is not something V8.50 introduced.

**Why this is worse than it looks.** Starving reclaim leaves a dead seat sitting; nothing
expires. Starving a parked member runs their **eviction clock** — at `evictionGracePeriod`
(7 days) a member the fund would have RESCUED is EVICTED instead. Delay does not defer
that work, it **changes the answer**. Two other queues share the problem in milder form:
`WORK_ADVANCE_EPOCH` is dead last and has a **calendar** deadline (the 25th), and
`WORK_DISTRIBUTE_CW` sits beside it.

**It blocks defect 5.** Lowering `maxItemsPerUpkeep` 15 -> 5 on gas grounds tightens the
starvation condition from "fewer than 15 pending" to "fewer than 5 pending". **The cap and
the order land together or neither lands.** The cap is therefore HELD AT 15 with the full
gas case recorded in place at `MatrixKeeper.sol:maxItemsPerUpkeep`.

## The fix, and the one thing it costs

Reorder discovery by **deadline**, not by history:

    velocity -> chain links -> PARKED -> CW distribute/epoch -> force-rotate
             -> velocity gate -> ghost/reclaim

Ghost and reclaim go LAST because they are the only work in the system with no deadline
attached. Nothing is dropped; the tail of a full batch is deferred to the next upkeep,
which for housekeeping is free.

**The cost is `V8_48_KeeperScan.test.js`.** It proves the refactored keeper and the frozen
`MatrixKeeperPrev` return **byte-identical** `performData`, and a reorder makes that false
by construction. Its own header anticipates pins for deliberate behaviour changes — but a
reorder cannot be pinned back to the old value, because the order is not a parameter.

**It does not have to be retired.** When the batch is NOT truncated both keepers emit the
same SET of work items, only in a different order, so the harness survives as
**set-identity** with no loss: all four of its recorded mutation kills (`idleSlotTimeout`
<-> `extendedIdleTimeout`, emptied chain links, hardcoded `maxItems`, wrong community
wallet) change WHICH items appear, never merely their order. Only the one truncation test
genuinely diverges, and that test should be re-premised to assert the NEW priority
deliberately.

**Sizes are not a constraint here** (`MatrixKeeper` 3,347 headroom, `MatrixKeeperLib`
15,436, `V8Governance` 11,828). The tight contracts — `MatrixPairFactory` 132 and
`MatrixLogicLib` 302 — are not touched by this.

## MEASURED 2026-08-17 — AND IT IS NOT FIRING TODAY

`diag_keeper_discovery.js` against live V8.48, block time 13:49:18Z:

    maxItemsPerUpkeep 15   pendingChainLinks 0   configuredTierCount 10
    T1: pairs=2 parked=105 pastGrace=0
         p0A occ=127/127 rot=460 parked=36
         p0B occ=127/127 rot=300 parked=69
    T2..T10: parked=0
    checkUpkeep -> upkeepNeeded true, items 1 / 15:  VELOCITY x1

**Correct the record: ZERO reclaim items exist right now.** The batch is 1 of 15. The
"14 Reclaim + 1 Velocity" signature quoted from `set_max_items.js` is V8.30-era history,
not the state of this chain — an earlier draft of this section leaned on it as if it were
current, and it is not. Defect 6 is a **latent ordering hazard**, not an active outage.
That lowers its urgency and it does NOT lower its correctness: `WORK_RECLAIM` is unbounded
and scanned ahead of parked work, so the hazard is one idle cohort away at any time, and
lowering the cap to 5 brings that cohort five times closer.

## THE THING THAT DOES NOT ADD UP: 105 parked, pastGrace 0

`parkedGracePeriod` is 24h. Every one of 105 parked members would have to have parked
within the last day. Possible on a T1 pair at rot=460/300 — but **it is also exactly what
a swallowed read prints**. `diag_keeper_discovery.js` wraps both per-member reads:

    const mem = await mx.getParkedMember(q).catch(() => ethers.ZeroAddress);
    const ts  = Number(await mx.parkedAt(mem).catch(() => 0n));

A member whose read reverts is still counted by `getParkedCount` and contributes 0 to the
age census. **This deployment is already on record returning `ARRAY_RANGE_ERROR` from
`getParkedMember` during active rescues** (section 8). So `parked=105 / pastGrace=0` has
two readings and the output cannot tell them apart — the same trap as the UTF-16
`Tee-Object` captures.

`scripts/diag_parked_ages.js` (new, read-only) settles it: it catches nothing silently,
names every failed read, prints the age histogram and the ten oldest with the numbers that
decide their verdict, and its closing verdict refuses to call the queue healthy unless
`aged == getParkedCount`. It also flags `parkedAt == 0 while queued` separately, which is
a state defect rather than a read failure — `_checkParked` reads that same slot, so the
keeper could not age such a member either.

### IT RAN — 2026-08-17 14:39Z, AND THE QUEUE IS CLEAN

    T1 p0A  queued=37  aged=37  readFailed=0  parkedAtZero=0  median 0.30d  oldest 0.85d
    T1 p0B  queued=69  aged=69  readFailed=0  parkedAtZero=0  median 0.60d  oldest 0.87d
    <1h 4   1-6h 14   6-24h 88   1-3d 0   3-7d 0   7-14d 0   14-30d 0   >30d 0
    getParkedCount 106 | aged 106 | read failures 0 | parkedAt==0 queued 0
    0 of 106 past the 24h grace.

**`pastGrace=0` was REAL.** All 106 aged with zero swallowed reads, so the earlier figure
was the queue being young, not the census failing. **Defect 6 is confirmed LATENT** — a
hazard, not an outage — and the reorder is cheap insurance rather than a fire drill.

Two things worth keeping from the reading:

- **The population is homogeneous, and it is a bigfill artefact, not an organic one.**
  Every one of the ten oldest holds exactly `$8.40` against a `$10.00` fee
  (`w=$3.40 res=$5.00`), `withdrawnRatio=0`. 88 of 106 sit in the 6-24h bucket, i.e. they
  parked before the chain went organic. Do not quote "35% of the parked queue" as an
  organic statistic.
- **`selfFundedGracePeriod` is 0.1h (6 min) live, `parkedGracePeriod` 24h.** These members
  hold $8.40 against a $10.00 crossing, so they are $1.60 short and wait the full 24h.
  Under item A a MatA parker's price is $5.00, their $8.40 covers it, `sfShare` is 0 and
  they take the **6-minute** window instead — 37 of these 106 (the p0A queue), which is
  the same effect `_triageParked` already records as "35 of 35 on the live chain, 76 of
  139 parked members across all tiers". Item A does nothing for the 69 MatB parkers; a
  MatB re-entry is still a full fee.
- **The whole 6-24h bucket crosses the grace within hours of each other.** 88 members
  become discoverable at nearly the same instant, against `maxItemsPerUpkeep` 15. That is
  the contention defect 6 is about, arriving on a timer.

### DONE — the reorder shipped

`MatrixKeeperLib.discover` now drains **bounded** sources first (velocity, chain links,
CW distribute+epoch, force-rotate, velocity gate), then runs the two **unbounded** scans
by deadline: **parked, then ghost/reclaim**. The rule is stated in full at the top of the
reordered block. No new storage, no new parameter, no bytes — the same code in a
different order.

`V8_48_KeeperScan.test.js` moved from byte-identity to **set-identity** (`canon` /
`expectSameSet`), its PARAM-59 sweep now matches flips **by member instead of by slot**
(index matching would have reported every item as flipped and started passing on noise),
and its truncation case was re-premised: the two keepers must still truncate to the same
SIZE, but which work survives is asserted against the NEW priority, not against Prev. A
new case, `DEFECT 6: parked work outranks ghost/reclaim`, squeezes the cap to 1 and
states the property on its own so it cannot quietly stop being tested.

**Still open — defect 5 (the cap).** Held at 15. The 2.6M-gas-per-rescued-item figure it
rests on predates items A and E1, and the reading above says item A turns a third of this
queue into `sfShare == 0` rescues with no SF round trip at all. **Measure post-item-A
rescue gas in a fixture before setting the cap** — that is a local test, no chain needed,
and it replaces a pessimistic estimate with a real number.

## DEFECT 7 — THE KeeperScan PINS NEVER COLLAPSED ANYTHING (found session 5, FIXED)

Surfaced by the V8.50 run, but it has been wrong since V8.48. `deployBoth()` pinned the
refactored keeper's `selfFundedGracePeriod` and `evictionGracePeriod` to **0** so the
frozen `MatrixKeeperPrev` — which has neither concept — stayed comparable. But
`_checkParked` gates on

    age < (sfShare == 0 ? selfFundedGracePeriod : parkedGracePeriod)
    age < (isGhost      ? parkedGracePeriod     : evictionGracePeriod)

and Prev gates BOTH on `parkedGracePeriod`, **which the pins left at its 6h default.**
Setting the new keeper's two windows to 0 does not collapse the split — it opens it as
wide as it goes: V8.50 discovers a self-funded rescue and fires an eviction IMMEDIATELY
where Prev waits six hours. The missing line was `setParkedGracePeriod(0)` on BOTH keepers.

**Why the setters force zero.** `setSelfFundedGracePeriod` enumerates 0/60/300/900/1800/
3600; `setEvictionGracePeriod` enumerates 0/1d/2d/3d/4d/5d/7d. **They intersect at 0 and
nowhere else.** "Set each equal to `parkedGracePeriod`" — the collapse the file header
describes and `EC-4` asserts — is only REACHABLE with all three at zero. Any other value
is unsettable, so any test that claims to pin them at a nonzero window is not pinning
anything.

**The grace-period walk was doing exactly that.** It set
`setSelfFundedGracePeriod(g === 0 ? 0 : (g >= 3600 ? 3600 : 300))` under a comment
claiming the windows were "pinned together" — a one-hour self-funded window against a
thirty-day loan window — and never restored the value, so every later test in the shared
world inherited an un-collapsed split. Real, and worth fixing on its own.

**⚠ CORRECTION, AND IT MATTERS MORE THAN THE FINDING.** The first write-up of this section
blamed that expression for six of the eight failures. **That attribution was wrong.** The
next run — with the pins corrected — failed six times again, and the output made the real
cause unmissable: **both keepers were returning exactly 15 items, the cap**, one filled
with `PARKED_RESCUE` and the other with `RECLAIM`.

    new: VELOCITY, FORCE_ROTATE, PARKED_RESCUE x12, RECLAIM      (15 = cap)
    old: VELOCITY, FORCE_ROTATE, RECLAIM x13                     (15 = cap)

**The batch was TRUNCATING in the shared world, and neither keeper was wrong.** Defect 6
reordered discovery precisely so that a full batch keeps parked work and sheds
housekeeping; Prev is frozen doing the opposite. Once the cap bites, no content comparison
against Prev can mean anything — the difference IS the fix.

Twice in a row a mechanism was reasoned out and asserted before it was measured, and both
times the measurement said something else. The lesson is the one this project already
knows: an explanation that fits the numbers is not the same as the explanation, and
"3 items vs 2, batch not full" should have prompted a check of what the cap actually was
rather than a theory about grace windows.

### The fix: a FOURTH pin — the batch must not truncate

`deployBoth()` now raises `maxItemsPerUpkeep` from the 15 default to the enumerated
ceiling of **40**, so the shared world discovers everything and the two keepers emit the
same SET in a different sequence — which is what `expectSameSet` is for. This file asks
one question, "did the 12a extraction preserve which member gets which verdict", and batch
sizing was never that question. The two sizing cases set the cap deliberately and restore
it to 40 rather than 15.

⚠ The pin holds only while the fixture stays under 40 discoverable items. Measured union
today is roughly 30 (2 bounded + ~14 parked + ~14 reclaim, `MATRIX_SIZE` 7 across two
matrices). **If both keepers ever report exactly 40, suspect this pin before anything
else.**

Rewritten honestly: full equivalence at `g == 0` where it is reachable, and elsewhere the
real safety property — every item Prev queues, V8.50 must queue with the SAME verdict (a
shorter window can only bring work forward, never withhold it), and any extra item must be
one of the two PARKED verdicts, never a ghost, reclaim or chain link.

**It passed for two versions because the fixture never reached the state.** That is the
blind spot the comment directly above those pins warns about, reintroduced by the pins
written to prevent it. Worth stating plainly: the harness was green on luck, not on proof.

### The other two failures were the reorder, working

The idle sweep and the mutation probe park a dozen members against a cap of 15. With
parked work now ahead of ghost/reclaim it fills the batch and squeezes the sweep out —
measured new = 12x `PARKED_RESCUE` + 1x `GHOST`, old = 13x `GHOST`, both exactly 15. Both
keepers still truncate identically; what breaks is that the GHOST/RECLAIM classification
those tests exist to check becomes unobservable, which would have turned a MUTATION PROBE
into a test passing because it sees nothing. Both now raise the cap to 40. Truncation
priority is covered separately and deliberately.

### Still unexplained, and recorded rather than guessed

Why defect 7 surfaced on THIS run and not on the earlier three-file run. The reorder does
not change what is discovered in an untruncated batch, so the working assumption is that
the shared fixture's parked population differs between running KeeperScan alone and
running the full suite. **Not proven.** The fix stands on its own merits either way.

### `setMaxItemsPerUpkeep` is enumerated — 5/10/15/20/30/40

There is no cap of 1. The first draft of the new `DEFECT 6` test asked for one and
reverted with `MK: invalid max items`. Five is the floor, and five slots are not all
contested (velocity, chain links, CW, force-rotate and the velocity gate drain first), so
the property is stated as an implication instead: **if any housekeeping item is in a
capped batch, every parked decision must already be in it.** That is what starvation
violates, and it survives the enumeration changing.

---

## DEFECT 5 — CLOSED. maxItemsPerUpkeep 15 -> 5, MEASURED (2026-08-17)

`test/V8_50_KeeperGas.test.js` (new) builds a real world — no mocks — and costs a whole
`performUpkeep`, because the failure mode is a transaction running out of gas and gas is
consumed by transactions, not by items in isolation.

### Per item, MATRIX_SIZE 7

| item | median | max |
|---|---|---|
| SF-funded rescue | 1.49M | **1.76M** |
| self-funded rescue (item A) | 0.92M | 0.92M |
| eviction | 0.09M | 0.10M |
| ghost / reclaim | 0.04M | 0.04M |

**An SF-funded rescue costs 1.62x a self-funded one.** That is item A's gas dividend,
measured. An eviction is 18x cheaper than a rescue; a reclaim 44x.

### ⚠ THE BATCH TABLE IS A TRAP AND IT CAUGHT ME FIRST

GAS-1 costs the batch this fixture happens to produce, and it FLATTENS above cap 10 —
4.52M, 4.67M, 4.71M, 4.90M — with every cap "fitting" the 17.8M ceiling, up to 40. The
mix column says why: **this world only ever offers four `PARKED_RESCUE` items**, and every
slot above that fills with `RECLAIM` at 0.04M. The first draft of the test printed
"the largest cap under 17.80M is 40" as its conclusion. That would have been the same
class of error the whole exercise existed to correct — quoting a number whose population
had changed underneath it.

### THE VERDICT: a SATURATED batch, which defect 6 made ordinary

Discovery now takes parked work FIRST, so a deep parked queue yields a batch of rescues
and nothing else. That is no longer the pathological composition, it is the normal one
whenever the queue is deep — and a 25-member fixture cannot build it, so GAS-4 projects
it from the worst rescue actually measured.

    cap   projected   vs 17.8M   verdict
      5       8.82M       49%    fits
     10      17.64M       99%    fits, no margin whatsoever
     15      26.47M      148%    EXCEEDS
     20      35.29M      198%    EXCEEDS

**And that is the generous end.** MATRIX_SIZE here is 7; live tiers run 127, where the
V8.49 chain measured ~2.6M for the same item. At live size: **5 -> ~13M (73%) fits,
10 -> ~26M (146%) EXCEEDS.** Ten survives in the small world and fails in the real one,
which is precisely why the value is 5 and not the 10 the local table would permit.

**Set to 5 — for about an hour.** Then defect 8 replaced the control entirely and the cap
went to **20**. Both moves are correct and the sequence is the point: 5 was the right
answer to the wrong question.

### DEFECT 8 — THE GAS FLOOR (built same session, owner directive: nothing deferred)

**⛔ CORRECTION FIRST, BECAUSE THE DEFECT 5 REASONING ABOVE CONTAINED A FALSE PREMISE.**
An earlier draft of this document and of the `maxItemsPerUpkeep` docstring both said an
out-of-gas batch "reverts WHOLE". **IT DOES NOT.**

Every work item is dispatched as `try this._doXExternal()` — an external self-call. Under
EIP-150 a sub-call receives 63/64 of the remaining gas, so when the batch runs dry the
sub-call burns its 63/64, reverts on out-of-gas, and **the catch fires**. The loop then
continues with 1/64 of nothing and every remaining item fails the same way.

**So exhaustion presents as a CASCADE of `WorkItemFailed` events** — indistinguishable
from a floor refusal, an SF exhaustion, or an already-rescued member. The transaction
succeeds. The keeper looks like it ran. This is worse than a revert and it is the exact
shape that cost a day of misdiagnosis on 2026-07-30.

**The fix.** `MatrixKeeper.minGasPerItem` (default `3_500_000`, DAO param 63, menu
2.5M / 3.5M / 5M / 7.5M) is checked with `gasleft()` **before** dispatching each item;
below it the loop emits `BatchGasHalted(processed, total, gasRemaining)` and **breaks**.

- A break, not a revert: reverting would discard the items that ALREADY SUCCEEDED in this
  transaction, which is the opposite of what a gas guard is for. The skipped tail stays in
  the queue and `checkUpkeep` rediscovers it next tick.
- The floor MUST exceed the worst single item or it lets the batch enter work it cannot
  finish and the cascade returns one item later. 3.5M clears the ~2.6M a live-size rescue
  measured, with ~35% margin. `GAS-6` asserts this against the measured worst item AND
  separately against the known live figure the small world cannot see.
- Measured working: `GAS-5` hands a 20-item batch 12M against a 7.5M floor and it halts at
  **9 of 20 with 6.46M remaining**, with the tail still discoverable afterwards.

### AND THAT IS WHY THE CAP WENT UP, NOT DOWN

A count is the wrong unit. An eviction costs 1/18th of a rescue, a reclaim 1/44th, so any
count sized for the worst mix throws away nearly all the throughput on the common one —
GAS-1 measured a 28-item batch at 4.90M, a quarter of the ceiling, where a cap of 5 would
have run six items and stopped. With the floor doing the safety work, `maxItemsPerUpkeep`
is **20**: a batch of evictions runs all 20 for ~2M, a batch of rescues still stops after
four or five, and nothing has to predict in advance which it is.

Not 40: `performData` is calldata on the way back in, and `_scanMatrix` walks every
position of every matrix before the cap binds. 20 is the largest DAO menu value that keeps
both modest.

**Sizes after defect 8:** MatrixKeeper 21,590 (+381, 2,986 spare), V8Governance 12,824
(+76, 11,752 spare). The tight pair is untouched — MatrixPairFactory 24,498 (78),
MatrixLogicLib 24,274 (302).

---

## SUITE GREEN — 602 passing / 7 pending / 0 failing (2026-08-17, after defect 8)

After `npx hardhat compile --force`. That is the first CONFIRMED green run of V8.50; the
earlier "595/0" in this document was a projection that was never executed, and it should
not have been written as a result.

The road there, because the failures were more instructive than the pass:

| run | failing | cause |
|---|---|---|
| 1 | 8 | 6 x un-collapsed split grace (defect 7) + 2 x idle-sweep truncation |
| 2 | 1 | the new DEFECT 6 test asked for `maxItemsPerUpkeep(1)`; the setter enumerates 5/10/15/20/30/40 |
| 3 | 6 | **the real cause** — the shared batch truncating at 15, misattributed in run 1 |
| 4 | 0 | fourth pin: `maxItemsPerUpkeep` 40 in `deployBoth()`, no truncation |

**Five tracked files are CRLF-only churn and must stay OUT of any commit** — verified with
`git diff --ignore-all-space --ignore-blank-lines`, which comes back empty for each:
`scripts/deployed_addresses_v8_30/31/40.json`, `contracts/test/CryptoNovaCommunityWallet.sol`,
`archive/windows_keeper/corescue.bat`. The address files matter especially: a 148-line
diff on a `deployed_addresses_*.json` looks exactly like a repoint, and here it is nothing
at all. Check them the same way before every commit rather than trusting the line count.

---

**Owner decision, still open:** whether parked work may take the WHOLE batch when the
queue is long, or whether housekeeping keeps a reserved slot or two. **The reorder as
shipped lets parked take the whole batch** — defensible because parked work drains (a
rescue or an eviction removes the item) while housekeeping has no deadline to miss, but
it is a policy choice and it is reversible with a reserved-slots param if the owner wants
one.

---

# 6f. ⛔ THE SECOND ORGANIC READING — THE LOOP IS REAL AND THE FUND IS UNDERWATER

`node scripts/diag_parked_growth.js`, 2026-08-18, blocks 45,060,000..45,645,471
(2026-08-05 -> 2026-08-18, ~13.6 days). Read-only. This is the second organic reading the
handoff has been asking for since 2026-08-16, and it is the most consequential measurement
of the V8.50 work.

## 1. THE LOOP SIGNATURE — MEASURED, NOT INFERRED

    758 park events across 339 unique members
    1x: 59      2x: 167      3-5x: 113      6-10x: 0      11+: 0
    REPEAT SHARE: 48.2% of all park events come from members who parked 3+ times

**ONLY 59 OF 339 MEMBERS PARKED ONCE AND STAYED OUT. 82.6% CAME BACK.**

That is the rescue -> SF debt -> re-seat -> cycle out underfunded -> park again cycle,
observed directly. **A later run the same night, after the exit-counting fix, read 773 park
events across the same 339 members — 1x:57, 2x:161, 3-5x:120, 6-10x:1 — a repeat share of
51.0% and 83.2% of members returning at least once.** The direction is stable across runs.

⚠ **THE RATE CLASSIFICATION IS A COIN FLIP AND MUST NOT BE QUOTED AS A VERDICT.** The
script calls the loop real when an ACCELERATING rate joins the other two criteria. It
printed ROUGHLY LINEAR on one run (149.7/day) and ACCELERATING on the next (154.7/day) —
but its threshold is `lastThree > firstHalf * 1.5`, i.e. **154.5**, so the second run
crossed by **0.2 parks/day**. At that precision the label is noise, not a finding. What is
solid: the park rate is rising roughly 50% and sitting exactly on an arbitrary threshold.
**Do not report "all three criteria met".** The repeat share and the climbing SF
outstanding carry the loop conclusion on their own; the rate neither adds to it nor
subtracts from it at this precision.

## 2. THE FINANCING — THE FUND HAS LENT 2.4x WHAT IT HOLDS

    CONTRACT counters (ground truth)   loaned $961.65   repaid $443.41   OUTSTANDING $518.24
    SF totalBalance, same night                                          $212.35

    net-outstanding-delta by day:  08-13 +$0.33   08-14 +$34.58   08-15 +$96.66
                                   08-16 -$44.04  08-17 +$258.17  08-18 +$167.35

**Outstanding debt is 2.4x the remaining balance, and the last two days added $425.52 of
net new debt.** Independently corroborated: `model_item_a.js` PHASE 1 read SF totalBalance
four times across ~9.7 hours tonight — $262.79 -> $259.49 -> $243.19 -> $212.35, monotonic,
about -$5.20/hour or ~-$125/day. Two different instruments reading different events agree
on the direction and roughly on the rate.

⚠ TESTNET, BIGFILL STOPPED. Do not extrapolate a runway figure to mainnet demand. The
DIRECTION is the finding, not the date it reaches zero.

## 3. WHAT THIS DOES TO V8.50's FRAMING

**Item A stops being a throughput improvement and becomes the fix.** Every sample tonight
put the MatA crossing at **62-65% of ALL funding parks, ~$724 of lending**, and PHASE 2
confirmed 67-75 of 67-75 MatA parkers are freed OUTRIGHT — the reserve covers the halved
crossing price with no fund involvement at all. E1 handles the other half by carrying the
member's balance so the MatB re-entry is affordable. Together they attack both legs of the
loop the section above measures.

The live crossing buffer reads **3600 bps** and V8.50 ships `crossingBufferBps` at **0**.
Every rescue today seeds 36% of the fee into the member's withdrawable as FUND money. That
was recorded as a tuning decision; against a fund that has lent 2.4x its balance it is
better read as part of the same repair.

## 4. ⛔ TWO THINGS IN THIS OUTPUT THAT DO NOT ADD UP — OPEN, NOT EXPLAINED

**(a) ✅ RESOLVED SAME SESSION — A SNAPSHOT RACE, AND MY HYPOTHESIS WAS WRONG.**

The script printed `VERDICT INPUTS (no holes — complete)` and, four lines earlier,
`EVENTS DO NOT RECONCILE`:

    events   loaned $956.46   repaid $443.41
    counters loaned $961.65   repaid $443.41      gap: $5.19 on the LOANED side only

**I proposed a lending path that emits no event. Reading the source killed it:**
`StabilityFund` has exactly ONE writer of `memberDebt[member] +=` (:941) and exactly ONE
of `totalRescueLoaned +=` (:942), in the same function, emitting at :945 with the SAME
`amount`. No silent path exists, and none ever did.

**`scripts/diag_sf_debt_reconcile.js` (new) found the real cause.** Scanning the same fund
from block 0: **EXACT on both sides — $966.84 / $966.84 and $443.41 / $443.41.** And its
counter read $966.84 against the growth script's $961.65 — **the counter had moved by
exactly the missing $5.19.**

`diag_parked_growth.js` scans ~585k blocks across 22 matrices (minutes of wall clock) and
then read the counters at the CURRENT head while its events stopped at `tip`. On a live
chain the counters are ahead by whatever was lent during the scan. At the ~$211/day rate
that script itself measures, $5.19 is about 35 minutes — the length of the scan.

**FIXED:** the counter read is now pinned with `{ blockTag: tip }`, so both sides describe
the same instant, and the misleading "some ranges dropped" text is gone. If they ever
disagree again, the message says outright that scan timing does NOT explain it.

**⚠ THE LESSON, WHICH IS THE SAME ONE AS THE TRUNCATED BATCH AND THE SWALLOWED CENSUS:**
the instrument's own two statements contradicted each other — "no holes" and "does not
reconcile" — and that contradiction, not the numbers, was the finding. The wrong
explanation was reached first, twice, by reasoning instead of measuring. **The event-derived
debt totals were never wrong.** Nothing quoted from them needs revising.

**(b) ✅ RESOLVED SAME SESSION — THE SCRIPT COULD NOT SEE THE KEEPER'S OWN RESCUES.**

Cumulative-net read 212 against a live queue of 105. `MatrixLogicLib` has **ELEVEN** call
sites of `_removeFromParkedQueue`; the `net` column knew about **three**:

| exit | was it counted? |
|---|---|
| `CoPayRescue` (:1663), `SelfRescue` (:1754), `MemberEvicted` | yes |
| **`forceCrossKeeper` (:1601) — the keeper's automated rescue** | **NO** |
| `GhostDequeued` (:1825 / :1855 / :1863) | NO |
| `enterMatrix` re-entry (:400), `forceCross` (:1536), `exitSeat` (:1803), `deductForUpgrade` (:1913) | **emit nothing at all** |

**The keeper's rescue was missed for a specific and memorable reason: its event
`ParkedRescued` is emitted by `MatrixKeeper`, not by the matrix**, and the script only ever
read matrix events. That one omission is most of the gap.

**FIXED and re-measured: cumulative-net 108 against a live queue of 106.** The `keeper`
column carries 110 previously invisible exits. The residual 2 is the four silent paths,
which no event scan can ever subtract — `net` is now labelled an UPPER BOUND and
`getParkedCount` is the only exact figure. (`RescueLoanIssued` is not a usable substitute:
it is guarded on `totalLoan > 0`, so a self-funded rescue emits nothing there.
`ParkedRescued` always fires — checked, because V8.50 makes self-funded rescues the common
case and it would otherwise have been a real observability regression.)

**⚠ THE HEADLINE FINDINGS WERE NEVER AFFECTED.** The repeat share is computed from park
events alone and the financing verdict rests on the contract counters. Only the `net` and
`cumulative-net` columns were wrong, and they overstated growth.

Neither of these changes the two headline findings — the repeat share comes from park
events alone, and the financing verdict rests on the CONTRACT COUNTERS, not the events.
But both need closing before this document's numbers are quoted as exact.

---

# 6e. THREE SAMPLES IN ONE NIGHT — THE VERDICTS HOLD, THE FIGURES DO NOT

`model_item_a.js` was run three times on 2026-08-18 as phases were added. The chain was
live throughout, so each run is an INDEPENDENT SAMPLE of a moving population. That was not
the intent, and it turned out to be the most useful thing about it.

## ⛔ THE UNDERLYING FIGURES ARE VOLATILE. DO NOT QUOTE A POINT VALUE AS "THE" NUMBER.

`WHAT ONE COMPLETED JOURNEY EARNS`, the same quantity, measured three ways:

| when | n | min | median | max |
|---|---|---|---|---|
| 2026-08-16 | 63 | $3.40 | **$4.83** | $6.34 |
| 2026-08-18 block 45630741 | 33 | $3.40 | **$3.40** | $10.90 |
| 2026-08-18 block 45642648 | 38 | $3.40 | **$6.55** | $10.15 |

**The median nearly doubled in under seven hours** (~12,000 blocks). Other figures moved
with it — the re-entry ask went from a $2.85 median to $0.00, and the top ladder band from
8 members to 20. **Item C's case for raising the floor rested on the $4.83 median.** That
number is not reproducible; it is one draw from a distribution that also produces $3.40
and $6.55. Any future argument built on a single run's median is built on sand.

The MINIMUM is the stable figure: **$3.40 in all three samples**, exactly the structural
no-referral floor (250 direct + 1800 pool + 1350 chain). That is the number to reason with.

## ✅ AND THE VERDICTS SURVIVED ALL THREE, WHICH IS WHY THEY CAN BE TRUSTED

Every conclusion recorded tonight was reached on one sample and then, by accident, re-run
on two more:

| verdict | run 1 | run 2 | run 3 |
|---|---|---|---|
| PARAM 59 at 3400 refuses | 1 of 40 | 1 of 33 | 1 of 38 |
| PARAM 59 at 5000 refuses | 1 (same) | 1 (same) | 1 (same) |
| members below the 4000 rung | 0 | 0 | 0 |
| presets 2/3 rescue additionally | 0 | 0 | 0 |
| can afford T2 at cycle-out, item A | 0 of 39 | 0 of 33 | 0 of 38 |
| shallow seats | — | 0 of 1534 | 0 of 1412 |
| SlotReclaimed | — | 0 | 0 |

**Nothing moved.** The decisions are robust to a population that churned substantially
underneath them, which is a much stronger claim than any of them had when it was made.

## THE 5 -> 6 CO-MOVEMENT: the MemberEntered identification just got firmer

PHASE 9's position-0 count and PHASE 4's "deferral parks (shortfall 0)" were both **5** in
run 2 and both **6** in run 3. Two independently computed counts moving together across
samples is far better evidence that they are the same events than a single coincidence
was — the earlier note calling the cross-check "suggestive rather than conclusive" was
right to hedge, and the hedge has now been partly discharged. Still not proof: both park
paths emit `MemberParked(member, 0)` and only `:534` also emits `MemberEntered`.

## WHAT THIS MEANS FOR THE NEXT SESSION

**Run the model more than once before deciding anything.** A single run is a sample, not a
measurement, and this chain moves fast enough that the difference matters. Where a verdict
is a COUNT AT A THRESHOLD it appears stable; where it is a MEDIAN it is not.

---

# 6d. THE TWO OWNER DECISIONS — BOTH SETTLED 2026-08-18, BOTH "NO CHANGE"

Settled against `scripts/model_item_a.js` PHASE 7 (added for this), read on the live
V8.48 chain, 40 MatB parkers, post-E1 basis.

## PARAM 59 `insolvencyFloorBps` — STAYS AT 3400

    1700 -> refuses 35 of 40      3400 -> refuses  1   <- live default
    2500 -> refuses 32            5000 -> refuses  1   <- the proposal. SAME MEMBER.
                                  6800 -> refuses  0

**Raising 3400 -> 5000 refuses the identical member.** The change that opened this item
buys nothing measurable. Only 6800 moves the outcome, and that one member is one of the
two carrying existing debt — the exact case the floor exists to refuse. Nearly doubling
the ceiling to reach them inverts the mechanism.

**⚠ PHASE 5 AND PHASE 7 DISAGREE HERE AND PHASE 7 IS THE ONE TO QUOTE.** Phase 5's sweep
reports 3400 clearing 40 of 40; phase 7 reports one refusal. Different models: phase 5
compares the raw ask to the ceiling, phase 7 does what policy B does — trims the advance
to `min(sfShare, shortfall)` and adds EXISTING debt. Phase 5 is the optimistic bound.

## SF rescue ladder bottom rung — STAYS AT PRESET 1 (4000)

    10000+  6 | 8000-8500  3 | 7000-7500 24 | 6500-7000  7 | BELOW 4000  0

Nobody is off the bottom. Preset 2 would additionally rescue 0; preset 3, also 0.

**The ~3400 worry was a PRE-E1 artefact.** It only exists on the ledger basis, where
item A strands journey-A earnings in a MatA ledger the re-entry gate cannot read. E1
carries them across, so the whole population sits at 6500 bps and up. **E1 did not just
close the conservation hole — it removed the reason to touch the ladder.**

## What this run also established, independent of the decisions

- **Item A's premise holds on chain, exactly: 67 of 67 MatA parkers freed outright.**
  $103.35 of real shortfall becomes $0.00.
- **Item A removes 64.7% of all funding parks** — 458 of 708 — and $727.03 of lending.
- **Phase 3 reconciles on all 171 self-funded crossings**, with the 50/50
  reserve/withdrawable split falling out structurally rather than by coincidence.
- **The live crossing buffer is 3600 bps; V8.50 ships `crossingBufferBps` at 0.** Already
  a recorded decision with the knob documented at the declaration, but it means rescued
  members stop being seeded 36% of the fee as SF money. Watch it wherever V8.50 first runs.
- **MatB parkers carrying debt: 2 of 40**, and `_crossToPartner` claws back HARDER under
  item A, not softer — the member arrives holding more.

## ⚠ BOTH DECISIONS REST ON A PROJECTION, NOT A RUNNING SYSTEM

E1 is not deployed. The live chain is V8.48, so PHASE 7 projects V8.50 onto today's
members. Neither decision should be treated as settled for a running system until V8.50
runs somewhere and the model is re-read there. Both were "no change", so nothing is at
risk from the projection being wrong — but a FUTURE change to either must not cite this
table as if it were a measurement of V8.50 in operation.

## Also open, and it bit this session

`model_item_a.js` treats an RPC **503** as "constant unreadable" and aborts. Refusing to
assume `CROSSING_RESERVE_BPS` is correct — guessing it would corrupt every number
downstream — but a busy endpoint and a missing selector are different failures sharing
one code path. It needs a retry wrapper that distinguishes transport errors (503, 429,
timeouts, resets) from genuine call failures, and only declares a value unreadable after
several attempts. Same discipline as `diag_parked_ages.js`. **Do not "fix" it by changing
the endpoint** — public endpoints were tried in this site's read pool and removed.

---

# 6g. ⚠ FOUR COMMIT MESSAGES HAVE MANGLED DOLLAR FIGURES — THE HANDOFF IS THE RECORD

`git log` bodies for **`fe3f594`, `da622c1`, `56140d3`, `2011eed`** contain 16 destroyed
figures: `$956.46` reads as `\.46`, `$5.19` as `\.19`, and so on.

**CAUSE:** the messages were passed as `git commit -m "...\$956.46..."` from PowerShell.
`\` is NOT PowerShell's escape character — a backtick is. So `\$956` became a literal
backslash plus the EMPTY variable `$956`, and every dollar amount lost its digits. The
three clean commits of that session are clean only because they contained no `$` figures.

**NOT REWRITTEN, DELIBERATELY.** Every one of those figures is correct and intact in this
document, which is the authoritative record; the commit bodies are secondary. Force-pushing
four commits to fix presentation would trade a real risk for a cosmetic gain.

**THE FIX FOR NEXT TIME — WRITE THE MESSAGE TO A FILE:**

    # Claude writes .git/COMMIT_DRAFT.txt, then:
    git commit -F .git/COMMIT_DRAFT.txt

`-F` reads the file verbatim. No interpolation, no escaping, no quoting rules, and it
handles the em-dashes and unicode this project's messages are full of. **Use it for any
commit message longer than one line.** `.git/` is not tracked, so the draft never becomes
a stray repo file.

---

# 7. HOW WE WORK

Claude drives, decides direction, and makes the file edits directly. **The owner runs
every command** — tests, git, chain reads, VPS — and reports back. Give copy-paste blocks
that name the folder they run in, **one step at a time, and wait for "done"**. Explain in
plain language; the owner is not deep on the technical side and leans on Claude as a
mentor. **Do not ask which item to take next — decide.**

Contracts push to **`v8.1`**. `admin → preview → main` is the FRONTEND repo only.

**Write docs and handoffs for a future session of Claude plus the owner. Nobody else
touches this code, so anything unexplained is an incomplete handoff from a past session:
verify it and close it rather than working around it.**

⛔ **AND STOP WRITING "WHOEVER PICKS THIS UP".** Owner correction, 2026-08-18. There is no
third party and there never has been. Every line here was written by a previous session of
Claude and executed by the owner. "Whoever picks this up" is **future-Claude reading its
own notes** — vague attribution invites vague standards, and a note addressed to nobody in
particular gets written to nobody's standard. Address it to yourself.

# ⛔ 7a. THE TWO RULES — OWNER-SET 2026-08-18, AFTER A SESSION THAT EARNED THEM

## RULE 1 — DO NOT HYPOTHESISE UNLESS NECESSARY.
## RULE 2 — MEASURE AND TEST BEFORE IMPLEMENTING. NEVER BUILD ON A HYPOTHESIS.

These are not general advice. They were set because of a specific, repeated failure in the
2026-08-18 session, and the evidence is worth keeping so the rules do not decay into slogans.

**EVERY WRONG ANSWER THAT SESSION CAME FROM REASONING AHEAD OF MEASURING:**

| the hypothesis, asserted confidently | what measurement said |
|---|---|
| "A lending path emits no event — find the silent path" | ONE writer, ONE emitter, same function. It was a **snapshot race**: counters read at the head after a multi-minute scan. |
| "Six KeeperScan failures are an un-collapsed split grace" | The **batch was truncating at 15**. Both keepers full, keeping different work by design. |
| "0.32% of entries are shallow seats — item D is real" | Position 0 **is not a seat**. Those were parks. Zero reclaims had fired, which made it impossible on its face. |
| "Item A accelerates tier progression; recalibrate the gates" | Measured on **V8Elevator's fixture ladder**. Live T2 is $25.00 and NOBODY upgrades at cycle-out in either world. |
| "The suite is at 595 passing / 0 failing" | Never executed. It was a **projection written as a result**. |

**AND EVERY CORRECT ANSWER CAME FROM BUILDING AN INSTRUMENT FIRST:**
`V8_50_KeeperGas.test.js` (the cap, measured not estimated) · `diag_parked_ages.js` (the
census with nothing swallowed) · `diag_sf_debt_reconcile.js` (the $5.19) · PHASE 7/8/9 of
`model_item_a.js` (both owner decisions, the tier gates, item D).

## HOW TO OBEY THEM IN PRACTICE

1. **When two numbers disagree, THE DISAGREEMENT IS THE FINDING.** Do not explain it —
   measure it. `no holes` beside `EVENTS DO NOT RECONCILE`; five shallow seats beside zero
   reclaims; a batch fitting the ceiling at every cap. Each contradiction was the whole
   answer and each was nearly explained away first.
2. **A number you have not run is not a result.** Never write a measurement in the past
   tense until it has executed. If it is a projection, label it a projection in the same
   sentence.
3. **Build the instrument before the fix.** It is cheaper than a wrong fix and it is the
   only thing that tells you the fix worked. Three V8.50 scope items closed with NO code
   change once measured.
4. **State the basis with every figure.** Which ledger, which deployment, which block,
   which matrix size. The 3400/5000 reversal happened because a floor was calibrated
   against a total the enforcing code could not see.
5. **One sample is not a measurement.** A count at a threshold held across three runs; a
   median nearly doubled in seven hours. Run it again before deciding.
6. **When a hypothesis IS necessary — and sometimes it is — say so out loud, mark it
   UNVERIFIED, and put measuring it at the top of the list.** Rule 1 says "unless
   necessary", not "never". What is forbidden is letting an unmarked guess become the
   basis for code.

---

# 8. OPEN, HONESTLY STATED

- **T6 was never answered — the V8.49 run had NO VALID CONTROL.** Self-rescue only happens
  WHILE that cohort's bigfill process is alive; cohort A's exited after registration, so it
  took 58 loans at `-SelfRescueRate 1.0` and behaved as a second subject. Run 2 must keep
  the control's bigfill alive AND confirm its members reached crossings before reading its
  loan count.
- **`SELF_RESCUE_RATE = 0` is a pathological extreme, not a population.** Real members can
  top up and pay. **Self-rescue does not remove the ~32%-per-cycle gap — it moves who
  absorbs it, into a recurring ~$3.20-per-cycle out-of-pocket cost at T1.** That is the
  number V8.50 should be judged on, and the honest one for member comms.
- **No end-to-end test that a real rescue books `shortfall` and nothing more.** The
  aggregate is consistent with it and the buffer is 0 by construction, but there is still
  no per-member assertion. Closing it means a `forceCrossKeeper` mock that RECORDS its
  `(sfContribution, crossingBuffer)` arguments.
- **`ARRAY_RANGE_ERROR` on `getParkedMember`** recurred as **five consecutive TAIL indices**
  during active rescues — not "always the last index" as recorded twice before. That fits
  the RACE explanation and does NOT fit a `getParkedCount` off-by-one, which would
  misreport by exactly one every time. The benign branch now has real support.
- **Item 2 (the wallet RPC, `sepolia.base.org`)** — still open, deferred to mainnet by
  owner decision. **Do NOT propose free public endpoints**; they were tried in this site's
  read pool, were buggy, and were removed. That is owner-observed operational history.
- ~~**The live V8.48 chain has been organic since 03:30:44 -04:00 and has never been
  measured that way.** Take a reading before anything restarts bigfill.~~ **DONE
  2026-08-18 — see section 6f.** The reading found the self-sustaining loop (82.6% of
  parked members park more than once) and a fund that has lent 2.4x what it holds
  ($518.24 outstanding against a $212.35 balance). It also opened two unexplained
  discrepancies, both listed in 6f: a $5.19 loaned-side gap that looks like a lending path
  emitting no event, and cumulative-net 212 against a live queue of 105.
- ~~**A LENDING PATH MAY NOT EMIT `MemberDebtIncreased`.**~~ **RESOLVED 2026-08-18 — IT
  WAS A SNAPSHOT RACE, NOT A SILENT PATH.** `StabilityFund` has one writer of `memberDebt`
  and one of `totalRescueLoaned`, same function, emitting the same amount.
  `diag_sf_debt_reconcile.js` reconciles EXACTLY from block 0. `diag_parked_growth.js` was
  reading the counters at the head after a multi-minute scan whose events stopped at
  `tip`; the gap was ~35 minutes of lending. Counter read is now pinned to `tip`.
  **Event-derived debt totals were never wrong — nothing quoted from them needs revising.**
- **⚠ `diag_parked_growth.js` DEFAULTS TO `deployed_addresses_v8_47.json`** and reads the
  live V8.48 chain only because `.env` line 69 sets `ADDRESSES_FILE`. Every V8.47 address
  differs — StabilityFund, pair managers, matrices. **Run it with that variable unset and
  it silently measures a dead deployment while printing confident numbers.**
  `diag_sf_debt_reconcile.js` refuses to start without it, rather than guessing.
- **The SF is draining and two instruments agree.** `diag_parked_growth.js` daily deltas
  and four `model_item_a.js` PHASE 1 balance reads both say the fund is losing ground —
  roughly $125/day, monotonic across ~9.7 hours. Testnet with bigfill stopped, so the
  DIRECTION is the finding and not any runway date.
