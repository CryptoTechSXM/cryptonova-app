// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CNOVAToken -- V8.1 "Elevator"
 * @notice ERC-20 token for the CryptoNova ecosystem on Base chain.
 *
 * V8.1 changes from V7
 * --------------------
 * 1. Tier multiplier  -- mintReward() accepts tierIndex (0=T1 ... 6=T7).
 *    Minted amount = base epoch reward x multiplier.
 *    T1:1x  T2:2x  T3:4x  T4:8x  T5:20x  T6:40x  T7:80x
 *
 * 2. Triple epoch trigger -- epoch advances when ANY of these fires first:
 *    a) MINT   -- totalMinted - epochStartMinted >= epochMintLimit
 *                 Default 1,000,000 CNOVA. Fires fast if T7-heavy.
 *    b) MEMBER -- epochMemberCount >= epochMemberLimit
 *                 Default 10,000 unique registrations. Fires fast if T1-heavy.
 *    c) TIME   -- block.timestamp >= epochStartTime + epochTimeLimit
 *                 Default 30 days. Slow-start protection -- epoch advances
 *                 regardless of activity, so late-joiners never catch up to
 *                 the same reward rate as early adopters.
 *
 *    Early adopters who join in Epoch 1 keep their 50 CNOVA base.
 *    Late-comers who join after 3 halvings get 6 CNOVA base -- regardless of
 *    whether the halvings were triggered by activity or just time passing.
 *
 *    All three limits are DAO-adjustable via GOVERNOR_ROLE so the community
 *    can tune the pace if adoption is faster or slower than expected.
 *
 * 3. Cliff vesting    -- every mint locks tokens in the recipient wallet for
 *    vestDuration (default 6 months). Tokens appear in balanceOf() (count
 *    for governance + staking boost) but are non-transferable until unlockAt.
 *
 * 4. Staking boost query -- getBoostBps(wallet) returns BPS boost based on
 *    CNOVA balance. Applied at withdrawal time by FigureEightMatrixV8.
 *
 * 5. mintDirectAdmin() -- DEFAULT_ADMIN_ROLE, bypasses vesting.
 *
 * Tokenomics (Proof of Participation -- no ICO, no presale, no pre-mine):
 *  - Max supply  : 21,000,000 CNOVA
 *  - Decimals    : 18
 *  - Mint access : MINTER_ROLE (matrix contracts)
 *  - Burn access : any holder, plus BURNER_ROLE (Treasury)
 */

