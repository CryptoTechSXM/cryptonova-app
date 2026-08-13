# PARITY_AUDIT.md — every member-facing claim, with its contract source (V8.48 item 38)

**The owner's deploy gate** (rule of 2026-08-10: *"code is truth but should also be
reflected on the frontend/website"*). One row per member-facing claim; the contract
function/constant that backs it; a verified date. **Anything without a named source
does not ship.**

- Audited 2026-08-13 against the V8.48 source tree (`contracts/` + `deploy_v8.js`)
  and the live frontend tree (`CryptoNova-Testnet-App`), all files as of this date.
- Sweep coverage: index.html, compensation.html, faq.html, buy.html, governance.html,
  liquidity.html, terms.html, locales/en.json (overrides HTML via i18n), and the
  Telegram bot SYSTEM_PROMPT (api/telegram-qa.js).
- Line numbers are as of 2026-08-13 and will drift; the SOURCE column (contract
  file + member name) is the durable reference.
- The mechanical half of this gate lives in `scripts/predeploy_check.js`
  ("item 38 — frontend ABI ↔ contract surface"): the gate FAILS if index.html
  declares any contract member absent from the V8.48 contracts. This document is
  the judgement half — re-read it before every deploy.
- STATUS: ✅ = claim verified true against the named source. ✗ = member-facing text
  is wrong → numbered fix in the FIX LIST at the bottom.

---

## 1. The fee split (every entry fee, all 10 tiers — identical split)

| # | Claim on the site | Where it appears | Contract source | Verified value | Status |
|---|---|---|---|---|---|
| 1.1 | 50% crossing reserve, pre-funds HALF the next crossing fee | comp :601, faq q4/q8/q12/q19, index :823, bot | `MatrixLogicLib.sol:187` `CROSSING_RESERVE_BPS = 5_000` | 5000 bps; crossing costs the FULL fee, reserve covers half, earnings the rest | ✅ 2026-08-13 |
| 1.2 | 2.5% instant earn on your own entry | comp :607, faq q4_li2, index :824, bot | `MatrixLogicLib.sol:188` `DIRECT_EARN_BPS = 250` | 250 bps | ✅ 2026-08-13 |
| 1.3 | 5% to the direct referrer (L1), on registration and upgrades | comp :617, faq g12/q16, index :826, bot | `deploy_v8.js:103` `SPLITS_ALL` l1=500 | 500 bps | ✅ 2026-08-13 |
| 1.4 | Chain pay 2.7% × 5 levels (L2–L6), 13.5% total | comp :623, faq q4_li5, index :827, bot | `deploy_v8.js:106` `CHAIN_PAY_ALL = [270×5, 0]` | 5 paid levels of 270 bps, 6th slot ZERO. (en.json carries a dead `s2_l6_pct` key — nothing renders it) | ✅ 2026-08-13 |
| 1.5 | 18% equalization pool, distributed EVERY ROTATION across seats 2–127 weighted by depth, no root lump | comp :613, faq g13/q17_a1, index :825, bot | `deploy_v8.js:103` pool=1800; `MatrixLogicLib` `_settlePool`/accumulators | 1800 bps, per-rotation drip | ✅ 2026-08-13 — but see ✗F16/✗F20 for three stale "pays at fill / resets / funds the root" wordings |
| 1.6 | 5% CNOVA Treasury | comp :631, faq g3/q21, index :829, bot | `deploy_v8.js:103` treasury=500 | 500 bps | ✅ 2026-08-13 |
| 1.7 | 3% Stability Rescue Fund | comp :637, faq g14, index :828, bot | `deploy_v8.js:103` sf=300 | 300 bps | ✅ 2026-08-13 — en.json `statusPage.sf_info_note` says **5%** → ✗F15 |
| 1.8 | Dev 1% + Ops 0.5% = 1.5% | comp :649, faq g4, index :830-831 | `deploy_v8.js:103` dev=100, ops=50 | 150 bps combined | ✅ 2026-08-13 |
| 1.9 | Community Wallet 1% | comp :655 (pct), faq q4_li10, index :832 | `deploy_v8.js:103` cw=100 (V8.47: 50→100) | 100 bps | ✅ pct — but comp :458/:656 prose+dollar still say 0.5%/$0.05 → ✗F6/✗F7; bot says 0.5% ×2 → ✗F6 |
| 1.10 | Buyback 0.25% · Liquidity 0.25% | comp :643/:661, faq q4_li9/li11, index :833-834 | `deploy_v8.js:103` bbr=25, lq=25 (V8.47: 50→25) | 25 bps each | ✅ pct — comp dollar cells still $0.05 → ✗F7 |
| 1.11 | "Protocol reserves 6%" remainder framing | comp :665, en.json split_footer | 300+100+50+100+25+25 = 600 bps | 6% | ✅ 2026-08-13 |
| 1.12 | Split identical across all 10 tiers; "fixed at deployment" | comp :322, terms s2 | `deploy_v8.js:108` `tierSplits()` returns SPLITS_ALL for every tier; splits are constructor-set immutables (`FigureEightMatrixV8.sol:48-57`) | one table, no setter | ✅ 2026-08-13 — terms "tier-dependent split rules" wording → ✗F22 |

