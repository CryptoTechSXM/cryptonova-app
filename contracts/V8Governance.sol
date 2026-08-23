// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title  V8Governance
 * @notice Minimal DAO governance for the V8.1 Elevator system.
 *
 *         DESIGN PRINCIPLES
 *         -----------------
 *         - CNOVA-weighted voting (1 CNOVA = 1 vote, no staking required)
 *         - Enumerated param-change proposals ONLY -- no arbitrary calls
 *         - 72-hour voting window + 48-hour timelock before execution
 *         - Quorum: configurable % of CNOVA circulating supply
 *         - Simple majority (>50% of votes cast) to pass
 *         - Proposals expire if not executed within 72h after timelock
 *
 *         GOVERNANCE SCOPE
 *         ----------------
 *         Governance can adjust params on:
 *           - TierRouter (autoUpgradeCycleThreshold, reentryMinCycles)
 *           - MatrixKeeper (velocityWindow, velocityThreshold,
 *                           deflationThreshold, idleSlotTimeout,
 *                           maxItemsPerUpkeep, sfRescueLadder)
 *           - FigureEightMatrixV8 (withdrawalFeeBps) -- target PairManagerV8
 *             (one per tier; broadcasts to every pair instance in that tier),
 *             checked there via onlyOwnerOrGovernance
 *           - V8Governance itself (votingPeriod, timelockPeriod, quorumBps)
 *
 *         V8.20: MatrixKeeper/TierRouter/FigureEightMatrixV8 must each have
 *         setGovernance(address(this)) called once post-deploy, or execute()
 *         reverts for every param above except the 3 self-governed ones.
 *         V8.21: the SF rescue ladder is now a curated preset index (0-3, see
 *         MatrixKeeper.setSfRescueLadderPreset) instead of a free-form array,
 *         so it goes through the normal propose()/_applyParam() path like
 *         every other scalar param. The CNOVA boost table is still genuinely
 *         array-valued and still uses its own proposeBoostTable() entry point.
 *         V8.21: PARAM_ESCROW_FLOOR_MULT (id 3) is retired -- TierRouter's
 *         escrowFloorMultiplier and its setter were deleted entirely (the param
 *         gated a guard that could never fire; see TierRouter.sol's removal
 *         note). propose() permanently rejects this id; id 3 is never reused.
 *         V8.21: PARAM_EARLY_EXIT_PENALTY_BPS (id 10) is ALSO retired, same
 *         reasoning -- FigureEightMatrixV8.earlyExitPenaltyBps was stored and
 *         DAO-votable but never actually consumed by any withdraw/cycle logic
 *         (dead state). The real, working early-exit penalty is CNOVATreasury's
 *         hardcoded time-tiered redeemAtFloor() schedule (45/30/15/5/0% by
 *         days-since-join), which is intentionally NOT governed by this param.
 *         id 10 is never reused. V8.21: PARAM_WITHDRAWAL_FEE_BPS (id 9)'s
 *         target changed from a single FigureEightMatrixV8 instance to
 *         PairManagerV8 (one per tier) -- a tier can have multiple matrix
 *         pairs (PairManagerV8.addPair() during auto-expansion), and fees are
 *         stored per-instance, so targeting a single matrix left every other
 *         pair on a stale value. PairManagerV8.setWithdrawalFeeBps() broadcasts
 *         to every pair the tier has ever added and auto-stamps future ones.
 *
 *         OUT OF SCOPE (always owner/multisig):
 *           - Deploy new contracts
 *           - Upgrade contract logic
 *           - Move treasury funds
 *           - Add/remove tier configurations
 */

interface ICNOVAToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    /// @dev V8.48 proposal fee: allowance-path burn (governance holds no BURNER_ROLE,
    ///      so the proposer must approve first — explicit consent, one approve tx).
    function burnFrom(address from, uint256 amount) external;
}

interface IGovernanceTarget {
    // TierRouter
    function setAutoUpgradeCycleThreshold(uint256 v) external;
    function setReentryMinCycles(uint256 v) external;
    // V8.21: setEscrowFloorMultiplier() removed -- TierRouter no longer has this
    // function. PARAM_ESCROW_FLOOR_MULT (id 3) is retired below.
    // MatrixKeeper
    function setVelocityWindow(uint256 v) external;
    function setVelocityThreshold(uint256 v) external;
    function setDeflationThreshold(uint256 v) external;
    function setIdleSlotTimeout(uint256 v) external;
    function setMaxItemsPerUpkeep(uint256 v) external;
    // Matrix fee params -- V8.21: target is PairManagerV8 (one per tier), which
    // broadcasts to every pair instance it has ever added. See setWithdrawalFeeBps
    // on PairManagerV8.sol for the actual implementation.
    function setWithdrawalFeeBps(uint256 v) external;
    // V8.21: setEarlyExitPenaltyBps() removed -- the param it backed
    // (PARAM_EARLY_EXIT_PENALTY_BPS, id 10) is retired below; FigureEightMatrixV8
    // no longer has this function at all.
    // MatrixKeeper -- V8.21: SF parked-rescue coverage ladder, now a curated
    // preset index (0-3) instead of a free-form array -- scalar like everything else.
    function setSfRescueLadderPreset(uint256 preset) external;

    // ── V8.20: second wave -- TierRouter ─────────────────────────────────────
    function setWhaleGateThreshold(uint256 v) external;
    function setInactivityDaysThreshold(uint256 v) external;
    function setInactivityCyclesThreshold(uint256 v) external;
    function setInactivityGuardEnabled(uint256 v) external;
    // ── V8.20: second wave -- MatrixKeeper ───────────────────────────────────
    function setParkedGracePeriod(uint256 v) external;
    function setRescueRatioBps(uint256 v) external;
    function setRescueRepayBps(uint256 v) external;  // V8.32 param #50
    // ── V8.33: MatrixKeeper extended idle timeout (param #51) ────────────────
    function setExtendedIdleTimeout(uint256 v) external;
    // ── V8.35: TierRouter per-tier whale gate thresholds (params #52-57) ─────
    function setTierGateThresholdT5(uint256 v) external;
    function setTierGateThresholdT6(uint256 v) external;
    function setTierGateThresholdT7(uint256 v) external;
    function setTierGateThresholdT8(uint256 v) external;
    function setTierGateThresholdT9(uint256 v) external;
    function setTierGateThresholdT10(uint256 v) external;
    // ── V8.20: second wave -- StabilityFund ──────────────────────────────────
    function setSFTarget(uint256 v) external;
    function setCommunityCarveOutBps(uint256 v) external;
    function setStabilityFloor(uint256 v) external;
    // ── V8.22: per-tier SF target multiplier -- reverses the V8.21 decision to
    //    keep this owner-only-array-only. One single-value setter per tier
    //    since propose() can only carry one uint256 value per proposal.
    function setSfTargetMultiplierT1(uint256 v) external;
    function setSfTargetMultiplierT2(uint256 v) external;
    function setSfTargetMultiplierT3(uint256 v) external;
    function setSfTargetMultiplierT4(uint256 v) external;
    function setSfTargetMultiplierT5(uint256 v) external;
    function setSfTargetMultiplierT6(uint256 v) external;
    function setSfTargetMultiplierT7(uint256 v) external;
    function setSfTargetMultiplierT8(uint256 v) external;
    function setSfTargetMultiplierT9(uint256 v) external;
    function setSfTargetMultiplierT10(uint256 v) external;
    // ── V8.48 item 46: SF insolvency floor ───────────────────────────────────
    function setInsolvencyFloorBps(uint256 v) external;
    // ── V8.48: SF surplus-to-community dial (item 26's setter, param 60) ─────
    function setCommunityOverflowBps(uint256 v) external;
    // ── V8.49: MatrixKeeper crossing buffer, default 0 (param 61) ────────────
    function setCrossingBufferBps(uint256 v) external;
    // ── V8.49 item 1: MatrixKeeper eviction clock, default 7 days (param 62) ─
    function setEvictionGracePeriod(uint256 v) external;
    function setMinGasPerItem(uint256 v) external;
    // ── V8.20: second wave -- CNOVABuybackReserve ────────────────────────────
    function setTriggerThreshold(uint256 v) external;
    function setMaxSlippageBps(uint256 v) external;
    // ── V8.20: second wave -- CNOVADirectSale ────────────────────────────────
    function setMaxTxBps(uint256 v) external;
    function setMaxWalletBps(uint256 v) external;
    function setSfTargetDS(uint256 v) external;
    function setLqTargetDS(uint256 v) external;
    // ── V8.20: second wave -- CNOVAToken (already GOVERNOR_ROLE-gated; this is
    //    the missing call path -- the role was granted but nothing ever used it)
    function setRewardPct(uint256 v) external;
    function setEpochMintLimit(uint256 v) external;
    function setEpochMemberLimitGov(uint256 v) external;
    function setEpochTimeLimit(uint256 v) external;
    function setVestDuration(uint256 v) external;
    function setMaxPenaltyBps(uint256 v) external;
    function setBoostTable(uint256[] calldata thresholds, uint256[] calldata rates) external;
    // ── V8.20: second wave -- CommunityWallet (also GOVERNOR_ROLE-gated; role
    //    grant to V8Governance never existed at all until this deploy)
    function setGenesisBps(uint256 v) external;
    function setDistributeRatio(uint256 v) external;
    function setDistributionDayOfMonth(uint8 v) external;   // V8.48: was setDistributeInterval(uint256)
    // ── V8.50: the item-43 sweep (owner decision 2026-08-21). Five setters carried
    //    an onlyOwnerOrGovernance gate with NO param id, so "DAO tunable" was
    //    owner-only in practice — the same defect V8.48 fixed for
    //    setCommunityOverflowBps. setUpkeepCaller is DELIBERATELY not among them:
    //    it is authorization, not economics, and a compromised keeper key must be
    //    revocable in minutes rather than through a vote plus timelock.
    function setClawbackPreset(uint256 v) external;          // StabilityFund
    function setBaseAdvanceBps(uint256 v) external;          // StabilityFund
    function setSelfFundedGracePeriod(uint256 v) external;   // MatrixKeeper
    function setFrozenMatBTimeout(uint256 v) external;       // MatrixKeeper
    function setGhostEntryEnabled(bool v) external;          // MatrixKeeper
}

