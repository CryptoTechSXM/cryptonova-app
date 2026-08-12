# V8.48 HANDOFF — updated 2026-08-12 (read this first, then V8_48_SCOPE.md)

**514 passing · 7 pending · 0 failing · DO NOT DEPLOY YET.**

Audience: a future session of Claude, plus the owner. Nobody else touches this code.

---

## THE RULE THAT NOW GOVERNS THE DEPLOY

The owner's instruction, 2026-08-11: **do not deploy while anything deploy-requiring
is unfinished.** That question was asked *before* starting the runbook, and it caught
item 11 — live money loss that item 12 would have accelerated. Ask it again before
the next attempt.

`V8_48_SCOPE.md` opens with a **DEPLOY GATE** table verified against `contracts/`,
not against the scope prose. Trust that table over any row further down; the rows lie
in both directions (two items were done and still marked open).

---

## WHAT BLOCKS THE DEPLOY

| item | what is missing | file |
|---|---|---|
| 2 | **BUILD (decided 2026-08-12): bind the automation reserve across ALL tiers** — waterfall hold, highest tier first, so `reservedFor` is actually held, not promised (live example that decided it: target $450, held $32.40). BEFORE designing, map where automation SPENDS from (drawFreeEarnings / hybridUpgrade / cycle-out funding paths) — the waterfall must hold money where automation can reach it, and the cross-matrix reads in withdrawCore need a gas-sane shape. | TierRouter(Lib) / MatrixLogicLib |
| 7 | cross-pair `memberJoinedAt` so `earlyExitPenaltyBps` can work. | PairManagerV8 |
| 40 | `selfRescueWithPermit` — the CONTRACT half. Frontend half shipped. | FigureEightMatrixV8 |
| PARKED | **OWNER-RAISED 2026-08-12, MEASURED same day (`scripts/diag_parked_growth.js`, complete scan, no holes) — the loop is REAL and it is the system's steady state.** 23,069 park events in 7.8 days from **650 unique members** (the network has ~671 — 97% of everyone): 35 parks/member average, 523 members (80%) parked 11+ times, top wallets ~90 parks (~11/day). **REPEAT SHARE 99.8%.** The QUEUE grows ~linearly (+125/day net, 991 live); what grows EXPONENTIALLY is the SF FINANCING: daily net-outstanding delta $7 → $13 → $44 → $459 → $1,707 → **$4,632**; outstanding $6,952, 91% of it accrued in the last 48h; today loaned $8,481 vs repaid $3,849. Mechanism: cycle out ~16% short (the 84% cluster) → park → rescue → the loan eats next earnings first → bigger shortfall next cycle. **TWO ANOMALIES OPEN:** (1) on 08-12 the mix FLIPPED — self-rescues collapsed 4,584→84 while copay jumped to 741 (bot wallets dry? fastlane keeper down? VPS is the source of truth — check fastlane.log); (2) ZERO evictions ever, consistent with evict_parked never running — the queue has no bottom-end relief valve. **The levers are ECONOMIC (owner decides, numbers first, item-42 style):** crossing-reserve bps (diag_parked_truth.js already tabulates how many members each extra point lifts over the line), rescue-loan terms / an insolvency floor (stop lending to accounts whose debt guarantees the next shortfall), eviction policy. Blocks the deploy until decided. | measured — decision pending |

**Both open decisions were DECIDED by the owner 2026-08-12:**
- **item 2 — DECIDED: BIND the reserve across all tiers** (waterfall, highest tier
  first, per the option-(a) framing in V8_48_BACKLOG.md §2). Now a BUILD item and
  a deploy blocker — see the blockers table. Note the interaction the owner chose
  it with: for automation-ON members a truly-held reserve means the re-entry fee
  exists at cycle-out, which directly attacks the parked loop for that cohort.
- **item 28 — DECIDED: KEEP the 30-day expiry — CLOSED.** No contract change; the
  loud surfacing (date + amber/red deadline warning under Total Claimable) shipped
  to members with the 2026-08-12 main promotion. Unclaimed shares sweep to the
  pool by design; ~$1,865 recycles on 2026-09-04 unless claimed, and that is now
  the stated rule, not an accident.

**Item 42 (epoch policy) is CLOSED — decided and shipped 2026-08-12.** Do not reopen it
as an open decision; the numbers and the reasoning are in the item-42 row of
`V8_48_SCOPE.md`. The short version: `epochMemberLimit` 10,000 → **1,000**,
`epochTimeLimit` 30 days → **180 days**, `epochMintLimit` **unchanged at 1,000,000**,
declared defaults changed rather than a post-deploy transaction because `deploy_v8.js`
never sets them.

