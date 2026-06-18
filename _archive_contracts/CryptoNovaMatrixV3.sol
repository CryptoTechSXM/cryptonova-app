// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CryptoNovaMatrixV3
 * @notice Conveyor-belt matrix with dynamic FIFO queue, automatic free re-entry,
 *         rising-floor USDC treasury, and founding-member community pool.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  PAYMENT SPLIT — every ENTRY_FEE USDC new registration
 * ═══════════════════════════════════════════════════════════════════
 *  30% → Referrer bonus
 *  40% → 7-level implicit-tree chain pay
 *              80% of each level → ancestor withdrawable
 *              20% of each level → treasury reserve
 *  15% → USDC treasury reserve (backs CNOVA floor price)
 *  10% → Community wallet (founding member pool)
 *   3% → Dev wallet
 *   2% → Ops wallet
 *  ────────────────────────────────────────────────────
 * 100% TOTAL
 *
 *  Chain pay level fractions of ENTRY_FEE (sum = 40%):
 *    13.3%  8.0%  6.7%  5.3%  3.5%  2.1%  1.1%
 *
 *  Example at $10 entry: $1.33  $0.80  $0.67  $0.53  $0.35  $0.21  $0.11  (sum=$4.00)
 *  Example at $500 entry: $66.50  $40.00  $33.50  $26.50  $17.50  $10.50  $5.50  (sum=$200)
 *
 * ═══════════════════════════════════════════════════════════════════
 *  CONVEYOR BELT MECHANIC
 * ═══════════════════════════════════════════════════════════════════
 *  • 254 active earning positions at any time (after initial fill).
 *  • Members pay $10 ONCE and remain in the queue forever.
 *  • When a new member joins (full matrix):
 *      1. Position-1 member is automatically re-entered at back of
 *         queue — FREE, no payment required.
 *      2. New member is appended one slot behind the re-entrant.
 *      3. Head pointer advances by 1 (O(1)) — everyone moves forward.
 *  • originalReferrer is locked at first registration and used for
 *    the referral-bonus calculation on every future new join.
 *    (Re-entry generates no payment — only new $10 joins pay out.)
 *
 * ═══════════════════════════════════════════════════════════════════
 *  IMPLICIT BINARY TREE (no stored parent/child pointers)
 * ═══════════════════════════════════════════════════════════════════
 *  Ancestor of position p at level k = floor(p / 2^k)
 *    Level 1: p >> 1    Level 5: p >> 5
 *    Level 2: p >> 2    Level 6: p >> 6
 *    Level 3: p >> 3    Level 7: p >> 7
 *    Level 4: p >> 4
 *  Address lookup: queue[head + ancestorPos - 1]   (O(1), no traversal)
 *
 * ═══════════════════════════════════════════════════════════════════
 *  CYCLE TRACKING
 * ═══════════════════════════════════════════════════════════════════
 *  • cyclesCompleted[member] increments each time that member rotates
 *    out from position-1 (completes one full 253-join cycle).
 *  • TierManager reads this to determine upgrade eligibility.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  FOUNDER POOL
 * ═══════════════════════════════════════════════════════════════════
 *  • First 1,000 unique members (by join order) are founders.
 *  • Owner allocates monthly bonus epochs from community wallet.
 *  • Each founder claims their share within 30 days.
 *  • Unclaimed portion sweeps back to community wallet.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CNOVAToken.sol";
import "./CNOVATreasury.sol";

interface ITierManagerAutoUpgrade {
    function tryAutoUpgrade(address member) external;
}

interface ICommunityWallet {
    function deposit(uint256 amount) external;
    function registerFounder(address member) external;
}

