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
| 3 | `bulkWithdraw(uint256 amount)` — one-signature PARTIAL withdrawals. The per-matrix loop this replaces is where Deborah's failed $50 lived. | TierRouter(Lib) |
| 4 | `mintReward` has no cap against `floorPrice()`. | CNOVAToken |
| 5 | no `floorBefore` guard in `addDexLiquidity` / `emergencyWithdraw`. | CNOVATreasury |
| 6 | `_floorPriceE6()` must read `usdcReserve`, not `balanceOf(treasury)`. | CNOVADirectSale |
| 7 | cross-pair `memberJoinedAt` so `earlyExitPenaltyBps` can work. | PairManagerV8 |
| 40 | `selfRescueWithPermit` — the CONTRACT half. Frontend half shipped. | FigureEightMatrixV8 |

**Two need an OWNER DECISION before they can be built — do not guess these:**
- **item 2** — `reservedHeldFor(member)` getter **or** bind the reserve across all tiers.
- **item 28** — distribution expiry: keep and surface it loudly, or remove it. $0.81 exposed today, ~$1,865 on the next run.

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

Frontend, already live: **39** (seat position + rotations-to-cycle + sampled rate),
**40 frontend** (one-click clear-all), **41b** (the 65/35 modal), and the withdraw
fixes below.

Contract, awaiting deploy (2026-08-12): **42** (epoch policy — see above).

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

**Fabricated-fallback sites still live in `index.html`** — a value-returning
`.catch()` renders a confident wrong number. Two are DISPLAY bugs, two are worse:

| line | read | why it matters |
|---|---|---|
| 4205, 4987 | `tierCycles(...).catch(() => 0n)` | feeds UPGRADE GATING, not display. A dropped read reads as "0 cycles" and can wrongly LOCK a member out of an upgrade. |
| 6301 | `memberHighestTier(...).catch(() => 1)` | same class, same consequence — mis-gates an upgrade. |

Each needs its own "could not verify" UI state and its own test. Do not batch-swap
them to `null` without checking what each caller does with the null.

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

**FIRST QUESTION FOR THE NEXT SESSION, do not skip it:** both reports are dated
2026-08-11, the same day the withdraw fixes (per-matrix try/catch, gas estimate,
balance-delta receipt, withdraw history) and the clear-all sequencer shipped. The
timestamps alone do not say whether these members were on the old build or the new
one. Establish that BEFORE treating either as evidence for or against the fixes —
reading a report from the old build as a failure of the new one, or the reverse,
would send the whole session the wrong way.