**The one thing to carry forward from item 42 even if you never touch epochs again:**
`mintReward` fires on EVERY seat — register, upgrade, crossing, re-entry, rescue
re-seat — while `countedMember` counts a person ONCE, EVER. Measured live: 27,776 seat
events across **671 unique members**, 41 seats each. Any future reasoning that treats
"a member" and "an entry" as the same quantity is wrong by a factor of ~41. That is
what made `epochMemberLimit = 10,000` unreachable, and it is not specific to epochs.

---

## DONE THIS SESSION (all pushed)

Contract, awaiting deploy: **1** (freeWithdrawable mirrors withdrawCore — worth $204.15
to one measured member), **11** (rescue no longer erases the surplus — LIVE loss),
**12** (grace protects against loans, not your own money), **12a** (MatrixKeeperLib,
535 → 4,738 bytes headroom), **26**, **27**, **29**, **30**, **31**, **33**, **35**,
**37**, **41** (distribution on the 25th), **8 + 9** (burning locked CNOVA no longer
bricks the wallet).

Frontend, **LIVE TO MEMBERS since 2026-08-12** (`main` promoted to `17b6c02`,
Vercel production deploy verified Ready): **39** (seat position +
rotations-to-cycle + sampled rate), **40 frontend** (one-click clear-all), **41b**
(the 65/35 modal), **41/28 frontend + 42 frontend** (founder countdown + epoch
panel — schedule reads are feature-detected across the V8.47→V8.48 cutover, see
THE DEPLOY MODEL below), and the withdraw fixes below. Before that promotion these
sat on `admin` for two days while the handoff said "already live" — members were
still filing reports against bugs that were already fixed. That wrong word cost
half a session and the members two days.

Contract, awaiting deploy (2026-08-12): **42** (epoch policy — see above),
**4 + 5 + 6** (the floor-price cluster, 528 passing — mint capped at each seat's
own reserve deposit, hard no-override floor guards on both treasury owner
functions, one floor formula; closing item 6 exposed and fixed a LATENT
DILUTION BUG — DirectSale delivered floor-backing by plain transfer, invisible
to usdcReserve, and deploy_v8.js now MUST authorize the sale as a treasury
caller or every purchase reverts; details in the item-6 scope row), and
**3** (`bulkWithdraw(uint256)` — the one-signature partial withdrawal, 520 passing;
includes an EIP-170 refactor: both sweep loops now live in TierRouterLib after the
overload put TierRouter 148 bytes over the deploy limit WITH a green suite — the
test network allows oversized contracts, so a green run is not a size gate. The
frontend switch to the single call is a POST-DEPLOY task; details in the item-3
row of `V8_48_SCOPE.md`, including the ethers-v6 overload-ambiguity caveat).

---

## NEXT UP, ALREADY SCOPED

**Frontend epoch transparency.** The dashboard reads `currentEpochNumber` and
`epochRewards` and shows the era name, but it does NOT read `epochMembersRemaining`,
`epochMintRemaining`, `epochTimeRemaining` or `epochLeadingTrigger` — so a member can
see they are in Aurora Zenith but not how close the next halving is. That is the piece
the owner needs before telling the community about the new policy: *"once the code and
the frontend align I give the information to the community."* No deploy required.

**And a live fabricated-fallback bug found while checking that:** `index.html:6410`
reads `cnova.currentEpochNumber().catch(() => 1)`, so a dropped RPC call renders
"Epoch 1 — Nebula Genesis" as fact and marks Epoch 1 `ACTIVE` in the reward-schedule
rows at `:6564`. This is the SAME defect the audit note at `:3447` says was already
fixed once at `:3451` — fixed in one place, still live in another. Same class as items
30 and 39. Grep for `.catch(() =>` returning a VALUE rather than null before assuming
these two are the last of them.

---

## OPEN MEMBER ISSUES

- **Deborah, 0x0ddb6a96 — "$50 withdrawal failed", intermittent.** Two real defects
  found and fixed in the partial-withdraw loop: no try/catch per matrix (partial
  success reported as total failure, money moved but the screen said it failed) and a
  hardcoded 200k gas ceiling. **NOT CONFIRMED as her cause** — the P&L scan does not
  break down by date. The new withdraw-history panel makes the next report
  self-diagnosing. Her real headline is item 1: `freeWithdrawable` shows $92.62
  against $296.77 actually claimable.
