# V8.48 HANDOFF — updated 2026-08-11 (read this first, then V8_48_SCOPE.md)

**508 passing · predeploy_check 110 · both repos clean · DO NOT DEPLOY YET.**

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
