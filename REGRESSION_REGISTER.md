# REGRESSION REGISTER

**Audience: the next session of Claude, plus the owner. There is no third party.**

Started 2026-09-03 (session 61), after the owner said this, and he was right:

> *"we are reverting and the same problem we had and corrected is now back... we fix, we
> launch, another issue arises, we fix, then relaunch, same old problem comes back. We need
> to get better at documenting what has worked and not remove for another fix."*

## Why this file exists, and why more comments would not have helped

Session 48 earned the rule: **a handoff that records a STOP must record the condition that
would LIFT it**, or the block outlives its own cause. This file is the inverse, and it is
the harder half:

> **A FIX MUST RECORD THE INVARIANT THAT PROVES IT IS STILL HOLDING,
> AND SOMETHING MUST CHECK THAT INVARIANT ON A SCHEDULE.**

The evidence that documentation alone is not enough is entry R2 below. The V8.43 lesson was
written down **in the right file, in the right function, in plain English, naming itself as a
root cause** - and the same behaviour was re-added roughly seventy lines further down the
same function. The new code even audited itself carefully against ONE predecessor (V8.48
item 10) and never mentioned the other.

> **A COMMENT IS A NOTE TO WHOEVER HAPPENS TO LOOK. IT IS NOT A CHECK.**
> **A FIX THAT AUDITS ITSELF AGAINST ONE PREDECESSOR WILL REINTRODUCE A DIFFERENT ONE.**

## How to use it

- **Before writing any fix**, read the entries whose INVARIANT your change could touch.
- **After writing it**, add or extend an entry. A fix with no invariant is not finished.
- **An invariant with no automated check is a liability**, not a safeguard. The `CHECKED BY`
  column is the point of the file. Where it says `NOT AUTOMATED`, that is a known gap.

---

## R1 - A matrix with no entry source freezes

**THE INVARIANT:** *No matrix may sit at MATRIX_SIZE with `rotationCount == 0`, and no MatB
may sit at occupancy 0 while its own MatA is full.*

**WHY:** `MatrixLogicLib:517` - `if (self.occupancy >= cfg.matrixSize) _cycleOutRoot(...)` -
sits inside the ENTRY path. A rotation happens **only** when an *entry* arrives at a full
matrix. Nothing else in the tree causes one. So a full matrix that receives no entries stops
permanently, and every member seated in it stops moving: no cycle-out, no crossing, no pool
credit from a rotation.

**THREE APPEARANCES, EACH CURED LOCALLY AND REINTRODUCED ELSEWHERE:**

| when | shape | outcome |
|---|---|---|
| pre-V8.48 | a first-match scan excluded a pair from new registrations FOREVER once its CUMULATIVE entry count passed a threshold | that pair's MatA had no entry source and froze |
| V8.43 | `rescueOverflow` diverted saturated-pair rescues to pair N+1 | the own MatB was starved - "the frozen-MatB root cause" |
| V8.48 + V8.50 | `_findExternalPair()` returns 0 (ONE DOOR) **and** item S seats overflow rescues into later MatAs | every pair except pair 0 fills without entries and freezes |

**MEASURED 2026-09-03:** T1.2 MatA `127/127` with **0 rotations**, T1.2 MatB `0/127`,
T1.3 MatA 91/127 on the same path. 127 members hold paid seats that can never cycle.

**THE IRONY THAT SHOULD HAVE STOPPED IT:** the V8.48 fix's own comment describes today's
defect exactly, as the thing it was fixing - *"Its MatA then had no entry source and froze
-- and a full MatA only rotates when it RECEIVES an entry, so 'no entries' means 'no
rotation' means every member in seats 2..127 stops moving."* The fix cured that for pair 0
by making pair 0 the only door, which gives every other pair no entry source.

**THE LEVER, PROVEN ON CHAIN 2026-09-03 (session 62, handoff 62.0):** an entry into a full
matrix is the only thing that rotates it, and the DOUBLE route (`TierRouter:1458`, via
`freePairFor`, which checks seat-holding but not occupancy) delivers exactly that. One armed
member cycling out of T1.1 MatB took T1.2 MatA from 0 rotations to 1 and T1.2 MatB from 0 to
1/127, with no redeploy. **So R1's cure is not "add a door" - it is "make sure the double can
fire": cycles >= `reentryMinCycles`, funded, and NOT opted out (see R4's live instance).**

