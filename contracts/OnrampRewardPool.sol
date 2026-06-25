// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  OnrampRewardPool
 * @notice LP staking pool that distributes Transak/Ramp partner-fee revenue to
 *         USDC liquidity providers.
 *
 * How it works
 * ────────────
 * 1. LPs deposit USDC in multiples of $10 (min $10).
 * 2. When a Transak/Ramp on-ramp partner fee arrives, the designated
 *    distributor wallet calls distributeReward(amount), which updates the
 *    global accRewardPerShare accumulator.
 * 3. Each LP earns a pro-rata share of every reward event proportional to
 *    their staked balance at the time of distribution.
 * 4. Rewards are claimed on deposit, withdraw, or harvest — no separate
 *    claim step required.
 *
 * Reward accounting
 * ─────────────────
 * Uses the standard "reward-per-share" pattern (MasterChef-style):
 *   accRewardPerShare += reward * ACC_PRECISION / totalStaked
 *   pending(user)     = staked[user] * accRewardPerShare / ACC_PRECISION
 *                       - rewardDebt[user]
 *
 * Deposit / withdrawal rules
 * ──────────────────────────
 * - Minimum deposit:  $10 USDC (10_000_000 units, 6 decimals)
 * - Deposit unit:     multiples of $10 only — $15 reverts, $20 passes
 * - Withdraw amount:  any multiple of $10 up to full staked balance;
 *                     rewards harvested automatically on every withdrawal
 * - No lock period:   LPs can exit at any time
 *
 * Deployment notes
 * ────────────────
 * - Standalone contract — no dependency on the core CryptoNova protocol
 * - Deploy separately; only needs the USDC token address at construction
 * - Point the Transak/Ramp partner dashboard to a funded distributor wallet
 * - Distributor wallet approves this contract then calls distributeReward()
 *   each time a partner-fee tranche arrives
 */
