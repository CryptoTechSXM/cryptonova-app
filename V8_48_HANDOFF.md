# V8.48 — SESSION HANDOFF (written 2026-08-09, end of a long working day)

**Read this first, then `V8_48_SCOPE.md`.** This file is a briefing from the previous
session to the next one. Nobody else works on this code: it is CryptoTech (owner) and
Claude, and it always has been.

---

## How we work — do not drift from this

- **Claude is the driver.** Lead, decide direction, mentor. The owner is a novice in this
  space by his own description and relies on being taught, not handed jargon.
- **One step at a time.** Give one command block, wait for the result, then the next.
  Never a batch of six things to run.
- **Split of hands:** Claude makes FILE EDITS directly (a past manual edit broke things).
  The owner RUNS commands — git, hardhat, deploys, VPS, on-chain txs — and reports back.
- **Every code block names its folder/host.** Website `C:\CryptoNova-Testnet-App`,
  contracts `C:\CryptoNite-Smart-Contracts\CryptoNova`, VPS after
  `ssh -i C:\Users\CryptoTech\.ssh\do_keeper root@167.99.0.250`. He has run commands in the
  wrong repo before because a block didn't say.
- **PowerShell 5.1.** No `&&`. No inline `VAR=x cmd` — use `$env:VAR = "1"` on its own line.
- **Uncertainty is never carried.** If Claude cannot recall or verify something, RERUN it
  and write the result down. Owner's standing instruction. It has paid for itself
  repeatedly — see "what verification found" below.
- **Code is truth.** Verify every member-facing claim against contract source before
  saying it.
- **Push ladder:** branches on ONE remote `origin` — `admin` (owner verifies) ->
  `preview` (small-team QA) -> `main` (community). `git push origin admin`, NOT
  `git push admin main`.

---

## THE ROUTING RULE — the owner stated this three times. Encode it, never violate it.

**NEW MEMBERS HAVE ONE ENTRY POINT. New entries are never diluted across pairs.**

**EXISTING MEMBERS CYCLE, and that is what populates later pairs:**

| route | when |
|---|---|
| A -> B -> A **same pair** | default |
| A -> B -> A **2nd pair** | member already holds a seat in this pair (cannot hold two seats in one pair) |
| A -> B -> A **upgrade pair** | tier upgrade |

Three designs were rejected for violating rule one, each caught by a TEST, not by
reasoning: round-robin (dilutes; no pair reaches MATRIX_SIZE so nothing rotates),
share-across-full-pairs-plus-one-filling (dilutes), divert-at-physical-fullness (freezes
the pair it diverts away from). **The answer was never a routing formula for new entries —
it was one door, plus giving CYCLING members the 2nd-pair route they were missing.**

The physics that makes this true: a full MatA only rotates when it RECEIVES an entry
(`MatrixLogicLib:407`). Divert entries away from a full pair and it goes inert. Spread
entries thinly and no pair ever reaches MATRIX_SIZE, so nothing rotates anywhere.

---

## V8.48 status

**Implemented and green (450 passing, 7 pending, 0 failing):**

| # | what |
|---|---|
| 10 | `rescueReentry` -> own MatA, unconditional. No collision branch — V8.46's universal pair guard (`MatrixLogicLib:278`) already rejects a seat in either half, so steering to MatB swaps one revert for another. |
| 10b | `_findExternalPair()` returns 0. One door. |
| 27 | `CommunityWallet.distribute()` divides by `COHORT_SIZE`, not live count. |
| 31 | Duplicates route to `_freePairFor(member, fromPairIndex)`; `_forceExpand()` then a loud `PM8: no seat available for duplicate` as last resort. |
| 33 | Factory expansion triggers on OCCUPANCY (newest pair full, or newest MatB >= 90%), not a cumulative counter. |
| 34 | Both expansion triggers now asserted — O5 (early trigger PLUS the lead time: successor deployed while pair 0 still has seats), O5b (negative control), O6 (full-pair backstop), on a new factory-wired size-7 fixture. O7 replaces O4's softened "wired and standing by" with real duplicate volume, proving both limbs of the routing rule from one event log and NAMING the route via `DoubleEntryFired`. |
| 30 | `deployEntryThreshold`, `routeEntryThreshold`, `setEntryThresholds`, `EntryThresholdsSet`, `overflowActive` all DELETED. Zero production reads, no governance wiring, no deploy-script call — verified before cutting. 36 test call sites across 11 files. |
| 35 | **NEW — `_findRoutingPair()` deleted; it was a SECOND routing rule and three public views followed it.** See below. |
| 36 | Frontend shipped with 30: threshold reads gone (incl. a `.catch(() => 381n)` that would have shown members a threshold that no longer exists), tier strip closes on SEATS REMAINING, −20 RPC calls per page load. Pushed to `admin` as `b7d92d1`. |

