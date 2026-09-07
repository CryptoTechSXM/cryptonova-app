# CryptoNova — MAINNET READINESS (Base mainnet, chainId 8453)

Written 2026-09-07 (session 66) for a future session of Claude and the owner. Entry point for all
mainnet work. `MAINNET_TODO.md` (2026-07-23, V4 era) and `DEPLOY_RUNBOOK.md` "Mainnet Differences"
(2026-06-17) are superseded by this file; keep them as history only.

Owner's stance (2026-09-07): take the readiness feedback seriously; explore an independent audit; if
it is out of reach, "go with a small soft launch and do an independent audit in the future".
Claude's standing position: audit before real funds; if unaffordable, the mitigations in §3 are
NOT optional. Target: go/no-go review **~2026-09-21**, gated on §1.

The two rules apply here more than anywhere: nothing in this file is "ready" until it has been
RUN on the target it names. A box that has not been run is not ticked.

---

## 1. HARD GATES — none of the rest matters until these are green

- [ ] **G1 Blockaid fully clear.** Peter cleared crypto-nova.app + the V8.52 TierRouter (09-05
      07:57Z) but the registration approval spender — T1 PairManager `0xc2fCD…d42c7` — still shows
      "Malicious" in MetaMask (3 samples 09-05/06/07). A real-money launch behind a red wallet
      warning is dead on arrival. Owner's follow-up (09-05 22:49 local) unanswered; nudge from
      09-08 morning local. Proof = the 62.30 wallet test with NO red tag on every spender the site
      asks for (10 PMs, 20 matrices, router, CouponRegistry, treasury). See memory
      `cryptonova-blockaid`.
- [ ] **G2 The organic measurement (09-03) closed.** Does the loop fund itself at the referral
      rate REAL members produce, organic wallets only, on V8.52 (live since 09-04)? Needs the
      window stated (start block, end block, wallets counted) and the number, not a feel.
      Instrument: `diag_rescue_seat_outcome.js` / SF debt book (memory `cryptonova-rescue-exposure`).
- [ ] **G3 Audit decision made** — one of: (a) quote accepted for the ~4k-nSLOC custody core
      (MatrixLogicLib, FigureEightMatrixV8, PairManagerV8, TierRouter, StabilityFund,
      MatrixKeeper); (b) soft launch with §3 mitigations in force, audit deferred and DATED.
      Sizing on record: unique deployed V8.52 money-moving source ~7,000 nSLOC; whole `contracts/`
      ~10,356 incl. legacy/mocks. Published ranges (not quotes): boutique/solo ~$8k–25k for a
      2-week core review; mid-tier $15k–70k; contests from ~$37.5k; top firms $60k–150k+.
      ▶ Next artefact: `AUDIT_SCOPE.md` (file list, nSLOC per file, trust assumptions, known
      limitations from `SECURITY_REVIEW.md`) so a quote request is one email.

## 2. POSTURE DECISIONS THE OWNER OWNS (Claude gives options + a recommendation, owner picks)

- [ ] **P1 Launch caps.** MEASURED 2026-09-07: tier fees are fixed at deploy — T1 $10 … T9
      $5,000, T10 $10,000 (`deploy_v8.js:143-152`). There is NO on-chain "max open tier" or
      per-member deposit cap; the only gates are `tierGateThreshold[5..10]` (1..50 first-entries,
      `TierRouter.sol:434-441`, setters `:558-563`) and the whale gate. **So "T1-only launch" is
      not a switch that exists today.** Options: (a) launch with the current gates and a PUBLISHED
      soft policy (small tiers only, monitored); (b) add a `maxOpenTier` guard in TierRouter —
      new code = new audit surface + full suite; (c) deploy only T1–T3 pair managers and leave the
      upper `tierPairManagers` unset — needs a measured test of what `manualUpgrade` does when the
      target tier's PM is address(0). ▶ Claude to MEASURE (c) on a local fork before recommending.
- [ ] **P2 Pause plan.** `TierRouter.pauseSystem(reason)` / `unpauseSystem()` are `onlyOwner`
      (`:720/:730`) and gate register/upgrade paths (`whenNotPaused`). Decide: who can call it (the
      deployer key today), from where (PC? box?), the trigger list (SF insolvency floor, keeper
      silent > N h, Blockaid re-flag, exploit report), and the member notice template. Withdrawals
      are NOT under `whenNotPaused` — confirm by test that a paused system still lets members out.
- [ ] **P3 Key custody.** Today: one deployer key, on the PC `.env` AND on the VPS `/root/keeper`
      (keepers spend from it). `TierRouter.setGovernance` exists (`:464`, `onlyOwnerOrGovernance`
      setters). Options: (a) Safe multisig (2-of-3: owner + two co-op members) as `owner`, deployer
      key demoted to keeper-only; (b) owner-only hardware wallet as owner, hot key for keepers;
      (c) status quo (single hot key = single point of theft) — NOT recommended for real funds.
      Whatever is picked, the keeper key must not be the owner key on mainnet.