contract OnrampRewardPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ───────────────────────────────────────────────────────────

    /// @notice USDC has 6 decimals; $10 = 10_000_000 units
    uint256 public constant DEPOSIT_UNIT = 10_000_000; // $10

    /// @dev Precision multiplier for reward-per-share accumulator
    uint256 private constant ACC_PRECISION = 1e12;

    // ── Immutables ──────────────────────────────────────────────────────────

    /// @notice USDC token contract (6 decimals)
    IERC20 public immutable usdc;

    // ── State ───────────────────────────────────────────────────────────────

    /// @notice Address authorised to call distributeReward() (besides owner)
    address public distributor;

    /// @notice Total USDC principal currently staked by all LPs
    uint256 public totalStaked;

    /// @notice Accumulated reward per staked unit, scaled by ACC_PRECISION
    uint256 public accRewardPerShare;

    /// @notice Total USDC reward distributed to date (informational)
    uint256 public totalRewardDistributed;

    /// @dev LP staked principal balances
    mapping(address => uint256) public staked;

    /// @dev reward-debt checkpoint — updated after every state-changing action
    mapping(address => uint256) public rewardDebt;

    // ── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed lp, uint256 amount, uint256 newTotal);
    event Withdrawn(address indexed lp, uint256 amount, uint256 newTotal);
    event Harvested(address indexed lp, uint256 reward);
    event RewardDistributed(address indexed from, uint256 amount, uint256 newAccRPS);
    event DistributorSet(address indexed previous, address indexed next);
    event EmergencyWithdrawn(address indexed lp, uint256 amount);

    // ── Constructor ─────────────────────────────────────────────────────────

    /// @param _usdc   Address of the USDC token (6 decimals)
    /// @param _owner  Initial owner (deployer / multisig)
    constructor(address _usdc, address _owner) Ownable(_owner) {
        require(_usdc != address(0), "ORP: zero USDC");
        usdc = IERC20(_usdc);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    /**
     * @notice Set the distributor wallet that may call distributeReward().
     * @dev    Typically set to the Transak partner-fee receiver wallet or a
     *         lightweight keeper script.  Owner can always call regardless.
     */
    function setDistributor(address _distributor) external onlyOwner {
        emit DistributorSet(distributor, _distributor);
        distributor = _distributor;
    }

    // ── LP actions ──────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the pool.
     * @param  amount Must be >= $10 and a multiple of $10 (DEPOSIT_UNIT).
     *                Pending rewards are harvested automatically before
     *                the new deposit is recorded.
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount >= DEPOSIT_UNIT,       "ORP: minimum $10");
        require(amount % DEPOSIT_UNIT == 0,   "ORP: must be a multiple of $10");

        // Harvest any pending rewards before adjusting balance
        _harvest(msg.sender);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        staked[msg.sender] += amount;
        totalStaked         += amount;

        // Checkpoint so the newly deposited principal earns from future events only
        rewardDebt[msg.sender] = _computeDebt(msg.sender);

        emit Deposited(msg.sender, amount, staked[msg.sender]);
    }

    /**
     * @notice Withdraw staked USDC principal.
     * @param  amount Must be a multiple of $10 and <= caller's staked balance.
     *                Pending rewards are harvested automatically.
     */
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0,                        "ORP: zero amount");
        require(amount % DEPOSIT_UNIT == 0,        "ORP: must be a multiple of $10");
        require(staked[msg.sender] >= amount,      "ORP: insufficient stake");

        _harvest(msg.sender);

        staked[msg.sender] -= amount;
        totalStaked         -= amount;
        rewardDebt[msg.sender] = _computeDebt(msg.sender);

        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, staked[msg.sender]);
    }

    /**
     * @notice Claim all pending rewards without touching the principal.
     */
    function harvest() external nonReentrant {
        uint256 pending = _pendingReward(msg.sender);
        require(pending > 0, "ORP: nothing to harvest");
        _harvest(msg.sender);
        rewardDebt[msg.sender] = _computeDebt(msg.sender);
    }

    /**
     * @notice Emergency principal withdrawal — skips reward accounting.
     * @dev    Use only if a rewards bug prevents normal withdrawal.
     *         Forfeits any unclaimed rewards.
     */
    function emergencyWithdraw() external nonReentrant {
        uint256 amount = staked[msg.sender];
        require(amount > 0, "ORP: nothing staked");

        staked[msg.sender] = 0;
        totalStaked        -= amount;
        rewardDebt[msg.sender] = 0;

        usdc.safeTransfer(msg.sender, amount);
        emit EmergencyWithdrawn(msg.sender, amount);
    }

    // ── Distribution ────────────────────────────────────────────────────────

    /**
     * @notice Distribute a USDC reward tranche to all current LPs.
     * @dev    Caller must approve this contract for `amount` USDC before calling.
     *         Reverts if no USDC is staked (no LPs to receive).
     * @param  amount USDC amount to distribute (pulled from caller).
     */
    function distributeReward(uint256 amount) external nonReentrant {
        require(
            msg.sender == owner() || msg.sender == distributor,
            "ORP: not authorized"
        );
        require(totalStaked > 0, "ORP: no stakers");
        require(amount > 0,      "ORP: zero reward");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        accRewardPerShare      += (amount * ACC_PRECISION) / totalStaked;
        totalRewardDistributed += amount;

        emit RewardDistributed(msg.sender, amount, accRewardPerShare);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Unclaimed reward available to an LP right now.
     */
    function pendingReward(address lp) external view returns (uint256) {
        return _pendingReward(lp);
    }

    /**
     * @notice Full LP summary in one call — useful for frontend display.
     * @return stakedAmount    Principal currently deposited
     * @return pendingAmount   Rewards claimable right now
     * @return sharePercent    LP's share of pool × 1e4 (divide by 100 for %)
     *                         e.g. 500 = 5.00 %
     */
    function lpInfo(address lp) external view returns (
        uint256 stakedAmount,
        uint256 pendingAmount,
        uint256 sharePercent
    ) {
        stakedAmount  = staked[lp];
        pendingAmount = _pendingReward(lp);
        sharePercent  = totalStaked == 0
            ? 0
            : (stakedAmount * 1_000_000) / totalStaked; // 1_000_000 = 100.0000 %
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _pendingReward(address lp) internal view returns (uint256) {
        if (staked[lp] == 0) return 0;
        return (staked[lp] * accRewardPerShare) / ACC_PRECISION - rewardDebt[lp];
    }

    function _computeDebt(address lp) internal view returns (uint256) {
        return (staked[lp] * accRewardPerShare) / ACC_PRECISION;
    }

    /// @dev Transfer pending reward to LP and zero out the debt delta.
    ///      rewardDebt is NOT updated here — caller must update after adjusting staked.
    function _harvest(address lp) internal {
        uint256 pending = _pendingReward(lp);
        if (pending > 0) {
            usdc.safeTransfer(lp, pending);
            emit Harvested(lp, pending);
        }
        // Debt sync happens in the caller after staked[] is adjusted
    }
}