**CHECKED BY:** `frozen_matrix_check.js` (CryptoNova-Keepers), cron `7 * * * *`, exit 2 on
violation, logs to `/root/keeper/frozen.log`. Proven both ways before being trusted, **and
seen to fire on the real freeze (CONFIRMED twice) - still to be seen clearing after 62.0.**

---

## R2 - Diverting rescues between pairs starves a MatB

**THE INVARIANT:** *Any change that routes a rescue, re-entry or graduate AWAY from its own
pair must state what stops the destination MatB from being starved, and what stops the
destination MatA from being filled without entries.*

**WHY:** `PairManagerV8:395`, the header of `rescueReentry`, still says it:
*"V8.44 overflow rework (replaces V8.43 rescueOverflow, which diverted saturated-pair
rescues to pair N+1 and starved the own MatB -- the frozen-MatB root cause)."*
**V8.50 item S, about seventy lines below that sentence in the same function, diverts
saturated-pair rescues to another pair.** T1.2 MatB is 0/127.

**THE DISTINCTION THAT MUST TRAVEL WITH THIS ENTRY:** the route differs. V8.43 starved the
OWN MatB by diverting rescues away from it. Item S starves LATER MatBs by filling their MatAs
with seats that carry no entry. **Different mechanism, same end state, both caused by moving
rescues between pairs.** Item S is not simply a mistake - it genuinely fixes an unseatable
park - but it was reviewed against V8.48 item 10 only.

**CHECKED BY:** R1's invariant catches the outcome. **The review discipline is NOT AUTOMATED**
and is the reason this file exists.

---

## R3 - The cumulative-counter root cause (V8.46)

**THE INVARIANT:** *No routing decision may be gated on a counter that only ever increments.*

**WHY:** `totalRegistered` / entry counts never decrease, so once a pair crosses a threshold
it is excluded FOREVER, even after members cycle out and free seats.

**THREE SITES, FOUND SEPARATELY:** `TierRouterLib.sameTierTarget` (V8.46), `rescueReentry`
(V8.48 item 10 - measured 2026-08-09: T2.1 MatA rot 581 vs MatB rot 5684, 65% of parked
members sitting in MatB), and `_findExternalPair` (V8.48 item 10b).

**LESSON:** V8.46 fixed one site and missed two. **When a root cause is named, sweep for
siblings in the same file before closing it.** The same failure recurs at R7.

**FOURTH SITE, MINE, 2026-09-04 (session 62):** the V8.52 front-door selector chose the full MatA
with the lowest `rotationCount` — a counter that only increments. Measured on the private chain:
5 entries, pair 1 stayed at 30, pair 2 went 1 → 6 — pair 1 starved until pair 2 catches up.
**I wrote the R1 addendum naming the rule and did not read this entry against it.** Cure:
select on `lastRotationTimestamp` (the pair that has WAITED longest, a never-rotated one first),
which is a clock, not a count. Handoff 62.14.

**CHECKED BY:** NOT AUTOMATED. A grep for `rotationCount|totalRegistered|totalRegistrations`
inside any function whose name contains `find`, `route`, `target` or `door` would have flagged
this in seconds; it still does not exist — add it to `predeploy_check.js`.

---

## R4 - `optionsSet` never flips back

**THE INVARIANT:** *Nothing may call `setMemberOptions` or `setDoubleEntry` with
`enableReentry = false`, and no code path may set member options as a side effect of doing
something else without stating what it does to all three flags.*

**WHY:** `reentryOn = (!opts.optionsSet || cycles < reentryMinCycles) ? true :
opts.autoReentryEnabled`. `optionsSet` flips true the first time options are set and NEVER
flips back, so a member who once had options written loses the protective default forever.
`setDoubleEntry(true)` sets `optionsSet = true` but never touches `autoReentryEnabled`
(default false) - **so the legacy toggle silently disables re-entry, and because the double
requires `anySeat`, it kills the very thing it was called to enable.**

