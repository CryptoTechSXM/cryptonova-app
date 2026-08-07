# V8.48 — PLAN

Status board. Written 2026-08-08 from V8_48_BACKLOG.md (all three items
evidenced live on V8.47). Anchor line for a fresh session: "V8.48 prep for
CryptoNova. Read V8_48_PLAN.md and V8_48_BACKLOG.md; deploy version =
deployed_addresses_v8_48.json."

---

## Theme

Make the chain agree with itself. V8.47's frontend now computes claimable
balances, reserve holds and loan settlement correctly — by mirroring
withdrawCore in JavaScript, because the contract's own views report something
else. V8.48 moves that truth on-chain: the views say what enforcement does,
reserve reporting becomes first-class, and the withdrawal experience finishes
with one-signature partial withdrawals. No changes to split economics, matrix
mechanics, or the SF ledger model.

## Decisions locked (owner 2026-08-08)

- **SCOPE FREEZE 2026-08-10 (~48h shakedown window)**: the upgrade-focused
  bigfill wave + community traffic run first as a deliberate V8.48 shakedown —
  it stresses exactly the code V8.48 touches (hybrid upgrades, debt-fold,
  higher-tier reserves, clawback bands). New contract-level findings are
  accepted into scope until the freeze; then we build. During the window the
  PARITY TESTS (item 1) are written against V8.47 code in the cloud harness —
  they must FAIL in exactly the documented ways (view under-reports, hybrid
  under-draws), proving they catch the bugs; they flip green after the build.
- Reserve semantics stay MEMBER-FRIENDLY: lower-tier earnings remain fully
  withdrawable; automation waits when short. V8.48 adds truthful REPORTING
  (`reservedHeldFor`), not stronger locking. The "waterfall" alternative
  (bind the target across all tiers) is DEFERRED — revisit before mainnet if
  wanted; it is a real member-behavior change and needs its own testing cycle.
- Scope stays lean: the three items below, nothing else rides along.

## Scope, in priority order

| # | Item | State |
|---|------|-------|
| **1** | Parity tests FIRST (V8.47 discipline — written before any implementation): V8_48_ViewParity.test.js proves for randomized member states (seated/unseated, toggles on/off, debt/no debt, multi-pair, commission-only credits) that `freeWithdrawable()` == what withdrawCore actually releases, per matrix | TODO |
| **2** | `freeWithdrawable()` rewritten to mirror withdrawCore exactly: crossing hold ONLY while the automation reserve is active on that matrix (V8.32 opt-out), reserve on the highest-tier matrix only — ideally one shared internal both call sites use, so they can never drift again. Side effect: fixes hybridUpgrade's under-draw (it consumes this view via TierRouterLib.drawFreeEarnings) | TODO |
| **3** | `netClaimableOf(member)` on TierRouter: Σ per-matrix free − memberDebt (clamped ≥0) = what a full withdrawal pays before the fee. One call for UIs/tools; frontend `_claimableAll` keeps its mirror as RPC-failure fallback but reads this as primary | TODO |
| **4** | `reservedHeldFor(member)` on TierRouter: what the reserve + crossing holds ACTUALLY withhold right now (the frontend's `heldNow`, computed on-chain). Badge/tools read it directly | TODO |
| **5** | `bulkWithdraw(uint256 amount)` on TierRouter: walk the member's matrices (same order as the no-arg sweep), draw up to `amount` total through the withdrawCore path — debt-first, hold-respecting, one signature. V8_48_BulkWithdraw.test.js: exact amounts, spanning matrices, debt interaction, reserve matrix skipped, fee math, gas | TODO |
| **6** | EIP-170: TierRouter is 142 bytes under the limit BEFORE these additions. All new loop bodies go to TierRouterLib (linked, delegatecall) from the start; if still over, extract further leaf helpers. Compile-size table is the gate, checked at every step | TODO |

## Verification plan

- Build + test in the cloud-container harness first (sf-harness pattern from
  V8.47; solc cache workaround documented in memory), then port to the device
  repo and re-run the FULL suite there (440+ passing baseline, 0 failures).
- New tests: V8_48_ViewParity.test.js (item 1), V8_48_BulkWithdraw.test.js
  (item 5), plus regression re-runs of all V8_47 tests unchanged.
- predeploy_check.js with ADDRESSES_FILE=deployed_addresses_v8_48.json.
- Frontend ripple lands ONLY after contracts verify: partial withdrawals call
  bulkWithdraw(amount) (one signature — retire the per-matrix loop to a
  fallback), `_claimableAll` prefers netClaimableOf, badge prefers
  reservedHeldFor. The JS mirror stays in the codebase as the cross-check.

## Deploy ripple

1. Fresh full redeploy (testnet convention: positions reset, re-register).
   deploy_v8.js: TierRouterLib deploy+link BEFORE TierRouter (existing V8.47
   pattern), tierRouter.setStabilityFund, splits UNCHANGED from V8.47.
2. .env / script defaults → deployed_addresses_v8_48.json (deploy_v8, seed_w1,
   bigfill_v8, predeploy_check).
3. After EVERY fresh deploy: keeper EOA re-auth via scripts/set_upkeep_caller.js;
   VPS keeper .env addresses file bump; frontend update_addrs script; RR
   sponsor list re-verify; integrity gate green before frontend goes to admin.
4. Gate + withdrawal window + community announcement, schedule TBD by owner
   (announced in community_report_2026-08-08.md as "well in advance").

## Not in scope

- Split/economics changes, matrix mechanics, SF ledger model — untouched.
- Reserve waterfall binding — deferred (see Decisions).
- Mainnet timeline — separate track (owner: weeks of mainnet before audit;
  Claude's position on record: audit before real funds).

## Next operational step (independent of V8.48 build)

Bigfill resumes with a small edit (owner to specify) + fund selected leaders
$30k USDC each for wallet-funded UPGRADES — next wave's main focus is upgrade
traffic (exercises the debt-fold, hybrid paths, and higher-tier fills).
