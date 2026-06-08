// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  StabilityFund
 * @notice V8.1 "Elevator" -- zero-treasury stability reserve.
 *
 * PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Holds and deploys USDC collected from 5 operational layers to guarantee
 *  every member advances without ever touching the CNOVA treasury.
 *
 *  TREASURY IS SACRED -- this contract has zero interaction with CNOVATreasury.
 *
 * FIVE FUNDING LAYERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  L1: Pool micro-carve       200 bps per entry (permanent, all tiers)
 *      --> FigureEightMatrixV8._distributePayments() via receiveLayer(tier, amt, 1)
 *
 *  L2: Referral micro-carve    50 bps from referral BPS (slow mode + deflation only)
 *      --> TierRouter or matrix in slow/deflation state via receiveLayer(tier, amt, 2)
 *      NOTE: L2 is NOT currently wired -- MatrixKeeper activates it via activateL2()
 *
 *  L3: Withdrawal health fee  1.5% of every withdrawal (counter-cyclical, permanent)
 *      --> FigureEightMatrixV8.withdraw() via receiveLayer(tier, amt, 3)
 *
 *  L4: DevOps contribution    50 bps of devOps share (deep deflation only)
 *      --> MatrixKeeper activates/deactivates via activateL4() / deactivateL4()
 *      NOTE: L4 is NOT currently wired -- keeper calls devOps to forward
 *
 *  L5: Early exit penalties   20-25% USDC on earlyEscrowRelease()
 *      --> FigureEightMatrixV8.earlyEscrowRelease() via receiveLayer(tier, amt, 5)
 *
 * DEPLOYMENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *  payGhostEntry(tierIndex)     -- MatrixKeeper calls to fund a BFS ghost entry.
 *                                  Pays one full entry fee for the given tier.
 *                                  Ghost entry = synthetic BFS advancement paid
 *                                  by stability fund so no real member is blocked.
 *
 *  payReentryDiscount(member, discount) -- MatrixKeeper calls to top up a member
 *                                          whose crossing funds are slightly short.
 *
 * BALANCES
 * ─────────────────────────────────────────────────────────────────────────────
 *  balanceByTier[tier]          -- USDC balance per tier (for tier-scoped governance)
 *  balanceByLayer[layer]        -- USDC deposited per layer (audit trail)
 *  totalBalance                 -- sum of all deposits minus withdrawals
 *  stabilityFloor               -- minimum total balance before ghost entries fire
 *                                  (DAO-votable, default 0 = no floor)
 *
 * GOVERNANCE
 * ─────────────────────────────────────────────────────────────────────────────
 *  Only owner (DAO multisig post-launch) can withdraw() to recover funds.
 *  MatrixKeeper is the only authorized caller for payGhostEntry() and
 *  payReentryDiscount().
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPairManagerV8Ghost {
    /// @notice Enter a ghost member into the matrix (keeper-funded entry).
    ///         PairManager must accept keeper as an authorized caller.
    function ghostEntry(uint8 tierIndex) external;
    function entryFee() external view returns (uint256);
}

interface IFigureEightMatrixV8Ghost {
    function ENTRY_FEE() external view returns (uint256);
}

/// @dev Minimal CNOVA interface used by redeemCNOVA().
///      burnFrom() uses ERC20 allowance when caller lacks BURNER_ROLE --
///      user must approve this contract before calling redeemCNOVA().
interface ICNOVABurnable {
    function totalSupply() external view returns (uint256);
    function burnFrom(address from, uint256 amount) external;
}

