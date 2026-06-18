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
 *                           maxItemsPerUpkeep)
 *           - FigureEightMatrixV8 (withdrawalFeeBps, earlyExitPenaltyBps)
 *             via TierRouter.setWithdrawalFeeForTier() / setExitPenaltyForTier()
 *           - V8Governance itself (votingPeriod, timelockPeriod, quorumBps)
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
    }

    /// @notice Owner can add or replace the allowed-values list for any param.
    function setAllowedValues(uint8 paramId, uint256[] calldata values) external onlyOwner {
        if (paramId == 0 || paramId > PARAM_QUORUM_BPS) revert GOV_InvalidParam();
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
        if (paramId == 0 || paramId > PARAM_QUORUM_BPS) revert GOV_InvalidParam();
        if (target == address(0) && paramId <= PARAM_QUORUM_BPS - 3) revert GOV_ZeroAddress();
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

        // Double-check value is still allowed (in case allowed list changed)
        if (!_isAllowed(p.paramId, p.newValue)) revert GOV_ValueNotAllowed();

        p.state = STATE_EXECUTED;

        _applyParam(p.paramId, p.target, p.newValue);

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