/// @notice Minimal interface to read floor price from CNOVATreasury
interface ICNOVATreasury {
    function floorPrice() external view returns (uint256);
}

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract CNOVAToken is ERC20, ERC20Burnable, AccessControl {

    // =========================================================================
    // Roles
    // =========================================================================

    bytes32 public constant MINTER_ROLE   = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE   = keccak256("BURNER_ROLE");
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // =========================================================================
    // Supply cap
    // =========================================================================

    uint256 public constant MAX_SUPPLY = 21_000_000 * 1e18;

    // =========================================================================
    // Tier multipliers  (index 0 = T1 ... index 6 = T7)
    // =========================================================================

    uint256[7] public tierMultipliers = [1, 2, 4, 8, 20, 40, 80];

    // =========================================================================
    // Epoch configuration
    // =========================================================================

    uint8 public constant TOTAL_EPOCHS = 9;

    // --- Trigger A: CNOVA minted per epoch ---
    // Default: 1,000,000 CNOVA. Protects against T7-heavy activity burning
    // through supply without advancing the epoch counter.
    // At T7 epoch-1: fires after just 250 entries (4000 CNOVA each).
    // At T1 epoch-1: fires after 20,000 entries (50 CNOVA each).
    // DAO can lower this to tighten halvings or raise it to extend each epoch.
    uint256 public epochMintLimit = 1_000_000 * 1e18;  // governable

    // --- Trigger B: Unique member registrations per epoch ---
    // Default: 10,000 unique registrations. Classic growth-based trigger.
    // Works well when most activity is T1-T3 where each entry mints < 200 CNOVA.
    // DAO can set to 14 for testnet (shows all 9 epochs in one fill cycle).
    uint256 public epochMemberLimit = 10_000;           // governable

    // --- Trigger C: Time elapsed since epoch start ---
    // Default: 30 days. Slow-start protection.
    // Epoch advances even with zero activity after this window.
    // Early adopters always have the advantage of having joined during a
    // higher-reward epoch -- even if the advance was time-triggered.
    uint256 public epochTimeLimit = 30 days;            // governable

    // --- Trigger type constants (emitted in EpochAdvanced event) ---
    uint8 public constant TRIGGER_MINT   = 0;  // mint limit reached
    uint8 public constant TRIGGER_MEMBER = 1;  // member count reached
    uint8 public constant TRIGGER_TIME   = 2;  // time limit elapsed

    // V8.1 base rewards per entry (before tier multiplier).
    // Epoch 9 = Final Frontier -- floor-price formula overrides index [8].
    uint256[9] public epochRewards = [
        50 * 1e18,   // Epoch 1 -- Nebula Genesis
        25 * 1e18,   // Epoch 2 -- Mercury Rise
        12 * 1e18,   // Epoch 3 -- Lunar Cluster
         6 * 1e18,   // Epoch 4 -- Aurora Zenith
         3 * 1e18,   // Epoch 5 -- Solaris Echo
         2 * 1e18,   // Epoch 6 -- Cosmic Core
         1 * 1e18,   // Epoch 7 -- Galaxy Grid
         1 * 1e18,   // Epoch 8 -- Supernova Spark
         1 * 1e18    // Epoch 9 -- Final Frontier (formula replaces this)
    ];

    // =========================================================================
    // Final Frontier (epoch 9) formula constants
    // =========================================================================

    uint256 public constant MAX_FF_REWARD      = 25 * 1e17;   // 2.5 CNOVA cap
    uint256 public constant TREASURY_PER_ENTRY = 1_500_000;   // $1.50 in 6-dec USDC
    uint256 public constant REWARD_PCT_MIN     = 10;
    uint256 public constant REWARD_PCT_MAX     = 75;
    uint256 public rewardPct                   = 25;          // governable

    // =========================================================================
    // Vesting (cliff vest per earn event)
    // =========================================================================

    struct VestBatch {
        uint128 amount;    // CNOVA locked (18-dec)
        uint128 unlockAt;  // unix timestamp -- transferable after this
    }

    mapping(address => VestBatch[]) private _vestBatches;
    uint256 public vestDuration   = 180 days;   // governable
    uint256 public constant MAX_VEST_BATCHES = 200;

    // =========================================================================
    // Staking boost lookup (DAO-adjustable via GOVERNOR_ROLE)
    // =========================================================================

    uint256[] public boostThresholds;
    uint256[] public boostRates;

    // =========================================================================
    // Treasury reference (Final Frontier floor-price minting)
    // =========================================================================

    ICNOVATreasury public treasuryRef;

    // =========================================================================
    // Epoch state
    // =========================================================================

    uint8   public currentEpoch;
    uint256 public epochMemberCount;  // unique registrations since last advance
    uint256 public epochStartTime;    // timestamp of last epoch advance
    uint256 public epochStartMinted;  // totalMinted at last epoch advance
    uint256 public totalMinted;

    // =========================================================================
    // Events
    // =========================================================================

    event TokensMinted(address indexed to, uint256 amount, uint8 epoch, uint8 tierIndex);
    event TokensBurnedByRole(address indexed from, uint256 amount);
    event EpochAdvanced(uint8 indexed newEpoch, uint256 timestamp, uint8 trigger);
    event RewardPctUpdated(uint256 oldPct, uint256 newPct);
    event EpochMintLimitUpdated(uint256 newLimit);
    event EpochMemberLimitUpdated(uint256 newLimit);
    event EpochTimeLimitUpdated(uint256 newLimit);
    event VestDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event BoostTableUpdated(uint256[] thresholds, uint256[] rates);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address admin) ERC20("CryptoNova", "CNOVA") {
        require(admin != address(0), "CNOVA: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        currentEpoch      = 0;
        epochStartTime    = block.timestamp;
        epochStartMinted  = 0;
        epochMemberCount  = 0;
        totalMinted       = 0;

        // Default boost table (DAO can replace via setBoostTable)
        boostThresholds.push(100    * 1e18);
        boostThresholds.push(500    * 1e18);
        boostThresholds.push(1_000  * 1e18);
        boostThresholds.push(5_000  * 1e18);
        boostThresholds.push(10_000 * 1e18);
        boostRates.push(500);    // +5%
        boostRates.push(1000);   // +10%
        boostRates.push(1500);   // +15%
        boostRates.push(2500);   // +25%
        boostRates.push(4000);   // +40%
    }

    // =========================================================================
    // Admin setters
    // =========================================================================

    /// @notice Override epoch member limit. Set to 14 for 127-member testnet.
    function setEpochMemberLimit(uint256 limit)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(limit >= 1 && limit <= 10_000, "CNOVA: limit out of range");
        epochMemberLimit = limit;
        emit EpochMemberLimitUpdated(limit);
    }

    /// @notice Set the CNOVATreasury reference for Final Frontier minting.
    function setTreasuryRef(address _treasury)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(_treasury != address(0), "CNOVA: zero treasury");
        treasuryRef = ICNOVATreasury(_treasury);
    }

    // =========================================================================
    // Governance setters (GOVERNOR_ROLE -- callable by V8Governance after vote)
    // =========================================================================

    /// @notice Update Final Frontier reward percentage (range 10-75).
    function setRewardPct(uint256 pct) external onlyRole(GOVERNOR_ROLE) {
        require(pct >= REWARD_PCT_MIN && pct <= REWARD_PCT_MAX, "CNOVA: pct out of range");
        uint256 old = rewardPct;
        rewardPct = pct;
        emit RewardPctUpdated(old, pct);
    }

    /**
     * @notice Set the CNOVA-minted-per-epoch trigger.
     *         Lower = faster halvings (tighter supply). Higher = longer epochs.
     *         Minimum 100,000 CNOVA (prevents trivial advance).
     *         Maximum 5,000,000 CNOVA (one epoch can't exceed 5M minted).
     */
    function setEpochMintLimit(uint256 limit) external onlyRole(GOVERNOR_ROLE) {
        require(
            limit >= 100_000 * 1e18 && limit <= 5_000_000 * 1e18,
            "CNOVA: mint limit out of range"
        );
        epochMintLimit = limit;
        emit EpochMintLimitUpdated(limit);
    }

    /**
     * @notice Set the unique-members-per-epoch trigger.
     *         Range: 100 to 100,000 members.
     */
    function setEpochMemberLimitGov(uint256 limit) external onlyRole(GOVERNOR_ROLE) {
        require(limit >= 100 && limit <= 100_000, "CNOVA: limit out of range");
        epochMemberLimit = limit;
        emit EpochMemberLimitUpdated(limit);
    }

    /**
     * @notice Set the time-based epoch trigger.
     *         Minimum 7 days (prevents manipulation). Maximum 365 days.
     *         Slow-start safety: even with zero activity, epoch advances after
     *         this window, protecting early adopters' reward advantage.
     */
    function setEpochTimeLimit(uint256 newLimit) external onlyRole(GOVERNOR_ROLE) {
        require(
            newLimit >= 7 days && newLimit <= 365 days,
            "CNOVA: time limit out of range"
        );
        epochTimeLimit = newLimit;
        emit EpochTimeLimitUpdated(newLimit);
    }

    /**
     * @notice Update the cliff vest duration for future mints.
     *         Does NOT retroactively change existing vest batches.
     *         Range: 1 day to 730 days (2 years).
     */
    function setVestDuration(uint256 newDuration) external onlyRole(GOVERNOR_ROLE) {
        require(
            newDuration >= 1 days && newDuration <= 730 days,
            "CNOVA: duration out of range"
        );
        uint256 old = vestDuration;
        vestDuration = newDuration;
        emit VestDurationUpdated(old, newDuration);
    }

    /**
     * @notice Replace the staking boost lookup table.
     *         thresholds must be strictly ascending. Pass empty arrays to disable.
     */
    function setBoostTable(
        uint256[] calldata thresholds,
        uint256[] calldata rates
    ) external onlyRole(GOVERNOR_ROLE) {
        require(thresholds.length == rates.length, "CNOVA: length mismatch");
        for (uint256 i = 1; i < thresholds.length; i++) {
            require(thresholds[i] > thresholds[i-1], "CNOVA: thresholds not ascending");
        }
        for (uint256 i = 0; i < rates.length; i++) {
            require(rates[i] <= 10_000, "CNOVA: rate exceeds 100%");
        }
        delete boostThresholds;
        delete boostRates;
        for (uint256 i = 0; i < thresholds.length; i++) {
            boostThresholds.push(thresholds[i]);
            boostRates.push(rates[i]);
        }
        emit BoostTableUpdated(thresholds, rates);
    }

    // =========================================================================
    // Minting
    // =========================================================================

    /**
     * @notice Mint CNOVA reward to a member, applying the tier multiplier.
     *         Tokens are cliff-vested for vestDuration.
     *
     *         Epochs 1-8 : base x tierMultipliers[tierIndex]
     *         Epoch 9 (Final Frontier) : floor-price formula x multiplier
     *
     * @param  to         Recipient address.
     * @param  tierIndex  0 = T1 ... 6 = T7.
     * @return amount     CNOVA minted (0 if cap reached or all epochs done).
     */
    function mintReward(address to, uint8 tierIndex)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 amount)
    {
        require(tierIndex < 7, "CNOVA: invalid tier");
        _tryAdvanceEpoch();
        if (currentEpoch >= TOTAL_EPOCHS) return 0;

        // Compute base reward
        uint256 base;
        bool isFinalFrontier = (currentEpoch == TOTAL_EPOCHS - 1);

        if (isFinalFrontier && address(treasuryRef) != address(0)) {
            uint256 floor = treasuryRef.floorPrice();
            if (floor == 0) {
                base = epochRewards[currentEpoch];
            } else {
                base = (rewardPct * TREASURY_PER_ENTRY * 1e18) / (100 * floor);
                if (base > MAX_FF_REWARD) base = MAX_FF_REWARD;
            }
        } else {
            base = epochRewards[currentEpoch];
        }

        // Apply tier multiplier
        amount = base * tierMultipliers[tierIndex];

        // Hard cap
        if (totalMinted + amount > MAX_SUPPLY) {
            amount = MAX_SUPPLY - totalMinted;
        }
        if (amount == 0) return 0;

        totalMinted      += amount;
        epochMemberCount += 1;

        _mintVested(to, amount);
        emit TokensMinted(to, amount, currentEpoch + 1, tierIndex);
        return amount;
    }

    /**
     * @notice Mint exact amount to `to`, cliff-vested. For tier-upgrade bonuses.
     *         Does NOT increment epochMemberCount.
     */
    function mintDirect(address to, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 minted)
    {
        require(to != address(0), "CNOVA: zero recipient");
        if (amount == 0) return 0;
        if (totalMinted + amount > MAX_SUPPLY) amount = MAX_SUPPLY - totalMinted;
        if (amount == 0) return 0;
        totalMinted += amount;
        _mintVested(to, amount);
        emit TokensMinted(to, amount, currentEpoch + 1, 0);
        return amount;
    }

    /**
     * @notice Mint exact amount WITHOUT vesting. DEFAULT_ADMIN_ROLE only.
     *         Use for treasury seeding / testnet tooling. NOT for matrix rewards.
     */
    function mintDirectAdmin(address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 minted)
    {
        require(to != address(0), "CNOVA: zero recipient");
        if (amount == 0) return 0;
        if (totalMinted + amount > MAX_SUPPLY) amount = MAX_SUPPLY - totalMinted;
        if (amount == 0) return 0;
        totalMinted += amount;
        _mint(to, amount);
        emit TokensMinted(to, amount, currentEpoch + 1, 0);
        return amount;
    }

    // =========================================================================
    // Burning
    // =========================================================================

    /**
     * @notice Burn tokens. BURNER_ROLE bypasses allowance (Treasury buyback-burn).
     *         Vesting lock still applies -- only unlocked tokens can be burned.
     */
    function burnFrom(address from, uint256 amount)
        public
        override(ERC20Burnable)
    {
        if (hasRole(BURNER_ROLE, msg.sender)) {
            _burn(from, amount);
            emit TokensBurnedByRole(from, amount);
        } else {
            super.burnFrom(from, amount);
        }
    }

    // =========================================================================
    // Vesting enforcement
    // =========================================================================

    /// @notice Total locked (non-transferable) CNOVA for `wallet`.
    function lockedBalanceOf(address wallet) public view returns (uint256 locked) {
        VestBatch[] storage batches = _vestBatches[wallet];
        uint256 len = batches.length;
        for (uint256 i = 0; i < len; i++) {
            if (block.timestamp < batches[i].unlockAt) {
                locked += batches[i].amount;
            }
        }
    }

    /// @notice Transferable (unlocked) CNOVA balance.
    function unlockedBalanceOf(address wallet) external view returns (uint256) {
        uint256 total  = balanceOf(wallet);
        uint256 locked = lockedBalanceOf(wallet);
        return total > locked ? total - locked : 0;
    }

    /// @notice All vest batches for `wallet` (for UI display).
    function vestBatchesOf(address wallet)
        external view returns (VestBatch[] memory)
    {
        return _vestBatches[wallet];
    }

    /// @notice Remove expired vest batches (gas refund). Permissionless.
    function pruneVestBatches(address wallet) external {
        VestBatch[] storage batches = _vestBatches[wallet];
        uint256 i = 0;
        while (i < batches.length) {
            if (block.timestamp >= batches[i].unlockAt) {
                batches[i] = batches[batches.length - 1];
                batches.pop();
            } else {
                i++;
            }
        }
    }

    /// @dev Internal: mint tokens and add vest batch.
    function _mintVested(address to, uint256 amount) internal {
        require(to != address(0), "CNOVA: zero address");
        VestBatch[] storage batches = _vestBatches[to];
        if (batches.length >= MAX_VEST_BATCHES) {
            bool pruned = false;
            for (uint256 i = 0; i < batches.length && !pruned; i++) {
                if (block.timestamp >= batches[i].unlockAt) {
                    batches[i] = batches[batches.length - 1];
                    batches.pop();
                    pruned = true;
                }
            }
            require(pruned, "CNOVA: vest batch limit reached");
        }
        batches.push(VestBatch({
            amount:   uint128(amount),
            unlockAt: uint128(block.timestamp + vestDuration)
        }));
        _mint(to, amount);
    }

    /**
     * @dev ERC20 transfer hook. Enforces vesting on wallet-to-wallet transfers.
     *      Mints (from==0) and burns (to==0) bypass the check.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 locked    = lockedBalanceOf(from);
            uint256 available = balanceOf(from) > locked ? balanceOf(from) - locked : 0;
            require(available >= value, "CNOVA: tokens vesting -- wait for unlock");
        }
        super._update(from, to, value);
    }

    // =========================================================================
    // Staking boost query
    // =========================================================================

    /**
     * @notice Returns the BPS boost `wallet` earns based on total CNOVA held.
     *         Called by FigureEightMatrixV8 at withdrawal time:
     *           payout = baseWithdrawable * (10000 + getBoostBps(member)) / 10000
     * @return bps  e.g. 500 = +5% on all USDC earnings.
     */
    function getBoostBps(address wallet) external view returns (uint256 bps) {
        uint256 held = balanceOf(wallet);
        uint256 len  = boostThresholds.length;
        for (uint256 i = 0; i < len; i++) {
            if (held >= boostThresholds[i]) {
                bps = boostRates[i];
            } else {
                break;
            }
        }
    }

    // =========================================================================
    // Epoch management
    // =========================================================================

    /**
     * @dev Triple-trigger epoch advance. Fires on whichever condition hits first:
     *
     *   TRIGGER_MINT   (0) -- too much CNOVA minted this epoch (T7 protection)
     *   TRIGGER_MEMBER (1) -- enough unique members registered
     *   TRIGGER_TIME   (2) -- time window elapsed (slow-start protection)
     *
     *  All three are DAO-adjustable. Emit includes which trigger fired so
     *  explorers and frontends can explain the halving to members.
     */
    function _tryAdvanceEpoch() internal {
        if (currentEpoch >= TOTAL_EPOCHS - 1) return;

        bool mintTrigger   = (totalMinted - epochStartMinted) >= epochMintLimit;
        bool memberTrigger = epochMemberCount >= epochMemberLimit;
        bool timeTrigger   = block.timestamp >= epochStartTime + epochTimeLimit;

        if (!mintTrigger && !memberTrigger && !timeTrigger) return;

        uint8 trigger = mintTrigger   ? TRIGGER_MINT
                      : memberTrigger ? TRIGGER_MEMBER
                      :                 TRIGGER_TIME;

        currentEpoch     += 1;
        epochMemberCount  = 0;
        epochStartTime    = block.timestamp;
        epochStartMinted  = totalMinted;

        emit EpochAdvanced(currentEpoch + 1, block.timestamp, trigger);
    }

    /// @notice Force-advance epoch (admin safety valve).
    function forceAdvanceEpoch() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(currentEpoch < TOTAL_EPOCHS - 1, "CNOVA: already at Final Frontier");
        currentEpoch     += 1;
        epochMemberCount  = 0;
        epochStartTime    = block.timestamp;
        epochStartMinted  = totalMinted;
        emit EpochAdvanced(currentEpoch + 1, block.timestamp, TRIGGER_TIME);
    }

    // =========================================================================
    // View helpers
    // =========================================================================

    /// @notice Returns 1-9. Epoch 9 = Final Frontier.
    function currentEpochNumber() external view returns (uint8) {
        return currentEpoch >= TOTAL_EPOCHS ? TOTAL_EPOCHS : currentEpoch + 1;
    }

    /// @notice Base reward for current epoch (before tier multiplier).
    function currentBaseRewardPerEntry() external view returns (uint256) {
        if (currentEpoch >= TOTAL_EPOCHS) return 0;
        return epochRewards[currentEpoch];
    }

    /// @notice Full reward for a tier in the current epoch.
    function currentRewardForTier(uint8 tierIndex) external view returns (uint256) {
        if (tierIndex >= 7 || currentEpoch >= TOTAL_EPOCHS) return 0;
        return epochRewards[currentEpoch] * tierMultipliers[tierIndex];
    }

    function isFinalFrontier() external view returns (bool) {
        return currentEpoch == TOTAL_EPOCHS - 1;
    }

    function remainingMintableSupply() external view returns (uint256) {
        return MAX_SUPPLY > totalMinted ? MAX_SUPPLY - totalMinted : 0;
    }

    /// @notice How much CNOVA has been minted in the current epoch so far.
    function epochMintedSoFar() external view returns (uint256) {
        return totalMinted - epochStartMinted;
    }

    /// @notice How much CNOVA remains before the mint trigger fires.
    function epochMintRemaining() external view returns (uint256) {
        uint256 minted = totalMinted - epochStartMinted;
        return minted >= epochMintLimit ? 0 : epochMintLimit - minted;
    }

    function epochTimeRemaining() external view returns (uint256) {
        uint256 expiry = epochStartTime + epochTimeLimit;
        return block.timestamp >= expiry ? 0 : expiry - block.timestamp;
    }

    function epochMembersRemaining() external view returns (uint256) {
        return epochMemberCount >= epochMemberLimit
            ? 0
            : epochMemberLimit - epochMemberCount;
    }

    /**
     * @notice Returns which trigger is closest to firing.
     *         0 = mint closest, 1 = member closest, 2 = time closest.
     *         Useful for frontends showing "epoch progress" bars.
     */
    function epochLeadingTrigger() external view returns (uint8) {
        uint256 mintPct   = (totalMinted - epochStartMinted) * 10_000 / epochMintLimit;
        uint256 memberPct = epochMemberCount * 10_000 / epochMemberLimit;
        uint256 elapsed   = block.timestamp > epochStartTime
                            ? block.timestamp - epochStartTime : 0;
        uint256 timePct   = elapsed * 10_000 / epochTimeLimit;

        if (mintPct >= memberPct && mintPct >= timePct)   return TRIGGER_MINT;
        if (memberPct >= mintPct && memberPct >= timePct) return TRIGGER_MEMBER;
        return TRIGGER_TIME;
    }
}