- [ ] **P4 Incident playbook** — one page: detect (Telegram alerts already live: balance,
      frozen-pair, silent-job, RPC, site/faucet probes), decide (who), act (pause tx block ready
      to paste), tell (member post template in the owner's voice), review. Lives in
      `GO_LIVE_RUNBOOK.md` as a new PHASE.
- [ ] **P5 Entity / disclosure.** No company, no licence, four-person unincorporated co-op —
      stated to Blockaid already. Decide what the public site says about this before real money
      (privacy.html exists; a plain "who we are / what we are not" line is owed).

## 3. MEASURED GAPS IN THE TOOLING (Claude fixes; each needs a run to tick)

- [ ] **T1 `deploy_v8.js` is not mainnet-safe at the W1 seed.** `:1052` calls
      `usdc.mint(W1_ADDR, T1_FEE)` unconditionally inside the W1 try/catch. Real Base USDC
      (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) has no public mint → revert → caught → W1 NOT
      registered, `setDefaultReferrer` skipped, script continues as if fine. Fix: when
      `USDC_ADDRESS` is set, require W1 to already hold ≥ T1_FEE USDC (read balance, fail LOUD
      otherwise) instead of minting. Also `:488` uses the MockUSDC ABI for a real token — fine for
      approve/balanceOf, but grep the script for any other `.mint(`/`faucet` call.
- [ ] **T2 Network guard.** Every keeper, diag and deploy script that reads `ADDRESSES_FILE` must
      refuse to run if the file's chainId ≠ the provider's chainId. Measure first: grep the
      keepers + `scripts/` for `chainId` checks; list what has none.
- [ ] **T3 Grace period default** — already fails safe: unknown network → 48h mainnet policy
      (`deploy_v8.js:947-951`). Tick after one dry run prints `172800` for `baseMainnet`.
- [ ] **T4 Verify-before-repoint as a script gate.** `verify_all_v850.js` exists; make a
      `verify_all.js` that reads the addresses file, verifies every contract, and EXITS NON-ZERO
      if any is unverified — and put it in `postdeploy_check.js` so the frontend repoint step
      cannot start on an unverified set (the rule that ended the Blockaid flags).
- [ ] **T5 `postdeploy_check.js` must read `upkeepCaller`** (R14, 62.23) — confirm it does, on a
      run against V8.52, before trusting it on mainnet.
- [ ] **T6 Faucet must not exist on mainnet.** `api/faucet.js` holds a funded key on the testnet
      app; the mainnet Vercel project must have NO faucet env/key and the site's faucet UI must be
      hidden by chain. `site_probe.js` expects `/api/faucet` → 400; on mainnet expect 404.
- [ ] **T7 Wallet RPC + chain params** (`WALLET_RPC_URLS`, chainId 8453, explorer basescan.org)
      in the frontend `ADDRS`/network block; the "Rabby on Base Sepolia" FAQ paragraph is
      testnet-only copy.
- [ ] **T8 Vercel: the `mainnet` branch trap (57.0).** `cryptonova-mainnet.vercel.app` PRODUCTION
      tracks branch `mainnet` = the 23-file June-19 marketing tree. Anything from `v8.1` merged
      into `mainnet` publishes the handoff to the world. The mainnet app needs its OWN project +
      domain plan written BEFORE any push; do not reuse that project casually.
- [ ] **T9 Keepers.** The box's crontab/`.env` point at `deployed_addresses_v8_52.json` on
      Sepolia. Mainnet keepers = a separate box or a separate user + `.env` + addresses file, with
      their own key (P3), their own Telegram source tags, and job A (stress fill) NEVER installed.
- [ ] **T10 Gas ceiling.** The measured Sepolia per-tx cap is 2^24 (memory
      `cryptonova-gas-ceiling`); Base mainnet's block gas limit differs. Measure `forceCross` /
      full-matrix registration gas on a mainnet fork before launch.

## 4. THE MAINNET DEPLOY RUNBOOK (to be written — separate file, after §3 T1/T2/T4 land)

`MAINNET_DEPLOY_RUNBOOK.md`: `.env` diff from testnet (USDC_ADDRESS, BASE_RPC_URL, no
CNOVA_ADDRESS, fresh deployer funded with real ETH — amount measured from the V8.52 deploy gas
total × mainnet gas price), the `--network baseMainnet` command, verify-all gate, W1 seed with
pre-funded USDC, `set_upkeep_caller`, postdeploy_check, frontend repoint on a NEW Vercel
project, Blockaid pre-notification (send the 46-row table BEFORE any member is pointed at it),
keeper start order, and the owner human test with a $10 real registration + withdrawal.

## 5. NEXT ACTIONS, IN ORDER

1. Blockaid nudge from 09-08 morning local (G1). Re-test after any reply.
2. Fix T1 (deploy_v8.js W1 seed) + T2 audit (network guard census) — pure tooling, no policy.
3. Write `AUDIT_SCOPE.md` (G3) so the owner can request quotes.
4. Measure P1 option (c) on a local fork; bring the owner options + a recommendation.
5. G2 measurement window: agree start block (V8.52 first organic registration) and run it.
