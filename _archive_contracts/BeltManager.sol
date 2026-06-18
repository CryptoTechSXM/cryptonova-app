// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BeltManager
 * @notice V5 — Multi-belt router for CryptoNova Tier-1 matrices.
 *
 * Concept
 * -------
 * Instead of one large queue that slows as membership grows, the system
 * uses multiple small "belts" (each a CryptoNovaMatrixV3 instance).
 * Each belt is capped at BELT_MAX members, keeping cycle times fast and
 * predictable regardless of total community size.
 *
 * Flow
 * ----
 * 1. Member approves BeltManager for ENTRY_FEE USDC.
 * 2. Member calls BeltManager.register(referrer).
 * 3. BeltManager checks whether the active belt is full.
 *    If full: activates the next pre-deployed belt.
 * 4. BeltManager pulls USDC from member, approves the active belt,
 *    and calls belt.registerFor(member, referrer).
 * 5. BeltManager records which belt the member belongs to.
 *
 * Belt sizes
 * ----------
 * Engine test : BELT_MAX = 50   (10 × AW of 5)
 * Mainnet     : BELT_MAX = 500  (10 × AW of 50)
 *
 * IMatrixMemberCount
 * ------------------
 * Treasury and TierManager call totalMembers() and memberJoinedAt() on
 * the "tier1Matrix" address.  BeltManager implements this interface so
 * it can be set as tier1Matrix, aggregating data across all belts.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CryptoNovaMatrixV3.sol";