**AND A LIVE INSTANCE OF THE SIDE-EFFECT HALF (found 2026-09-03):** the website calls
`setMemberOptions(false, true, false)` automatically after every registration. Good intent -
it forces `autoReentryEnabled = true` - but it also writes `doubleReentryEnabled = false` and
`optionsSet = true` for **every member, on their behalf, in their first minute.**

**CHECKED BY:** `check_member_options.js` (read-only, per-member, manual).
**NOT AUTOMATED** as a fleet-wide sweep.

---

## R5 - A member-facing number computed from the wrong source

**THE INVARIANT:** *Every displayed figure must be read from the thing it names. A value
derived from a NEIGHBOURING value is a lie waiting for the two to diverge.*

**FOUR INSTANCES, ALL SHIPPED, ALL MEMBER-FACING:**

- `status.html` counted `MemberDebtIncreased` into a variable named `rescueCount`. That event
  fires only when the fund ADVANCES money, so ~45% of rescues - the common, zero-cost case -
  were invisible. The page read "Total rescues 0" an hour after a real seated rescue. (59.1)
- `status.html` computed rescue capacity as `Math.floor(sfBalance / 5)` with no concept of the
  copay floor, promising twelve rescues the keeper would refuse. (57.10)
- The crontab header described jobs as disabled when they were live, and labelled job A
  "every 10 min" when it runs `*/20`. (58)
- **`index.html renderPairSubRows()` derived MatB's displayed fill AND the pair's status label
  from MatA's fullness**, so T1.2 read `127/127 . Full` while the chain read `0/127` - on the
  one screen that would have exposed R1. Fixed 2026-09-03 (`223c6d0`). (61.5)
- **`check_member_options.js` evaluated every cycle-out gate on the CURRENT `tierCycles`, but
  the contract INCREMENTS FIRST (`TierRouter:1259`) and reads the incremented value into every
  gate (`:1260`, `:1369-1380`).** So its "verdict on next cycle-out" column was off by one, and
  printed `doubleOn false` for the owner's armed wallet at cycles 1 - whose double WILL fire,
  because the chain reads 2 against `reentryMinCycles` 2. **A diagnostic that read the right
  variable at the wrong moment.** Fixed 2026-09-03, session 62: the column now shows `now` and
  `next` and computes the flags on `next`. (62.0)

**THE FIFTH INSTANCE SHARPENS THE INVARIANT:** *"read from the thing it names"* also means
*at the moment the contract reads it*. A pre-increment read of a post-increment gate is the
same lie as a neighbouring value.

**CHECKED BY:** NOT AUTOMATED. **The cheapest available check is the one that caught the
last two: read the artefact that will actually produce the output, not a document about it.**

---

## R6 - Failure-as-zero

**THE INVARIANT:** *A failed read must never become `0`, `false`, `empty` or `full speed`.
It must be named, and the verdict must be INCOMPLETE rather than PASS.*

**GOOD EXAMPLES ALREADY IN THE TREE, COPY THESE:** `rr_keeper.js:424-429` - a failed
`globalJoinedCount()` read falls to the TAPERED cap, never full speed. `copay_rescue.js` -
a failed `stabilityFloor()` read stands the run down rather than defaulting to `0n`, which
would let one run drain the fund. `pair_saturation.js` - an unread matrix prints
SATURATION UNKNOWN, never "has room". `_bothHalvesFull` - an unreadable matrix returns
false ("not known to be saturated"), which keeps today's behaviour.

**CHECKED BY:** convention plus review. `frozen_matrix_check.js` and `cycle_census.js` both
follow it and both were negative-tested before being trusted.

---

## R7 - A correction applied at one site and never swept for siblings

**THE INVARIANT:** *When a stale comment or claim is corrected, grep the file for the same
claim before closing the task.*