- **CryptoJan22 / Sherwyn — "why so few cycles?"** Answered by item 39. Not defects.

---

## STANDING FACTS WORTH NOT REDISCOVERING

- **The VPS is the source of truth for keepers**, not `CryptoNova-Keepers/`. Reading
  the repo's crontab produced a wrong finding on 2026-08-11. `crontab_live_mirror.txt`
  is a redacted snapshot; RPC URLs carry the API key in the PATH and must never be
  committed.
- **`evict_parked.js` has NEVER RUN** — the cron guard `pgrep -f evict_loop.sh`
  matches its own parent shell. Confirmed on the VPS. **Do not just fix the guard:**
  it borrows the matrixKeeper slot (a crash strands a matrix with an EOA as keeper)
  and evicts with no `rescueRatioBps` check, unlike the contract.
- **Parked members cluster at ~84% of the entry fee** (median measured on chain,
  p25 84.0 / p75 84.9). Self-funded ones are real but rare — ~1/hour against ~900
  parked, cleared by fastlane within 10 minutes, which is why point-in-time censuses
  see none. A rare state is not an absent one.
- **`MockUSDC` lives in `contracts/test/`** — the root `contracts/MockUSDC.sol` is a
  5-line tombstone. Do not "fix" the missing permit there.
- Unverified external claim: **native USDC on Base supports EIP-2612.** Item 40's
  permit half depends on it. Check `DOMAIN_SEPARATOR()` on the Base USDC address.

---

## HOW TO WORK (from /preferences.md — read it at session start AND periodically)

Claude drives and makes file edits directly. The owner runs commands: VPS shell,
`git push`, and the local test suite. Give copy-paste blocks that name the folder or
host. One step at a time. Do not ask which backlog item to take next — decide.

**Verify the premise before implementing** (`CLAUDE.md`). Items 12 and 41 were both
built on claims that were false when written. And verify the effect LANDED: `fd7bfe4`
claimed a fix that only existed in the build container.

Push ladder is branches on one remote: `admin` → `preview` → `main`.

---

## READ THIS BEFORE YOU INVESTIGATE ANYTHING (added 2026-08-12)

**1. `git status` may show five files you did not touch. They are NOT dirty.**
`archive/windows_keeper/corescue.bat`, `contracts/test/CryptoNovaCommunityWallet.sol`
and `scripts/deployed_addresses_v8_30/31/40.json` appear MODIFIED when git runs
inside the Claude sandbox, and CLEAN when the owner runs git on Windows. Cause:
the owner's global `core.autocrlf=true` is invisible to the sandbox, which reads
only the repo-local config (unset), so the sandbox sees whole-file CRLF rewrites
that do not exist. `git diff --ignore-cr-at-eol` returns zero lines for all five.
**Do not revert them, do not commit them, do not add a `.gitattributes`** — the
last would renormalise the whole repo right before a deploy. A session already
spent time on this and raised it to the owner as a real finding. It is not one.

**2. Stage by explicit path, never `git add -A`,** for the reason above.

**3. The owner runs every command.** Claude edits files directly; the owner
executes anything that runs (tests, git, deploys, chain reads). Neither sandbox
can reach Base Sepolia — the proxy returns 403 — so every on-chain number in
these docs came from the owner running a script and pasting the output.

---

## LOOSE ENDS, NAMED (2026-08-12) — none of these are silently in flight

**Uncommitted right now:** `CryptoNova-Testnet-App/index.html` carries the item-42
frontend (epoch countdown + the `catch(() => 1)` fix). If it is still uncommitted
when you read this, it was never pushed — check `git log --oneline -1` against
`item 42 frontend`. Nothing else is part-done.

**Fabricated-fallback GATING sites — FIXED 2026-08-12, commit `6ced4f1`, LIVE on
`main` (Vercel production verified Ready).** What shipped, per site:

