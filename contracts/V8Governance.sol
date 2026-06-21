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
 *           - TierRouter (autoUpgradeCycleThreshold, reentryMinCycles,
 *                         escrowFloorMultiplier)
 *           - MatrixKeeper (velocityWindow, velocityThreshold,
 *                           deflationThreshold, idleSlotTimeout,
 *                           maxItemsPerUpkeep, sfRescueLadder)
 *           - FigureEightMatrixV8 (withdrawalFeeBps, earlyExitPenaltyBps) --
 *             target the matrix contract directly (set as `target` on the
 *             proposal); checked there via owner()/tierRouter/governance
 *           - V8Governance itself (votingPeriod, timelockPeriod, quorumBps)
 *
 *         V8.20: MatrixKeeper/TierRouter/FigureEightMatrixV8 must each have
 *         setGovernance(address(this)) called once post-deploy, or execute()
 *         reverts for every param above except the 3 self-governed ones.
 *         The SF rescue ladder is array-valued (not a single uint256), so it
 *         uses a separate entry point: proposeLadder() instead of propose(),
 *         still sharing the same vote/quorum/timelock/execute lifecycle.
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
}

interface IGovernanceTarget {
    // TierRouter
    function setAutoUpgradeCycleThreshold(uint256 v) external;
    function setReentryMinCycles(uint256 v) external;
    function setEscrowFloorMultiplier(uint256 v) external;
    // MatrixKeeper
    function setVelocityWindow(uint256 v) external;
    function setVelocityThreshold(uint256 v) external;
    function setDeflationThreshold(uint256 v) external;
    function setIdleSlotTimeout(uint256 v) external;
    function setMaxItemsPerUpkeep(uint256 v) external;
    // Matrix fee params (via TierRouter or direct)
    function setWithdrawalFeeBps(uint256 v) external;
    function setEarlyExitPenaltyBps(uint256 v) external;
    // MatrixKeeper -- V8.20: SF parked-rescue coverage ladder (array-valued param)
    function setSfRescueLadder(uint256[] calldata thresholds, uint256[] calldata bpsValues) external;

    // ── V8.20: second wave -- TierRouter ─────────────────────────────────────
    function setWhaleGateThreshold(uint256 v) external;
    function setInactivityDaysThreshold(uint256 v) external;
    function setInactivityCyclesThreshold(uint256 v) external;
    function setInactivityGuardEnabled(uint256 v) external;
    // ── V8.20: second wave -- MatrixKeeper ───────────────────────────────────
    function setParkedGracePeriod(uint256 v) external;
    function setRescueRatioBps(uint256 v) external;
    // ── V8.20: second wave -- StabilityFund ──────────────────────────────────
    function setSFTarget(uint256 v) external;
    function setCommunityCarveOutBps(uint256 v) external;
    function setStabilityFloor(uint256 v) external;
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
    function setDistributeInterval(uint256 v) external;
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
    uint8 public constant PARAM_ESCROW_FLOOR_MULT       = 3;
    uint8 public constant PARAM_VELOCITY_WINDOW         = 4;
    uint8 public constant PARAM_VELOCITY_THRESHOLD      = 5;
    uint8 public constant PARAM_DEFLATION_THRESHOLD     = 6;
    uint8 public constant PARAM_IDLE_SLOT_TIMEOUT       = 7;
    uint8 public constant PARAM_MAX_ITEMS_PER_UPKEEP    = 8;
    uint8 public constant PARAM_WITHDRAWAL_FEE_BPS      = 9;
    uint8 public constant PARAM_EARLY_EXIT_PENALTY_BPS  = 10;
    uint8 public constant PARAM_VOTING_PERIOD           = 11;
    uint8 public constant PARAM_TIMELOCK_PERIOD         = 12;
    uint8 public constant PARAM_QUORUM_BPS              = 13;
    /// @dev V8.20: array-valued param, proposed/executed via proposeLadder()/execute(),
    ///      not via propose()/_applyParam() -- has no allowed-values registry entry.
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
    uint8 public constant PARAM_CW_DISTRIBUTE_INTERVAL     = 39;

