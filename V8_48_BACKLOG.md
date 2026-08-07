# V8.48 — CONTRACT BACKLOG

Items discovered live on V8.47 that need a REDEPLOY to fix. Frontend already
compensates for both (index.html `_claimableAll`, 2026-08-07) — no member harm
meanwhile — but the chain should agree with itself at the next version.

## 1. freeWithdrawable() view disagrees with withdrawCore (the enforcement)

Found 2026-08-07 (Sherwyn ticket ea89ba8 + owner's Nova Rise / Nova Core
screenshots). The VIEW pre-dates two rules that live only in withdrawCore:

- **V8.32 opt-out missing**: `freeWithdrawable` (FigureEightMatrixV8:623)
  subtracts the seated crossing hold (`ENTRY_FEE − crossingReserve`)
  UNCONDITIONALLY, but `withdrawCore` (MatrixLogicLib:992) enforces it ONLY
  while the automation reserve is active on that matrix
  (`automationReserve > 0`). A member with all automation off can withdraw
  freely, yet the view under-reports.
- **Reserve netting asymmetry**: the view subtracts `reservedFor` on the
  highest-tier matrix — correct — but every UI that then subtracted the
  reserve AGAIN on top of the view double-counted it. A `reservedHeldFor()`
  getter (see item 2) removes the temptation.
- **V8.47 debt not reflected**: withdrawCore repays `SF.memberDebtOf(member)`
  FIRST out of any withdrawal; no view exposes "net after debt".

**Fix**: make the view a line-for-line mirror of withdrawCore (or extract one
shared internal both call), and consider a `netClaimableOf(member)` convenience
view = what a full withdrawal would actually pay before the withdrawal fee.

## 2. Automation reserve only binds the highest tier — automation can be left underfunded

`withdrawCore` applies `reservedFor` ONLY where `(memberHighestTier − 1) ==
tierIndex`. Lower-tier balances are withdrawable in full, so a member can
drain T1..T(n−1) and leave the reserve target mostly unfunded (live example
2026-08-07: target $450, actually held $32.40). Consequences are soft — the
V8.47 upgrade gate no-ops when short and auto re-entry waits for new earnings
— but "reserved" promises more than the chain holds.

**Decide one of**:
- (a) bind the reserve across ALL tiers' withdrawals (waterfall: hold up to
  `reservedFor` across matrices, highest tier first), or
- (b) keep best-effort semantics and add an on-chain `reservedHeldFor(member)`
  getter (what is actually held now) so UIs never have to reconstruct it.

Frontend currently reconstructs (b) client-side (`_claimableAll.heldNow`) and
words the badge as "Reserve target $X · $Y held from current earnings".

## Context

- Deploy version at discovery: deployed_addresses_v8_47.json, Base Sepolia.
- Frontend compensation commits (Testnet-App, admin): 427beb5 (unified
  `_claimableAll` withdrawCore mirror) + follow-up badge-truth commit.
- Owner decisions 2026-08-07: badge shows both figures; this backlog logged.
- Related standing rule: mainnet grace = 48h (testnet 24h) — keeper config,
  not a contract change.