## 2. Tier fees and names

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 2.1 | T1 $10 · T2 $25 · T3 $50 · T4 $100 · T5 $250 · T6 $500 · T7 $1,000 · T8 $2,500 · T9 $5,000 · T10 $10,000 | comp table :492-573, faq q4, index :857-865 + fallback tables :2195/:5242, bot | `deploy_v8.js:88-99` `TIER_FEES` | exact | ✅ 2026-08-13 (hardcoded fallback tables match today; drift risk if fees ever change) |
| 2.2 | Tier display names (one canonical set) | index table :857-865 vs registration selector :1703-1714 | frontend-only (no contract source) | selector disagrees with the site's own canonical names for T4–T7 (e.g. "SuperNova Spark" is also an epoch name) | ✗F14 |

## 3. Gates

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 3.1 | T2–T5 unlock together at 25 T5 pioneers | comp :583, faq q11_a2, index :868/:1146, bot, gov param 52 hint | `TierRouter.sol:408-410` `tierGateThreshold[5] = 25` | 25 | ✅ 2026-08-13 |
| 3.2 | T6 = 15, T7 = 10, T8/T9/T10 = 5 each (governance params 52–57) | comp :583, faq q11_a2, gov hints :866-871 | `TierRouter.sol:411-415` | 15/10/5/5/5 | ✅ 2026-08-13 — bot still says "own 25-member milestone" → ✗F9 |
| 3.3 | comp access-table shows T2 "Open", T3+ "Whale Gated" | comp :505 | same as 3.1 — T2 is gated WITH T3–T5 until 25 T5 pioneers | T2 gated at fresh deploy | ✗F8 |
| 3.4 | index tier cards: "Gate opens when T{n} MatB hits 80% fill" (9 cards) | index :897-1041 | NO SUCH MECHANIC — gates are first-entry counts (3.1/3.2); 80% is the PAIR FACTORY pre-deploy trigger (`MatrixPairFactory`), unrelated to gates | wrong mechanic on all 9 cards | ✗F11 |
| 3.5 | Velocity gate is separate, auto-upgrades only, display "Auto-Paused" | index :4050-4065 | `TierRouter` `tierVelocityGreen` (keeper-set) | correctly separated from Whale Gate | ✅ 2026-08-13 |

## 4. Cycle-out and automation

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 4.1 | Additive engine: re-entry → upgrade → double seat, in that order | comp :418, faq q6/q11, bot | `TierRouter.sol` `_executeAdditive` blocks 1/2/3 | additive — all three can fire in one cycle-out | ✅ 2026-08-13 — index :1544 still describes either/or → ✗F12 |
| 4.2 | Auto re-entry forced ON for the first 2 cycles | faq q11_a1 "until 2 cycles", bot | `TierRouter.sol:265` `reentryMinCycles = 2`, `:1300` | 2 | ✅ 2026-08-13 |
| 4.3 | Auto-upgrade ON for the first 5 cycles | faq q11_a1, bot | `TierRouter.sol:264` `autoUpgradeCycleThreshold = 5`, `:1303` | 5 | ✅ 2026-08-13 |
| 4.4 | Double re-entry OFF by default; activates only after 2 completed cycles | bot | `TierRouter.sol:227` default false; `:1306-1307` `&& cycles >= reentryMinCycles` | correct | ✅ 2026-08-13 |
| 4.5 | Manual upgrade routes: completed cycle OR gate open OR seat in previous tier's MatB | comp :583, faq q11_a2 | `TierRouter.sol` `_upgradeEligible` (a)/(b)/(c) | three routes | ✅ 2026-08-13 |
| 4.6 | Switching auto re-entry off ⇒ graduation on cycle-out (reserve returned, seat not kept) — confirm dialog | index (38605d7) | `TierRouter.sol:226` + `_executeAdditive` park/graduate path | correct | ✅ 2026-08-13 |
| 4.7 | reservedFor is ADDITIVE (reentry +curFee, upgrade +nextFee, double +curFee); modal itemizes | index reserve modal | `TierRouter.sol:1717` `reservedFor`, `:1755` `reservedHeldFor` (NEW V8.48 — frontend switch is a post-deploy task, scope item 2) | additive | ✅ 2026-08-13 |