contract V8Governance is Ownable {

    // ── Proposal states ───────────────────────────────────────────────────────
    uint8 public constant STATE_ACTIVE    = 0;
    uint8 public constant STATE_PASSED    = 1;
    uint8 public constant STATE_DEFEATED  = 2;
    uint8 public constant STATE_TIMELOCKED = 3;
    uint8 public constant STATE_EXECUTED  = 4;
    uint8 public constant STATE_EXPIRED   = 5;
    uint8 public constant STATE_CANCELLED = 6;

    // ── Param IDs (enumerated) ────────────────────────────────────────────────
    uint8 public constant PARAM_UPGRADE_CYCLE_THRESHOLD = 1;
    uint8 public constant PARAM_REENTRY_MIN_CYCLES      = 2;
    /// @dev RETIRED in V8.21 -- TierRouter.escrowFloorMultiplier and its setter
    ///      were deleted entirely (gated a guard that could never fire; escrow
    ///      is hardcoded to 0 everywhere). propose() permanently rejects this
    ///      id. Do not reuse id 3 for a new param -- it stays retired so no
    ///      historical proposal/event ever gets reinterpreted as something else.
    uint8 public constant PARAM_ESCROW_FLOOR_MULT       = 3;
    uint8 public constant PARAM_VELOCITY_WINDOW         = 4;
    uint8 public constant PARAM_VELOCITY_THRESHOLD      = 5;
    uint8 public constant PARAM_DEFLATION_THRESHOLD     = 6;
    uint8 public constant PARAM_IDLE_SLOT_TIMEOUT       = 7;
    uint8 public constant PARAM_MAX_ITEMS_PER_UPKEEP    = 8;
    /// @dev V8.21: target changed from a single FigureEightMatrixV8 instance to
    ///      PairManagerV8 (one per tier) -- see PairManagerV8.setWithdrawalFeeBps
    ///      and the class doc-comment above for the multi-pair broadcast fix.
    uint8 public constant PARAM_WITHDRAWAL_FEE_BPS      = 9;
    /// @dev RETIRED in V8.21 -- FigureEightMatrixV8.earlyExitPenaltyBps and its
    ///      setter were deleted entirely (stored + DAO-votable but never
    ///      actually applied in any withdraw/cycle path; see V8Governance's
    ///      class doc-comment above). propose() permanently rejects this id.
    ///      Do not reuse id 10 for a new param.
    uint8 public constant PARAM_EARLY_EXIT_PENALTY_BPS  = 10;
    uint8 public constant PARAM_VOTING_PERIOD           = 11;
    uint8 public constant PARAM_TIMELOCK_PERIOD         = 12;
    uint8 public constant PARAM_QUORUM_BPS              = 13;
    /// @dev V8.21: curated preset index (0-3) -- scalar, goes through the normal
    ///      propose()/_applyParam() path with allowed values [0,1,2,3].
    uint8 public constant PARAM_SF_RESCUE_LADDER        = 14;

    // ── V8.20 second wave: TierRouter ─────────────────────────────────────────
    uint8 public constant PARAM_WHALE_GATE_THRESHOLD       = 15;
    uint8 public constant PARAM_INACTIVITY_DAYS_THRESHOLD  = 16;
    uint8 public constant PARAM_INACTIVITY_CYCLES_THRESHOLD = 17;
    uint8 public constant PARAM_INACTIVITY_GUARD_ENABLED   = 18;
    // ── V8.20 second wave: MatrixKeeper ───────────────────────────────────────
    uint8 public constant PARAM_PARKED_GRACE_PERIOD        = 19;
    uint8 public constant PARAM_RESCUE_RATIO_BPS           = 20;
    // ── V8.20 second wave: StabilityFund ──────────────────────────────────────
    uint8 public constant PARAM_SF_TARGET                  = 21;
    uint8 public constant PARAM_SF_COMMUNITY_CARVEOUT_BPS  = 22;
    uint8 public constant PARAM_SF_STABILITY_FLOOR         = 23;
    // ── V8.20 second wave: CNOVABuybackReserve ────────────────────────────────
    uint8 public constant PARAM_BBR_TRIGGER_THRESHOLD      = 24;
    uint8 public constant PARAM_BBR_MAX_SLIPPAGE_BPS       = 25;
    // ── V8.20 second wave: CNOVADirectSale ─────────────────────────────────────
    uint8 public constant PARAM_DS_MAX_TX_BPS              = 26;
    uint8 public constant PARAM_DS_MAX_WALLET_BPS          = 27;
    uint8 public constant PARAM_DS_SF_TARGET               = 28;
    uint8 public constant PARAM_DS_LQ_TARGET               = 29;
    // ── V8.20 second wave: CNOVAToken (GOVERNOR_ROLE) ─────────────────────────
    uint8 public constant PARAM_CNOVA_REWARD_PCT           = 30;
    uint8 public constant PARAM_CNOVA_EPOCH_MINT_LIMIT     = 31;
    uint8 public constant PARAM_CNOVA_EPOCH_MEMBER_LIMIT   = 32;
    uint8 public constant PARAM_CNOVA_EPOCH_TIME_LIMIT     = 33;
    uint8 public constant PARAM_CNOVA_VEST_DURATION        = 34;
    uint8 public constant PARAM_CNOVA_MAX_PENALTY_BPS      = 35;
    /// @dev array-valued, via proposeBoostTable()/execute(), same pattern as the SF ladder.
    uint8 public constant PARAM_CNOVA_BOOST_TABLE          = 36;
    // ── V8.20 second wave: CommunityWallet (GOVERNOR_ROLE) ────────────────────
    uint8 public constant PARAM_CW_GENESIS_BPS             = 37;
    uint8 public constant PARAM_CW_DISTRIBUTE_RATIO_BPS    = 38;
    uint8 public constant PARAM_CW_DISTRIBUTION_DAY        = 39;   // V8.48: was PARAM_CW_DISTRIBUTE_INTERVAL
    // ── V8.22: StabilityFund per-tier SF target multiplier ────────────────────
    /// @dev Reverses the V8.21 decision (sfTargetMultiplier was owner-only-array
    ///      only). Each tier gets its own id so the DAO can move one tier's
    ///      multiplier without touching the other nine. Target is always
    ///      StabilityFund's address, same as PARAM_SF_TARGET/PARAM_SF_*.
    uint8 public constant PARAM_SF_MULT_T1                 = 40;
    uint8 public constant PARAM_SF_MULT_T2                 = 41;
    uint8 public constant PARAM_SF_MULT_T3                 = 42;
    uint8 public constant PARAM_SF_MULT_T4                 = 43;
    uint8 public constant PARAM_SF_MULT_T5                 = 44;
    uint8 public constant PARAM_SF_MULT_T6                 = 45;
    uint8 public constant PARAM_SF_MULT_T7                 = 46;
    uint8 public constant PARAM_SF_MULT_T8                 = 47;
    uint8 public constant PARAM_SF_MULT_T9                 = 48;
    uint8 public constant PARAM_SF_MULT_T10                = 49;
    /// @notice V8.32: DAO-votable rescue loan repayment fraction (StabilityFund.rescueRepayBps).
    uint8 public constant PARAM_SF_RESCUE_REPAY_BPS         = 50;

    /// @notice V8.33: MatrixKeeper extended idle timeout (7-day default).
    uint8 public constant PARAM_EXTENDED_IDLE_TIMEOUT       = 51;

    /// @notice V8.35: Per-tier whale gate thresholds (T5-T10 pioneer milestones).
    ///         T5 gate also unlocks T2-T4; T6-T10 are independent.
    uint8 public constant PARAM_WHALE_GATE_T5               = 52;
    uint8 public constant PARAM_WHALE_GATE_T6               = 53;
    uint8 public constant PARAM_WHALE_GATE_T7               = 54;
    uint8 public constant PARAM_WHALE_GATE_T8               = 55;
    uint8 public constant PARAM_WHALE_GATE_T9               = 56;
    uint8 public constant PARAM_WHALE_GATE_T10              = 57;

    /// @notice V8.48 (owner decision 2026-08-13): the proposal fee, made REAL and
    ///         DAO-votable. History matters here: V8.34 shipped the FRONTEND and the
    ///         test fixture for a "100 CNOVA burned on propose" fee, but the contract
    ///         half was never built — proposalFee() did not exist, the UI's read always
    ///         reverted, and a .catch dressed the revert up as 100e18 until the
    ///         2026-08-07 audit removed the fiction. This id completes what V8.34
    ///         started. Menu includes 0 (the escape hatch — a value absent from the
    ///         menu can never be voted back, the item-42 lesson).
    uint8 public constant PARAM_PROPOSAL_FEE               = 58;

    /// @notice V8.48 item 46 (owner policy 2026-08-13): the SF insolvency floor —
    ///         expected per-cycle earnings as BPS of the loan tier's fee; a member
    ///         whose debt reaches it gets no new SF loans and the item-47 valve
    ///         evicts them. V8.50 DEFAULT 5000 (owner decision 2026-08-19, on the
    ///         AB_FLOOR_BPS curve — full basis at the declaration in StabilityFund.sol;
    ///         it was 3400, the measured ~34% median, from V8.48 through V8.49).
    ///         0 on the menu = floor disabled, the escape hatch.
    uint8 public constant PARAM_SF_INSOLVENCY_FLOOR        = 59;

    /// @notice V8.48 (owner decision 2026-08-13): the SF surplus-to-community dial,
    ///         finally DAO-votable. setCommunityOverflowBps existed with an
    ///         onlyOwnerOrGovernance gate but NO param id — governance had no path
    ///         to it, so "DAO tunable" was owner-only in practice (the item-43
    ///         "fee that never existed" class, caught in the 2026-08-13 sweep of a
    ///         recovered 2026-08-07 decision). Default 10_000 = 100% of at-target
    ///         L1 inflow to the CommunityWallet; the DAO can dial it down.
    uint8 public constant PARAM_SF_COMMUNITY_OVERFLOW      = 60;

    /// @notice V8.49 (owner decision 2026-08-15): the MatrixKeeper CROSSING BUFFER.
    ///         Was a hardcoded 3_600 bps advanced on top of every keeper rescue and
    ///         booked as member debt. Measured on the live V8.48 chain it accounted for
    ///         80% of everything the Stability Fund was asked for, and being LARGER than
    ///         insolvencyFloorBps (3_400) it made that floor impossible to enforce —
    ///         every advance cleared it on the way past. DEFAULT 0 = buffer off.
    ///         Kept DAO-tunable rather than deleted so it can be restored without a
    ///         redeploy if rescued members start re-parking too fast (the accepted risk
    ///         of 0). Full reasoning and numbers in V8_49_SCOPE.md item 1b.
    uint8 public constant PARAM_MK_CROSSING_BUFFER         = 61;

    /// @notice V8.49 item 1: the MatrixKeeper EVICTION CLOCK, split out from the rescue
    ///         clock. Owner policy has always been "eviction should not happen for 3 to
    ///         5 days", but the evict branch gated on parkedGracePeriod — the same 24h
    ///         window that governs SF rescue — so the policy was never built. It went
    ///         unnoticed because evictions had literally never fired: the VPS cron guard
    ///         matched its own parent shell. V8.48 put eviction on chain and authorized
    ///         the keeper, making it live for the first time. Default 7 days (604_800) —
    ///         identical to what extendedIdleTimeout already enforced on the execution
    ///         side, so making this the single clock moved nobody's eviction.
    ///         Ghost dequeues deliberately stay on parkedGracePeriod — they cost their
    ///         holder nothing. Full reasoning in V8_49_SCOPE.md item 1.
    uint8 public constant PARAM_MK_EVICTION_GRACE          = 62;

    /// @notice V8.50 defect 8: the MatrixKeeper GAS FLOOR. performUpkeep stops starting
    ///         new work once fewer than this many gas units remain.
    ///
    ///         Governable because it is the one keeper setting that has to track
    ///         something OUTSIDE the contract — the gas a real rescue costs at live
    ///         matrix size, which moves whenever the payout walk or the SF path changes.
    ///         A floor that has drifted below the worst single item silently stops
    ///         protecting anything, and the symptom is the WorkItemFailed cascade it
    ///         exists to prevent. Menu 2.5M / 3.5M / 5M / 7.5M; default 5_000_000.
    ///
    ///         ⛔ THE DEFAULT MOVED 3_500_000 -> 5_000_000 ON 2026-08-18. A cold SF-funded
    ///         rescue at the LIVE MATRIX_SIZE 127 measures 4.37M
    ///         (test/V8_50_KeeperGas.test.js, GAS_MATRIX_SIZE=127), so 3.5M sat BELOW one
    ///         item and the invariant above was violated. The ~2.6M this comment used to
    ///         cite was never an item cost — it was a BATCH PER-ITEM AVERAGE (12.9M over
    ///         5 items, testchain_keeper.js:285), so the "35% margin" never existed.
    ///         ⛔ AND IT MOVED AGAIN, 5_000_000 -> 7_500_000 ON 2026-08-22, on the first
    ///         PER-ITEM MEASUREMENT TAKEN ON A REAL CHAIN rather than in the harness:
    ///         61 single-item SF-funded rescues at MATRIX_SIZE 127 returned a MAX of
    ///         4.58M, leaving 5M with 8.5% headroom — and that run was 3 tiers deep,
    ///         so it is a lower bound on the community chain's worst case, not the
    ///         worst case.
    ///
    ///         Voting this back down to 5M, 3.5M or 2.5M re-arms exactly the silent
    ///         cascade described above. See MatrixKeeper.minGasPerItem for the full
    ///         measurement and for the throughput cost, which is between zero and one
    ///         rescue per tick depending on a question G.4 has not yet answered.
    uint8 public constant PARAM_MK_MIN_GAS_PER_ITEM        = 63;

    /// @notice V8.50 (owner decision 2026-08-21): the item-43 sweep. Every setter
    ///         gated onlyOwnerOrGovernance should have a governance path unless the
    ///         mechanism forbids it. Five did not. Two more — setTierGateThreshold
    ///         and setTierWhaleGateActive — take TWO arguments and a proposal carries
    ///         one value, so they stay unreachable by construction; the per-tier whale
    ///         gates already have ids 52-57, which is the coverage that matters.
    ///         setUpkeepCaller stays owner-only ON PURPOSE (authorization, not
    ///         economics: a compromised keeper key needs revoking in minutes).

    /// @notice StabilityFund clawback bands, as a preset id. 0=off, 1=gentle,
    ///         2=current default (90/80/70/60), 3=hard. Full basis and the warning
    ///         that its effect is UNMEASURED are at the declaration in
    ///         StabilityFund.setClawbackPreset.
    uint8 public constant PARAM_SF_CLAWBACK_PRESET         = 64;

    /// @notice StabilityFund sponsorship gate: the ceiling for members who have
    ///         sponsored nobody. Menu IS the measured curve (handoff 18.4): 1500
    ///         refuses every zero-sponsor borrower, 4000 grants all but one, and
    ///         10000 is inert (>= insolvencyFloorBps, the ship-disabled default).
    ///         Policy value 3000 — see StabilityFund.baseAdvanceBps.
    uint8 public constant PARAM_SF_BASE_ADVANCE            = 65;

    /// @notice MatrixKeeper self-funded grace — the third of three park clocks and
    ///         the only one that had no governance path (parked is 19, eviction 62).
    ///         MUST mirror setSelfFundedGracePeriod's require exactly.
    uint8 public constant PARAM_MK_SELF_FUNDED_GRACE       = 66;

    /// @notice MatrixKeeper frozen-MatB timeout. The setter takes a RANGE
    ///         (0, or 5 minutes..30 days) rather than an enumeration, so this menu is
    ///         a curated subset of it — house convention is menus, not free ranges.
    uint8 public constant PARAM_MK_FROZEN_MATB             = 67;

    /// @notice MatrixKeeper ghost-entry switch. Boolean, carried as 0/1 exactly the
    ///         way PARAM_INACTIVITY_GUARD_ENABLED (18) already does it.
    uint8 public constant PARAM_MK_GHOST_ENTRY             = 68;

    /// @dev Highest assigned param id -- update whenever a new param is added.
    uint8 public constant PARAM_MAX_ID                     = PARAM_MK_GHOST_ENTRY;

    // ── Governance config (self-governable) ───────────────────────────────────
    uint256 public votingPeriod   = 72 hours;
    uint256 public timelockPeriod = 48 hours;
    uint256 public execExpiry     = 72 hours;
    /// @notice Quorum as BPS of CNOVA total supply (default 200 = 2%)
    uint256 public quorumBps      = 200;
    /// @notice V8.48: CNOVA burned from the proposer on EVERY proposal (propose() and
    ///         proposeBoostTable() both). Anti-spam; voting stays free. Default 100e18 —
    ///         the number V8.34's UI always claimed. DAO-votable via PARAM_PROPOSAL_FEE;
    ///         0 is on the menu so proposing can be voted free again.
    uint256 public proposalFee    = 100e18;

    // ── Core contracts ────────────────────────────────────────────────────────
    address public cnovaToken;
    address public tierRouter;
    address public matrixKeeper;

    // ── Proposal storage ──────────────────────────────────────────────────────
    struct Proposal {
        uint256 id;
        address proposer;
        uint256 startTime;
        uint256 endTime;
        uint256 timelockEnd;
        uint8   state;
        // Param to change
        uint8   paramId;
        address target;     // contract to call (tierRouter, matrixKeeper, etc.)
        uint256 newValue;
        string  description;
        // Vote tally
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 quorumRequired;
    }

    mapping(uint256 => Proposal)               public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => uint256)) public voteWeight;

    uint256 public proposalCount;

    // ── Allowed values registry (paramId => sorted list of allowed values) ────
    // Enforced both at proposal-creation time and at execution time
    mapping(uint8 => uint256[]) private _allowedValues;

    // ── V8.20: array-valued proposal storage (PARAM_CNOVA_BOOST_TABLE only) ──
    // V8.21: the SF rescue ladder's equivalent storage (proposalLadderThresholds/
    // proposalLadderBps) was removed -- that param is scalar now, see PARAM_SF_RESCUE_LADDER.
    mapping(uint256 => uint256[]) public proposalBoostThresholds;
    mapping(uint256 => uint256[]) public proposalBoostRates;

    // ── Events ────────────────────────────────────────────────────────────────
    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        uint8   paramId,
        address target,
        uint256 newValue,
        string  description
    );
    event VoteCast(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event ProposalPassed(uint256 indexed id, uint256 votesFor, uint256 votesAgainst);
    event ProposalDefeated(uint256 indexed id, uint256 votesFor, uint256 votesAgainst);
    event ProposalExecuted(uint256 indexed id, uint8 paramId, uint256 newValue);
    event ProposalCancelled(uint256 indexed id);
    event AllowedValuesSet(uint8 indexed paramId, uint256[] values);
    event BoostTableProposed(uint256 indexed id, uint256[] thresholds, uint256[] rates);
    /// @notice V8.48: emitted on every fee-bearing proposal. Absent when proposalFee == 0.
    event ProposalFeeBurned(uint256 indexed id, address indexed proposer, uint256 amount);

    // ── Custom errors ─────────────────────────────────────────────────────────
    error GOV_NotActive();
    error GOV_AlreadyVoted();
    error GOV_NoVotingPower();
    error GOV_NotPassed();
    error GOV_Timelocked();
    error GOV_Expired();
    error GOV_ValueNotAllowed();
    error GOV_ZeroAddress();
    error GOV_InvalidParam();
    error GOV_NotProposer();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _cnovaToken,
        address _tierRouter,
        address _matrixKeeper
    ) Ownable(msg.sender) {
        if (_cnovaToken  == address(0)) revert GOV_ZeroAddress();
        if (_tierRouter  == address(0)) revert GOV_ZeroAddress();
        cnovaToken   = _cnovaToken;
        tierRouter   = _tierRouter;
        matrixKeeper = _matrixKeeper;

        _initAllowedValues();
    }

    // ── Allowed-value registry ────────────────────────────────────────────────

    function _initAllowedValues() internal {
        // TierRouter params
        _allowedValues[PARAM_UPGRADE_CYCLE_THRESHOLD] = [1, 3, 5, 10];
        _allowedValues[PARAM_REENTRY_MIN_CYCLES]      = [1, 2, 3, 5];
        // V8.21: PARAM_ESCROW_FLOOR_MULT intentionally has no allowed-values
        // entry -- it's retired and permanently blocked at propose() time below.
        // MatrixKeeper params
        _allowedValues[PARAM_VELOCITY_WINDOW]         = [1800, 3600, 7200, 14400];
        _allowedValues[PARAM_VELOCITY_THRESHOLD]      = [1, 2, 3, 5];
        _allowedValues[PARAM_DEFLATION_THRESHOLD]     = [5, 10, 15, 20];
        _allowedValues[PARAM_IDLE_SLOT_TIMEOUT]       = [21600, 43200, 86400];
        // ⚠ 2026-08-22: 1 and 2 added (30.10). ALSO CLOSES A PRE-EXISTING MISMATCH found
        // while doing it — this list was [5,10,15,20] while MatrixKeeper's own require()
        // accepts 30 and 40, so a governance proposal for 30 or 40 was rejected HERE while
        // the setter would have accepted it. Two menus for one dial, silently unequal.
        _allowedValues[PARAM_MAX_ITEMS_PER_UPKEEP]    = [1, 2, 5, 10, 15, 20, 30, 40];
        // Matrix fee params
        _allowedValues[PARAM_WITHDRAWAL_FEE_BPS]      = [50, 100, 150, 200, 250];
        // V8.21: PARAM_EARLY_EXIT_PENALTY_BPS intentionally has no allowed-values
        // entry -- it's retired and permanently blocked at propose() time below.
        // Governance self-params
        _allowedValues[PARAM_VOTING_PERIOD]           = [48 hours, 72 hours, 96 hours, 168 hours];
        _allowedValues[PARAM_TIMELOCK_PERIOD]         = [24 hours, 48 hours, 72 hours];
        _allowedValues[PARAM_QUORUM_BPS]              = [100, 200, 300, 500];
        // V8.48: owner's menu 2026-08-13, plus 0 as the vote-it-free escape hatch.
        _allowedValues[PARAM_PROPOSAL_FEE]            = [0, 2.5e18, 5e18, 10e18, 25e18,
                                                         50e18, 100e18, 250e18, 500e18, 1000e18];
        // V8.21: 0=Conservative, 1=Default, 2=Generous, 3=Maximum -- see
        // MatrixKeeper.setSfRescueLadderPreset() for the exact numbers.
        _allowedValues[PARAM_SF_RESCUE_LADDER]        = [0, 1, 2, 3];

        // ── V8.20 second wave: TierRouter ─────────────────────────────────────
        _allowedValues[PARAM_WHALE_GATE_THRESHOLD]        = [10, 15, 20, 25, 30, 50];
        _allowedValues[PARAM_INACTIVITY_DAYS_THRESHOLD]   = [0, 7, 14, 30, 60, 90];
        _allowedValues[PARAM_INACTIVITY_CYCLES_THRESHOLD] = [0, 1, 2, 3, 5, 10];
        _allowedValues[PARAM_INACTIVITY_GUARD_ENABLED]    = [0, 1];
        // ── V8.20 second wave: MatrixKeeper ───────────────────────────────────
        _allowedValues[PARAM_PARKED_GRACE_PERIOD]         = [0, 3600, 21600, 432000, 864000, 1296000];
        _allowedValues[PARAM_RESCUE_RATIO_BPS]            = [5000, 6000, 7000, 8000, 9000, 9500];
        // ── V8.20 second wave: StabilityFund ──────────────────────────────────
        _allowedValues[PARAM_SF_TARGET]                   = [100_000_000, 500_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000, 10_000_000_000];
        _allowedValues[PARAM_SF_COMMUNITY_CARVEOUT_BPS]   = [0, 100, 200, 300, 400, 500];
        _allowedValues[PARAM_SF_STABILITY_FLOOR]          = [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000, 250_000_000];
        // ── V8.20 second wave: CNOVABuybackReserve ─────────────────────────────
        _allowedValues[PARAM_BBR_TRIGGER_THRESHOLD]       = [100_000_000, 250_000_000, 500_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000];
        _allowedValues[PARAM_BBR_MAX_SLIPPAGE_BPS]        = [100, 200, 300, 500, 1000, 1500, 2000];
        // ── V8.20 second wave: CNOVADirectSale ─────────────────────────────────
        _allowedValues[PARAM_DS_MAX_TX_BPS]               = [0, 50, 100, 200, 300, 500];
        _allowedValues[PARAM_DS_MAX_WALLET_BPS]           = [0, 250, 500, 1000, 1500, 2000];
        _allowedValues[PARAM_DS_SF_TARGET]                = [0, 100_000_000, 250_000_000, 500_000_000, 1_000_000_000, 2_500_000_000];
        _allowedValues[PARAM_DS_LQ_TARGET]                = [0, 250_000_000, 500_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000];
        // ── V8.20 second wave: CNOVAToken (GOVERNOR_ROLE) ──────────────────────
        _allowedValues[PARAM_CNOVA_REWARD_PCT]            = [10, 20, 30, 40, 50, 60, 75];
        _allowedValues[PARAM_CNOVA_EPOCH_MINT_LIMIT]      = [100_000e18, 500_000e18, 1_000_000e18, 2_500_000e18, 5_000_000e18];
        _allowedValues[PARAM_CNOVA_EPOCH_MEMBER_LIMIT]    = [100, 500, 1000, 5000, 10000, 50000, 100000];
        _allowedValues[PARAM_CNOVA_EPOCH_TIME_LIMIT]      = [7 days, 14 days, 30 days, 90 days, 180 days, 365 days];
        _allowedValues[PARAM_CNOVA_VEST_DURATION]         = [30 days, 90 days, 180 days, 365 days, 730 days];
        _allowedValues[PARAM_CNOVA_MAX_PENALTY_BPS]       = [0, 1000, 2000, 3000, 4000, 5000];
        // ── V8.20 second wave: CommunityWallet (GOVERNOR_ROLE) ─────────────────
        _allowedValues[PARAM_CW_GENESIS_BPS]              = [5000, 6000, 7000, 8000, 9000];
        _allowedValues[PARAM_CW_DISTRIBUTE_RATIO_BPS]     = [1000, 2500, 5000, 7500, 9000];
        _allowedValues[PARAM_CW_DISTRIBUTION_DAY]         = [1, 10, 15, 20, 25];   // day of month, <=28
        // ── V8.22: StabilityFund per-tier SF target multiplier ────────────────
        // Same menu for all 10 -- the DAO picks whatever's appropriate for
        // each tier independently; no enforced ordering between tiers.
        _allowedValues[PARAM_SF_MULT_T1]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T2]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T3]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T4]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T5]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T6]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T7]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T8]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T9]  = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        _allowedValues[PARAM_SF_MULT_T10] = [5, 10, 15, 20, 30, 40, 50, 75, 100, 150];
        // V8.32 param #50: rescue loan repayment BPS — 10%→100% in 10% steps
        _allowedValues[PARAM_SF_RESCUE_REPAY_BPS] = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
        // V8.48 item 46: insolvency floor — 0 = disabled (escape hatch). V8.50 default
        // 5000 (owner decision 2026-08-19); it was 3400 through V8.49. BOTH values were
        // already on this menu before the default moved, so the change needed no menu
        // edit — which is the item-42 lesson working as intended: put the plausible
        // values on the menu when the param is created, not when someone wants one.
        _allowedValues[PARAM_SF_INSOLVENCY_FLOOR] = [0, 1700, 2500, 3400, 5000, 6800, 10000];
        // V8.48: surplus-to-community dial — MUST mirror StabilityFund's setter
        // enumeration exactly; default 10000 and 0 both on the menu.
        _allowedValues[PARAM_SF_COMMUNITY_OVERFLOW] = [0, 100, 250, 500, 1000, 2500, 5000, 7500, 10000];
        // V8.49: crossing buffer — 0 (the new default, buffer OFF) through 3600 (the
        // retired V8.31 value). Both endpoints on the menu so either can be voted back;
        // must mirror MatrixKeeper.setCrossingBufferBps's require exactly.
        _allowedValues[PARAM_MK_CROSSING_BUFFER] = [0, 900, 1800, 2700, 3600];
        // V8.49 item 1: eviction clock — 0 (admin/testing override, evict immediately)
        // and 86400 (the PRE-V8.49 24h behaviour) are both on the menu on purpose: the
        // second is how the DAO reverses this change without a redeploy, and it is the
        // value the frozen-keeper equivalence harness pins to. Default 604800 = 7 days.
        // Must mirror MatrixKeeper.setEvictionGracePeriod's require exactly.
        _allowedValues[PARAM_MK_EVICTION_GRACE] = [0, 86400, 172800, 259200, 345600, 432000, 604800];
        // 2026-08-22: 12.5M / 15M added — see MatrixKeeper.setMinGasPerItem. MUST stay in
        // step with that require(), or a proposal passes here and reverts on execution.
        _allowedValues[PARAM_MK_MIN_GAS_PER_ITEM] = [2_500_000, 3_500_000, 5_000_000, 7_500_000, 12_500_000, 15_000_000];
        // ── V8.50 item-43 sweep. EVERY menu below must be accepted by its target
        //    setter — V8_50_DaoParams.test.js proves that by CALLING the setter with
        //    each value rather than eyeballing the two lists.
        // Clawback preset: 0 off / 1 gentle / 2 current default / 3 hard.
        _allowedValues[PARAM_SF_CLAWBACK_PRESET]  = [0, 1, 2, 3];
        // Base advance: the measured curve from handoff 18.4, plus 10000 = inert,
        // which is BOTH the shipped default and the DAO's one-vote way to switch the
        // gate back off without a redeploy.
        _allowedValues[PARAM_SF_BASE_ADVANCE]     = [1500, 2000, 2500, 3000, 3500, 4000, 5000, 10000];
        // Self-funded grace: mirrors setSelfFundedGracePeriod's require EXACTLY.
        _allowedValues[PARAM_MK_SELF_FUNDED_GRACE] = [0, 60, 300, 900, 1800, 3600];
        // Frozen-MatB timeout: curated subset of the setter's 0 | 5min..30d range.
        // Both endpoints of the range are on the menu on purpose.
        _allowedValues[PARAM_MK_FROZEN_MATB]      = [0, 300, 3600, 21600, 86400, 604800, 2592000];
        // Ghost entry: boolean as 0/1.
        _allowedValues[PARAM_MK_GHOST_ENTRY]      = [0, 1];
        // V8.33: extended idle timeout -- 0.5d/1d/2d/3d/4d/5d/6d/7d/14d
        _allowedValues[PARAM_EXTENDED_IDLE_TIMEOUT] = [43200, 86400, 172800, 259200, 345600, 432000, 518400, 604800, 1209600];
        // V8.35: per-tier whale gate thresholds (1–50 pioneers)
        uint256[9] memory gateVals = [uint256(1), 5, 10, 15, 20, 25, 30, 40, 50];
        _allowedValues[PARAM_WHALE_GATE_T5]  = gateVals;
        _allowedValues[PARAM_WHALE_GATE_T6]  = gateVals;
        _allowedValues[PARAM_WHALE_GATE_T7]  = gateVals;
        _allowedValues[PARAM_WHALE_GATE_T8]  = gateVals;
        _allowedValues[PARAM_WHALE_GATE_T9]  = gateVals;
        _allowedValues[PARAM_WHALE_GATE_T10] = gateVals;
    }

    /// @notice Owner can add or replace the allowed-values list for any param.
    function setAllowedValues(uint8 paramId, uint256[] calldata values) external onlyOwner {
        if (paramId == 0 || paramId > PARAM_MAX_ID) revert GOV_InvalidParam();
        _allowedValues[paramId] = values;
        emit AllowedValuesSet(paramId, values);
    }

    function getAllowedValues(uint8 paramId) external view returns (uint256[] memory) {
        return _allowedValues[paramId];
    }

    // ── Proposal lifecycle ────────────────────────────────────────────────────

    /**
     * @notice Create a governance proposal.
     * @param paramId     One of the PARAM_* constants above
     * @param target      Contract to call on execution (tierRouter, matrixKeeper, etc.)
     * @param newValue    Proposed new value -- must be in the allowed-values list
     * @param description Human-readable rationale (stored for events only)
     */
    function propose(
        uint8   paramId,
        address target,
        uint256 newValue,
        string  calldata description
    ) external returns (uint256 proposalId) {
        if (paramId == 0 || paramId > PARAM_MAX_ID) revert GOV_InvalidParam();
        // V8.21: PARAM_SF_RESCUE_LADDER is no longer array-valued -- it goes
        // through this normal propose() path now. Only the boost table is still
        // genuinely array-valued and still blocked here (uses proposeBoostTable()).
        if (paramId == PARAM_CNOVA_BOOST_TABLE) revert GOV_InvalidParam();
        // V8.21: PARAM_ESCROW_FLOOR_MULT is retired -- TierRouter no longer has
        // a setter for it. Block it permanently rather than letting it fall
        // through to _isAllowed() (which would just always be false anyway,
        // since _initAllowedValues() no longer populates an entry for it).
        if (paramId == PARAM_ESCROW_FLOOR_MULT) revert GOV_InvalidParam();
        // V8.21: PARAM_EARLY_EXIT_PENALTY_BPS is retired -- FigureEightMatrixV8
        // no longer has a setter for it. Block it permanently, same reasoning
        // as PARAM_ESCROW_FLOOR_MULT above.
        if (paramId == PARAM_EARLY_EXIT_PENALTY_BPS) revert GOV_InvalidParam();
        bool isSelfParam = (paramId == PARAM_VOTING_PERIOD ||
                            paramId == PARAM_TIMELOCK_PERIOD ||
                            paramId == PARAM_QUORUM_BPS ||
                            paramId == PARAM_PROPOSAL_FEE);
        if (target == address(0) && !isSelfParam) revert GOV_ZeroAddress();
        if (!_isAllowed(paramId, newValue)) revert GOV_ValueNotAllowed();

        // Proposer must hold at least 0.01% of supply
        uint256 supply    = ICNOVAToken(cnovaToken).totalSupply();
        uint256 minTokens = supply / 10_000;
        if (ICNOVAToken(cnovaToken).balanceOf(msg.sender) < minTokens) revert GOV_NoVotingPower();

        proposalId = ++proposalCount;
        // V8.48: fee AFTER every validation (a wallet failing the checks above learns
        // that without needing an allowance) and BEFORE the storage write. `supply`
        // was read pre-burn, so quorum is overstated by fee*quorumBps/10k — dust,
        // and in the conservative direction.
        _chargeProposalFee(proposalId);
        uint256 quorum = supply * quorumBps / 10_000;

        proposals[proposalId] = Proposal({
            id:             proposalId,
            proposer:       msg.sender,
            startTime:      block.timestamp,
            endTime:        block.timestamp + votingPeriod,
            timelockEnd:    0,
            state:          STATE_ACTIVE,
            paramId:        paramId,
            target:         target,
            newValue:       newValue,
            description:    description,
            votesFor:       0,
            votesAgainst:   0,
            quorumRequired: quorum
        });

        emit ProposalCreated(proposalId, msg.sender, paramId, target, newValue, description);
    }

    /**
     * @notice V8.20: Create a governance proposal for CNOVAToken's boost table
     *         (the array-valued param). Separate entry point from propose()
     *         because the boost table can't be expressed as a single uint256.
     *         (V8.21: the SF rescue ladder used to have an equivalent
     *         proposeLadder() entry point here -- removed, it's a scalar
     *         preset-index param now, see PARAM_SF_RESCUE_LADDER.)
     * @param target      CNOVAToken address (must hold GOVERNOR_ROLE for this contract)
     * @param thresholds  Strictly ascending breakpoints (mirrors CNOVAToken's own check)
     * @param rates       Boost rates in BPS, each <= 10_000 (mirrors CNOVAToken's own check)
     * @param description Human-readable rationale (stored for events only)
     */
    function proposeBoostTable(
        address target,
        uint256[] calldata thresholds,
        uint256[] calldata rates,
        string  calldata description
    ) external returns (uint256 proposalId) {
        if (target == address(0)) revert GOV_ZeroAddress();
        if (!_isValidBoostTable(thresholds, rates)) revert GOV_ValueNotAllowed();

        uint256 supply = ICNOVAToken(cnovaToken).totalSupply();
        if (ICNOVAToken(cnovaToken).balanceOf(msg.sender) < supply / 10_000) revert GOV_NoVotingPower();

        proposalId = ++proposalCount;
        _chargeProposalFee(proposalId);   // V8.48: boost-table proposals pay the same fee

        proposalBoostThresholds[proposalId] = thresholds;
        proposalBoostRates[proposalId]       = rates;

        Proposal storage p = proposals[proposalId];
        p.id             = proposalId;
        p.proposer       = msg.sender;
        p.startTime      = block.timestamp;
        p.endTime        = block.timestamp + votingPeriod;
        p.state          = STATE_ACTIVE;
        p.paramId        = PARAM_CNOVA_BOOST_TABLE;
        p.target         = target;
        p.description    = description;
        p.quorumRequired = supply * quorumBps / 10_000;

        emit ProposalCreated(proposalId, msg.sender, PARAM_CNOVA_BOOST_TABLE, target, 0, description);
        emit BoostTableProposed(proposalId, thresholds, rates);
    }

    /// @dev V8.48: burn the proposal fee from the proposer. Allowance path only —
    ///      this contract holds no BURNER_ROLE, so the proposer consents via approve.
    ///      Vest-locked CNOVA burns fine and the vest ledger follows (items 8+9).
    ///      A revert here reverts the whole proposal — nobody pays without proposing.
    function _chargeProposalFee(uint256 proposalId) internal {
        uint256 fee = proposalFee;
        if (fee == 0) return;
        ICNOVAToken(cnovaToken).burnFrom(msg.sender, fee);
        emit ProposalFeeBurned(proposalId, msg.sender, fee);
    }

    /**
     * @notice Cast a vote on an active proposal.
     * @param support  true = for, false = against
     */
    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != STATE_ACTIVE)       revert GOV_NotActive();
        if (block.timestamp > p.endTime)   revert GOV_NotActive();
        if (hasVoted[proposalId][msg.sender]) revert GOV_AlreadyVoted();

        uint256 weight = ICNOVAToken(cnovaToken).balanceOf(msg.sender);
        if (weight == 0) revert GOV_NoVotingPower();

        hasVoted[proposalId][msg.sender]    = true;
        voteWeight[proposalId][msg.sender]  = weight;

        if (support) {
            p.votesFor += weight;
        } else {
            p.votesAgainst += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @notice Close voting on a proposal after the voting period ends.
     *         Anyone may call this.
     */
    function finalizeVote(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != STATE_ACTIVE)      revert GOV_NotActive();
        if (block.timestamp <= p.endTime) revert GOV_NotActive();

        uint256 totalVotes = p.votesFor + p.votesAgainst;
        bool quorumMet  = totalVotes >= p.quorumRequired;
        bool majorityFor = p.votesFor > p.votesAgainst;

        if (quorumMet && majorityFor) {
            p.state        = STATE_TIMELOCKED;
            p.timelockEnd  = block.timestamp + timelockPeriod;
            emit ProposalPassed(proposalId, p.votesFor, p.votesAgainst);
        } else {
            p.state = STATE_DEFEATED;
            emit ProposalDefeated(proposalId, p.votesFor, p.votesAgainst);
        }
    }

    /**
     * @notice Execute a passed-and-timelocked proposal.
     *         Anyone may call this.
     */
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.state != STATE_TIMELOCKED)              revert GOV_NotPassed();
        if (block.timestamp < p.timelockEnd)          revert GOV_Timelocked();
        if (block.timestamp > p.timelockEnd + execExpiry) revert GOV_Expired();

        p.state = STATE_EXECUTED;

        if (p.paramId == PARAM_CNOVA_BOOST_TABLE) {
            // Array-valued param: no allowed-values registry, apply directly.
            IGovernanceTarget(p.target).setBoostTable(
                proposalBoostThresholds[proposalId],
                proposalBoostRates[proposalId]
            );
        } else {
            // Double-check value is still allowed (in case allowed list changed)
            if (!_isAllowed(p.paramId, p.newValue)) revert GOV_ValueNotAllowed();
            _applyParam(p.paramId, p.target, p.newValue);
        }

        emit ProposalExecuted(proposalId, p.paramId, p.newValue);
    }

    /**
     * @notice Proposer can cancel their own proposal while it is still ACTIVE.
     */
    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.proposer != msg.sender) revert GOV_NotProposer();
        if (p.state != STATE_ACTIVE)  revert GOV_NotActive();
        p.state = STATE_CANCELLED;
        emit ProposalCancelled(proposalId);
    }

    // ── Param application ─────────────────────────────────────────────────────

    function _applyParam(uint8 paramId, address target, uint256 value) internal {
        IGovernanceTarget t = IGovernanceTarget(target);

        if (paramId == PARAM_UPGRADE_CYCLE_THRESHOLD) {
            t.setAutoUpgradeCycleThreshold(value);
        } else if (paramId == PARAM_REENTRY_MIN_CYCLES) {
            t.setReentryMinCycles(value);
        // V8.21: PARAM_ESCROW_FLOOR_MULT branch removed -- execute() never
        // reaches here for this id (propose() rejects it first), and the
        // target function no longer exists on TierRouter anyway.
        } else if (paramId == PARAM_VELOCITY_WINDOW) {
            t.setVelocityWindow(value);
        } else if (paramId == PARAM_VELOCITY_THRESHOLD) {
            t.setVelocityThreshold(value);
        } else if (paramId == PARAM_DEFLATION_THRESHOLD) {
            t.setDeflationThreshold(value);
        } else if (paramId == PARAM_IDLE_SLOT_TIMEOUT) {
            t.setIdleSlotTimeout(value);
        } else if (paramId == PARAM_MAX_ITEMS_PER_UPKEEP) {
            t.setMaxItemsPerUpkeep(value);
        } else if (paramId == PARAM_WITHDRAWAL_FEE_BPS) {
            t.setWithdrawalFeeBps(value);
        // V8.21: PARAM_EARLY_EXIT_PENALTY_BPS branch removed -- execute() never
        // reaches here for this id (propose() rejects it first), and the
        // target function no longer exists on FigureEightMatrixV8 anyway.
        } else if (paramId == PARAM_VOTING_PERIOD) {
            votingPeriod = value;
        } else if (paramId == PARAM_TIMELOCK_PERIOD) {
            timelockPeriod = value;
        } else if (paramId == PARAM_QUORUM_BPS) {
            quorumBps = value;
        } else if (paramId == PARAM_PROPOSAL_FEE) {
            proposalFee = value;
        } else if (paramId == PARAM_SF_RESCUE_LADDER) {
            t.setSfRescueLadderPreset(value);
        // ── V8.20 second wave: TierRouter ─────────────────────────────────────
        } else if (paramId == PARAM_WHALE_GATE_THRESHOLD) {
            t.setWhaleGateThreshold(value);
        } else if (paramId == PARAM_INACTIVITY_DAYS_THRESHOLD) {
            t.setInactivityDaysThreshold(value);
        } else if (paramId == PARAM_INACTIVITY_CYCLES_THRESHOLD) {
            t.setInactivityCyclesThreshold(value);
        } else if (paramId == PARAM_INACTIVITY_GUARD_ENABLED) {
            t.setInactivityGuardEnabled(value);
        // ── V8.20 second wave: MatrixKeeper ───────────────────────────────────
        } else if (paramId == PARAM_PARKED_GRACE_PERIOD) {
            t.setParkedGracePeriod(value);
        } else if (paramId == PARAM_RESCUE_RATIO_BPS) {
            t.setRescueRatioBps(value);
        // ── V8.20 second wave: StabilityFund ──────────────────────────────────
        } else if (paramId == PARAM_SF_TARGET) {
            t.setSFTarget(value);
        } else if (paramId == PARAM_SF_COMMUNITY_CARVEOUT_BPS) {
            t.setCommunityCarveOutBps(value);
        } else if (paramId == PARAM_SF_STABILITY_FLOOR) {
            t.setStabilityFloor(value);
        // ── V8.20 second wave: CNOVABuybackReserve ─────────────────────────────
        } else if (paramId == PARAM_BBR_TRIGGER_THRESHOLD) {
            t.setTriggerThreshold(value);
        } else if (paramId == PARAM_BBR_MAX_SLIPPAGE_BPS) {
            t.setMaxSlippageBps(value);
        // ── V8.20 second wave: CNOVADirectSale ─────────────────────────────────
        } else if (paramId == PARAM_DS_MAX_TX_BPS) {
            t.setMaxTxBps(value);
        } else if (paramId == PARAM_DS_MAX_WALLET_BPS) {
            t.setMaxWalletBps(value);
        } else if (paramId == PARAM_DS_SF_TARGET) {
            t.setSfTargetDS(value);
        } else if (paramId == PARAM_DS_LQ_TARGET) {
            t.setLqTargetDS(value);
        // ── V8.20 second wave: CNOVAToken (GOVERNOR_ROLE) ──────────────────────
        } else if (paramId == PARAM_CNOVA_REWARD_PCT) {
            t.setRewardPct(value);
        } else if (paramId == PARAM_CNOVA_EPOCH_MINT_LIMIT) {
            t.setEpochMintLimit(value);
        } else if (paramId == PARAM_CNOVA_EPOCH_MEMBER_LIMIT) {
            t.setEpochMemberLimitGov(value);
        } else if (paramId == PARAM_CNOVA_EPOCH_TIME_LIMIT) {
            t.setEpochTimeLimit(value);
        } else if (paramId == PARAM_CNOVA_VEST_DURATION) {
            t.setVestDuration(value);
        } else if (paramId == PARAM_CNOVA_MAX_PENALTY_BPS) {
            t.setMaxPenaltyBps(value);
        // ── V8.20 second wave: CommunityWallet (GOVERNOR_ROLE) ─────────────────
        } else if (paramId == PARAM_CW_GENESIS_BPS) {
            t.setGenesisBps(value);
        } else if (paramId == PARAM_CW_DISTRIBUTE_RATIO_BPS) {
            t.setDistributeRatio(value);
        } else if (paramId == PARAM_CW_DISTRIBUTION_DAY) {
            t.setDistributionDayOfMonth(uint8(value));
        // ── V8.22: StabilityFund per-tier SF target multiplier ────────────────
        } else if (paramId == PARAM_SF_MULT_T1) {
            t.setSfTargetMultiplierT1(value);
        } else if (paramId == PARAM_SF_MULT_T2) {
            t.setSfTargetMultiplierT2(value);
        } else if (paramId == PARAM_SF_MULT_T3) {
            t.setSfTargetMultiplierT3(value);
        } else if (paramId == PARAM_SF_MULT_T4) {
            t.setSfTargetMultiplierT4(value);
        } else if (paramId == PARAM_SF_MULT_T5) {
            t.setSfTargetMultiplierT5(value);
        } else if (paramId == PARAM_SF_MULT_T6) {
            t.setSfTargetMultiplierT6(value);
        } else if (paramId == PARAM_SF_MULT_T7) {
            t.setSfTargetMultiplierT7(value);
        } else if (paramId == PARAM_SF_MULT_T8) {
            t.setSfTargetMultiplierT8(value);
        } else if (paramId == PARAM_SF_MULT_T9) {
            t.setSfTargetMultiplierT9(value);
        } else if (paramId == PARAM_SF_MULT_T10) {
            t.setSfTargetMultiplierT10(value);
        // ── V8.32: StabilityFund rescue repayment BPS ─────────────────────────
        } else if (paramId == PARAM_SF_RESCUE_REPAY_BPS) {
            t.setRescueRepayBps(value);
        // ── V8.48 item 46: StabilityFund insolvency floor ─────────────────────
        } else if (paramId == PARAM_SF_INSOLVENCY_FLOOR) {
            t.setInsolvencyFloorBps(value);
        // ── V8.48: StabilityFund surplus-to-community dial ────────────────────
        } else if (paramId == PARAM_SF_COMMUNITY_OVERFLOW) {
            t.setCommunityOverflowBps(value);
        // ── V8.49: MatrixKeeper crossing buffer (default 0 — buffer off) ──────
        } else if (paramId == PARAM_MK_CROSSING_BUFFER) {
            t.setCrossingBufferBps(value);
        // ── V8.49 item 1: MatrixKeeper eviction clock (default 7 days) ────────
        } else if (paramId == PARAM_MK_EVICTION_GRACE) {
            t.setEvictionGracePeriod(value);
        // ── V8.50 defect 8: MatrixKeeper gas floor (default 5M, measured at size 127) ──
        } else if (paramId == PARAM_MK_MIN_GAS_PER_ITEM) {
            t.setMinGasPerItem(value);
        // ── V8.50 item-43 sweep: five setters that were owner-only in practice ──
        } else if (paramId == PARAM_SF_CLAWBACK_PRESET) {
            t.setClawbackPreset(value);
        } else if (paramId == PARAM_SF_BASE_ADVANCE) {
            t.setBaseAdvanceBps(value);
        } else if (paramId == PARAM_MK_SELF_FUNDED_GRACE) {
            t.setSelfFundedGracePeriod(value);
        } else if (paramId == PARAM_MK_FROZEN_MATB) {
            t.setFrozenMatBTimeout(value);
        } else if (paramId == PARAM_MK_GHOST_ENTRY) {
            // Boolean carried as 0/1, same as PARAM_INACTIVITY_GUARD_ENABLED.
            t.setGhostEntryEnabled(value != 0);
        // ── V8.33: MatrixKeeper extended idle timeout ──────────────────────────
        } else if (paramId == PARAM_EXTENDED_IDLE_TIMEOUT) {
            t.setExtendedIdleTimeout(value);
        // ── V8.35: TierRouter per-tier whale gate thresholds ──────────────────
        } else if (paramId == PARAM_WHALE_GATE_T5) {
            t.setTierGateThresholdT5(value);
        } else if (paramId == PARAM_WHALE_GATE_T6) {
            t.setTierGateThresholdT6(value);
        } else if (paramId == PARAM_WHALE_GATE_T7) {
            t.setTierGateThresholdT7(value);
        } else if (paramId == PARAM_WHALE_GATE_T8) {
            t.setTierGateThresholdT8(value);
        } else if (paramId == PARAM_WHALE_GATE_T9) {
            t.setTierGateThresholdT9(value);
        } else if (paramId == PARAM_WHALE_GATE_T10) {
            t.setTierGateThresholdT10(value);
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _isAllowed(uint8 paramId, uint256 value) internal view returns (bool) {
        uint256[] storage allowed = _allowedValues[paramId];
        for (uint256 i = 0; i < allowed.length; i++) {
            if (allowed[i] == value) return true;
        }
        return false;
    }

    /// @dev V8.20: structural validation for CNOVAToken's boost table (mirrors
    ///      the same checks CNOVAToken.setBoostTable enforces on-chain). Adds a
    ///      length >= 1 floor on top of CNOVAToken's own checks -- an empty table
    ///      is technically accepted on-chain but is never a sane governance ask.
    function _isValidBoostTable(uint256[] calldata thresholds, uint256[] calldata rates)
        internal pure returns (bool)
    {
        uint256 n = thresholds.length;
        if (n == 0)               return false;
        if (rates.length != n)    return false;
        for (uint256 i = 0; i < n; i++) {
            if (rates[i] > 10_000) return false;
            if (i > 0 && thresholds[i] <= thresholds[i - 1]) return false;
        }
        return true;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getProposalState(uint256 proposalId) external view returns (string memory) {
        uint8 s = proposals[proposalId].state;
        if (s == STATE_ACTIVE)     return "ACTIVE";
        if (s == STATE_PASSED)     return "PASSED";
        if (s == STATE_DEFEATED)   return "DEFEATED";
        if (s == STATE_TIMELOCKED) return "TIMELOCKED";
        if (s == STATE_EXECUTED)   return "EXECUTED";
        if (s == STATE_EXPIRED)    return "EXPIRED";
        if (s == STATE_CANCELLED)  return "CANCELLED";
        return "UNKNOWN";
    }

    function getVotes(uint256 proposalId)
        external view
        returns (uint256 votesFor, uint256 votesAgainst, uint256 quorumRequired)
    {
        Proposal storage p = proposals[proposalId];
        return (p.votesFor, p.votesAgainst, p.quorumRequired);
    }
}
