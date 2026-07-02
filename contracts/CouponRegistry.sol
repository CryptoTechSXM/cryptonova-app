// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  CouponRegistry
 * @notice Off-chain coupon codes are hashed (keccak256) before being stored
 *         on-chain, so the raw code is never visible on the blockchain.
 *
 *         Workflow:
 *   1. Issuer generates a unique plaintext code (e.g. "BOSS-XY7-2026").
 *   2. Issuer calls issueCoupon(keccak256(bytes(code))) and deposits
 *      COUPON_AMOUNT USDC.  The hash is stored; the plaintext stays private.
 *   3. Issuer shares the plaintext code with one new member.
 *   4. During registration, the matrix calls redeemCoupon(keccak256(code), member)
 *      which validates the coupon and transfers COUPON_AMOUNT USDC to the matrix.
 *   5. If unused after EXPIRY_DURATION, the issuer calls reclaimCoupon(hash)
 *      to get their USDC back.
 *
 *         Owner toggle: setAuthorizedMatrix(address, bool) whitelists which
 *         matrix contracts can call redeemCoupon.  Set address(0) in the matrix
 *         (via setCouponRegistry) to disable coupon redemption at the matrix level.
 */

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CouponRegistry is Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────────

    struct Coupon {
        address issuer;
        uint256 amount;   // USDC (6-decimal) deposited by issuer
        uint256 expiry;   // block.timestamp + EXPIRY_DURATION at issuance
        bool    used;
    }

    // ── Immutables / constants ────────────────────────────────────────────────

    IERC20  public immutable usdc;
    uint256 public constant  EXPIRY_DURATION = 30 days;

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Amount a coupon is worth. Owner-adjustable so it stays at the T1 entry fee.
    uint256 public couponAmount;

    /// @notice codeHash => Coupon
    mapping(bytes32 => Coupon) public coupons;

    /// @notice Only whitelisted matrix contracts may call redeemCoupon.
    mapping(address => bool) public authorizedMatrix;

    // ── Events ────────────────────────────────────────────────────────────────

    event CouponIssued   (bytes32 indexed codeHash, address indexed issuer, uint256 amount, uint256 expiry);
    event CouponRedeemed (bytes32 indexed codeHash, address indexed issuer, address indexed newMember, uint256 amount);
    event CouponReclaimed(bytes32 indexed codeHash, address indexed issuer, uint256 amount);
    event MatrixAuthorized(address indexed matrix, bool authorized);
    event CouponAmountUpdated(uint256 oldAmount, uint256 newAmount);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _usdc, uint256 _couponAmount) Ownable(msg.sender) {
        require(_usdc != address(0),     "CR: zero usdc");
        require(_couponAmount > 0,       "CR: zero amount");
        usdc         = IERC20(_usdc);
        couponAmount = _couponAmount;
    }

    // ── Owner controls ────────────────────────────────────────────────────────

    /// @notice Whitelist or de-whitelist a matrix contract.
    function setAuthorizedMatrix(address matrix, bool authorized) external onlyOwner {
        authorizedMatrix[matrix] = authorized;
        emit MatrixAuthorized(matrix, authorized);
    }

    /// @notice Update the USDC value of new coupons (existing coupons keep their original amount).
    function setCouponAmount(uint256 newAmount) external onlyOwner {
        require(newAmount > 0, "CR: zero amount");
        emit CouponAmountUpdated(couponAmount, newAmount);
        couponAmount = newAmount;
    }

    // ── Issuer actions ────────────────────────────────────────────────────────

    /**
     * @notice Issue a coupon.
     * @param codeHash  keccak256(abi.encodePacked(plainTextCode)) — computed off-chain by the issuer.
     *                  The plaintext code is NEVER passed on-chain.
     */
    function issueCoupon(bytes32 codeHash) external {
        require(codeHash != bytes32(0),              "CR: empty hash");
        require(coupons[codeHash].issuer == address(0), "CR: code already taken");

        uint256 amt    = couponAmount;
        uint256 expiry = block.timestamp + EXPIRY_DURATION;

        coupons[codeHash] = Coupon({
            issuer: msg.sender,
            amount: amt,
            expiry: expiry,
            used:   false
        });

        usdc.safeTransferFrom(msg.sender, address(this), amt);

        emit CouponIssued(codeHash, msg.sender, amt, expiry);
    }

    /**
     * @notice Reclaim an expired, unused coupon.
     * @param codeHash  Same hash passed to issueCoupon.
     */
    function reclaimCoupon(bytes32 codeHash) external {
        Coupon storage c = coupons[codeHash];
        require(c.issuer == msg.sender,       "CR: not issuer");
        require(!c.used,                      "CR: already used");
        require(block.timestamp >= c.expiry,  "CR: not expired yet");

        uint256 amt = c.amount;
        c.used = true;   // mark used so it can't be reclaimed twice

        usdc.safeTransfer(msg.sender, amt);

        emit CouponReclaimed(codeHash, msg.sender, amt);
    }

    // ── Matrix-only actions ───────────────────────────────────────────────────

    /**
     * @notice Called by an authorized matrix during member registration.
     *         Validates the coupon and transfers USDC to the matrix (msg.sender).
     * @param codeHash  keccak256(abi.encodePacked(plainTextCode)) — hashed by the matrix after
     *                  the new member supplies their plaintext code to the frontend.
     * @param newMember The wallet address that is registering.
     * @return amount   USDC transferred to the matrix (equals the coupon's stored amount).
     */
    function redeemCoupon(bytes32 codeHash, address newMember) external returns (uint256 amount) {
        require(authorizedMatrix[msg.sender], "CR: caller not authorized matrix");
        require(newMember != address(0),      "CR: zero member");

        Coupon storage c = coupons[codeHash];
        require(c.issuer != address(0),       "CR: coupon not found");
        require(!c.used,                      "CR: already used");
        require(block.timestamp < c.expiry,   "CR: expired");

        amount  = c.amount;
        c.used  = true;

        usdc.safeTransfer(msg.sender, amount);

        emit CouponRedeemed(codeHash, c.issuer, newMember, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isValid(bytes32 codeHash) external view returns (bool) {
        Coupon storage c = coupons[codeHash];
        return (c.issuer != address(0) && !c.used && block.timestamp < c.expiry);
    }
}
