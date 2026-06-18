// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CNOVAGovernance
 * @notice Burn-to-vote on-chain governance for the CryptoNova protocol.
 *
 * ─── HOW IT WORKS ───────────────────────────────────────────────────────────
 *
 *  1. PROPOSE  — Burn MIN_CREATE_BURN CNOVA to create a proposal.
 *                Anyone can propose; burning is the spam filter.
 *
 *  2. VOTE     — During VOTING_PERIOD, any CNOVA holder burns tokens to
 *                vote FOR or AGAINST. Votes are weighted by CNOVA burned.
 *                You can add more burns to your position any time.
 *
 *  3. RESULT   — When voting closes:
 *                  PASSED   → burnedFor ≥ MIN_QUORUM_BURN
 *                             AND burnedFor > burnedAgainst
 *                  DEFEATED → otherwise
 *
 *  4. EXECUTE  — After EXECUTION_DELAY (timelock), anyone calls execute().
 *                The contract calls the governed parameter setter.
 *                Execution is permissionless — no admin bottleneck.
 *
 * ─── BURN-TO-VOTE FLYWHEEL ──────────────────────────────────────────────────
 *
 *  Every vote burns CNOVA → removes supply → floor price rises.
 *  Governance participation directly strengthens the token economy.
 *  High conviction = larger burn = more voting power = higher floor.
 *  There are no free votes — your ballot IS your contribution.
 *
 * ─── PHASE GATE ─────────────────────────────────────────────────────────────
 *
 *  Governance is locked until Universe Mode activates (500+ members).
 *  Before that point the admin wallet retains full control, preventing
 *  early manipulation before real community breadth exists.
 *
 * ─── V1 GOVERNED PARAMETERS ─────────────────────────────────────────────────
 *
 *  REWARD_PCT  → CNOVAToken.rewardPct  (range: 10–75)
 *    Controls the Final Frontier minting multiplier.
 *    Higher % → more CNOVA per entry.
 *    Lower  % → faster floor growth, stronger token.
 *
 * ─── EXTENDING GOVERNANCE ───────────────────────────────────────────────────
 *
 *  Add new ProposalTypes and a matching branch in _executeProposal().
 *  Each type should have explicit min/max bounds to prevent runaway changes.
 *  Suggested V2 additions:
 *    ESCROW_BPS    — Follow Me Escrow percentage in FigureEightMatrix
 *    FOUNDER_BPS   — Founder pool split
 *    VOTING_PERIOD — Governance can change its own parameters
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CNOVAToken.sol";

/// @dev Minimal interface to read Universe Mode status from CNOVATreasury
interface IUniverseModeGate {
    function isUniverseMode() external view returns (bool);
}