contract CryptoNovaMatrixV3 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants & immutables
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice 1 stablecoin unit ($1.00): 1e6 on Base (USDC), 1e18 on BSC (USDT).
    uint256 public immutable UNIT;

    /// @notice Dollar multiplier used at deploy (e.g., 10 for $10, 500 for $500).
    uint256 public immutable FEE_MULTIPLIER;

    uint256 public immutable ENTRY_FEE;         // FEE_MULTIPLIER × UNIT
    uint256 public constant  REENTRY_FEE_BPS = 500; // 5% re-entry fee on rotation (V4)
    uint256 public immutable SPLIT_REFERRER;    // 30% of ENTRY_FEE
    uint256 public immutable SPLIT_RESERVE;     // 15% of ENTRY_FEE
    uint256 public immutable SPLIT_COMMUNITY;   // 10% of ENTRY_FEE
    uint256 public immutable SPLIT_DEV;         //  3% of ENTRY_FEE
    uint256 public immutable SPLIT_OPS;         //  2% of ENTRY_FEE

    uint256 public immutable ACTIVE_WINDOW;  // set in constructor — lightning:2, engine:5, mainnet:50
    uint256 public constant FOUNDERS_MAX  = 1_000;  // founder-pool eligibility cutoff
    uint256 public constant CLAIM_WINDOW  = 30 days;

    /// @dev Chain pay amounts for levels 1-7. Set once in constructor.
    ///      Sum must equal 4 x UNIT.
    uint256[7] private CHAIN_PAY;

    // ─────────────────────────────────────────────────────────────────────────
    // External contracts
    // ─────────────────────────────────────────────────────────────────────────

    IERC20        public immutable usdc;
    CNOVAToken    public immutable cnova;
    CNOVATreasury public immutable treasury;

    address public devWallet;
    address public opsWallet;
    address public communityWallet; // CryptoNovaCommunityWallet + default referrer
    address public tierManagerAddr;  // V5 auto-upgrade

    // ─────────────────────────────────────────────────────────────────────────
    // Queue state
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Grows by 2 on every new join once the matrix is full
    ///      (1 re-entrant appended + 1 new member appended).
    address[] private _queue;

    /// @notice Index into _queue of the current position-1 member (0-based).
    uint256 public head;

    /// @notice Slots filled so far. Reaches ACTIVE_WINDOW and stays there.
    uint256 public occupancy;

    /// @notice Unique member count (each wallet counted once, ever).
    uint256 public totalJoined;

    /// @notice Total rotations that have occurred since deployment.
    uint256 public rotationCount;

    /// @notice Number of complete cycles (rotate out from position 1) per member.
    ///         Incremented each time a member is rotated out from position 1.
    ///         Read by TierManager to determine upgrade eligibility.
    mapping(address => uint256) public cyclesCompleted;

    /// @dev Maps each member address to their current (latest) index in _queue.
    ///      Updated on every re-entry so positionOf() always returns the current slot.
    mapping(address => uint256) private _memberQueueIndex;

    // ─────────────────────────────────────────────────────────────────────────
    // Member data
    // ─────────────────────────────────────────────────────────────────────────

    struct Member {
        uint256 id;               // sequential join number (unique members only)
        address referrer;         // wallet that referred them at registration
        address originalReferrer; // locked at first registration — never changes
        uint256 joinedAt;         // block.timestamp of initial registration
        uint256 withdrawable;     // claimable USDC balance
        uint256 totalEarned;      // lifetime earnings stat (withdrawable + withdrawn)
        uint256 reentryCount;     // how many times they have cycled back
        bool    isRegistered;
    }

    mapping(address => Member)  public members;
    mapping(uint256 => address) public memberById; // join-order ID → wallet

    // ─────────────────────────────────────────────────────────────────────────
    // Authorized registrars
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Contracts permitted to call registerFor() on behalf of members.
    ///         Typically set to the TierManager after deploy.
    mapping(address => bool) public authorizedRegistrars;

    // ─────────────────────────────────────────────────────────────────────────
    // Founder pool
    // ─────────────────────────────────────────────────────────────────────────

    struct FounderEpoch {
        uint256 amountPerFounder; // USDC each founder may claim
        uint256 startTime;        // epoch creation timestamp
        uint256 eligibleCount;    // number of founders at epoch creation time
        uint256 totalClaimed;     // count of founders who have claimed
    }

    uint256 public currentFounderEpoch;
    mapping(uint256 => FounderEpoch)              public founderEpochs;
    mapping(address => mapping(uint256 => bool))  public founderClaimed;

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency pause (new registrations only — re-entry always runs)
    // ─────────────────────────────────────────────────────────────────────────

    bool public paused;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event MemberRegistered(
        address indexed member,
        address indexed referrer,
        uint256 memberId,
        uint256 position,
        uint256 cnovaRewarded
    );

    event MatrixRotation(
        uint256 indexed rotationNumber,
        address indexed rotatedToBack,
        address indexed newJoiner
    );

    event MemberReentered(
        address indexed member,
        uint256 indexed reentryCount,
        uint256 newPosition
    );

    /// @notice Emitted each time a member completes a full cycle (rotates out from position 1).
    event CycleCompleted(
        address indexed member,
        uint256 indexed cycleNumber,
        uint256 totalJoinsThatCycle
    );

    event ChainPayment(
        address indexed recipient,
        uint256 level,
        uint256 amount,
        uint256 joinerPosition,
        uint256 recipientPosition
    );

    event ReferrerBonus(address indexed referrer, address indexed newMember, uint256 amount);
    event EarningsWithdrawn(address indexed member, uint256 amount);

    event FounderEpochCreated(
        uint256 indexed epochId,
        uint256 amountPerFounder,
        uint256 eligibleFounders,
        uint256 totalFunded
    );

    event FounderBonusClaimed(address indexed member, uint256 indexed epochId, uint256 amount);
    event FounderBonusSwept(uint256 indexed epochId, uint256 amount, address indexed to);

    event DevWalletUpdated(address indexed newDev);
    event OpsWalletUpdated(address indexed newOps);
    event CommunityWalletUpdated(address indexed newWallet);
    event AuthorizedRegistrarUpdated(address indexed registrar, bool authorized);
    event MatrixPaused(address indexed by);
    event MatrixUnpaused(address indexed by);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _usdc            USDC token contract (6 decimals on Base).
     * @param _cnova           CNOVAToken contract.
     * @param _treasury        CNOVATreasury contract.
     * @param _devWallet       Dev revenue wallet.
     * @param _opsWallet       Ops revenue wallet.
     * @param _communityWallet CryptoNovaCommunityWallet contract.
     * @param _admin           Contract owner (Ownable2Step).
     * @param _unit            1e6 for Base USDC, 1e18 for BSC USDT.
     * @param _feeMultiplier   Entry fee in whole dollars (e.g., 10 = $10, 500 = $500).
     *                         All payment splits scale proportionally with this value.
     */
    constructor(
        address _usdc,
        address _cnova,
        address _treasury,
        address _devWallet,
        address _opsWallet,
        address _communityWallet,
        address _admin,
        uint256 _unit,
        uint256 _feeMultiplier,
        uint256 _activeWindow
    ) Ownable(_admin) {
        require(_usdc            != address(0), "V3: zero usdc");
        require(_cnova           != address(0), "V3: zero cnova");
        require(_treasury        != address(0), "V3: zero treasury");
        require(_devWallet       != address(0), "V3: zero dev");
        require(_opsWallet       != address(0), "V3: zero ops");
        require(_communityWallet != address(0), "V3: zero community");
        require(_unit >= 1e3 && _unit <= 1e18,  "V3: invalid unit");
        require(_feeMultiplier >= 1 && _feeMultiplier <= 100_000, "V3: invalid fee multiplier");
        require(_activeWindow >= 2 && _activeWindow <= 10_000, "V3: invalid active window");

        usdc            = IERC20(_usdc);
        cnova           = CNOVAToken(_cnova);
        treasury        = CNOVATreasury(_treasury);
        devWallet       = _devWallet;
        opsWallet       = _opsWallet;
        communityWallet = _communityWallet;

        UNIT           = _unit;
        FEE_MULTIPLIER = _feeMultiplier;
        ACTIVE_WINDOW  = _activeWindow;

        // Payment splits scale with fee multiplier (percentages stay constant):
        //   30% referrer + 40% chain pay + 15% treasury + 10% community + 3% dev + 2% ops = 100%
        ENTRY_FEE       = _feeMultiplier * _unit;
        SPLIT_REFERRER  = _feeMultiplier * 3  * _unit / 10;   // 30%
        SPLIT_RESERVE   = _feeMultiplier * 3  * _unit / 20;   // 15% (3/20 = 0.15)
        SPLIT_COMMUNITY = _feeMultiplier * _unit / 10;         // 10%
        SPLIT_DEV       = _feeMultiplier * 3  * _unit / 100;  //  3%
        SPLIT_OPS       = _feeMultiplier * 2  * _unit / 100;  //  2%

        // Chain pay L1-L7: level fractions × entry fee (sum = 40% of ENTRY_FEE)
        // Coefficients in thousandths: [133,80,67,53,35,21,11] → sum=400 → 40%
        CHAIN_PAY[0] = _feeMultiplier * 133 * _unit / 1000;  // L1: 13.3%
        CHAIN_PAY[1] = _feeMultiplier *  80 * _unit / 1000;  // L2:  8.0%
        CHAIN_PAY[2] = _feeMultiplier *  67 * _unit / 1000;  // L3:  6.7%
        CHAIN_PAY[3] = _feeMultiplier *  53 * _unit / 1000;  // L4:  5.3%
        CHAIN_PAY[4] = _feeMultiplier *  35 * _unit / 1000;  // L5:  3.5%
        CHAIN_PAY[5] = _feeMultiplier *  21 * _unit / 1000;  // L6:  2.1%
        CHAIN_PAY[6] = _feeMultiplier *  11 * _unit / 1000;  // L7:  1.1%
        // Ancestor earns: 80% of chain pay = 32%  Treasury from chain pay: 8%
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Modifier
    // ─────────────────────────────────────────────────────────────────────────

    modifier notPaused() {
        require(!paused, "V3: registrations paused");
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // REGISTRATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Join the matrix by paying ENTRY_FEE USDC.
     *         Call this ONCE per wallet — re-entry is automatic and free forever.
     *         Caller must approve this contract for ENTRY_FEE USDC before calling.
     *
     * @param referrer  Address of the member who referred you.
     *                  Pass address(0) for member #1 or as a fallback.
     */
    function register(address referrer) external nonReentrant notPaused {
        require(!members[msg.sender].isRegistered, "V3: already registered");
        usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);
        _processRegistration(msg.sender, referrer, true);
    }

    /**
     * @notice Register `member` via an authorized registrar (e.g., TierManager).
     *         The caller must be in `authorizedRegistrars` and must have approved
     *         this contract for ENTRY_FEE USDC before calling.
     *         CNOVA minting is intentionally skipped — the calling contract
     *         handles its own tier-specific CNOVA award via mintDirect().
     *
     * @param member    Wallet to register (must not already be registered).
     * @param referrer  Referrer address (forwarded from TierManager upgrade call).
     */
    /// @notice TierManager path — skips CNOVA (tier upgrades don't earn join reward).
    function registerFor(address member, address referrer) external nonReentrant notPaused {
        _registerFor(member, referrer, false);
    }

    /// @notice BeltManager path — mints CNOVA (Tier-1 entry deserves the join reward).
    function registerForWithCnova(address member, address referrer, bool mintCnova)
        external nonReentrant notPaused
    {
        _registerFor(member, referrer, mintCnova);
    }

    /// @dev Shared logic for both registerFor paths.
    function _registerFor(address member, address referrer, bool mintCnova) internal {
        require(authorizedRegistrars[msg.sender], "V3: not authorised registrar");
        require(member != address(0),             "V3: zero member");
        require(!members[member].isRegistered,    "V3: already registered");
        usdc.safeTransferFrom(msg.sender, address(this), ENTRY_FEE);
        _processRegistration(member, referrer, mintCnova);
    }

    /**
     * @dev Core registration logic shared by register() and registerFor().
     *      Fee must be in the contract's balance before this is called.
     *
     * @param sender    The wallet being registered.
     * @param referrer  Referrer hint (resolved internally).
     * @param mintCnova If true, calls cnova.mintReward(sender). Skip for registerFor().
     */
    function _processRegistration(
        address sender,
        address referrer,
        bool    mintCnova
    ) internal {
        // Referrer resolution
        address effectiveReferrer;
        if (totalJoined == 0) {
            effectiveReferrer = address(0);
        } else if (referrer != address(0) && members[referrer].isRegistered) {
            effectiveReferrer = referrer;
        } else {
            effectiveReferrer = communityWallet;
        }

        // Record member
        totalJoined += 1;
        uint256 memberId = totalJoined;

        members[sender] = Member({
            id:               memberId,
            referrer:         effectiveReferrer,
            originalReferrer: effectiveReferrer,
            joinedAt:         block.timestamp,
            withdrawable:     0,
            totalEarned:      0,
            reentryCount:     0,
            isRegistered:     true
        });
        memberById[memberId] = sender;

        // Register as founder in CommunityWallet (no-op after slots fill)
        try ICommunityWallet(communityWallet).registerFounder(sender) {} catch {}

        // Place in queue
        uint256 position = _enqueue(sender);

        // Distribute payments
        _distributePayments(sender, effectiveReferrer, position);

        // Mint CNOVA reward (direct register only; registerFor skips this)
        uint256 cnovaRewarded = 0;
        if (mintCnova) {
            cnovaRewarded = cnova.mintReward(sender);
        }

        emit MemberRegistered(sender, effectiveReferrer, memberId, position, cnovaRewarded);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // QUEUE MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Append `member` to the queue.
     *
     *  Initial fill (occupancy < 254):
     *    Simple push — member goes to next empty slot.
     *
     *  Full matrix (occupancy == 254):
     *    Position-1 member auto re-entered at back, head advances by 1,
     *    new member appended one slot behind the re-entrant.
     *
     * @return position  1-based queue position of the newly placed member.
     */
    function _enqueue(address member) internal returns (uint256 position) {
        if (occupancy < ACTIVE_WINDOW) {
            // INITIAL FILL
            _queue.push(member);
            _memberQueueIndex[member] = _queue.length - 1;
            occupancy += 1;
            position = _queue.length; // = occupancy (1-based)
        } else {
            // ROTATION
            address rotatedOut = _queue[head];

            head         += 1;
            rotationCount += 1;

            // Re-enter the rotated member at the back (free, automatic)
            _queue.push(rotatedOut);
            _memberQueueIndex[rotatedOut] = _queue.length - 1;
            members[rotatedOut].reentryCount += 1;

            // V4: Re-entry fee on every rotation
            {
                uint256 rfee = ENTRY_FEE * REENTRY_FEE_BPS / 10_000;
                if (rfee > 0 && members[rotatedOut].withdrawable >= rfee) {
                    members[rotatedOut].withdrawable -= rfee;
                    // Deduct from USDC held in contract (already there from earnings)
                    uint256 toTr = rfee * 70 / 100;
                    uint256 toRf = rfee * 20 / 100;
                    usdc.safeTransfer(address(treasury), toTr);  // push, no approval needed
                    treasury.recordDirectDeposit(toTr);
                    _creditMember(members[rotatedOut].originalReferrer, toRf);
                    usdc.safeTransfer(devWallet, rfee - toTr - toRf);
                }
            }

            // Cycle completed — rotatedOut has exited position 1
            cyclesCompleted[rotatedOut] += 1;

            // V4: C+E hybrid CNOVA minting on re-entry (epoch-aware, if floor >= $0.10)
            {
                uint256 floorNow = treasury.floorPrice();
                uint256 minFloor = 100_000; // $0.10 in 6-dec USDC
                if (floorNow >= minFloor) {
                    uint8 tierNum = 1; // V4 TODO: pass tier dynamically
                    // Base C+E calculation
                    uint256 cOption = (ENTRY_FEE * 500 / 10_000) / 1e6 * 1e18; // 1 CNOVA per $1 re-entry fee
                    uint256 eOption = uint256(tierNum) * 2 * 1e18;              // tier * 2
                    uint256 baseAmt = cOption > eOption ? cOption : eOption;
                    // Epoch scaling: multiply by (currentEpochReward / epoch1Reward)
                    // epoch1Reward = 50e18; currentEpochReward from cnova.currentRewardPerEntry()
                    uint256 epochReward = cnova.currentRewardPerEntry();
                    uint256 mintAmt = epochReward > 0
                        ? baseAmt * epochReward / (50 * 1e18)
                        : 0;
                    if (mintAmt > 0) {
                        cnova.mintDirect(rotatedOut, mintAmt);
                    }
                }
            }

            emit CycleCompleted(rotatedOut, cyclesCompleted[rotatedOut], ACTIVE_WINDOW - 1);

            // V5: Auto-upgrade — silently attempt upgrade if member opted in
            if (tierManagerAddr != address(0)) {
                try ITierManagerAutoUpgrade(tierManagerAddr).tryAutoUpgrade(rotatedOut) {} catch {}
            }

            uint256 reentryPos = _queue.length - head;
            emit MemberReentered(rotatedOut, members[rotatedOut].reentryCount, reentryPos);
            emit MatrixRotation(rotationCount, rotatedOut, member);

            // Append new member one slot behind the re-entrant
            _queue.push(member);
            _memberQueueIndex[member] = _queue.length - 1;
            position = _queue.length - head;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAYMENT DISTRIBUTION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Distribute the $10 entry fee.
     *
     *  $3.00 → referrer bonus                (30%)
     *  $4.00 → 7-level chain pay             (40%)
     *  $1.50 → treasury reserve              (15%)
     *  $1.00 → community wallet              (10%)
     *  $0.30 → dev wallet                    ( 3%)
     *  $0.20 → ops wallet                    ( 2%)
     */
    function _distributePayments(
        address newMember,
        address referrer,
        uint256 joinerPosition
    ) internal {
        // 1. Referrer bonus ($3.00)
        _creditMember(referrer, SPLIT_REFERRER);
        emit ReferrerBonus(referrer, newMember, SPLIT_REFERRER);

        // 2. Chain pay ($4.00 across 7 implicit tree levels)
        _distributeChainPay(joinerPosition);

        // 3. Treasury reserve — direct $1.50
        SafeERC20.forceApprove(usdc, address(treasury), SPLIT_RESERVE);
        treasury.depositReserve(SPLIT_RESERVE);

        // 4. Community wallet — $1.00 (via deposit() so pendingPool is tracked)
        SafeERC20.forceApprove(usdc, communityWallet, SPLIT_COMMUNITY);
        ICommunityWallet(communityWallet).deposit(SPLIT_COMMUNITY);

        // 5. Dev wallet — $0.30
        usdc.safeTransfer(devWallet, SPLIT_DEV);

        // 6. Ops wallet — $0.20
        usdc.safeTransfer(opsWallet, SPLIT_OPS);
    }

    /**
     * @dev Distribute chain pay from a new joiner at `joinerPosition`.
     *
     *  Ancestor at level k = joinerPosition >> k (floor(p / 2^k)).
     *  80% of each level amount → ancestor.withdrawable
     *  20% of each level amount → treasury (batched for gas)
     *
     * SCALING FIX: Once the matrix is full, the raw queue position of a new
     * joiner grows unboundedly (255, 256, 257...). Left uncapped, ancestor
     * pointers escape the active window and chain pay silently misses members.
     *
     * Fix: normalise to ACTIVE_WINDOW + 1 (= 101) when matrix is full.
     * At position 255 all 7 ancestors land within positions 1-127 (active).
     */
    function _distributeChainPay(uint256 joinerPosition) internal {
        // Normalise position when matrix is full to keep ancestors in active window
        if (joinerPosition > ACTIVE_WINDOW + 1) {
            joinerPosition = ACTIVE_WINDOW + 1;
        }

        uint256 treasuryAccum = 0;
        uint256 devAccum      = 0;  // ramp-up ancestor share → dev wallet

        for (uint8 level = 1; level <= 7; level++) {
            uint256 total      = CHAIN_PAY[level - 1];
            uint256 toTreasury = total / 5;          // 20%
            uint256 toEarn     = total - toTreasury; // 80%

            uint256 ancestorPos = joinerPosition >> level;

            if (ancestorPos == 0) {
                // No ancestor — ramp-up. V4: only L7 goes to treasury; L1-L6 stay with dev.
                treasuryAccum += toTreasury;
                if (level == 7) treasuryAccum += toEarn;
                else            devAccum      += toEarn;
                continue;
            }

            uint256 ancestorIdx = head + ancestorPos - 1;

            if (ancestorIdx >= _queue.length) {
                treasuryAccum += toTreasury;
                if (level == 7) treasuryAccum += toEarn;
                else            devAccum      += toEarn;
                continue;
            }

            address ancestor = _queue[ancestorIdx];

            if (!members[ancestor].isRegistered) {
                treasuryAccum += toTreasury;
                if (level == 7) treasuryAccum += toEarn;
                else            devAccum      += toEarn;
                continue;
            }

            members[ancestor].withdrawable += toEarn;
            members[ancestor].totalEarned  += toEarn;
            treasuryAccum += toTreasury;

            emit ChainPayment(ancestor, level, toEarn, joinerPosition, ancestorPos);
        }

        if (treasuryAccum > 0) {
            SafeERC20.forceApprove(usdc, address(treasury), treasuryAccum);
            treasury.depositReserve(treasuryAccum);
        }

        if (devAccum > 0) {
            usdc.safeTransfer(devWallet, devAccum);
        }
    }

    /**
     * @dev Credit `amount` to `recipient`'s withdrawable balance.
     *      Falls back to opsWallet if recipient is not a registered member.
     */
    function _creditMember(address recipient, uint256 amount) internal {
        if (recipient != address(0) && members[recipient].isRegistered) {
            members[recipient].withdrawable += amount;
            members[recipient].totalEarned  += amount;
        } else if (recipient == communityWallet) {
            usdc.safeTransfer(communityWallet, amount);
        } else {
            usdc.safeTransfer(opsWallet, amount);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WITHDRAWALS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw all claimable USDC earnings.
     */
    function withdraw() external nonReentrant {
        address sender = msg.sender;
        uint256 amount = members[sender].withdrawable;
        require(amount > 0, "V3: nothing to withdraw");

        members[sender].withdrawable = 0;
        usdc.safeTransfer(sender, amount);

        emit EarningsWithdrawn(sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FOUNDER POOL
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Create a new founder bonus epoch. Owner only.
     * @param totalAmount  Total USDC to fund this epoch.
     */
    function allocateFounderBonus(uint256 totalAmount) external onlyOwner nonReentrant {
        require(totalAmount > 0, "V3: zero amount");

        uint256 eligible = totalJoined >= FOUNDERS_MAX ? FOUNDERS_MAX : totalJoined;
        require(eligible > 0, "V3: no founders yet");

        uint256 perFounder  = totalAmount / eligible;
        require(perFounder > 0, "V3: amount too small per founder");

        uint256 actualTotal = perFounder * eligible;

        usdc.safeTransferFrom(msg.sender, address(this), actualTotal);

        currentFounderEpoch += 1;
        founderEpochs[currentFounderEpoch] = FounderEpoch({
            amountPerFounder: perFounder,
            startTime:        block.timestamp,
            eligibleCount:    eligible,
            totalClaimed:     0
        });

        emit FounderEpochCreated(currentFounderEpoch, perFounder, eligible, actualTotal);
    }

    /**
     * @notice Claim founder bonus for a given epoch.
     * @param epochId  The epoch to claim from.
     */
    function claimFounderBonus(uint256 epochId) external nonReentrant {
        address sender = msg.sender;

        require(members[sender].isRegistered,       "V3: not registered");
        require(members[sender].id <= FOUNDERS_MAX, "V3: not a founder");
        require(!founderClaimed[sender][epochId],    "V3: already claimed this epoch");

        FounderEpoch storage epoch = founderEpochs[epochId];
        require(epoch.amountPerFounder > 0,                          "V3: invalid epoch");
        require(block.timestamp <= epoch.startTime + CLAIM_WINDOW,   "V3: claim window closed");

        founderClaimed[sender][epochId] = true;
        epoch.totalClaimed += 1;

        uint256 payout = epoch.amountPerFounder;
        usdc.safeTransfer(sender, payout);

        emit FounderBonusClaimed(sender, epochId, payout);
    }

    /**
     * @notice Sweep unclaimed founder bonus back to communityWallet after window closes.
     * @param epochId  The epoch to sweep.
     */
    function sweepUnclaimedFounderBonus(uint256 epochId) external onlyOwner nonReentrant {
        FounderEpoch storage epoch = founderEpochs[epochId];
        require(epoch.amountPerFounder > 0,                      "V3: invalid epoch");
        require(block.timestamp > epoch.startTime + CLAIM_WINDOW, "V3: window still open");

        uint256 unclaimed   = epoch.eligibleCount - epoch.totalClaimed;
        uint256 sweepAmount = unclaimed * epoch.amountPerFounder;

        if (sweepAmount > 0) {
            usdc.safeTransfer(communityWallet, sweepAmount);
            emit FounderBonusSwept(epochId, sweepAmount, communityWallet);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Current 1-based queue position of `member`.
     */
    function positionOf(address member) public view returns (uint256) {
        require(members[member].isRegistered, "V3: not registered");
        return _memberQueueIndex[member] - head + 1;
    }

    /**
     * @notice Address of the member at a given 1-based position right now.
     */
    function memberAtPosition(uint256 position) public view returns (address) {
        require(position >= 1, "V3: position 0 invalid");
        uint256 idx = head + position - 1;
        require(idx < _queue.length, "V3: position out of range");
        return _queue[idx];
    }

    /**
     * @notice How many new joins until `member` reaches position 1.
     *         Returns 0 if they are already at position 1.
     */
    function movesUntilRoot(address member) public view returns (uint256) {
        uint256 pos = positionOf(member);
        return pos > 1 ? pos - 1 : 0;
    }

    /**
     * @notice True if `member` is currently in the active earning window (positions 1-254).
     */
    function isActive(address member) public view returns (bool) {
        if (!members[member].isRegistered) return false;
        return positionOf(member) <= ACTIVE_WINDOW;
    }

    /**
     * @notice Snapshot of the active queue: addresses at positions 1 through
     *         min(occupancy, ACTIVE_WINDOW), in order.
     */
    function getActiveQueue() public view returns (address[] memory) {
        uint256 len = occupancy < ACTIVE_WINDOW ? occupancy : ACTIVE_WINDOW;
        address[] memory result = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = _queue[head + i];
        }
        return result;
    }

    /**
     * @notice Total entries in the internal queue array.
     */
    function queueLength() public view returns (uint256) {
        return _queue.length;
    }

    /**
     * @notice Full Member struct for a given address.
     */
    function getMember(address member) external view returns (Member memory) {
        return members[member];
    }

    /**
     * @notice Claimable USDC balance of `member`.
     */
    function withdrawableBalance(address member) external view returns (uint256) {
        return members[member].withdrawable;
    }

    /**
     * @notice CNOVA floor price from the treasury.
     */
    function cnovaFloorPrice() external view returns (uint256) {
        return treasury.floorPrice();
    }

    /**
     * @notice Top-level matrix statistics.
     */
    function matrixStats() external view returns (
        uint256 _totalJoined,
        uint256 _rotationCount,
        uint256 _occupancy,
        uint256 _queueLen,
        uint256 _headIndex
    ) {
        return (totalJoined, rotationCount, occupancy, _queue.length, head);
    }

    /**
     * @notice Standard IMatrixMemberCount interface — used by CNOVATreasury and TierManager.
     */
    function memberJoinedAt(address member) external view returns (uint256) {
        return members[member].joinedAt;
    }

    function totalMembers() external view returns (uint256) {
        return totalJoined;
    }

    /**
     * @notice Alias kept for backwards-compatibility.
     */
    function totalMembersCount() external view returns (uint256) {
        return totalJoined;
    }

    /**
     * @notice Cycles completed by `member` in this matrix instance.
     *         Each cycle = one full rotation out from position 1 (~253 new joins).
     *         Read by TierManager for upgrade-eligibility gating.
     */
    function getCyclesCompleted(address member) external view returns (uint256) {
        return cyclesCompleted[member];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Grant or revoke a contract's permission to call registerFor().
     *         Call once after deploy with the TierManager address as `registrar`.
     */
    function setAuthorizedRegistrar(address registrar, bool authorized) external onlyOwner {
        require(registrar != address(0), "V3: zero registrar");
        authorizedRegistrars[registrar] = authorized;
        emit AuthorizedRegistrarUpdated(registrar, authorized);
    }

    /// @notice V5: set TierManager address for auto-upgrade callbacks.
    function setTierManager(address tm) external onlyOwner {
        tierManagerAddr = tm;
    }

    /// @notice V5: BeltManager calls this to keep a full belt spinning.
    ///         Triggers one rotation without requiring a new external member.
    ///         Only works when the queue is at or beyond ACTIVE_WINDOW capacity.
    function triggerReentry() external {
        require(msg.sender == beltManagerCaller, "V3: not belt manager");
        require(occupancy >= ACTIVE_WINDOW, "V3: queue not full");
        require(head < _queue.length, "V3: empty queue");

        address rotatedOut = _queue[head];
        head          += 1;
        rotationCount += 1;

        // Re-entry fee paid from pre-funded reentryPool (Option B)
        // Pool was funded upfront by the new Belt B/C/D/E joiner who triggered this
        uint256 rfee = ENTRY_FEE * REENTRY_FEE_BPS / 10_000;
        if (rfee > 0 && reentryPool >= rfee) {
            reentryPool -= rfee;
            uint256 toTr = rfee * 70 / 100;
            uint256 toRf = rfee * 20 / 100;
            usdc.safeTransfer(address(treasury), toTr);
            treasury.recordDirectDeposit(toTr);
            _creditMember(members[rotatedOut].originalReferrer, toRf);
            usdc.safeTransfer(devWallet, rfee - toTr - toRf);
        }

        // Re-enter at back
        _queue.push(rotatedOut);
        _memberQueueIndex[rotatedOut] = _queue.length - 1;
        members[rotatedOut].reentryCount += 1;
        cyclesCompleted[rotatedOut] += 1;

        // C+E CNOVA on re-entry (epoch-aware)
        {
            uint256 floorNow = treasury.floorPrice();
            if (floorNow >= 100_000) {
                uint8 tierNum = 1;
                uint256 cOption = (ENTRY_FEE * 500 / 10_000) / 1e6 * 1e18;
                uint256 eOption = uint256(tierNum) * 2 * 1e18;
                uint256 baseAmt = cOption > eOption ? cOption : eOption;
                uint256 epochReward = cnova.currentRewardPerEntry();
                uint256 mintAmt = epochReward > 0 ? baseAmt * epochReward / (50 * 1e18) : 0;
                if (mintAmt > 0) cnova.mintDirect(rotatedOut, mintAmt);
            }
        }

        emit CycleCompleted(rotatedOut, cyclesCompleted[rotatedOut], ACTIVE_WINDOW - 1);
        emit MemberReentered(rotatedOut, members[rotatedOut].reentryCount, _queue.length - head);
        emit MatrixRotation(rotationCount, rotatedOut, rotatedOut);

        // Auto-upgrade
        if (tierManagerAddr != address(0)) {
            try ITierManagerAutoUpgrade(tierManagerAddr).tryAutoUpgrade(rotatedOut) {} catch {}
        }
    }

    /// @dev Address authorised to call triggerReentry() — set to BeltManager.
    address public beltManagerCaller;

    /// @dev USDC pool reserved for triggerReentry — pre-funded by new joiners on newer belts.
    uint256 public reentryPool;

    function setBeltManagerCaller(address caller) external onlyOwner {
        beltManagerCaller = caller;
    }

    /// @notice BeltManager calls this to pre-fund the reentry pool when a new member
    ///         joins a newer belt. Caller must have approved this contract for `amount`.
    function topUpReentryPool(uint256 amount) external {
        require(msg.sender == beltManagerCaller, "V3: not belt manager");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        reentryPool += amount;
    }

    /// @notice V5: TierManager calls this to pull upgrade fee from member's withdrawable.
    function deductWithdrawable(address member, uint256 amount) external {
        require(msg.sender == tierManagerAddr, "V3: not tier manager");
        require(members[member].withdrawable >= amount, "V3: insufficient balance");
        members[member].withdrawable -= amount;
        usdc.safeTransfer(tierManagerAddr, amount);
    }

    /// @notice Pause new registrations (re-entry is unaffected and always runs).
    function pause() external onlyOwner {
        paused = true;
        emit MatrixPaused(msg.sender);
    }

    /// @notice Unpause new registrations.
    function unpause() external onlyOwner {
        paused = false;
        emit MatrixUnpaused(msg.sender);
    }

    function setDevWallet(address _dev) external onlyOwner {
        require(_dev != address(0), "V3: zero dev");
        devWallet = _dev;
        emit DevWalletUpdated(_dev);
    }

    function setOpsWallet(address _ops) external onlyOwner {
        require(_ops != address(0), "V3: zero ops");
        opsWallet = _ops;
        emit OpsWalletUpdated(_ops);
    }

    function setCommunityWallet(address _cw) external onlyOwner {
        require(_cw != address(0), "V3: zero community");
        communityWallet = _cw;
        emit CommunityWalletUpdated(_cw);
    }
}