**Withdrawn / reversed after verification:**

- **25** — "adminForceRotateRoot fails 29%" was a LIFETIME ratio presented as a current
  rate. 91% of it landed on one day in July, already fixed by V8.44/V8.46. Nothing since
  2026-08-02.
- **16** — "revert the live threshold mitigation" — nothing to revert. Not proxies; V8.48
  is a FRESH DEPLOY, so old-contract state vanishes.
- **18** — REVERSED. `frozen_matb_keeper.js` is NOT redundant; it has done 6,726 rotations
  and is still rotating T1/T2/T3 every 10 minutes. Retiring it would freeze every MatB.
  The original "redundant" call came from a case-sensitive grep of mine that missed
  `Rotated`/`forcing`.

**Remaining, in the order I'd take them:**

1. **32 — backup keeper** watching for `PM8: no seat available for duplicate` and
   triggering a spawn. Owner: *"a member eligible to cross should not be parked, a new pair
   should be spawned so they have space to sit."*
2. **26 — SF L1 surplus -> CommunityWallet.** Fully specified with a payout model. Default
   bps 0 so deploying changes nothing until the DAO votes it on. Do NOT touch L3 — that
   overflow funds BuybackReserve, which supports the CNOVA floor.
3. **28 — distribution expiry** silently forfeits member money back to the pool. Decide:
   keep and surface loudly, or remove.
4. The rest of the 29-item list in `V8_48_SCOPE.md`, including **12a MatrixKeeperLib**
   extraction (MatrixKeeper has 535 free bytes and item 12 does not fit).

---

## THREE THINGS FROM 2026-08-09 (evening) THAT THE CODE NO LONGER SHOWS

**1. `fullTrigger` is SUBSUMED by `matBTrigger` — do not reclaim its bytes casually.**
`setFactoryExpandThreshold` caps at `BPS_DENOM` and a matrix's occupancy can never exceed
`MATRIX_SIZE`, so a full pair implies a full MatB implies 10000 bps. `_pairFull()` in
`_tryAdvancePair` can therefore NEVER be the sole cause of an expansion. It is defence in
depth, and it earns its bytes in exactly one case: if occupancy ever drifts ABOVE
MATRIX_SIZE (the V8.44 phantom-seat class, "occupancy drift +44"), MatB reads 6/7 while the
pair sums to full and only `fullTrigger` sees it. Item 30's doctrine says delete what
steers nothing; this one steers something, but only in a failure mode. Reasoning is written
into O6 in `V8_44_Overflow.test.js`.

**2. Item 35 is invisible now that `_findRoutingPair` is deleted.** The bug was TWO ROUTING
RULES: `_findRoutingPair()` ("oldest pair with a free MatA seat, else the newest") survived
item 10b, which moved real routing to `_findExternalPair()` = constant 0. They agree only
while pair 0's MatA has room — and **a full pair 0 is the designed steady state**, so the
views went wrong precisely when the design started working. `getActivePair()`,
`allPairsStatus().active[]` and `routingDistribution()` all reported the stale rule, the
tier card reads all three, and the home card picks WHICH MATRICES TO DRAW from that flag —
so T1.1 could hold 254 members while the card drew T1.2's empty ones. None of the three had
a test. **The general lesson: after changing a routing rule, grep for every VIEW that claims
to report it.** A view is an instrument, and this project has now caught four of them lying.

**3. O5b and O8 are built to be ABLE to fail — do not "simplify" them.** O5b is a negative
control: the identical drive with the threshold at 100%, proving the threshold CAUSED the
expansion rather than merely co-occurring with it. O8 recomputes the DELETED rule inside the
test and asserts it points at a different pair, so it proves it is standing on the
divergence — without that, O8 would pass in any state where pair 0 has room, which is most
states, and would keep passing if someone reintroduced `_findRoutingPair`. Both exist
because `bypass_scan_full.js` twice printed a confident "0" with a proven positive inside
its own range.

## Live protocol state — the holding configuration