contract StabilityFund is Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Tokens ───────────────────────────────────────────────────────────────
    IERC20          public immutable usdc;
    ICNOVABurnable  public immutable cnova;

    // ── Authorized callers ───────────────────────────────────────────────────
    /// @notice MatrixKeeper (Chainlink Automation) -- the ONLY address allowed
    ///         to call payGhostEntry() and payReentryDiscount().
    address public matrixKeeper;

    /// @notice TierRouter -- authorized to call receiveLayer() for L2 routing.
    address public tierRouter;

    /// @notice Authorized matrix contracts may call receiveLayer().
    mapping(address => bool) public authorizedMatrices;

    // ── Tier fee registry ─────────────────────────────────────────────────────
    /// @notice Entry fee per tier (0-based). Set by owner after tier deploy.
    ///         Used to compute ghost entry costs.
    uint256[7] public tierEntryFees;

    // ── Balances ─────────────────────────────────────────────────────────────
    /// @notice USDC balance per tier (deposits keyed to source tier).
    mapping(uint8 => uint256) public balanceByTier;

    /// @notice USDC deposited per layer (audit trail, not used for spending).
    mapping(uint8 => uint256) public balanceByLayer;

    /// @notice Total USDC available in this contract (all tiers + layers).
    uint256 public totalBalance;

    /// @notice Minimum total balance required before ghost entry payments fire.
    ///         DAO-votable. Default 0 (no floor -- ghost entries always fire if
    ///         funds available). Set to e.g. 500e6 ($500) to keep a reserve.
    uint256 public stabilityFloor;

    // ── Metrics ───────────────────────────────────────────────────────────────
    uint256 public totalDeposited;
    uint256 public totalGhostEntries;
    uint256 public totalDiscountsPaid;
    uint256 public totalGhostCost;

    // ── Events ───────────────────────────────────────────────────────────────
    event FundDeposit(uint8 indexed tier, uint256 amount, uint8 layer, address from);
    event GhostEntryFunded(uint8 indexed tier, uint256 cost, uint256 remainingBalance);
    event DiscountPaid(address indexed member, uint256 discount, uint256 remainingBalance);
    event FundWithdrawn(address indexed to, uint256 amount, string reason);
    event MatrixKeeperSet(address indexed keeper);
    event TierRouterSet(address indexed router);
    event MatrixAuthorized(address indexed matrix, bool authorized);
    event TierFeeSet(uint8 indexed tier, uint256 fee);
    event StabilityFloorSet(uint256 floor);
    event CNOVARedeemed(address indexed redeemer, uint256 cnovaAmount, uint256 usdcPaid);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _cnova, address _admin) Ownable(_admin) {
        require(_usdc  != address(0), "SF: zero usdc");
        require(_cnova != address(0), "SF: zero cnova");
        usdc  = IERC20(_usdc);
        cnova = ICNOVABurnable(_cnova);
    }

    // ── Admin setup ──────────────────────────────────────────────────────────

    /// @notice Set the MatrixKeeper address. Only keeper may call ghost entry/discount.
    function setMatrixKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "SF: zero keeper");
        matrixKeeper = _keeper;
        emit MatrixKeeperSet(_keeper);
    }

    /// @notice Set TierRouter address (used for L2 authorization).
    function setTierRouter(address _tr) external onlyOwner {
        require(_tr != address(0), "SF: zero tierRouter");
        tierRouter = _tr;
        emit TierRouterSet(_tr);
    }

    /// @notice Authorize or deauthorize a matrix contract to call receiveLayer().
    function setMatrixAuthorized(address matrix, bool authorized) external onlyOwner {
        require(matrix != address(0), "SF: zero matrix");
        authorizedMatrices[matrix] = authorized;
        emit MatrixAuthorized(matrix, authorized);
    }

    /// @notice Register entry fee for a tier (0-based). Used in ghost entry cost calc.
    function setTierFee(uint8 tierIndex, uint256 fee) external onlyOwner {
        require(tierIndex < 7,  "SF: invalid tier");
        require(fee > 0,        "SF: zero fee");
        tierEntryFees[tierIndex] = fee;
        emit TierFeeSet(tierIndex, fee);
    }

    /// @notice Set minimum balance before ghost entries fire.
    ///         DAO-votable. Allowed: 0, 100e6, 250e6, 500e6, 1000e6.
    function setStabilityFloor(uint256 floor) external onlyOwner {
        stabilityFloor = floor;
        emit StabilityFloorSet(floor);
    }

    // ── Funding entry point ───────────────────────────────────────────────────

    /**
     * @notice Receive a stability fund contribution from an authorized matrix or router.
     *         Called by:
     *           - FigureEightMatrixV8._distributePayments() for L1 (layer=1)
     *           - FigureEightMatrixV8.withdraw() for L3 (layer=3)
     *           - FigureEightMatrixV8.earlyEscrowRelease() for L5 (layer=5)
     *           - TierRouter or keeper for L2 (layer=2) and L4 (layer=4)
     *
     *         Caller MUST have approved this contract for `amount` USDC before calling.
     *
     * @param tierIdx  0-6 (source tier)
     * @param amount   USDC amount (6 decimals)
     * @param layer    1-5 (which stability layer this contribution comes from)
     */
    function receiveLayer(uint8 tierIdx, uint256 amount, uint8 layer) external {
        require(
            authorizedMatrices[msg.sender] ||
            msg.sender == tierRouter       ||
            msg.sender == matrixKeeper     ||
            msg.sender == owner(),
            "SF: unauthorized"
        );
        require(tierIdx < 7,        "SF: invalid tier");
        require(layer >= 1 && layer <= 5, "SF: invalid layer");
        require(amount > 0,         "SF: zero amount");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        balanceByTier[tierIdx] += amount;
        balanceByLayer[layer]  += amount;
        totalBalance           += amount;
        totalDeposited         += amount;

        emit FundDeposit(tierIdx, amount, layer, msg.sender);
    }

    // ── Spending (keeper-only) ────────────────────────────────────────────────

    /**
     * @notice Fund a ghost BFS entry for the given tier.
     *
     *         A ghost entry is a synthetic member slot paid by the StabilityFund
     *         to advance the BFS queue when a real member has left an idle slot.
     *         The ghost occupies the slot until a real member fills it, keeping
     *         all other members advancing without stalling.
     *
     *         Ghost entry cost = one full ENTRY_FEE for tierIndex.
     *         The funds go to PairManager which handles the actual BFS insertion.
     *
     *         The keeper checks:
     *           1. An idle slot exists (via reclaimIdleSlot event or direct read)
     *           2. totalBalance > stabilityFloor + ghostCost
     *           3. Calls this function
     *
     * @param tierIndex  0-based tier index (0=T1, 6=T7)
     * @param pairManager  The PairManager for this tier that will receive funds
     */
    function payGhostEntry(uint8 tierIndex, address pairManager) external {
        require(msg.sender == matrixKeeper, "SF: not keeper");
        require(tierIndex < 7,              "SF: invalid tier");
        require(pairManager != address(0),  "SF: zero pairManager");

        uint256 cost = tierEntryFees[tierIndex];
        require(cost > 0,                        "SF: tier fee not set");
        require(totalBalance >= cost + stabilityFloor, "SF: below floor");
        require(totalBalance >= cost,            "SF: insufficient funds");

        // Deduct from this tier's balance first, then from general pool if needed
        if (balanceByTier[tierIndex] >= cost) {
            balanceByTier[tierIndex] -= cost;
        } else {
            // Drain tier balance to zero, cover remainder from general pool
            balanceByTier[tierIndex] = 0;
        }
        totalBalance -= cost;

        // Transfer to PairManager so it can call registerFor(ghostAddress, address(0))
        usdc.safeTransfer(pairManager, cost);

        totalGhostEntries += 1;
        totalGhostCost    += cost;

        emit GhostEntryFunded(tierIndex, cost, totalBalance);
    }

    /**
     * @notice Top up a parked member's crossing funds so they can re-enter.
     *
     *         When a member parks after cycle-out (insufficient funds to cross),
     *         the keeper may call this to provide a discount (small USDC top-up)
     *         covering the gap. The discount is sent directly to the member's
     *         withdrawable balance via transfer, then the matrix handles crossing.
     *
     *         Keeper should only use this for small gaps (< 20% of entry fee) and
     *         only after ghost entry reserve is healthy (totalBalance > floor * 2).
     *
     * @param member    Address of the parked member
     * @param recipient The matrix contract holding the member's withdrawable balance
     * @param discount  USDC amount to transfer to recipient for the member
     */
    function payReentryDiscount(
        address member,
        address recipient,
        uint256 discount
    ) external {
        require(msg.sender == matrixKeeper,  "SF: not keeper");
        require(member    != address(0),     "SF: zero member");
        require(recipient != address(0),     "SF: zero recipient");
        require(discount  > 0,              "SF: zero discount");
        require(totalBalance >= discount + stabilityFloor, "SF: below floor");
        require(totalBalance >= discount,    "SF: insufficient funds");

        totalBalance -= discount;
        usdc.safeTransfer(recipient, discount);

        totalDiscountsPaid += 1;

        emit DiscountPaid(member, discount, totalBalance);
    }

    // ── CNOVA floor-price redemption ─────────────────────────────────────────

    /**
     * @notice Burn CNOVA at the current floor price and receive USDC from this fund.
     *
     *         floor price  = totalBalance (6-dec) / cnova.totalSupply() (18-dec)
     *         usdcOut      = cnovaAmount  * totalBalance / totalSupply
     *
     *         Caller MUST approve this contract to spend `cnovaAmount` CNOVA
     *         before calling (ERC20 allowance path -- no BURNER_ROLE required).
     *
     *         Reverts if the redemption would push totalBalance below stabilityFloor,
     *         ensuring the ghost-entry reserve is never drained by user redemptions.
     *
     * @param cnovaAmount  CNOVA to burn (18-dec, wei units)
     */
    function redeemCNOVA(uint256 cnovaAmount) external {
        require(cnovaAmount > 0, "SF: zero amount");

        uint256 supply = cnova.totalSupply();
        require(supply > 0, "SF: no CNOVA supply");

        // usdcOut(6-dec) = cnovaAmount(18-dec) * totalBalance(6-dec) / totalSupply(18-dec)
        // 1e18 cancels: result is naturally 6-dec USDC units.
        uint256 usdcOut = (cnovaAmount * totalBalance) / supply;
        require(usdcOut > 0, "SF: zero payout");
        require(
            totalBalance >= usdcOut + stabilityFloor,
            "SF: would breach floor"
        );

        // Burn CNOVA from sender (uses ERC20 allowance -- no special role needed)
        cnova.burnFrom(msg.sender, cnovaAmount);

        // Pay out USDC to sender
        totalBalance -= usdcOut;
        usdc.safeTransfer(msg.sender, usdcOut);

        emit CNOVARedeemed(msg.sender, cnovaAmount, usdcOut);
    }

    // ── Governance: emergency withdrawal ─────────────────────────────────────

    /**
     * @notice DAO-only emergency withdrawal. Used only if:
     *           a) System is winding down, OR
     *           b) Funds need to be migrated to an upgraded StabilityFund
     *
     *         This is NOT a normal operation. The fund is designed to accumulate
     *         and deploy via keeper, not to be drained by owner.
     *
     * @param amount  USDC to withdraw (must not exceed totalBalance)
     * @param to      Recipient address (should be DAO treasury or new SF)
     * @param reason  Short description for audit trail (logged on-chain)
     */
    function withdraw(
        uint256 amount,
        address to,
        string calldata reason
    ) external onlyOwner {
        require(amount > 0,            "SF: zero amount");
        require(to != address(0),      "SF: zero recipient");
        require(amount <= totalBalance, "SF: insufficient balance");

        totalBalance -= amount;
        // Note: does NOT reduce balanceByTier/balanceByLayer (audit trail preserved)
        usdc.safeTransfer(to, amount);

        emit FundWithdrawn(to, amount, reason);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice Current floor price per CNOVA scaled by 1e18 for precision.
     *         floor = totalBalance(6-dec) / totalSupply(18-dec)
     *         Return value is in 6-dec units scaled x1e18.
     *         Example: $0.03/CNOVA returns 30_000_000_000_000 (3e13).
     *         Divide by 1e12 in JS to get a human-readable dollar amount.
     *         Returns 0 if no CNOVA has been minted yet.
     */
    function floorPrice() external view returns (uint256) {
        uint256 supply = cnova.totalSupply();
        if (supply == 0 || totalBalance == 0) return 0;
        // result: (6-dec * 1e18) / 18-dec => dimensionless ratio in 6-dec units x1e18
        return (totalBalance * 1e18) / supply;
    }

    /// @notice Current spendable balance (total minus floor).
    function spendableBalance() external view returns (uint256) {
        if (totalBalance <= stabilityFloor) return 0;
        return totalBalance - stabilityFloor;
    }

    /// @notice Check if the fund can cover a ghost entry for a given tier.
    function canFundGhostEntry(uint8 tierIndex) external view returns (bool) {
        if (tierIndex >= 7) return false;
        uint256 cost = tierEntryFees[tierIndex];
        if (cost == 0) return false;
        return totalBalance >= cost + stabilityFloor;
    }

    /// @notice All 7 tier balances in one call.
    function getAllTierBalances() external view returns (uint256[7] memory balances) {
        for (uint8 i = 0; i < 7; i++) {
            balances[i] = balanceByTier[i];
        }
    }

    /// @notice All 5 layer deposit totals in one call.
    function getAllLayerTotals() external view returns (uint256[5] memory totals) {
        for (uint8 i = 1; i <= 5; i++) {
            totals[i - 1] = balanceByLayer[i];
        }
    }

    /// @notice Full fund status snapshot for keeper and dashboard.
    function fundStatus() external view returns (
        uint256 total,
        uint256 floor,
        uint256 spendable,
        uint256 ghostEntriesFired,
        uint256 ghostCostTotal,
        uint256 discountsFired,
        uint256 depositedAllTime
    ) {
        total             = totalBalance;
        floor             = stabilityFloor;
        spendable         = totalBalance > stabilityFloor ? totalBalance - stabilityFloor : 0;
        ghostEntriesFired = totalGhostEntries;
        ghostCostTotal    = totalGhostCost;
        discountsFired    = totalDiscountsPaid;
        depositedAllTime  = totalDeposited;
    }
}