    // ── Governance config (self-governable) ───────────────────────────────────
    uint256 public votingPeriod   = 72 hours;
    uint256 public timelockPeriod = 48 hours;
    uint256 public execExpiry     = 72 hours;
    /// @notice Quorum as BPS of CNOVA total supply (default 200 = 2%)
    uint256 public quorumBps      = 200;

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

    // ── V8.20: array-valued proposal storage (paramId == PARAM_SF_RESCUE_LADDER only) ──
    // Side storage keyed by proposalId, kept separate from the Proposal struct so the
    // existing scalar-param ABI (newValue) is untouched.
    mapping(uint256 => uint256[]) public proposalLadderThresholds;
    mapping(uint256 => uint256[]) public proposalLadderBps;

    // ── V8.20: second array-valued proposal storage (PARAM_CNOVA_BOOST_TABLE only) ──
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
    event LadderProposed(uint256 indexed id, uint256[] thresholds, uint256[] bpsValues);
    event BoostTableProposed(uint256 indexed id, uint256[] thresholds, uint256[] rates);

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
        _allowedValues[PARAM_ESCROW_FLOOR_MULT]       = [110, 120, 150, 200];
        // MatrixKeeper params
        _allowedValues[PARAM_VELOCITY_WINDOW]         = [1800, 3600, 7200, 14400];
        _allowedValues[PARAM_VELOCITY_THRESHOLD]      = [1, 2, 3, 5];
        _allowedValues[PARAM_DEFLATION_THRESHOLD]     = [5, 10, 15, 20];
        _allowedValues[PARAM_IDLE_SLOT_TIMEOUT]       = [21600, 43200, 86400];
        _allowedValues[PARAM_MAX_ITEMS_PER_UPKEEP]    = [5, 10, 15, 20];
        // Matrix fee params
        _allowedValues[PARAM_WITHDRAWAL_FEE_BPS]      = [50, 100, 150, 200, 250];
        _allowedValues[PARAM_EARLY_EXIT_PENALTY_BPS]  = [1000, 1500, 2000, 2500];
        // Governance self-params
        _allowedValues[PARAM_VOTING_PERIOD]           = [48 hours, 72 hours, 96 hours, 168 hours];
        _allowedValues[PARAM_TIMELOCK_PERIOD]         = [24 hours, 48 hours, 72 hours];
        _allowedValues[PARAM_QUORUM_BPS]              = [100, 200, 300, 500];

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
        _allowedValues[PARAM_CW_DISTRIBUTE_INTERVAL]      = [7 days, 30 days, 90 days, 180 days, 365 days];
    }

    /// @notice Owner can add or replace the allowed-values list for any param.
    function setAllowedValues(uint8 paramId, uint256[] calldata values) external onlyOwner {
        if (paramId == 0 || paramId > PARAM_CW_DISTRIBUTE_INTERVAL) revert GOV_InvalidParam();
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
        if (paramId == 0 || paramId > PARAM_CW_DISTRIBUTE_INTERVAL) revert GOV_InvalidParam();
        if (paramId == PARAM_SF_RESCUE_LADDER || paramId == PARAM_CNOVA_BOOST_TABLE) revert GOV_InvalidParam();
        bool isSelfParam = (paramId == PARAM_VOTING_PERIOD ||
                            paramId == PARAM_TIMELOCK_PERIOD ||
                            paramId == PARAM_QUORUM_BPS);
        if (target == address(0) && !isSelfParam) revert GOV_ZeroAddress();
        if (!_isAllowed(paramId, newValue)) revert GOV_ValueNotAllowed();

        // Proposer must hold at least 0.01% of supply
        uint256 supply    = ICNOVAToken(cnovaToken).totalSupply();
        uint256 minTokens = supply / 10_000;
        if (ICNOVAToken(cnovaToken).balanceOf(msg.sender) < minTokens) revert GOV_NoVotingPower();

        proposalId = ++proposalCount;
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
     * @notice V8.20: Create a governance proposal for the SF rescue ladder
     *         (the one array-valued param). Separate entry point from propose()
     *         because the ladder can't be expressed as a single uint256.
     * @param target      Contract to call on execution (MatrixKeeper)
     * @param thresholds  Descending withdrawable/entryFee bps breakpoints, must start at 10_000
     * @param bpsValues   Ascending SF coverage bps per breakpoint, must start at 0, capped at 10_000
     * @param description Human-readable rationale (stored for events only)
     */
    function proposeLadder(
        address target,
        uint256[] calldata thresholds,
        uint256[] calldata bpsValues,
        string  calldata description
    ) external returns (uint256 proposalId) {
        if (target == address(0)) revert GOV_ZeroAddress();
        if (!_isValidLadder(thresholds, bpsValues)) revert GOV_ValueNotAllowed();

        uint256 supply = ICNOVAToken(cnovaToken).totalSupply();
        if (ICNOVAToken(cnovaToken).balanceOf(msg.sender) < supply / 10_000) revert GOV_NoVotingPower();

        proposalId = ++proposalCount;

        // Store the arrays first and drop them -- avoids keeping two calldata
        // arrays "live" alongside the struct write below (Yul stack-too-deep).
        proposalLadderThresholds[proposalId] = thresholds;
        proposalLadderBps[proposalId]        = bpsValues;

        // Field-by-field instead of one struct literal -- same reason: a
        // 13-field literal needs every value live on the stack at once.
        Proposal storage p = proposals[proposalId];
        p.id             = proposalId;
        p.proposer       = msg.sender;
        p.startTime      = block.timestamp;
        p.endTime        = block.timestamp + votingPeriod;
        p.state          = STATE_ACTIVE;
        p.paramId        = PARAM_SF_RESCUE_LADDER;
        p.target         = target;
        p.description    = description;
        p.quorumRequired = supply * quorumBps / 10_000;

        emit ProposalCreated(proposalId, msg.sender, PARAM_SF_RESCUE_LADDER, target, 0, description);
        emit LadderProposed(proposalId, thresholds, bpsValues);
    }

    /**
     * @notice V8.20: Create a governance proposal for CNOVAToken's boost table
     *         (the second array-valued param). Separate entry point from propose()
     *         for the same reason as proposeLadder() -- can't be a single uint256.
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

        if (p.paramId == PARAM_SF_RESCUE_LADDER) {
            // Array-valued param: no allowed-values registry, apply directly.
            IGovernanceTarget(p.target).setSfRescueLadder(
                proposalLadderThresholds[proposalId],
                proposalLadderBps[proposalId]
            );
        } else if (p.paramId == PARAM_CNOVA_BOOST_TABLE) {
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
        } else if (paramId == PARAM_ESCROW_FLOOR_MULT) {
            t.setEscrowFloorMultiplier(value);
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
        } else if (paramId == PARAM_EARLY_EXIT_PENALTY_BPS) {
            t.setEarlyExitPenaltyBps(value);
        } else if (paramId == PARAM_VOTING_PERIOD) {
            votingPeriod = value;
        } else if (paramId == PARAM_TIMELOCK_PERIOD) {
            timelockPeriod = value;
        } else if (paramId == PARAM_QUORUM_BPS) {
            quorumBps = value;
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
        } else if (paramId == PARAM_CW_DISTRIBUTE_INTERVAL) {
            t.setDistributeInterval(value);
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

    /// @dev V8.20: structural validation for the SF rescue ladder (mirrors the
    ///      same checks MatrixKeeper.setSfRescueLadder enforces on-chain, so a
    ///      malformed proposal can't even be created).
    function _isValidLadder(uint256[] calldata thresholds, uint256[] calldata bpsValues)
        internal pure returns (bool)
    {
        uint256 n = thresholds.length;
        if (n < 2 || n > 20)         return false;
        if (bpsValues.length != n)   return false;
        if (thresholds[0] != 10_000) return false;
        if (bpsValues[0] != 0)       return false;
        for (uint256 i = 1; i < n; i++) {
            if (thresholds[i] >= thresholds[i - 1]) return false;
            if (bpsValues[i] <= bpsValues[i - 1])   return false;
            if (bpsValues[i] > 10_000)              return false;
        }
        return true;
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