contract CNOVAGovernance is Ownable2Step, ReentrancyGuard {

    // ─── Governed contracts ───────────────────────────────────────────────────
    CNOVAToken           public immutable cnova;
    IUniverseModeGate    public immutable treasury;  // Universe Mode phase gate

    // ─── Proposal types (V1) ──────────────────────────────────────────────────
    enum ProposalType {
        REWARD_PCT     // CNOVAToken.rewardPct  (10–75)
        // Future: ESCROW_BPS, FOUNDER_BPS, L1_SPLIT_BPS, VOTING_PERIOD, ...
    }

    // ─── Proposal states ──────────────────────────────────────────────────────
    enum ProposalState {
        ACTIVE,    // Voting window open
        PASSED,    // Voting ended — passed, awaiting execution delay
        QUEUED,    // Execution delay elapsed — ready to execute
        EXECUTED,  // Successfully executed
        DEFEATED,  // Voting ended — did not pass
        CANCELED   // Canceled by proposer before voting closed
    }

    // ─── Proposal data ────────────────────────────────────────────────────────
    struct Proposal {
        uint256      id;
        ProposalType proposalType;
        address      proposer;
        string       description;
        uint256      newValue;      // The value being proposed
        uint256      startTime;     // Block timestamp when voting opened
        uint256      endTime;       // startTime + votingPeriod
        uint256      burnedFor;     // Total CNOVA burned in support
        uint256      burnedAgainst; // Total CNOVA burned in opposition
        bool         executed;
        bool         canceled;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    /// @notice CNOVA burned by each voter, per side, per proposal
    mapping(uint256 => mapping(address => uint256)) public voterBurnedFor;
    mapping(uint256 => mapping(address => uint256)) public voterBurnedAgainst;

    // ─── Governable parameters (admin-set, eventually governance-settable) ────
    uint256 public minCreateBurn  = 5   * 1e18;  // 5 CNOVA to create a proposal
    uint256 public minQuorumBurn  = 50  * 1e18;  // 50 CNOVA total FOR needed for validity
    uint256 public votingPeriod   = 7 days;
    uint256 public executionDelay = 2 days;       // timelock after voting closes

    // ─── Value bounds per proposal type ──────────────────────────────────────
    // REWARD_PCT
    uint256 public constant REWARD_PCT_MIN = 10;
    uint256 public constant REWARD_PCT_MAX = 75;

    // ─── Pause ────────────────────────────────────────────────────────────────
    bool public paused;

    // ─── Events ───────────────────────────────────────────────────────────────
    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        ProposalType    proposalType,
        uint256         newValue,
        uint256         endTime,
        string          description
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool            support,
        uint256         burnAmount,
        uint256         newTotalFor,
        uint256         newTotalAgainst
    );
    event ProposalExecuted(
        uint256 indexed id,
        ProposalType    proposalType,
        uint256         newValue
    );
    event ProposalDefeated(
        uint256 indexed id,
        uint256         burnedFor,
        uint256         burnedAgainst,
        string          reason
    );
    event ProposalCanceled(uint256 indexed id);
    event GovernanceParamsUpdated(string param, uint256 newValue);
    event Paused(bool isPaused);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier notPaused() {
        require(!paused, "GOV: paused");
        _;
    }

    modifier universeMode() {
        require(treasury.isUniverseMode(), "GOV: Universe Mode not active yet");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _cnova,
        address _treasury,
        address _admin
    ) Ownable(_admin) {
        require(_cnova    != address(0), "GOV: zero cnova");
        require(_treasury != address(0), "GOV: zero treasury");
        cnova    = CNOVAToken(_cnova);
        treasury = IUniverseModeGate(_treasury);
    }

    // ─── PROPOSE ──────────────────────────────────────────────────────────────

    /**
     * @notice Create a new governance proposal.
     *         Burns minCreateBurn CNOVA from msg.sender.
     *         Voting opens immediately and runs for votingPeriod.
     *
     * @param proposalType  What parameter is being changed
     * @param newValue      The proposed new value (validated per type)
     * @param description   Human-readable rationale (stored on-chain)
     */
    function propose(
        ProposalType proposalType,
        uint256      newValue,
        string calldata description
    )
        external
        notPaused
        universeMode
        nonReentrant
        returns (uint256 proposalId)
    {
        require(bytes(description).length > 0, "GOV: empty description");
        _validateValue(proposalType, newValue);

        // Burn creation fee from proposer
        _burnFrom(msg.sender, minCreateBurn);

        proposalId = ++proposalCount;
        uint256 end = block.timestamp + votingPeriod;

        proposals[proposalId] = Proposal({
            id:             proposalId,
            proposalType:   proposalType,
            proposer:       msg.sender,
            description:    description,
            newValue:       newValue,
            startTime:      block.timestamp,
            endTime:        end,
            burnedFor:      0,
            burnedAgainst:  0,
            executed:       false,
            canceled:       false
        });

        emit ProposalCreated(
            proposalId,
            msg.sender,
            proposalType,
            newValue,
            end,
            description
        );
    }

    // ─── VOTE ─────────────────────────────────────────────────────────────────

    /**
     * @notice Cast a vote by burning CNOVA.
     *         The more you burn, the more weight your vote carries.
     *         You can call vote() multiple times to add to your existing position.
     *
     * @param proposalId  ID of the proposal
     * @param support     true = vote FOR, false = vote AGAINST
     * @param burnAmount  CNOVA to burn (18-decimal, must be > 0)
     */
    function vote(
        uint256 proposalId,
        bool    support,
        uint256 burnAmount
    )
        external
        notPaused
        nonReentrant
    {
        require(burnAmount > 0, "GOV: zero burn");

        Proposal storage p = proposals[proposalId];
        require(p.id != 0,              "GOV: proposal not found");
        require(!p.canceled,            "GOV: proposal canceled");
        require(!p.executed,            "GOV: already executed");
        require(block.timestamp <= p.endTime, "GOV: voting closed");

        // Burn CNOVA from voter
        _burnFrom(msg.sender, burnAmount);

        if (support) {
            p.burnedFor                        += burnAmount;
            voterBurnedFor[proposalId][msg.sender] += burnAmount;
        } else {
            p.burnedAgainst                        += burnAmount;
            voterBurnedAgainst[proposalId][msg.sender] += burnAmount;
        }

        emit VoteCast(
            proposalId,
            msg.sender,
            support,
            burnAmount,
            p.burnedFor,
            p.burnedAgainst
        );
    }

    // ─── EXECUTE ──────────────────────────────────────────────────────────────

    /**
     * @notice Execute a passed proposal after the execution delay has elapsed.
     *         Permissionless — anyone can trigger execution once conditions are met.
     *         This removes admin bottlenecks from governance outcomes.
     *
     * @param proposalId  ID of the proposal to execute
     */
    function execute(uint256 proposalId)
        external
        notPaused
        nonReentrant
    {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0,   "GOV: proposal not found");
        require(!p.canceled, "GOV: proposal canceled");
        require(!p.executed, "GOV: already executed");
        require(block.timestamp > p.endTime, "GOV: voting still open");

        // Check it passed
        require(
            p.burnedFor >= minQuorumBurn,
            "GOV: quorum not reached"
        );
        require(
            p.burnedFor > p.burnedAgainst,
            "GOV: proposal defeated"
        );

        // Check execution delay (timelock)
        require(
            block.timestamp >= p.endTime + executionDelay,
            "GOV: execution delay not elapsed"
        );

        p.executed = true;

        _executeProposal(p);

        emit ProposalExecuted(proposalId, p.proposalType, p.newValue);
    }

    // ─── CANCEL ───────────────────────────────────────────────────────────────

    /**
     * @notice Cancel a proposal during the voting window.
     *         Only the original proposer or the admin can cancel.
     *         Burned CNOVA is NOT refunded — burning is irreversible.
     *
     * @param proposalId  ID of the proposal to cancel
     */
    function cancel(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0,                                         "GOV: not found");
        require(!p.executed,                                       "GOV: already executed");
        require(!p.canceled,                                       "GOV: already canceled");
        require(
            msg.sender == p.proposer || msg.sender == owner(),
            "GOV: not proposer or admin"
        );
        require(block.timestamp <= p.endTime, "GOV: voting already closed");

        p.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    // ─── INTERNAL: Execution dispatch ─────────────────────────────────────────

    function _executeProposal(Proposal storage p) internal {
        if (p.proposalType == ProposalType.REWARD_PCT) {
            // Double-check bounds at execution time (value may no longer be valid
            // if bounds changed between proposal creation and execution)
            require(
                p.newValue >= REWARD_PCT_MIN && p.newValue <= REWARD_PCT_MAX,
                "GOV: value out of bounds at execution"
            );
            cnova.setRewardPct(p.newValue);
        }
        // Future types: add else-if branches here
    }

    function _validateValue(ProposalType t, uint256 v) internal pure {
        if (t == ProposalType.REWARD_PCT) {
            require(
                v >= REWARD_PCT_MIN && v <= REWARD_PCT_MAX,
                "GOV: REWARD_PCT must be 10-75"
            );
        }
    }

    function _burnFrom(address from, uint256 amount) internal {
        // Requires from to have approved this contract OR BURNER_ROLE burns directly.
        // We use BURNER_ROLE path — governance contract is granted BURNER_ROLE at deploy.
        // This avoids the user needing a separate approve() tx before voting.
        cnova.burnFrom(from, amount);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the current state of a proposal.
     */
    function proposalState(uint256 proposalId)
        external view
        returns (ProposalState)
    {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0, "GOV: not found");

        if (p.canceled) return ProposalState.CANCELED;
        if (p.executed) return ProposalState.EXECUTED;

        if (block.timestamp <= p.endTime) return ProposalState.ACTIVE;

        // Voting closed — check result
        bool quorumMet = p.burnedFor >= minQuorumBurn;
        bool majority  = p.burnedFor > p.burnedAgainst;

        if (!quorumMet || !majority) return ProposalState.DEFEATED;

        // Passed — check if execution delay elapsed
        if (block.timestamp < p.endTime + executionDelay) {
            return ProposalState.PASSED;   // waiting out the timelock
        }
        return ProposalState.QUEUED;       // ready to execute
    }

    /**
     * @notice Full proposal details in a single call.
     */
    function getProposal(uint256 proposalId)
        external view
        returns (Proposal memory)
    {
        return proposals[proposalId];
    }

    /**
     * @notice How much CNOVA a specific voter burned on each side of a proposal.
     */
    function voterInfo(uint256 proposalId, address voter)
        external view
        returns (uint256 forBurned, uint256 againstBurned)
    {
        forBurned     = voterBurnedFor[proposalId][voter];
        againstBurned = voterBurnedAgainst[proposalId][voter];
    }

    /**
     * @notice Whether a proposal has passed and is ready to execute.
     */
    function isExecutable(uint256 proposalId) external view returns (bool) {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0 || p.canceled || p.executed) return false;
        if (block.timestamp <= p.endTime)           return false;
        bool quorum   = p.burnedFor >= minQuorumBurn;
        bool majority = p.burnedFor > p.burnedAgainst;
        bool delayed  = block.timestamp >= p.endTime + executionDelay;
        return quorum && majority && delayed;
    }

    /**
     * @notice Current value of each governable parameter (for frontend).
     */
    function currentParams()
        external view
        returns (
            uint256 _rewardPct,
            uint256 _minCreateBurn,
            uint256 _minQuorumBurn,
            uint256 _votingPeriod,
            uint256 _executionDelay
        )
    {
        _rewardPct      = cnova.rewardPct();
        _minCreateBurn  = minCreateBurn;
        _minQuorumBurn  = minQuorumBurn;
        _votingPeriod   = votingPeriod;
        _executionDelay = executionDelay;
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────────

    function setMinCreateBurn(uint256 v)  external onlyOwner {
        minCreateBurn  = v;
        emit GovernanceParamsUpdated("minCreateBurn", v);
    }
    function setMinQuorumBurn(uint256 v)  external onlyOwner {
        minQuorumBurn  = v;
        emit GovernanceParamsUpdated("minQuorumBurn", v);
    }
    function setVotingPeriod(uint256 v)   external onlyOwner {
        require(v >= 1 days && v <= 30 days, "GOV: period out of range");
        votingPeriod   = v;
        emit GovernanceParamsUpdated("votingPeriod", v);
    }
    function setExecutionDelay(uint256 v) external onlyOwner {
        require(v <= 7 days, "GOV: delay too long");
        executionDelay = v;
        emit GovernanceParamsUpdated("executionDelay", v);
    }
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }
}
