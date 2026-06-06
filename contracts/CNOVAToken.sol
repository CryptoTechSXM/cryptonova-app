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
 * 2. Cliff vesting    -- every mint locks tokens in the recipient wallet for
 *    vestDuration (default 6 months). Tokens appear in balanceOf() (so they
 *    count for governance votes and staking boost) but are non-transferable
 *    until unlockAt. Multiple earn events each get an independent cliff.
 *    CNOVA purchased on DEX carries no lock (unlocked at time of purchase).
 *
 * 3. Staking boost query -- getBoostBps(wallet) returns the BPS boost the
 *    wallet is entitled to based on its total CNOVA balance (locked + unlocked).
 *    Applied at withdrawal time by FigureEightMatrixV8 -- CNOVAToken only
 *    stores and exposes the lookup table; enforcement is in the matrix.
 *
 * 4. Updated epoch halving schedule -- V8.1: 50->25->12->6->3->2->1->1->FF
 *    (base, before tier multiplier). T7 epoch-1 earns 50*80 = 4,000 CNOVA.
 *
 * 5. mintDirectAdmin() -- DEFAULT_ADMIN_ROLE, bypasses vesting. Used for
 *    treasury seeding / testnet tooling. Regular mintDirect() vests.
 *
 * Unchanged from V7
 * -----------------
 * - 21M hard cap, AccessControl roles, epoch member/time triggers
 * - Final Frontier (epoch 9) floor-price-aware formula
 * - forceAdvanceEpoch(), burnFrom(), all view helpers
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

    uint8   public constant TOTAL_EPOCHS     = 9;
    uint256 public epochMemberLimit          = 10_000;   // admin-settable
    uint256 public constant EPOCH_TIME_LIMIT = 30 days;

    /// @dev V8.1 base rewards per entry (before tier multiplier applied).
    ///      Epoch 9 = Final Frontier -- floor-price formula overrides index [8].
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

    /// @dev reward = min(MAX_FF_REWARD, rewardPct% x TREASURY_PER_ENTRY x 1e18 / floor)
    uint256 public constant MAX_FF_REWARD      = 25 * 1e17;   // 2.5 CNOVA (cap)
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

    /// @notice How long newly minted CNOVA is locked (DAO-adjustable).
    uint256 public vestDuration = 180 days;

    /// @notice Hard cap on vest batches per address to bound gas.
    uint256 public constant MAX_VEST_BATCHES = 200;

    // =========================================================================
    // Staking boost lookup (DAO-adjustable via GOVERNOR_ROLE)
    // =========================================================================

    /// @dev Parallel arrays: boostThresholds[i] CNOVA held -> boostRates[i] BPS.
    ///      Arrays must have equal length. Thresholds must be strictly ascending.
    uint256[] public boostThresholds;  // CNOVA amount (18-dec)
    uint256[] public boostRates;       // BPS boost at each threshold level

    // =========================================================================
    // Treasury reference (Final Frontier floor-price minting)
    // =========================================================================

    ICNOVATreasury public treasuryRef;

    // =========================================================================
    // Epoch state
    // =========================================================================

    uint8   public currentEpoch;
    uint256 public epochMemberCount;
    uint256 public epochStartTime;
    uint256 public totalMinted;

    // =========================================================================
    // Events
    // =========================================================================

    event TokensMinted(address indexed to, uint256 amount, uint8 epoch, uint8 tierIndex);
    event TokensBurnedByRole(address indexed from, uint256 amount);
    event EpochAdvanced(uint8 indexed newEpoch, uint256 timestamp);
    event RewardPctUpdated(uint256 oldPct, uint256 newPct);
    event EpochMemberLimitUpdated(uint256 newLimit);
    event VestDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event BoostTableUpdated(uint256[] thresholds, uint256[] rates);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address admin) ERC20("CryptoNova", "CNOVA") {
        require(admin != address(0), "CNOVA: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        currentEpoch     = 0;
        epochStartTime   = block.timestamp;
        epochMemberCount = 0;
        totalMinted      = 0;

        // Default boost table (DAO can replace via setBoostTable)
        boostThresholds.push(100  * 1e18);   //    100 CNOVA -> +5%
        boostThresholds.push(500  * 1e18);   //    500 CNOVA -> +10%
        boostThresholds.push(1_000  * 1e18); //  1,000 CNOVA -> +15%
        boostThresholds.push(5_000  * 1e18); //  5,000 CNOVA -> +25%
        boostThresholds.push(10_000 * 1e18); // 10,000 CNOVA -> +40%
        boostRates.push(500);
        boostRates.push(1000);
        boostRates.push(1500);
        boostRates.push(2500);
        boostRates.push(4000);
    }

    // =========================================================================
    // Admin setters
    // =========================================================================

    /// @notice Set how many unique members trigger an epoch advance.
    ///         Set to 14 for 127-member testnet simulation (shows all 9 epochs).
    function setEpochMemberLimit(uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(limit >= 1 && limit <= 10_000, "CNOVA: limit out of range");
        epochMemberLimit = limit;
        emit EpochMemberLimitUpdated(limit);
    }

    /// @notice Set the CNOVATreasury reference used in Final Frontier formula.
    function setTreasuryRef(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
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

    /// @notice Update the cliff vest duration for future mints.
    ///         Does NOT retroactively change existing vest batches.
    /// @param  newDuration  Seconds (min 1 day, max 730 days / 2 years).
    function setVestDuration(uint256 newDuration) external onlyRole(GOVERNOR_ROLE) {
        require(newDuration >= 1 days && newDuration <= 730 days, "CNOVA: duration out of range");
        uint256 old = vestDuration;
        vestDuration = newDuration;
        emit VestDurationUpdated(old, newDuration);
    }

    /// @notice Replace the staking boost lookup table.
    ///         thresholds must be strictly ascending. Arrays must be equal length.
    ///         Pass empty arrays to disable the boost entirely.
    function setBoostTable(uint256[] calldata thresholds, uint256[] calldata rates)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        require(thresholds.length == rates.length, "CNOVA: length mismatch");
        for (uint256 i = 1; i < thresholds.length; i++) {
            require(thresholds[i] > thresholds[i-1], "CNOVA: thresholds not ascending");
        }
        for (uint256 i = 0; i < rates.length; i++) {
            require(rates[i] <= 10_000, "CNOVA: rate > 100%");
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
     *         Minted tokens are cliff-vested for vestDuration.
     *         Epochs 1-8: base * tierMultipliers[tierIndex]
     *         Epoch 9 (Final Frontier): floor-price formula * tierMultipliers[tierIndex]
     * @param  to         Recipient address.
     * @param  tierIndex  0 = T1 ... 6 = T7.
     * @return amount     CNOVA minted (0 if cap reached).
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

        // Enforce hard cap
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
     * @notice Mint an exact amount of CNOVA to `to`, with cliff vesting.
     *         Used for tier-upgrade bonuses and other matrix-activity rewards.
     *         Does NOT increment epochMemberCount.
     */
    function mintDirect(address to, uint256 amount)
        external
        onlyRole(MINTER_ROLE)
        returns (uint256 minted)
    {
        require(to != address(0), "CNOVA: zero recipient");
        if (amount == 0) return 0;
        if (totalMinted + amount > MAX_SUPPLY) {
            amount = MAX_SUPPLY - totalMinted;
        }
        if (amount == 0) return 0;
        totalMinted += amount;
        _mintVested(to, amount);
        emit TokensMinted(to, amount, currentEpoch + 1, 0);
        return amount;
    }

    /**
     * @notice Mint an exact amount WITHOUT vesting lock. DEFAULT_ADMIN_ROLE only.
     *         Use for treasury seeding, testnet tooling, or initial liquidity.
     *         NOT for normal matrix rewards -- use mintReward / mintDirect.
     */
    function mintDirectAdmin(address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 minted)
    {
        require(to != address(0), "CNOVA: zero recipient");
        if (amount == 0) return 0;
        if (totalMinted + amount > MAX_SUPPLY) {
            amount = MAX_SUPPLY - totalMinted;
        }
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
     * @notice Burn tokens. BURNER_ROLE bypasses allowance check (used by Treasury
     *         for buyback-and-burn of DEX-purchased CNOVA).
     *         Vesting check still applies -- only unlocked tokens can be burned.
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

    /**
     * @notice Returns the total locked (non-transferable) CNOVA for `wallet`.
     *         Iterates all vest batches and sums those with unlockAt > now.
     *         O(n) -- typical users have <20 batches. Prune with pruneVestBatches().
     */
    function lockedBalanceOf(address wallet) public view returns (uint256 locked) {
        VestBatch[] storage batches = _vestBatches[wallet];
        uint256 len = batches.length;
        for (uint256 i = 0; i < len; i++) {
            if (block.timestamp < batches[i].unlockAt) {
                locked += batches[i].amount;
            }
        }
    }

    /**
     * @notice Returns transferable (unlocked) CNOVA balance for `wallet`.
     */
    function unlockedBalanceOf(address wallet) external view returns (uint256) {
        uint256 total  = balanceOf(wallet);
        uint256 locked = lockedBalanceOf(wallet);
        return total > locked ? total - locked : 0;
    }

    /**
     * @notice Returns all vest batches for `wallet` (for UI display).
     */
    function vestBatchesOf(address wallet)
        external
        view
        returns (VestBatch[] memory)
    {
        return _vestBatches[wallet];
    }

    /**
     * @notice Remove expired vest batches from storage (gas refund).
     *         Anyone can call for any wallet -- permissionless cleanup.
     */
    function pruneVestBatches(address wallet) external {
        VestBatch[] storage batches = _vestBatches[wallet];
        uint256 i = 0;
        while (i < batches.length) {
            if (block.timestamp >= batches[i].unlockAt) {
                // Swap with last and pop
                batches[i] = batches[batches.length - 1];
                batches.pop();
            } else {
                i++;
            }
        }
    }

    /// @dev Internal: mint tokens AND add a vest batch.
    function _mintVested(address to, uint256 amount) internal {
        require(to != address(0), "CNOVA: zero address");
        VestBatch[] storage batches = _vestBatches[to];
        // Prune one expired batch if at cap (keeps array bounded without hard revert)
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
     * @dev ERC20 transfer hook. Enforces vesting: sender cannot transfer
     *      more than their unlocked balance.
     *      Mints (from == address(0)) and burns (to == address(0)) are exempt
     *      from the check -- the vesting lock only restricts wallet-to-wallet
     *      transfers.
     */
    function _update(address from, address to, uint256 value)
        internal
        override
    {
        if (from != address(0) && to != address(0)) {
            // Normal transfer: check unlocked balance
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
     * @notice Returns the BPS boost `wallet` is entitled to based on its
     *         total CNOVA balance (locked + unlocked).
     *         Returns 0 if wallet holds less than the first threshold.
     *         FigureEightMatrixV8 calls this at withdrawal time:
     *           payout = baseWithdrawable * (10000 + getBoostBps(member)) / 10000
     *
     * @param  wallet  Address to query.
     * @return bps     Boost in basis points (e.g. 500 = +5%).
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

    function _tryAdvanceEpoch() internal {
        if (currentEpoch >= TOTAL_EPOCHS - 1) return;
        bool memberTrigger = epochMemberCount >= epochMemberLimit;
        bool timeTrigger   = block.timestamp >= epochStartTime + EPOCH_TIME_LIMIT;
        if (memberTrigger || timeTrigger) {
            currentEpoch     += 1;
            epochMemberCount  = 0;
            epochStartTime    = block.timestamp;
            emit EpochAdvanced(currentEpoch + 1, block.timestamp);
        }
    }

    /// @notice Force-advance the epoch. Admin safety valve.
    function forceAdvanceEpoch() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(currentEpoch < TOTAL_EPOCHS - 1, "CNOVA: already at Final Frontier");
        currentEpoch    += 1;
        epochMemberCount = 0;
        epochStartTime   = block.timestamp;
        emit EpochAdvanced(currentEpoch + 1, block.timestamp);
    }

    // =========================================================================
    // View helpers
    // =========================================================================

    /// @notice Returns 1-9. Epoch 9 = Final Frontier (never ends until cap hit).
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

    function epochTimeRemaining() external view returns (uint256) {
        uint256 expiry = epochStartTime + EPOCH_TIME_LIMIT;
        return block.timestamp >= expiry ? 0 : expiry - block.timestamp;
    }

    function epochMembersRemaining() external view returns (uint256) {
        return epochMemberCount >= epochMemberLimit
            ? 0
            : epochMemberLimit - epochMemberCount;
    }
}