## 5. Parking and rescue

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 5.1 | Park on crossing shortfall; reserve covers exactly half; earnings must cover the rest | faq q19, comp, bot | `MatrixLogicLib` park sites + `CROSSING_RESERVE_BPS` | designed path | ✅ 2026-08-13 — en.json `g16`/`reg.earn_disclaimer` imply the reserve covers the WHOLE re-entry → ✗F17/✗F19 |
| 5.2 | "24-hour grace" before co-pay rescue | index :1333, bot | `deploy_v8.js:616-618` sets `setParkedGracePeriod(86400)` (testnet default; source default `MatrixKeeper.sol:125` is 6h, governance menu param at `V8Governance.sol:426`) | 24h AS DEPLOYED on testnet — copy is correct for this deploy; env-dependent (PARKED_GRACE_SECS) | ✅ 2026-08-13 — prefer reading the getter live |
| 5.3 | Self-rescue: shortfall paid from YOUR WALLET, approved to the MATRIX; no loan, no debt | index :1338 (+approve target verified :9424), bot | `MatrixLogicLib.selfRescue` `safeTransferFrom(member, …)` | correct | ✅ 2026-08-13 |
| 5.4 | `selfRescueWithPermit` — one signature, no separate approve (V8.48) | frontend switch is post-deploy (scope item 40) | `FigureEightMatrixV8.sol:580` | shipped contract-side; Base mainnet USDC IS EIP-2612 (probe 2026-08-13) | ✅ 2026-08-13 |
| 5.5 | Co-pay rescue: SF lends only the gap; repaid automatically from future earnings | index :1341, bot | `StabilityFund.sol:113` `rescueRepayBps = 10_000` + `MatrixLogicLib` `_settlePool` debt-first + `withdrawCore:1196-1209` | 100% of payouts to debt until clear; ALSO settles on withdraw (V8.47 ledger) | ✅ 2026-08-13 — comp :674 / faq g14 / en.json say "repays 60% to 90% depending on tier" → ✗F1; "nothing is ever taken from your wallet" → ✗F2 |
| 5.6 | Insolvency floor: no SF loan when debt ratio breaches floor; ghost = dequeue-only; insolvent = evict with reserve released | item-46 frontend surface SHIPS WITH DEPLOY (scope item 46) | `StabilityFund.sol:783` `insolvencyFloorBps = 3_400` (param 59); valve in 45/46/47 package | 3400 bps default | ✅ contract 2026-08-13 — frontend surface still to ship → NEXT UP list |
| 5.7 | Frozen MatB rotated by the CONTRACT after 15 minutes | (ops fact; no page claims a number) | `MatrixKeeper.sol:150` `frozenMatBTimeout = 15 minutes` | 15 min — VPS `frozen_matb_keeper` cron must be DELETED on deploy day (with `evict_parked`) | ✅ 2026-08-13 |
| 5.8 | Idle seat reclaimed after 7 days | faq q18 "after 7 days", gov p51 hint "604800" | `MatrixKeeper.sol:123` `extendedIdleTimeout = 604_800` | 7 days | ✅ 2026-08-13 |
| 5.9 | SF surplus redirect to Community Wallet at 100% once SF at target | (gov menu) | `StabilityFund.sol:146` `communityOverflowBps = 10_000` (param 60) | 100% | ✅ 2026-08-13 — params 59/60 missing from governance.html picker → ✗F23c |
| 5.10 | SF target = tier fee × 10 (flat) | gov p40-49 hints say "Default: 20x" ×10 sites (+ en.json) | `StabilityFund.sol:252` `sfTargetMultiplier[i] = 10` (item 48) | 10x | ✗F23a |

## 6. Withdrawals

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 6.1 | 1.5% withdrawal fee; you receive 98.5% | index :1430 (live read + 150n fallback), faq q13_fee, bot, gov p9 hint | `FigureEightMatrixV8.sol:184` `withdrawalFeeBps = 150`; charged in `MatrixLogicLib.withdrawCore:1249` | 150 bps | ✅ 2026-08-13 |
| 6.2 | Fee is governance-adjustable 0.5%–2.5% | faq q13_fee | `V8Governance.sol:406` param 9 menu `[50,100,150,200,250]` | 0.5–2.5% | ✅ 2026-08-13 |
| 6.3 | Fee goes to the Stability Fund | faq q13_fee | `MatrixLogicLib.sol:1253` `_forwardToStabilityFund(…, fee, 3)` | SF (layer 3) | ✅ 2026-08-13 |
| 6.4 | Outstanding rescue debt is repaid first on any withdrawal | faq q13_fee | `MatrixLogicLib.withdrawCore:1196-1209` (member-level ledger, V8.47) | up to full available | ✅ 2026-08-13 |
| 6.5 | Locks apply at your HIGHEST tier only; lower-tier balances fully withdrawable | faq q13_fee | `withdrawCore:1216-1238` — automationReserve and fee-minus-reserve keep-back enforced only where `(highest-1) == tierIndex`; reserve keep-back also skipped entirely when automation is off | correct in V8.48 | ✅ 2026-08-13 |
| 6.6 | "Withdraw all sweeps every tier in one transaction" | faq q13_a1 | `TierRouter.sol:1026` `bulkWithdraw()` + `:1049` `bulkWithdraw(uint256)` (V8.48 item 3) | one signature | ✅ contract 2026-08-13 — frontend still loops per-matrix; switching to the single call is the item-3 POST-DEPLOY task |
| 6.7 | freeWithdrawable() is the site's number and mirrors withdrawCore incl. accrual | index (V8.44 G3 + item 1) | `FigureEightMatrixV8.sol:690` + V8.48 item 1 fix | mirrors | ✅ 2026-08-13 |