**WHY:** `PairManagerV8:683` had a stale forward-graduation claim corrected, with a note
saying it was fixed *"because the next person to read it would have believed it."* **The
identical claim at `:776` was never swept. The next person read `:776`.** (60.9)

Same shape as R3, where V8.46 fixed one of three sites.

**CHECKED BY:** NOT AUTOMATED.

---

## R8 - A detector that cannot match the thing it is looking for

**THE INVARIANT:** *A grep that finds nothing is not evidence that nothing happened. Before
a count becomes a finding, read the raw artefact once.*

**EIGHT INSTANCES ACROSS SESSIONS 56-61**, including: a residue guard firing on its own
explanatory comment; a spend scan classifying a self-test as a spender because it matched
regex literals asserting the ABSENCE of those patterns; a bare `403` in a log scan matching
the millisecond field of a timestamp; and - twice in ten minutes on 2026-09-03 - a taper
check whose pattern excluded the exact line it was written to find, **which made a healthy
engine look dead for 9h20m.**

**THE TWO RULES THIS EARNED:**
- **When a system TRANSITIONS, the log line's shape changes at the moment of the transition.
  A pattern derived from the PRE-transition format is guaranteed to miss the event, and its
  last match sits right at the boundary - the most convincing possible false negative.
  Match the stable stem, never the formatted middle.**
- **A filter that correlates with the thing you are measuring returns a clean, confident,
  useless answer.** (A candidate scan filtered on "seated in MatB" - but a member only earns
  a cycle by cycling OUT of MatB, so it excluded by construction everyone it was looking for.)

**THE CURE, USED SUCCESSFULLY THE SAME DAY:** stop enumerating by derived wallet and
enumerate from EVENTS. `cycle_census.js` cannot miss a population nobody thought to derive.

**CHECKED BY:** NOT AUTOMATED, and probably cannot be. This entry is a reading habit.

---

## R9 - A count cannot see a substitution that preserves the count

**THE INVARIANT:** *Pair every count with a whole-artefact equivalence check that neutralises
only the field you meant to change.*

**WHY:** a `sed` rotating two RPC endpoints matched the whole non-space token and ate
`BASE_SEPOLIA_RPC_URL=` along with the URL, leaving the shell asked to EXECUTE a URL. **Five
count-based checks all passed.** What caught it: `sed -E 's#https?://[^ ]*#X#g' <file> |
md5sum` on both files - identical means nothing but the URLs changed, and it prints no
secret. (60.1)

**CHECKED BY:** convention. Used again on 2026-09-03 to install the `frozen_matrix_check`
cron line: 14 -> 15 active lines, and the rest of the crontab hashing identically before and
after.

---

## R10 - Secrets in things that get printed

**THE INVARIANT:** *Never print any line of the live crontab, and never fetch a deployed
frontend page into a chat, a browser pane or a model context. Verify by counts and hashes.*

**WHY:** a two-line crontab `diff`, believed safe because the redacted MIRROR showed
`${RPC_D}`, printed two live QuickNode keys - the LIVE crontab has them inline. (59.3)
**And measured 2026-09-03: the deployed `index.html` and `status.html` DO serve live
41-character keys to every visitor.** A browser dApp cannot hide its endpoint, so the
mitigation is **endpoint restriction (domain/referrer allowlist + rate limits), never
rotation** - and a frontend endpoint is never also a keeper endpoint.

**CHECKED BY:** convention. The safe instruments: `crontab -l | md5sum`,
`awk '!/^[ \t]*#/ && NF' | wc -l`, `grep -c <token>`, and
`tail -40 <log> | sed -E 's#https?://[^ ,")]*#<URL>#g'` for reading a log safely.
**Note `grep -c` counts matching LINES, not matches, even with `-o` - it yields a FLOOR.**

---

## R11 - A test retargeted to pass is a deleted test

**THE INVARIANT:** *An assertion may be weakened or removed ONLY with an entry in this file
naming the law it enforced, the replacement law, and the check that now enforces it. A test
whose title still names the old law is a lie to the next reader.*