| was | now |
|---|---|
| `tierCycles(...).catch(() => 0n)` on the T2 upgrade card — a dropped read rendered "Locked until your first T1 cycle completes" | retryRead ×3; still unknown → explicit "could not verify — this does NOT mean you are locked", approve stays enabled (an approve is harmless; the CONTRACT judges eligibility — same policy as the 2026-08-07 debt-unreadable approve fix) |
| the second `tierCycles(...).catch(() => 0n)` (t1CyclesTR) | was DEAD CODE — nothing consumed it. Deleted. |
| `memberHighestTier(...).catch(() => 1)` + two `tierEntryFees(...).catch(() => 0n)` in the automation-reserve breakdown — a dropped read relabeled everything "T1" and could fire the settings-mismatch warning with fabricated numbers | retryRead each; any unknown → show the contract's held TOTAL (known at that point) with "breakdown unverifiable right now", never an invented breakdown |

No dedicated frontend tests exist for these (the repo has no JS test harness — the
existing guard style is predeploy_check.js static asserts); the checks run were
node --check on all inline JS plus a scope check on retryRead (same-block, hoisted).
The FULL failure-as-zero sweep of index.html is still open (2026-08-07 audit note) —
these three were only the ones that gated actions.

**Verified and closed this session, so you do not redo it:** the frontend has no
`epochMemberLimit`/`epochTimeLimit` hardcodes; `deploy_v8.js` never sets the three
epoch limits (which is why item 42 changed the DECLARED DEFAULTS); and the
`currentEpochNumber().catch(() => 1)` in the CNOVA modal is fixed.

**Unverified external claim, still unverified:** native USDC on Base supports
EIP-2612. Item 40's contract half depends on it. Nobody has checked.

---

## SESSION HEALTH NOTE — why this handoff exists (2026-08-12)

This session ran long and through one compaction, and the last stretch produced
three claims that had to be retracted: a "519 passing" prediction that assumed a
test file had not been collected (it had — 514 was correct), the CRLF finding
above, and `model_epoch_policy.js` v1, which read `tierPairManagers(uint8)` when
TierRouter declares `address[MAX_TIERS] public tierPairManagers` — wrong selector,
every call reverted, and a `.catch(() => ZeroAddress)` turned each revert into a
plausible zero. Ten zeros made the average climb 1.0x, and 1.0x is exactly the
assumption under which every candidate policy reports "SMOOTH". **The script
fabricated the answer it was asked to test.**

The pattern in all three: a value-returning fallback, or an inference stated
without rerunning the check. The owner's standing rule in memory covers it — *if
you cannot recall, verify or validate something, RERUN it rather than assert it* —
and it was written before this session, which is the point. Re-read
`/preferences.md` periodically, not only at the start.

---

## THE FRONTEND REPO PUSHES TO ITSELF (found 2026-08-12)

`CryptoNova-Testnet-App` receives automated commits on `origin/admin` from the live
site's bug-report endpoint — it appends each submission to `BUGS.md` and commits.
So the local clone falls behind on its own and `git push origin admin` is rejected
with "fetch first" for no reason you did anything wrong. **Always `git fetch origin`
and rebase before pushing the frontend.** A session lost time treating this as a
mystery divergence. It is not: check `git log --oneline HEAD..origin/admin` and if
the commits read `bug-report(<date>)`, they only touch `BUGS.md` and a rebase is
conflict-free. Confirm with `git diff --numstat HEAD origin/admin -- index.html`
before assuming it.

**Related trap:** running `git status` or `git diff` against this repo from the
Claude sandbox is slow enough to hit the 45s tool timeout, and a killed git leaves
`.git/index.lock` behind. The sandbox CANNOT delete it (no unlink permission), so
the owner's next git command fails with "Another git process seems to be running".
It is a corpse, not a live process — `Remove-Item .git\index.lock -Force`. Better:
do not run git against the frontend repo from the sandbox at all; ask the owner.

---

## TWO UNREAD MEMBER REPORTS — arrived via the bug endpoint 2026-08-11

Nobody had read these; they were found only because a push bounced. **Check BUGS.md
for more on every session** — reports land in the repo without notifying anyone.

**CryptoJan22** (MetaMask, `0x79470c63b5421e333ab4149b3206d55a39c17532`, 10:46 GMT):
*"decided to do a withdrawal. It took forever and after clicking max only 50% went
through. i tried max again but it did not go through."* Expected *"at least a reason
for the failure."* Frequency: Consistent. **This is item 3 in a member's own words** —
a partial withdrawal walks matrix-by-matrix with one signature each, some legs land
and some do not, and the member sees half their money move unexplained. Same
mechanism as Deborah's failed $50. Same member as item 39's cycle question.