| item | state | why |
|---|---|---|
| `routeEntryThreshold`, ALL 10 tiers | `type(uint256).max` | Set 2026-08-09 17:07 UTC. A finite sentinel silently expires; max says what we mean. Inert after V8.48 anyway. |
| `deployEntryThreshold` | 375, untouched | Factory expansion unchanged. |
| `route_rr.js` | cron trimmed 2026-08-06 + kill switch `route_rr.OFF` set | A dry run wanted to set route 1000000 -> 696, which would refreeze T1.1. |
| parked members | **714**, MatA 248 / MatB 466 | Reconciles EXACTLY with `copay_rescue`'s "714 still in grace" (86400s). Nobody is stuck past grace. |
| StabilityFund | ~$10,900, target $5,000, ledger conserves to the cent, fully backed | `sum(memberDebt) = loaned - repaid = $283.34` across 180 debtors. |
| CommunityWallet | $3,730.94, enrolled 646 (G 500, P 146) | Next distribution **2026-09-04**. Item 27 must ship before then or Pioneers get 2.3x Genesis. |

**Frontend:** admin, preview and main are all synced at `69a2f3e`.

---

## What verification found that reasoning did not

Every one of these came from re-running something rather than trusting recall, which is
why the owner's standing rule exists:

- **A third site of the V8.46 root cause** (`_findExternalPair`) that had already frozen
  254 members three days after its masking keeper was switched off — and would have
  shipped V8.48 still live.
- **60 keeper scripts** pointed at two-release-old contracts, held correct by ONE line in
  `.env`. Now a single `deployed_addresses_current.json` symlink.
- **A shared log helper** (`safeGetLogs`) silently truncating every "lifetime" figure on
  the site to a 2.3-day window AND swallowing dropped windows.
- **Eighteen unguarded reads** on the community home page that could render "CNOVA Minted
  0" or the wrong epoch after the halving.
- **466 of 714 parked members recycling in MatB** — item 10's cost measured in people.
- **A cohort inversion** paying Pioneers 2.3x Genesis, 26 days from its first material
  payout.

**Four instruments were lying, and each was concealing something rather than merely
failing:** a case-sensitive grep of mine (hid 6,726 rotations), `set_entry_thresholds.js`'s
routing-pair label (named the standby pair, making a working fix look broken),
`diag_overflow.js`'s hardcoded pair index (reverted before reaching a second bug that had
never executed), and the member-facing tier card (told members a standby pair opens at
1,000,000 entries).

**Two owner beliefs came from the old buggy UI**, not from him: "Genesis get paid at 500,
Pioneer at 1000" and "claim on the 25th". Neither exists in the contract. That is what a
lying interface costs — it misleads the person building the thing.

---

## Tooling fixed on the VPS (not in git — recorded in `KEEPER_VPS_CONFIG.md`)

Single addresses pointer; `set_entry_thresholds.js` routing-pair label + verify retry;
`diag_overflow.js` parameterised with a parked-count census (`CENSUS=1`); `parked_census.js`
and `sf_surplus.js` added; log rotation created where none existed (`rescue.log` was 124 MB
unbounded, now 21 MB gzipped and capped at 7 days).

---

## Standing gotchas

- **Read-after-write RPC lag is real on this pool.** A confirmed `.wait()` followed by an
  immediate read can hit a node still behind. Correlates with CONFIRMATION SPEED: on
  2026-08-09 the three tiers that confirmed in ~0.22s all printed a false mismatch while
  every tier taking ~4.3s read clean. Re-read after ~20s before believing a failure.
- **Syntax checks pass on undefined variables.** Verify SCOPE when moving code between
  functions — this bit us on `sf` in the loan book, and again tonight on `matA` in a test.
- **`index.html` is ~611 KB.** Never hand-merge it. A `String.replace()` with `$&` in the
  replacement once corrupted it 602 KB -> 987 KB; use function-form replacement.
- **Size wall:** TierRouter 142 bytes free, MatrixPairFactory 356, MatrixKeeper 535. Run
  `npx hardhat run scripts/sizes.js` after EVERY contract edit.
- **The frontend repo is pure CRLF (9,380 line endings, zero bare LF).** Any scripted
  edit to `index.html` must build its search strings with `\r\n` or every match silently
  fails. Verified 2026-08-09 after a patch aborted on the first assert.
- **Do not run bare `git status` in a connected repo from the Cowork bridge.** It creates
  `.git/index.lock`, and the bridge CANNOT delete files — only move them — so the lock is
  left behind and blocks the owner's next `git add`. Use `git --no-optional-locks status`.
  One was left in CryptoNova-Testnet-App on 2026-08-09, renamed to
  `.git/index.lock.STALE-safe-to-delete`; delete it when convenient.
- **Tests that fail after a change are not automatically wrong.** Tonight the suite caught
  three bad designs. The question to ask each time: does this test protect a MEMBER-FACING
  INVARIANT (make the code pass it) or a MECHANISM we deliberately removed (retarget it,
  and write the reasoning into the test file where the decision lives)?