**WHY, AND IT IS THE CENTRE OF THE "we fix and refix the same thing" CIRCLE:**
`test/V8_44_Overflow.test.js` O4 is titled *"DESIGN-LAW GATE - keepers OFF, both MatBs
rotate from pure member-driven flow."* Its body no longer asserts that pair 1 rotates. It was
**retargeted twice**: V8.48 item 10b dropped the pair-1 rotation assertion (*"an EMPTY STANDBY
pair is not a frozen pair - the law is about members who are waiting, and pair 1 has none"*),
and V8.50 item S dropped the *"pair 1 is empty"* assertion because item S had just started
filling pair 1 - at which point the 10b reasoning was false (pair 1 now HAD members waiting)
and nobody restored the rotation check. Each edit carried a persuasive paragraph. **The gate
that would have gone red on the 2026-09-03 freeze (R1) was talked out of existence in two
steps by two sessions.** A comment explaining why an assertion was removed is the same
failure as R2's comment explaining a root cause: prose where a check should be.

**THE RULE:** when a test goes red after a change, the ONLY two honest outcomes are (a) the
code is wrong, fix the code; or (b) the LAW changed - record here what the old law was, what
the new law is, and add the assertion that enforces the new one. Weakening the assertion so
the suite is green is neither.

**CHECKED BY:** NOT AUTOMATED. Partial mechanical guard worth adding: a test whose title
contains "GATE" or "LAW" must contain at least one `expect(` on a `rotationCount` - crude,
but it would have flagged O4 as retargeted.

---

## R1 - ADDENDUM: the planned cure (session 62), recorded BEFORE the code

**THE DEFECT LINE:** `PairManagerV8._findExternalPair()` returns 0 - one door, forever - since
commit `4122949`. Its own doc block above it still describes a different rule (*"one point of
entry until that pair is physically full, then the next pair opens"*) and warns that *"strict
one-door would have left pairs 1+ permanently inert"* - the function ignores its own doc.

**THE CURE:** the front door is **the FULL MatA that has rotated LEAST** (pair 0 until pair 0
is full; thereafter whichever full pair is most starved; a full matrix at 0 rotations always
wins; ties to the lowest index; if no MatA is full, pair 0). Reads live `occupancy()` and
`rotationCount()` only - no cursor, no threshold, no cumulative counter (R3), no storage.

**WHY THIS SHAPE AND NOT THE DOC'S:** the doc's rule ("pair 0 until physically full, then the
next") would freeze PAIR 0 instead - a full pair is the designed steady state (every entry
seats one and rotates one out, so occupancy stays at size), so "then the next" means pair 0
never receives another entry. That is the freeze relocated a fourth time. "Least rotated
among the full" keeps every full pair moving by construction, and never thin-spreads (the
doc's correct objection to naive round-robin): a pair that is not full is never a door.

**THE DECLARED DESIGN CHANGE (R11 applies):** O7's law *"pair 1 fills from existing members
cycling, NEVER from the front door"* is replaced by *"the front door NEVER reaches a pair
whose MatA is not full"*. O7 will go red on its "never" assertions; they are to be replaced
by the new law's assertion, not deleted. O8's routing views must report the new door.

**THE TEST THAT MUST BE RED ON TODAY'S CODE FIRST:** `test/V8_52_FrozenPair.test.js` - two
pairs, registrations + selfRescue only, drive until pair 1's MatA is full, keep driving, and
assert R1 directly (no matrix at size with 0 rotations; MatB not empty while MatA full),
while ALSO asserting pair 0 keeps rotating (the relocated-freeze guard) and that no not-full
pair ever receives a front-door member (the thin-spread guard).

**DONE, MEASURED (2026-09-03, session 62):** `test/V8_52_FrozenPair.test.js` ran 3 passing /
1 failing on `return 0` (F1: "pair 1 MatA is 4/4 with rotationCount 0 after 16 further
front-door entries"), then 4 passing after the one-function change; `V8_44_Overflow` 9/9
including O7 (its drive stops at pair 1's FIRST arrival, so pair 1 is never full there and
its assertions were exact for both laws - only its title and LIMB 1 text were restated, per
R11); `sizes.js`: PairManagerV8 16,855 / headroom 7,721. Full suite: see handoff 62.6.

**THE CURE AS SHIPPED — V8.52b (2026-09-04, the owner's design, handoff 62.15/62.16):** the
front door stays pair 0 (ONE DOOR). When the circulation (re-entry / rescue, which ends in a real
`enterFor`) finds no pair with room, it ENTERS the full pair that has waited longest
(`_fullPairWaitingLongest`: lowest `lastRotationTimestamp`, MatB must have room) — that entry
rotates it. No counter (R3). F4 = no registration's first seat is pair 1 AND pair 1 rotates AND
pair 0 rotates. The V8.52a front-door selector below was measured, found to starve pair 1, and
replaced; its record stays here as the history.

**PROVEN ON A LIVE CHAIN, OWNER AS A MEMBER (2026-09-04 06:50Z, private V8.52a, size 15):** pair 2
filled to 15/15 by overflow only (rotations 0 — the freeze reproduced), then ONE front-door
registration → pair 2 rotations 0 → 1, MatB 0 → 1, pair 1 unchanged. Handoff 62.12.

**CHECKED BY:** `frozen_matrix_check.js` hourly on chain (R1), and F1-F3 in the suite.

---

## R13 - A redirect truncates its target before the command reads

**THE INVARIANT:** *Never write a file beside the file you are reading it from, never with a
relative path, and never in a block that can be pasted into a shell whose working directory
you did not set on the same line. Write to `<dest>/<name>.new` by absolute path, then `mv`.*

**WHY:** 2026-09-04 05:34Z: the sandbox-build block for the private V8.52 chain contained
`sed '...' /root/keeper/.env > .env`. The block was pasted into the wrong window, its error
text was pasted back into the VPS shell, and that line executed with the shell still in
`/root/keeper`. The shell opened `> .env` (truncating the LIVE keeper `.env` to 0 bytes) before
`sed` read it, so `sed` read nothing and wrote nothing. **Every live keeper job lost its RPC,
keys and address book for ~35 minutes; the ADDRESSES_FILE guards (R6) held and nothing ran on
a dead default.** Restored from `.env.bak_roster41_20260828` + the V8.51 repoint, proven by
`frozen_matrix_check.js` reading 26 matrices. ⚠ Anything changed in the live `.env` between
2026-08-28 and 09-04 other than `ADDRESSES_FILE` is LOST and unknown - watch for a keeper that
behaves differently from before and check this first.

Same family as session 56's `io.open(P,"w")` truncation: the destructive step happened before
the productive one, and an error in between left nothing. The cure is the same: produce the
new content somewhere harmless first, then swap it in atomically.

**CHECKED BY:** NOT AUTOMATED. Every future block that builds a config from another config
uses absolute paths and the `.new` + `mv` form. A daily `test -s /root/keeper/.env` in the
health report would have alarmed within a tick and does not exist yet.

---

## R14 - A per-deployment grant is not a deploy step until a script makes it one

**THE INVARIANT:** *Every authorisation the running system needs — an allowlist entry, a
role, a caller grant — is either made BY the deploy run or CHECKED by the post-deploy
verification, so that "deployed and verified" cannot be true while the keeper is locked out.*

**WHY:** 2026-09-04: the V8.52 community deploy was verified 46/46, graduation on, frontend
cut over, keepers repointed — and `MatrixKeeper.performUpkeep` (:911) refused the keeper
wallet with `MK: not authorized keeper` because `upkeepCaller[0xd419…]` is a mapping on the
NEW contract and nobody ran `scripts/set_upkeep_caller.js`. The V8.51 grant (block 45433132)
was made by hand and remembered by nobody. For ~4 hours after cutover no rescue, eviction or
velocity work ran, and the only signal was a Telegram FAIL with `reason=null` (the revert
string does not survive the send path). **CHECKED BY:** `diag_upkeep_callers.js` — read it
against the new book before the frontend is pointed at any deployment; the grant belongs in the
deploy runbook between "verified" and "cut over", and the verification script should read the
mapping for the keeper EOA and fail without it (not yet done).