**@Lavern-Gay** (Rabby, `0x737c3309c3d6f5702c8f4bb81494568f8d0d1be5`, 23:14 GMT):
*"I had to click both Approval and Self-Rescue several times, even though the
transaction was marked as complete."* Frequency: Consistent. **This is the two-tx
path item 40's contract half (`selfRescueWithPermit`) collapses into one signature.**

**ANSWERED 2026-08-12 — both reports were the OLD build, necessarily:** the
withdraw fixes only ever reached `admin`, and members are served `main` (verified
in the Vercel dashboard, see THE DEPLOY MODEL below). Neither report is evidence
against the fixes; the fixes had simply never reached a member. Full findings and
the retraction that preceded them are in the 2026-08-12 sections below — read them
before touching anything withdraw-related. **Since the same day's promotion of
`main` to `17b6c02` (~18:00 UTC), members ARE on the fixed build** — a withdraw
report dated after that is evidence about the NEW code (mind the cached-tab
caveat, and for CryptoJan22 specifically the 7702 relay section below).

---

## THE DEPLOY MODEL — verified in the Vercel dashboard, 2026-08-12

Not inferred; read off the screen with the owner's Vercel account, project
`cryptonova-testnet-app`:

- **Production tracks `main`.** The Production environment carries
  `v8.crypto-nova.app`, `www.crypto-nova.app`, `crypto-nova.app`,
  `cryptonova-testnet-app.vercel.app` (+2 more). **Members see `main`. Only
  `main`.**
- A push to `admin` produces a PREVIEW deployment on an auto-generated URL.
  It is not member-facing. The push ladder `admin → preview → main` is therefore
  a real staging ladder, and nothing is "live" until it lands on `main`.
- **RESOLVED later the same day: `main` was promoted to `17b6c02` (2026-08-12)**
  after an on-chain probe (`scripts/probe_v847_getters.js`) confirmed every getter
  the new UI reads exists on deployed V8.47 — except the two item-41 getters
  (`nextDistributionTime`, `distributionDayOfMonth`), which the founder countdown
  now FEATURE-DETECTS: V8.48 getter first, else `lastDistributionTime +
  distributeInterval` (the V8.47 truth), else an honest "schedule unavailable".
  Remove that fallback (and the `distributeInterval` ABI line) after V8.48 ships.
- KNOWN, ACCEPTED until the V8.48 deploy: page prose says distributions happen on
  the 25th (V8.48 policy) while the countdown shows the deployed contract's real
  rolling date (2026-09-04). The countdown is the true one. If a member reports
  this mismatch, it is that, not a new bug.
- Consequence for docs: when writing "shipped" or "live", say WHICH BRANCH.
  A past session wrote "already live" for admin-only pushes and this session
  initially reasoned from it.
- Before ANY future admin → main promotion, re-run the same check: does anything
  on admin read a getter that exists only in the undeployed contract tree?
  `scripts/probe_v847_getters.js` is the template — probe the CHAIN, not the
  source tree; the tree is always the next version.

## CRYPTOJAN22 IS A METAMASK SMART ACCOUNT (EIP-7702) — found 2026-08-12

Her wallet 0x79470c63… is delegated to MetaMask's Delegation Framework
(basescan shows "Authority … Delegated to 0x63c0c19a…"). Her withdrawals are NOT
transactions she sends: a MetaMask relayer (0xC066ac5D… on 2026-08-11) calls
**Redeem Delegations** on the DelegationManager (0xdb9B1e94…), which executes the
matrix calls. Verified: her EOA's last self-sent tx is Aug 7, yet four withdrawal
legs ran Aug 11 03:23 UTC and paid her $60.33 net.

What this means and what it cost:

- **`EarningsWithdrawn(member=X)` does not mean X sent the tx. Check `tx.from`.**
  This session first claimed her legs carried "new-build gas fingerprints" —
  the gas limits belonged to MetaMask's relayer, not to any build of index.html.
  The claim was retracted the same day. `scripts/diag_withdraw_timeline.js` now
  prints `tx.from` and flags relayed legs so it cannot mislead this way again.
- **Her "It took forever" is relay-queue latency**, and "tried max again but it
  did not go through" can die inside MetaMask's relay with the dapp never told.
  The per-matrix withdraw loop (one signature per leg) multiplies this. One more
  reason item 3 (`bulkWithdraw` partial — ONE tx) is the real fix for her class
  of account, not just a UX nicety.
- Unknown, worth measuring before designing around it: how many members are
  7702-delegated. (@Lavern-Gay uses Rabby and is not this case.)