contract BeltManager is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────
    uint256 public immutable BELT_MAX;   // lightning:10, engine:50, mainnet:500
    uint256 public constant MAX_BELTS = 1000;  // keeper adds belts dynamically, no hard cap needed

    // ─── State ────────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;

    /// @dev All registered belt contracts in order of activation.
    CryptoNovaMatrixV3[] public belts;

    /// @dev Index of the currently accepting belt (0-based).
    uint256 public activeBeltIndex;

    /// @dev Which belt index each member registered on.
    mapping(address => uint256) public memberBeltIndex;

    /// @dev Whether a member has registered through this BeltManager.
    mapping(address => bool) public hasRegistered;

    /// @dev Contracts authorised to call registerFor() — e.g. TierManager for T2-T7 upgrades.
    mapping(address => bool) public authorizedRegistrars;

    // ─── Events ───────────────────────────────────────────────────────────────
    event BeltAdded(uint256 indexed beltIndex, address beltAddress);
    event BeltActivated(uint256 indexed beltIndex, address beltAddress);
    event MemberRouted(address indexed member, uint256 beltIndex, address beltAddress);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _usdc, address _admin, uint256 _beltMax) Ownable(_admin) {
        require(_usdc != address(0), "BM: zero usdc");
        require(_beltMax >= 2 && _beltMax <= 10_000, "BM: invalid belt max");
        usdc = IERC20(_usdc);
        BELT_MAX = _beltMax;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setAuthorizedRegistrar(address registrar, bool authorized) external onlyOwner {
        authorizedRegistrars[registrar] = authorized;
    }

    /// @notice Pre-register a belt contract. Must be called before that belt
    ///         can accept members. Belts activate in the order they are added.
    function addBelt(address belt) external onlyOwner {
        require(belt != address(0), "BM: zero belt");
        require(belts.length < MAX_BELTS, "BM: max belts reached");
        belts.push(CryptoNovaMatrixV3(belt));
        emit BeltAdded(belts.length - 1, belt);
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Register a member in the current active belt.
     *         Member must have approved BeltManager for ENTRY_FEE USDC.
     * @param referrer  Sponsor address (use address(0) for no sponsor).
     */
    function register(address referrer) external nonReentrant {
        require(belts.length > 0, "BM: no belts configured");
        require(!hasRegistered[msg.sender], "BM: already registered");

        // Advance belt if active one is full
        _ensureActiveBeltHasRoom();

        CryptoNovaMatrixV3 belt = belts[activeBeltIndex];
        uint256 fee        = belt.ENTRY_FEE();
        uint256 reentryAmt = fee * belt.REENTRY_FEE_BPS() / 10_000; // per older belt

        // Total pulled from member = entry fee + (one reentry cost per older full belt)
        // Cap re-entry contributions at 3 older belts so overhead stays at $1.50 max
        // regardless of how many total belts exist (infinitely scalable)
        uint256 beltsToPay = activeBeltIndex > 3 ? 3 : activeBeltIndex;
        uint256 totalCost  = fee + (beltsToPay * reentryAmt);
        usdc.safeTransferFrom(msg.sender, address(this), totalCost);

        // Pre-fund up to 3 older belts (capped for scalability — $1.50 max overhead)
        uint256 fundStart = activeBeltIndex > 3 ? activeBeltIndex - 3 : 0;
        for (uint256 i = fundStart; i < activeBeltIndex; i++) {
            SafeERC20.forceApprove(usdc, address(belts[i]), reentryAmt);
            belts[i].topUpReentryPool(reentryAmt);
        }

        // Approve active belt for entry fee and register
        SafeERC20.forceApprove(usdc, address(belt), fee);
        belt.registerForWithCnova(msg.sender, referrer, true);

        // Record
        hasRegistered[msg.sender]   = true;
        memberBeltIndex[msg.sender] = activeBeltIndex;

        emit MemberRouted(msg.sender, activeBeltIndex, address(belt));

        // Trigger reentry on funded belts only (same 3-belt window)
        for (uint256 i = fundStart; i < activeBeltIndex; i++) {
            try belts[i].triggerReentry() {} catch {}
        }
    }

    /// @dev Advance activeBeltIndex if current belt is full.
    function _ensureActiveBeltHasRoom() internal {
        CryptoNovaMatrixV3 active = belts[activeBeltIndex];
        if (active.totalMembers() >= BELT_MAX) {
            uint256 next = activeBeltIndex + 1;
            require(next < belts.length, "BM: all belts full - add more");
            activeBeltIndex = next;
            emit BeltActivated(next, address(belts[next]));
        }
    }

    /**
     * @notice Register a member on behalf of an authorized caller (e.g. TierManager for T2-T7).
     *         Caller must have pre-approved this contract for (entryFee + reentry contributions).
     *         Does NOT mint CNOVA — tier upgrades handle CNOVA separately via mintDirect.
     */
    function registerFor(address member, address referrer) external nonReentrant {
        require(authorizedRegistrars[msg.sender], "BM: not authorized registrar");
        require(belts.length > 0, "BM: no belts configured");
        require(!hasRegistered[member], "BM: already registered");

        _ensureActiveBeltHasRoom();

        CryptoNovaMatrixV3 belt = belts[activeBeltIndex];
        uint256 fee        = belt.ENTRY_FEE();
        uint256 reentryAmt = fee * belt.REENTRY_FEE_BPS() / 10_000;
        uint256 beltsToPay = activeBeltIndex > 3 ? 3 : activeBeltIndex;
        uint256 totalCost  = fee + (beltsToPay * reentryAmt);

        // Pull from authorized caller (TierManager already has the USDC)
        usdc.safeTransferFrom(msg.sender, address(this), totalCost);

        // Pre-fund older belt pools
        uint256 fundStart = activeBeltIndex > 3 ? activeBeltIndex - 3 : 0;
        for (uint256 i = fundStart; i < activeBeltIndex; i++) {
            SafeERC20.forceApprove(usdc, address(belts[i]), reentryAmt);
            belts[i].topUpReentryPool(reentryAmt);
        }

        // Register in active belt (no CNOVA — tier upgrade handles minting separately)
        SafeERC20.forceApprove(usdc, address(belt), fee);
        belt.registerFor(member, referrer);

        hasRegistered[member]   = true;
        memberBeltIndex[member] = activeBeltIndex;

        emit MemberRouted(member, activeBeltIndex, address(belt));

        // Trigger reentries on funded older belts
        for (uint256 i = fundStart; i < activeBeltIndex; i++) {
            try belts[i].triggerReentry() {} catch {}
        }
    }

    // ─── IMatrixMemberCount implementation ────────────────────────────────────
    // Treasury and TierManager call these on tier1Matrix (= this contract).

    /**
     * @notice Total members across ALL belts.
     */
    function totalMembers() external view returns (uint256 total) {
        for (uint256 i = 0; i < belts.length; i++) {
            total += belts[i].totalMembers();
        }
    }

    /**
     * @notice Returns the joinedAt timestamp for a member from whichever
     *         belt they registered on.
     */
    function memberJoinedAt(address member) external view returns (uint256) {
        if (!hasRegistered[member]) return 0;
        CryptoNovaMatrixV3 belt = belts[memberBeltIndex[member]];
        return belt.memberJoinedAt(member);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Total USDC a member must approve to register.
    ///         Simulates _ensureActiveBeltHasRoom() so the returned cost accounts
    ///         for a potential belt advance that happens inside register().
    function registrationCost() external view returns (uint256 total, uint256 entryFee, uint256 reentryContribution) {
        if (belts.length == 0) return (0, 0, 0);
        // Mirror _ensureActiveBeltHasRoom: if current belt is full, use next index
        uint256 idx = activeBeltIndex;
        if (idx < belts.length && belts[idx].totalMembers() >= BELT_MAX && idx + 1 < belts.length) {
            idx = idx + 1;
        }
        CryptoNovaMatrixV3 belt = belts[idx];
        entryFee            = belt.ENTRY_FEE();
        uint256 reentryAmt  = entryFee * belt.REENTRY_FEE_BPS() / 10_000;
        uint256 beltsToPay  = idx > 3 ? 3 : idx;  // cap at 3 older belts
        reentryContribution = beltsToPay * reentryAmt;
        total               = entryFee + reentryContribution;
    }

    /// @notice Address of the currently active belt.
    function activeBelt() external view returns (address) {
        if (belts.length == 0) return address(0);
        return address(belts[activeBeltIndex]);
    }

    /// @notice Number of belts registered.
    function totalBelts() external view returns (uint256) {
        return belts.length;
    }

    /**
     * @notice Full status of a belt.
     * @return beltAddress  Contract address.
     * @return memberCount  Current member count.
     * @return isFull       Whether belt has reached BELT_MAX.
     * @return isActive     Whether this is the currently accepting belt.
     */
    function beltStatus(uint256 beltIndex) external view returns (
        address beltAddress,
        uint256 memberCount,
        bool isFull,
        bool isActive
    ) {
        require(beltIndex < belts.length, "BM: invalid index");
        CryptoNovaMatrixV3 belt = belts[beltIndex];
        memberCount  = belt.totalMembers();
        beltAddress  = address(belt);
        isFull       = memberCount >= BELT_MAX;
        isActive     = beltIndex == activeBeltIndex;
    }

    /// @notice Returns true if member registered through any belt on this manager.
    function isRegistered(address member) external view returns (bool) {
        return hasRegistered[member];
    }

    /// @notice Returns the belt contract address for a given member.
    function beltOf(address member) external view returns (address) {
        if (!hasRegistered[member]) return address(0);
        return address(belts[memberBeltIndex[member]]);
    }
}
