// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BeltManagerV6
 * @notice V6 — Belt queue that feeds the 127-member BFS matrix.
 *
 * Flow
 * ────
 * 1. Member registers → joins belt queue (FIFO).
 * 2. When matrix has an open slot, BeltManager calls matrix.enterMatrix().
 * 3. When matrix root cycles out, matrix calls BeltManager.reenterBelt().
 *    Root goes to BACK of belt queue (fair, no priority).
 * 4. Belt is always active — if BELT_MAX exceeded, new belt opens.
 * 5. Each registration pre-funds older belt pools (Option B, capped at 3).
 *
 * DOUBLE RE-ENTRY (opt-in)
 * ────────────────────────
 * Members can enable doubleReentry via setDoubleReentry(true).
 * When enabled, each time they cycle out their withdrawable balance covers
 * 2× the re-entry fee, they are queued TWICE instead of once — earning from
 * two simultaneous matrix positions. The 2nd fee is deducted from their
 * withdrawable at re-entry time. If balance is insufficient the second slot
 * is silently skipped (falls back to single re-entry).
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./CryptoNovaMatrixV6.sol";

contract BeltManagerV6 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────────────
    uint256 public immutable BELT_MAX;   // lightning:10, expedited:50, mainnet:500
    uint256 public constant  MAX_BELTS = 1000;
    IERC20  public immutable usdc;

    // ─── State ────────────────────────────────────────────────────────────────
    CryptoNovaMatrixV6[] public belts;
    uint256 public activeBeltIndex;

    /// @dev Belt queue: ordered list of members waiting to enter the matrix
    address[] private _queue;
    uint256   private _queueHead;  // index of front of queue

    mapping(address => bool)    public hasRegistered;
    mapping(address => uint256) public memberBeltIndex;
    mapping(address => bool)    public authorizedMatrices;  // matrices that can call reenterBelt
    mapping(address => bool)    public doubleReentry;        // opt-in: re-queue twice per cycle

    // ─── Events ───────────────────────────────────────────────────────────────
    event BeltAdded(uint256 indexed beltIndex, address beltAddress);
    event BeltActivated(uint256 indexed beltIndex, address beltAddress);
    event MemberQueued(address indexed member, uint256 queuePosition);
    event MemberEnteredMatrix(address indexed member, address matrix);
    event MemberReentered(address indexed member, uint256 queuePosition);
    event DoubleReentrySet(address indexed member, bool enabled);
    event SecondSlotQueued(address indexed member, uint256 queuePosition);

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(address _usdc, address _admin, uint256 _beltMax) Ownable(_admin) {
        require(_usdc != address(0), "BMV6: zero usdc");
        require(_beltMax >= 2,       "BMV6: invalid belt max");
        usdc     = IERC20(_usdc);
        BELT_MAX = _beltMax;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function addBelt(address belt) external onlyOwner {
        require(belt != address(0),    "BMV6: zero belt");
        require(belts.length < MAX_BELTS, "BMV6: max belts");
        belts.push(CryptoNovaMatrixV6(belt));
        authorizedMatrices[belt] = true;
        emit BeltAdded(belts.length - 1, belt);
    }

    function setAuthorizedRegistrar(address registrar, bool authorized) external onlyOwner {
        authorizedMatrices[registrar] = authorized;
    }

    /**
     * @notice Admin-only: reset a member's registration so they can re-register.
     *         FOR TESTING ONLY — allows wallet reuse across deploys without
     *         generating new wallets each time.
     *         On mainnet this would be removed or gated behind a timelock.
     */
    function resetMember(address member) external onlyOwner {
        hasRegistered[member] = false;
        memberBeltIndex[member] = 0;
        doubleReentry[member] = false;
    }

    // ─── Double Re-entry Opt-in ───────────────────────────────────────────────

    /**
     * @notice Toggle double re-entry mode. When enabled, each time you cycle out
     *         of the matrix your withdrawable balance is checked. If it covers
     *         2× the entry fee, you are queued TWICE — two independent positions
     *         that earn chain pay and referral income separately.
     *
     *         The second slot deducts 1× entry fee from your withdrawable at the
     *         moment reenterBelt() fires. If your balance is insufficient at that
     *         time, the second slot is skipped silently (falls back to single).
     *
     *         You must have registered before enabling this.
     */
    function setDoubleReentry(bool enabled) external {
        require(hasRegistered[msg.sender], "BMV6: not registered");
        doubleReentry[msg.sender] = enabled;
        emit DoubleReentrySet(msg.sender, enabled);
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Join the belt queue. Member must approve BeltManager for ENTRY_FEE.
     *         FIFO queue — next matrix slot goes to front of queue.
     */
    function register(address referrer) external nonReentrant {
        require(belts.length > 0,            "BMV6: no belts");
        require(!hasRegistered[msg.sender],  "BMV6: already registered");
        _register(msg.sender, referrer);
    }

    /**
     * @notice Privileged registration on behalf of a member.
     *         Only authorised registrars (TierManager) may call this.
     *         Used by TierManagerV6.tryAutoUpgrade() and upgradeTier() so the
     *         member — not TierManager — becomes the registered address.
     *
     *         USDC must be pre-approved to this BeltManager by the caller
     *         (TierManager transfers it first via forceApprove → register).
     */
    function registerFor(address member, address referrer) external nonReentrant {
        require(belts.length > 0,             "BMV6: no belts");
        require(!hasRegistered[member],        "BMV6: already registered");
        require(authorizedMatrices[msg.sender], "BMV6: not authorized registrar");
        _register(member, referrer);
    }

    /// @dev Shared registration logic used by both register() and registerFor().
    ///      USDC is pulled from msg.sender (the caller), not from `member`.
    ///      For register(): msg.sender == member.
    ///      For registerFor(): msg.sender == TierManager, which pre-approved funds.
    function _register(address member, address referrer) internal {

        // Advance belt if current one is full
        _ensureBeltHasRoom();

        CryptoNovaMatrixV6 belt = belts[activeBeltIndex];
        uint256 fee        = belt.ENTRY_FEE();
        // Hybrid re-entry funding:
        // 5% overhead per older belt (capped at 3) pre-funds the re-entry pool
        // This ensures members can always re-enter even if chain pay earnings are low
        uint256 reentryAmt = fee * 500 / 10_000;  // 5% = $0.50 per older belt
        uint256 beltsToPay = activeBeltIndex > 3 ? 3 : activeBeltIndex;
        uint256 totalCost  = fee + (beltsToPay * reentryAmt);

        // Pull USDC from the caller
        usdc.safeTransferFrom(msg.sender, address(this), totalCost);

        // Pre-fund older belt re-entry pools
        uint256 fundStart = activeBeltIndex > 3 ? activeBeltIndex - 3 : 0;
        for (uint256 i = fundStart; i < activeBeltIndex; i++) {
            SafeERC20.forceApprove(usdc, address(belts[i]), reentryAmt);
            belts[i].topUpReentryPool(reentryAmt);
        }

        // Record membership under the MEMBER address (not caller)
        hasRegistered[member]   = true;
        memberBeltIndex[member] = activeBeltIndex;

        // Add to queue (FIFO)
        _queue.push(member);
        uint256 qPos = _queue.length - 1 - _queueHead;
        emit MemberQueued(member, qPos);

        // Try to feed the front of the queue into the matrix immediately
        _tryFeedMatrix(belt, fee, referrer, member);
    }

    /**
     * @notice Called by V6 matrix when root cycles out.
     *         Root goes to BACK of belt queue — fair, no priority.
     *
     *         If member has doubleReentry enabled AND their withdrawable balance
     *         in the calling matrix covers 1× entry fee, they are queued a SECOND
     *         time. The fee is deducted from withdrawable immediately so it cannot
     *         be double-spent. The second queue entry runs independently through
     *         the full matrix cycle, earning chain pay and referral income.
     */
    function reenterBelt(address member) external {
        // No nonReentrant here — this is called from within register()'s nonReentrant context
        // via: register → enterMatrix → _cycleOutRoot → reenterBelt
        // The outer nonReentrant on register() already protects this call chain.
        require(authorizedMatrices[msg.sender], "BMV6: not authorized matrix");
        require(member != address(0),           "BMV6: zero member");

        // Add to back of queue (first slot — always)
        _queue.push(member);
        uint256 qPos = _queue.length - 1 - _queueHead;
        emit MemberReentered(member, qPos);

        // ── Double re-entry: queue a second slot ──────────────────────────────
        // The second slot's entry fee is drawn from the member's withdrawable
        // balance in the matrix. We deduct it there and keep it here in the
        // BeltManager's own USDC balance so _feedMemberToMatrix can spend it
        // when the 2nd slot reaches the front of the queue.
        // We do NOT forward it to reentryPool — that would leave BM with $0
        // to cover the actual enterMatrix() call.
        // Hybrid re-entry funding:
        // Primary:  self-fund from member's withdrawable earnings
        // Fallback: re-entry pool pre-funded by newer belt joiners ($0.50 overhead)
        CryptoNovaMatrixV6 callingMatrix = CryptoNovaMatrixV6(msg.sender);
        uint256 reentryFee = callingMatrix.ENTRY_FEE();
        uint256 available  = callingMatrix.withdrawableOf(member);

        if (available >= reentryFee) {
            // Self-fund: deduct from earnings — USDC lands in BeltManager
            callingMatrix.deductWithdrawable(member, reentryFee);
        } else if (callingMatrix.reentryPool() >= reentryFee) {
            // Pool fallback: drain pool to BeltManager to cover enterMatrix cost
            callingMatrix.drainReentryPool(reentryFee);
        } else {
            // No funds available — member stays in queue, covered on next join
            return;
        }

        // Double re-entry opt-in (self-fund only for second slot)
        if (doubleReentry[member]) {
            uint256 available2 = callingMatrix.withdrawableOf(member);
            if (available2 >= reentryFee) {
                callingMatrix.deductWithdrawable(member, reentryFee);
                _queue.push(member);
                uint256 q2Pos = _queue.length - 1 - _queueHead;
                emit SecondSlotQueued(member, q2Pos);
            }
        }

        // Advance belt if current active one just filled (edge case: cycle-out at BELT_MAX)
        if (activeBeltIndex < belts.length) {
            CryptoNovaMatrixV6 checkBelt = belts[activeBeltIndex];
            if (checkBelt.totalMembers() >= BELT_MAX) {
                uint256 next = activeBeltIndex + 1;
                if (next < belts.length) {
                    activeBeltIndex = next;
                    emit BeltActivated(next, address(belts[next]));
                }
            }
        }
        // Feed into active belt matrix — always use active belt, not original belt
        CryptoNovaMatrixV6 currentBelt = belts[activeBeltIndex];
        if (currentBelt.isFull()) {
            // Active matrix is full — member waits in queue
            return;
        }
        // Pop member from queue head before feeding into matrix
        // (member was just pushed to back of queue above — pop from wherever they are)
        if (_queueHead < _queue.length && _queue[_queueHead] == member) {
            _queueHead++;
        }
        _feedMemberToMatrix(currentBelt, member, address(0));
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _ensureBeltHasRoom() internal {
        if (activeBeltIndex < belts.length) {
            CryptoNovaMatrixV6 active = belts[activeBeltIndex];
            if (active.totalMembers() >= BELT_MAX) {
                uint256 next = activeBeltIndex + 1;
                require(next < belts.length, "BMV6: all belts full - add more");
                activeBeltIndex = next;
                emit BeltActivated(next, address(belts[next]));
            }
        }
    }

    function _tryFeedMatrix(
        CryptoNovaMatrixV6 belt,
        uint256 /* fee */,
        address referrer,
        address member
    ) internal {
        // Matrix always accepts: when full it cycles out root (position 1).
        // Never bail on isFull() — that is exactly when cycle-out fires.

        // Pop front of queue (should be this member since they just joined)
        if (_queueHead < _queue.length && _queue[_queueHead] == member) {
            _queueHead++;
            _feedMemberToMatrix(belt, member, referrer);
        }
    }

    function _feedMemberToMatrix(
        CryptoNovaMatrixV6 belt,
        address member,
        address referrer
    ) internal {
        uint256 fee = belt.ENTRY_FEE();
        SafeERC20.forceApprove(usdc, address(belt), fee);
        // No try/catch — let the real error surface so registration reverts cleanly
        belt.enterMatrix(member, referrer);
        emit MemberEnteredMatrix(member, address(belt));
    }

    // ─── IMatrixMemberCount (Treasury / TierManager interface) ───────────────

    function totalMembers() external view returns (uint256 total) {
        for (uint256 i = 0; i < belts.length; i++) {
            total += belts[i].totalMembers();
        }
    }

    function memberJoinedAt(address member) external view returns (uint256) {
        if (!hasRegistered[member]) return 0;
        uint256 idx = memberBeltIndex[member];
        if (idx >= belts.length) return 0;
        return belts[idx].memberJoinedAt(member);
    }

    function isRegistered(address member) external view returns (bool) {
        return hasRegistered[member];
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function queueLength() external view returns (uint256) {
        return _queue.length > _queueHead ? _queue.length - _queueHead : 0;
    }

    function queuePosition(address member) external view returns (uint256) {
        for (uint256 i = _queueHead; i < _queue.length; i++) {
            if (_queue[i] == member) return i - _queueHead + 1;
        }
        return 0;  // not in queue
    }

    function activeBelt() external view returns (address) {
        if (belts.length == 0) return address(0);
        return address(belts[activeBeltIndex]);
    }

    function totalBelts() external view returns (uint256) {
        return belts.length;
    }

    function beltOf(address member) external view returns (address) {
        if (!hasRegistered[member]) return address(0);
        uint256 idx = memberBeltIndex[member];
        if (idx >= belts.length) return address(0);
        return address(belts[idx]);
    }

    function beltStatus(uint256 index) external view returns (
        address beltAddress, uint256 memberCount, bool isFull, bool isActive
    ) {
        require(index < belts.length, "BMV6: invalid index");
        CryptoNovaMatrixV6 belt = belts[index];
        memberCount = belt.totalMembers();
        return (address(belt), memberCount, belt.isFull(), index == activeBeltIndex);
    }

    function registrationCost() external view returns (
        uint256 total, uint256 entryFee, uint256 reentryContribution
    ) {
        if (belts.length == 0) return (0, 0, 0);
        uint256 idx = activeBeltIndex;
        if (idx < belts.length && belts[idx].totalMembers() >= BELT_MAX && idx + 1 < belts.length) {
            idx = idx + 1;
        }
        CryptoNovaMatrixV6 belt = belts[idx];
        entryFee            = belt.ENTRY_FEE();
        uint256 reentryAmt2 = entryFee * 500 / 10_000;
        uint256 beltsToPay2 = idx > 3 ? 3 : idx;
        reentryContribution = beltsToPay2 * reentryAmt2;
        total               = entryFee + reentryContribution;
    }
}