## 7. CNOVA token and epochs

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 7.1 | Epoch rewards 50/40/20/10/5/2.5/2.5/2.5 (+E9 ≤2.5), era names Nebula Genesis → Final Frontier | comp :426-436, faq q9/q20, index :3521-3528, bot | `CNOVAToken.sol:182-190` `epochRewards[9]` | exact, 9 epochs | ✅ 2026-08-13 — index mining schedule renders only 8 of 9 → ✗F13; faq "halves each epoch" (50→40 isn't a halving) → ✗F21 |
| 7.2 | Epoch advances at 1,000,000 CNOVA minted OR 1,000 new members OR 180 days | index halving panel :2491-2517 (live reads) | `CNOVAToken.sol:137/159/170` (item 42) | 1M / 1,000 / 180d | ✅ 2026-08-13 — comp :426, faq g11/q9, en.json ×3 still say "30 days" → ✗F3; bot says "10k members, 30 days" → ✗F4 |
| 7.3 | Tier multipliers ×1/2/4/8/20/40/80/160/320/640; "T7 = 80x", "T10 640x", "T5 E1 = 1,000 CNOVA, T10 = 32,000" | index :994, comp :438, bot | `CNOVAToken.sol:92` `tierMultipliers` | exact (50×20=1,000; 50×640=32,000) | ✅ 2026-08-13 |
| 7.4 | Hard cap 21,000,000 CNOVA | comp :438, faq q20, bot | `CNOVAToken.sol:86` `MAX_SUPPLY` | 21M, mint clamps at cap (`:528`) | ✅ 2026-08-13 |
| 7.5 | Cliff-vest 180 days; early unlock costs up to 50%, falling linearly; penalty burned | comp :446, faq q21_a3, index :738 (vestDuration read, 15552000n fallback) | `CNOVAToken.sol:214` `vestDuration = 180 days`; `:231` `maxPenaltyBps = 5_000`; `:226/:234` burned when `penaltyDestination == 0` | exact | ✅ 2026-08-13 |
| 7.6 | Floor = Treasury USDC reserve ÷ CNOVA supply; "only ever moves up"; mint never exceeds backing | comp :445-449, faq q21, buy :423, terms | `CNOVATreasury.sol:213-222` `floorPrice()`; V8.48 items 4+5+6 (mint capped at each seat's reserve deposit; hard no-override floor guards on both treasury owner functions) | formula exact; monotonicity now guard-enforced | ✅ 2026-08-13 |
| 7.7 | "50 CNOVA per T1 entry at $0.01 launch floor, backed by the $0.50 treasury deposit" | index :738, comp :448, faq q21_a2, bot floor-by-tier table | E1 reward 50 (`epochRewards`), treasury 5% of $10 (`SPLITS_ALL`), floor formula 7.6 | derivations check ($0.50/50=$0.01; T2 $1.25/100=$0.0125; T8 $125/8000=$0.015625) | ✅ 2026-08-13 |
| 7.8 | Rewards minted on EVERY seat (register, upgrade, crossing, re-entry, rescue) | comp :352, faq g2 | `CNOVAToken.mintReward` call sites; a member ≈ 41 seats measured | per-seat | ✅ 2026-08-13 |
| 7.9 | Final Frontier reward percentage, range 10–75% (gov param 30) | gov :834 hint | `CNOVAToken.sol:200-202` `rewardPct = 25`, min 10 max 75; menu `V8Governance.sol:441` `[10..75]` | hint's range correct | ✅ 2026-08-13 |

## 8. Community Wallet

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 8.1 | First 1,000 members, enrolled automatically, for life | comp :366/:455, faq q12_a2, index :706/:1600, terms | `CommunityWallet.sol:61` `MAX_MEMBERS = 1_000` | 1,000, one slot per wallet | ✅ 2026-08-13 |
| 8.2 | Genesis (#1–500) 60% / Pioneer (#501–1,000) 40% | index modal (live read, 6000/4000 fallback), comp :460-461, bot | `CommunityWallet.sol:72-73` `genesisBps = 6_000` / `pioneerBps = 4_000` | 60/40 — the OLD 65/35 modal claim was the bug, fixed 2026-08-10 (item 41b), guarded by predeploy_check | ✅ 2026-08-13 |
| 8.3 | Half of the pool distributes, half rolls over | comp :464, index :6922 | `CommunityWallet.sol:74` `distributeRatioBps = 5_000` | 50/50 | ✅ 2026-08-13 |
| 8.4 | Distribution on the 25TH of every month (calendar-day model), anyone can trigger | index countdown (nextDistributionTime + V8.47 fallback) | `CommunityWallet.sol:84` `distributionDayOfMonth = 25` (item 41) | the 25th — NOT a rolling 30 days | ✅ index — comp :464 + bot still say "every 30 days" → ✗F5; gov param-39 hint still describes an interval → ✗F23b |
| 8.5 | Claim window 30 days; unclaimed sweeps back to the pool (by design, item 28) | comp :470, index :3255 (deadline warning shipped 2026-08-12) | `CommunityWallet.sol` claim window + sweep | 30 days | ✅ 2026-08-13 |
| 8.6 | Funded by the 1% CW split + orphan fees | comp :458/:464 | `SPLITS_ALL` cw=100; orphan routing (`SRC_ORPHAN_ACCT1` family → CW layer) | 1% | ✅ mechanism — the "0.5%" prose is ✗F6 |

## 9. Governance

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 9.1 | Proposal fee: burned CNOVA, DAO-tunable param 58, menu 0–1000, 0 = free; voting always free; live-read + FEATURE-DETECTED (V8.47 has no getter) | gov :658/:1795-1824/:1912 | `V8Governance.sol:302` `proposalFee = 100e18`; `_chargeProposalFee` after validations | 100 CNOVA default; feature-detect verified present | ✅ 2026-08-13 |
| 9.2 | 72h voting, 48h timelock, executes within 72h or expires | gov :449/:686/:691, faq q1/q26, terms, en.json | `V8Governance.sol:293-295` | 72h/48h/72h (menus at `:410-411`) | ✅ 2026-08-13 |
| 9.3 | Quorum 2% of supply; majority wins | gov :681/:813 | `V8Governance.sol:297` `quorumBps = 200`, `:542` | 2% | ✅ 2026-08-13 |
| 9.4 | Proposer must hold ≥0.01% of supply | gov :676, en.json | `V8Governance.sol:~532` `supply / 10_000` | 0.01% | ✅ 2026-08-13 |
| 9.5 | Param picker offers everything governable | gov :509-601 | params 59 (`insolvencyFloorBps`) and 60 (`communityOverflowBps`) exist in V8.48 | missing from picker (58 is runtime-installed) | ✗F23c |
| 9.6 | "Fixed Protocol Rates (not yet DAO-votable)" card | gov :457 | the same card's own badges name params 9 and 50 as votable | self-contradicting title | ✗F23d |
| 9.7 | Rescue repay param 50 hint "10000 = 100%" | gov :862-863 | `StabilityFund.sol:113` | correct | ✅ 2026-08-13 — but the param-50 DESCRIPTION omits/contradicts settle-on-withdraw → fold into ✗F1's sweep |

## 10. Direct sale, liquidity, terms

| # | Claim | Where | Source | Verified value | Status |
|---|---|---|---|---|---|
| 10.1 | Buy above floor on a supply curve 1.25× → 1.50× → 1.75× → 2.00×, tiers at 1M/5M/20M CNOVA | buy :532/:582-585 | `CNOVADirectSale.sol:147-149` curve tiers (+2.00× above 20M) | exact | ✅ 2026-08-13 |
| 10.2 | Whale caps: 1% of supply per tx, 5% per wallet | buy :791 comments/errors | `CNOVADirectSale.sol:86-87` `maxTxBps = 100`, `maxWalletBps = 500` | exact (menus `:456-469`) | ✅ 2026-08-13 |
| 10.3 | Minimum purchase $1 | buy :846/:1079 | `CNOVADirectSale` min-purchase check | $1 | ✅ 2026-08-13 |
| 10.4 | Premium split SF/LQ by deficit — page computes it LOCALLY from hardcoded $500/$1000 targets and coerces failed reads to $0 | buy :589-590/:978-1004 | contract exposes `previewPurchase()` (in the page's own ABI :607, unused); DS targets are governable (params 28/29, menus `:389/:401`) | display model can diverge from the contract's own split | ✗F24 |
| 10.5 | DirectSale purchases feed usdcReserve (V8.48 item 6: deploy MUST authorize the sale as a treasury caller or every purchase reverts) | (deploy wiring, not page copy) | scope item-6 row; `deploy_v8.js` authorization step; predeploy_check gates it | wired | ✅ 2026-08-13 |
| 10.6 | Yield-pool / AMM facts on liquidity.html ($10 multiples, no lock, auto-harvest, ~15-min pushes "not enforced on-chain", 0.30% swap fee, emergencyWithdraw forfeits) | liquidity :409-730 | `CryptoNovaLP.sol` / yield pool — **NOT in the V8.48 deploy set**; page hedges honestly ("not enforced on-chain") | out of this deploy's scope — verify when those contracts are next touched; page has zero data-i18n keys (locale rule) | ⚠ tracked, non-blocking |
| 10.7 | Terms: owner can halt entries, cannot block withdrawals; splits have no setter; SF has no sweep; treasury withdrawal reverts if it would lower the floor | terms :273/:311, faq q26 | V8.48 items 4+5 floor guards; splits immutable (1.12); SF spend paths | correct | ✅ 2026-08-13 — "distributed instantly" and "tier-dependent" wordings → ✗F22 |
| 10.8 | Swap success message prints the pre-trade QUOTE as the executed amount (slippage floor 0.95× quote) | liquidity :1280-1297 | receipt is the truth, not the quote | misreports up to 5% | ✗F25 |

## 11. Version labels and addresses (cutover items — the deploy protocol owns these)

| # | What | Where | Status |
|---|---|---|---|
| 11.1 | Maintenance-gate + banner version strings: "V8.43" (comp ×5, faq ×4), "V8.31" (buy/liquidity/terms gates), "V8.11" (en.json ×3), "V8.47 live" (index :1848) | all pages | ✗F26 — one pass at cutover |
| 11.2 | Bot header "## Contracts (Base Sepolia — V8.47)" + 5 hardcoded addresses (+ stale "V8.41" comment) | telegram-qa.js | ✗F26 — `update_addrs_v8_48.py` MUST include api/telegram-qa.js (CLAUDE.md mandate) |
| 11.3 | Hardcoded V8.47 contract addresses: index `ADDRS` + CNOVA card :736-737, buy :571-577, liquidity :702/:1097-1099 (same addresses labelled "V8.29/V8.30/V8.31" across pages) | all pages | ✗F26 — update_addrs pass + label unification |
| 11.4 | index feature-detect fallbacks to REMOVE after deploy: `distributeInterval` ABI line + V8.47 countdown fallback; item-41 getters go direct | index | post-deploy batch (handoff NEXT UP) |

---

## FIX LIST — member-facing text wrong against V8.48 source

Pre-deploy (contract-truth fixes, all frontend/bot text — no contract changes):

- **F1 — SF advance "repays 60% to 90% depending on tier" → 100%** (`rescueRepayBps = 10_000`), and mention debt also settles on withdrawal. Sites: comp :674, faq :301 (g14), en.json `sf_advance_note` + `g14_def`, gov param-50 description.
- **F2 — "nothing is ever taken from your wallet" → correct it.** Self-rescue pulls the shortfall from the wallet (5.3), and the V8.47+ upgrade gate pulls fee + outstanding debt from the wallet. Sites: comp :674, faq g14/q19 wording.
- **F3 — epoch time trigger "30 days" → 180 days.** Sites: comp :426 (s4_p2), faq :349 (g11) + :482 (q9), en.json (3 keys).
- **F4 — bot epoch triggers "10k members / 30 days" → 1,000 members / 180 days.**
- **F5 — "every 30 days a distribution can be triggered" → the 25th of every month.** Sites: comp :464 (s6_p3), bot. (index already fixed by item 41b.)
- **F6 — Community Wallet "0.5%" prose → 1%.** Sites: comp :458 (s6_p1), en.json `s6_p1`, bot ×2 (split list + community-pool section).
- **F7 — comp split-table dollar cells stale:** liquidity $0.05→**$0.025** (:644), CW $0.05→**$0.10** (:656), buyback $0.05→**$0.025** (:662). (Percentages already correct.)
- **F8 — comp access table: T2 "Open" → whale-gated with T3–T5** (:505).
- **F9 — bot whale gates "T6–T10 own 25-member milestone" → 15/10/5/5/5.**
- **F10 — bot still teaches the 375/381 pair thresholds → delete** (thresholds removed in V8.48 item 30; use "seats remaining in the pair", the item-36 copy).
- **F11 — index tier cards ×9 "Gate opens when T{n} MatB hits 80% fill" → real gate copy** (first-entry counts; 80% is the pair-factory pre-deploy trigger, not a gate) (:897-1041).
- **F12 — index :1544 "re-enter … only when Auto-Upgrade does not fire" → additive engine copy** (all three can fire).
- **F13 — index mining schedule renders 8 of 9 epochs → include Final Frontier** (:6676-6687).
- **F14 — index registration tier-selector names disagree with the site's canonical tier names for T4–T7** (:1703-1714).
- **F15 — en.json `statusPage.sf_info_note` "SF receives 5% of every entry fee" → 3%.**
- **F16 — pay-at-fill / matrix-resets pool copy → per-rotation drip.** Sites: en.json `how.step4`, `split.equalization_tip` ("when all 127 seats fill"), `reg.earn_title_tip` ("pool pays out and the matrix resets"), `statusPage.matrix_info_note`.
- **F17 — en.json `reg.earn_disclaimer` "$5.00 … covers your next entry" → covers HALF of it.**
- **F18 — en.json `reg.whale_gate_pre` "Tiers 5–7 require sequential progression …" → actual gate structure** (T2–T5 together at 25 T5 pioneers; T6–T10 own gates 15/10/5/5/5).
- **F19 — en.json faq `g16_def` "your first crossing costs you nothing extra" → earnings must cover the other half.**
- **F20 — faq q17_a2 "excess funds the root member's re-entry" → no root-directed pool payout** (known stale-claim family; also drop "top up your pool balance manually" — no such control).
- **F21 — faq q9 "the reward per entry halves" → 50→40 first, then halvings** (minor wording).
- **F22 — terms.html:** "distributed instantly" (:306) → describe reserve + per-rotation pool; "tier-dependent on-chain split rules" (:274) → identical split, tier-dependent FEES; bump "Last updated: June 2026" (:254).
- **F23 — governance.html:** (a) p40–49 hints "Default: 20x" ×10 (+ en.json copies) → **10x** (item 48); (b) param-39 hint still describes a rolling interval → day-of-month model, claim window fixed at 30 days; (c) params 59/60 absent from the picker → add with plain-language hints; (d) "Fixed Protocol Rates (not yet DAO-votable)" card title contradicts its own badges; (e) both `catch { p._voted = false; }` sites (:1143, :1278) → null = unknown, disable the vote buttons (the audit comment two lines above each already says so).
- **F24 — buy.html premium breakdown → call the contract's `previewPurchase()`** instead of the local $500/$1000 model, and stop coercing failed SF/LQ balance reads to $0 (renders a fabricated full-deficit split).
- **F25 — liquidity.html swap success prints the quote as the executed amount → read the receipt.**
- **F26 — version/address cutover pass** (see section 11): update_addrs_v8_48.py over ALL pages incl. api/telegram-qa.js, unify the V8.29/30/31 labels, refresh gate strings, then the truncation check per CLAUDE.md.

Display-integrity debt (tracked, larger than one fix — the standing 2026-08-07 failure-as-zero audit):

- **D1 — fee fallbacks that FEED AN APPROVE:** `tierEntryFees(...).catch(() => 25_000_000n / 10_000_000n)` at index :5569/:5855/:5860 and `fee = … || 25_000_000n` at :9107 — a dropped read approves T2's $25 for a $500 tier and guarantees a revert. 6ced4f1 class (fabricated read gating an action). **Fix with the pre-deploy batch.**
- **D2 — ~50 more `.catch(() => <literal>)` sites in index.html** rendering zeros/defaults as fact (balances, reserves, parkedAt, rotationCount, positions, CW pool, proposal count …). Non-gating; sweep post-deploy per the 2026-08-07 audit note. Inventory captured in this audit's working notes.
- **D3 — JS defects found during the sweep:** `CHAIN_ID` referenced but never defined on comp :779, faq :889, terms :457 (chainChanged handler throws); liquidity theme toggle targets non-existent `btn-theme` (:1419-1422, throws + `toggleTheme` undefined).

---

## ITEM 15 — THE APPROVALS SWEEP (2026-08-13): every ERC20 approval vs what V8.48 charges

Charge sites verified in the contracts, then every approve in frontend + scripts + live keepers matched against them.

**What V8.48 pulls from a wallet, per action (the charge table):**

| Action | Spender | Amount pulled | Source |
|---|---|---|---|
| register / registerWithOptions | T1 PairManager | T1 fee ($10) | `TierRouter._register` → `PM.registerDirectFor` → `PairManagerV8:496` |
| registerWithPermit | (permit to T1 PM) | T1 fee | `TierRouter:742` |
| registerWithCoupon | the T1 matrix | `ENTRY_FEE − couponCovered` | `FigureEightMatrixV8:431` |
| manualUpgrade | TierRouter | fee **+ memberDebtOf** | `TierRouter:935` + `_walletFold` → `TierRouterLib:193` |
| hybridUpgrade | TierRouter | (fee − free earnings) **+ memberDebtOf** | `TierRouter:980` + `:984` |
| bulkUpgrade | TierRouter | Σ fees(start..target), **NO debt fold** | `TierRouter:1105` (no `_walletFold` — see observation O1) |
| manualUpgradeWithPermit | (permit to TierRouter) | must cover fee + debt | `TierRouter:917` |
| selfRescue | the parked MATRIX | shortfall | `MatrixLogicLib:1506` |
| selfRescueWithPermit (V8.48) | (permit to the matrix) | shortfall | `MatrixLogicLib:1458` |
| coPayRescue | **NOBODY — never pulls from the wallet** | SF lends the ENTIRE shortfall or reverts | `MatrixLogicLib:1390-1425`, `StabilityFund:673` |
| rescueReentry Path A (optional) | TierRouter (standing allowance) | fee | `TierRouter:1177` |
| issueCoupon | CouponRegistry | `couponAmount` (owner-settable; currently == $10) | `CouponRegistry:131` |
| DirectSale buyCNOVA | DirectSale | usdcAmount | `CNOVADirectSale:196` |
| Treasury redeem | CNOVA allowance to Treasury | cnovaAmount (burnFrom) | `CNOVATreasury:281`, `CNOVAToken:603` |
| createProposal (V8.48) | CNOVA allowance to V8Governance | proposalFee (burned) | `V8Governance:615` |
| LP add/swap · yield pool deposit | LP / pool | exact in-amounts | `CryptoNovaLP:99-202` |

**Frontend reconciliation — all approve sites matched; two real defects found and FIXED same day:**

- ✗→✅ **A1 (FIXED): graduated tier re-entry approved FEE ONLY** (`doGraduatedReenter`, index ~:7692) while it calls `manualUpgrade`, which pulls fee + debt — the exact allowance-revert Jacob hit on the main upgrade path (50c59b1 fixed it there, this flow was missed). Now folds `memberDebtOf` like the main path, refuses honestly when the debt read fails.
- ✗→✅ **A2 (FIXED): the co-pay "You pay" approve step was fiction.** The UI computed `sfShare = withdrawable / 2` and a shortfall that IGNORED the crossing reserve — both invented; the contract has the SF lend the entire shortfall (reserve + earnings counted first) or revert. A member could be told to approve and pay for an approve tx the contract never draws on. The block now sets memberShare = 0 (contract truth), hiding the row and the approve button; co-pay is one click.
- ✅ everything else matches: register (PM, $10) · coupon register (matrix, remainder) · manual upgrade (fee+debt, 50c59b1) · bulk (Σ fees via live reads, abort-on-unreadable) · self-rescue (matrix, shortfall) · limbo re-entry (matrix, fee) · CNOVA redeem (Treasury) · proposal fee (feature-detected, live-read) · DirectSale (exact amount) · LP/pool (exact amounts). The D1 fee-fallback fixes (above) also protect the upgrade approve amounts.

**Scripts + keepers:**

- Live VPS keepers (crontab mirror 2026-08-13): only `onramp_keeper` (pool funding, amount = balance) and `system_keeper`/`topup_sf` (SF top-up, exact amount) approve — both match their pulls. The rescue keepers never approve (SF/matrix-funded) — correct.
- `bigfill_v8.js` (owner's Windows machine): register $10 → T1 PM ✓; bulk approve = whole climb (bulkUpgrade has no debt fold — correct as-is) ✓; its manualUpgrade path already folds `memberDebtOf` (:513) ✓; DirectSale exact ✓.
- ✗→✅ **A3 (FIXED): `manual_upgrade_w1.js` approved fee-only before `manualUpgrade`** — same class as A1. Now folds memberDebtOf.
- Hygiene notes (accepted, testnet drip wallets only): `organic_drip.js` and `community_drip.js` grant MaxUint256 allowances; `revoke_allowances.js` exists for cleanup. Not member-facing.

**Observations for the scope (not approval bugs):**

- **O1:** `bulkUpgrade` does NOT `_walletFold` — a debted member can bulk-upgrade past an unpaid loan while `manualUpgrade`/`hybridUpgrade` refuse. Debt still settles on withdraw/pool payouts, so no money is lost, but the "advances clean" policy is inconsistent across the three upgrade paths. Owner call whether to align it in V8.48 or note-and-ship.
- **O2:** index.html's coupon-issue approve hardcodes `T1_FEE` while `couponAmount` is an owner-settable contract value (currently equal). If `setCouponAmount` is ever used, the approve under/over-shoots. Low risk; the ABI already carries `couponAmount()` — switch the approve to read it when the coupon UI is next touched.

---

*Maintenance rule: when a deploy changes any value in the SOURCE column, update the row and its verified date in the SAME session, or the row is presumed stale. predeploy_check.js enforces the mechanical half (ABI members + genesisBps prose + distributeInterval removal + day-cap + param-39 routing); everything else on this page is the judgement half.*
