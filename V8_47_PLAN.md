# V8.47 — PLAN

Status board. Written 2026-08-04; finalized at deploy time 2026-08-05. Supersedes
the scattered V8.47 notes in CLAUDE.md, which stay as the evidence trail.
Anchor line for a fresh session: "V8.47 deploy for CryptoNova. Read V8_47_PLAN.md
and GO_LIVE_RUNBOOK.md; deploy version = deployed_addresses_v8_47.json."

---

## Theme

A rescue loan IS a personal debt the member owes. V8.46 could not always collect
it (a moved-on matrix with $0 left dropped the loss on the Stability Fund).
V8.47 makes the debt follow the member until repaid: the per-matrix debt silo is
promoted to a MEMBER-LEVEL ledger in the StabilityFund (creditor + custodian),
so debt drains from any tier the member earns in. Member-facing copy must frame
this as a repayable advance that stays on the account until cleared — never
"nothing owed / not a personal debt".

---

## Scope, in priority order

| # | Item | State |
|---|------|-------|
| **1** | SF-conservation invariant test (written FIRST, before implementation): sum(memberDebt) == totalRescueLoaned - totalRescueRepaid, and SF USDC == totalBalance, held across a 400-op random sweep | **BUILT, GREEN** |
| **2** | Member-level ledger in StabilityFund: memberDebt / debtIssuingTier / totalRescueLoaned / totalRescueRepaid; increaseMemberDebt (matrix + owner-migration paths); overloaded receiveDebtRepayment(address,uint256); tierRouter accepted as repayer | **BUILT, GREEN** |
| **3** | MatrixLogicLib rewired: all 5 repay sites + 2 loan-issue sites point at the SF ledger; local per-matrix rescueDebt frozen | **BUILT, GREEN** |
| **4** | Banded clawback keyed to the ISSUING tier (deeper tiers claw harder): T8-10 90%, T6-7 80%, T4-5 70%, T1-3 60%; owner-tunable via setClawbackBands | **BUILT, GREEN** |
| **5** | Upgrade gate = FOLD outstanding debt into the upgrade cost on ALL 3 paths (_executeAdditive auto, _manualUpgrade, hybridUpgrade); no-op if under-funded (advance stays clean) | **BUILT, GREEN** |
| **6** | Migration of existing stranded per-matrix debt into the ledger (no USDC moves): FigureEightMatrixV8.clearRescueDebt onlyOwner; addRescueDebt retired from forceCross | **BUILT, GREEN** |
| **7** | Split BPS change (same redeploy, net-zero): Community 50 -> 100, Liquidity Reserve 50 -> 25, CNOVA Buyback Reserve 50 -> 25. Sum stays exactly 4750 (ctor hard-requires); no other bucket touched. Full SPLITS_ALL = [500,1350,1800,500,300,100,50,100,25,25] | **BUILT** |
| **8** | EIP-170 size fix: TierRouter's param-only leaf helpers (_takeSeat, _sameTierTarget, _drawFreeEarnings) + the debt-fold extracted to NEW linked library contracts/TierRouterLib.sol. TierRouter now 24434 bytes = 142 under the 24576 limit | **BUILT, GREEN** |

## Verification record

- Full suite on the dev machine: compile clean (no size warning), **440 passing / 0 failing** (7 pending).
- V8.47 tests: V8_47_SFConservation.test.js (invariant #1, bands, access control),
  V8_47_Integration.test.js (migration sweep; the 0xa2Df stranded-debt-collects-on-withdrawal case),
  V8_47_UpgradeGate.test.js (G1 manual fold, G2 under-funded revert, G3 real MatB
  cycle-out collects debt + clean auto-upgrade to T2).
- stress_test_full.js updated off the old per-matrix debt model (SF-authorize the
  4 fixture matrices; T7 helpers re-pointed to sf.increaseMemberDebt / sf.memberDebt).
- predeploy_check.js: 86/86 passed with ADDRESSES_FILE=deployed_addresses_v8_47.json.

## Deploy ripple (NEW this version)

1. TierRouter must deploy AND LINK TierRouterLib (same pattern as
   MatrixLogicLib -> FigureEightMatrixV8). deploy_v8.js updated; all 19 active
   test fixtures relinked via getContractFactory('TierRouter', {libraries: ...}).
2. tierRouter.setStabilityFund(sfAddr) after deploy (in deploy_v8.js).
3. .env ADDRESSES_FILE=deployed_addresses_v8_47.json (deploy_v8 / seed_w1 /
   bigfill_v8 defaults aligned to v8_47).
4. predeploy_check.js does NOT check contract size or library linking — the
   compile-time size table is the guard there.

## Schedule (all EDT, set 2026-08-04)

- Site gated (countdown) from midnight Aug 5; members withdraw before midnight,
  fresh redeploy = positions reset, re-register on V8.47.
- PREVIEW push (small-team QA): 9:00 AM EDT Aug 5.
- MAIN push (community go-live): 10:00 AM EDT Aug 5. 1-hour QA window.
- Announcement: community_deploy_v8_47.md (finalized). $1 bug bounty stays live.

Deploy follows GO_LIVE_RUNBOOK.md (Phase 0 prep -> 1 deploy + integrity gate ->
3 frontend on admin -> 6 preview -> main). Push ladder: admin (owner verifies
frontend) -> preview (small-team QA) -> main (community).
