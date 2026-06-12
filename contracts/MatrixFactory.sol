// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./FigureEightMatrixV8.sol";

/**
 * @title  MatrixFactory
 * @notice Pure registry for FigureEightMatrixV8 pairs.
 *
 *         ARCHITECTURE NOTE
 *         -----------------
 *         MatrixFactory does NOT deploy or wire FigureEightMatrixV8 contracts.
 *         All wiring (setPartner, setTierRouter, setPairManager, setStabilityFund,
 *         setMatrixKeeper, TierRouter.registerMatrix, PairManager.addPair) is
 *         performed by the deploy script (admin) BEFORE calling registerPair.
 *
 *         registerPair() validates that:
 *           - caller is admin
 *           - both matrices are Ownable-owned by admin
 *           - both matrices report the correct tierIndex
 *           - the tier is already configured in this factory
 *         and then records the pair in the registry.
 */

contract MatrixFactory {

    // -- Immutable configuration ----------------------------------------------
    address public immutable admin;
    address public immutable tierRouter;
    address public immutable stabilityFund;
    address public immutable matrixKeeper;

    uint8 public constant MAX_TIERS = 10;  // V8.7: expanded from 7 → 10 tiers

    // -- Per-tier configuration -----------------------------------------------
    address[MAX_TIERS]        internal pairManagerPerTier;
    uint256[MAX_TIERS]        internal matrixSizePerTier;
    bool[MAX_TIERS]           internal tierConfigured;
    mapping(uint8 => uint256) internal pairCountPerTier;

    // -- Deployment registry --------------------------------------------------
    address[] public allMatA;
    address[] public allMatB;
    uint8[]   public deployedTierIndex;

    // -- Events ---------------------------------------------------------------
    event PairRegistered(
        uint8   indexed tierIndex,
        address matA,
        address matB,
        uint256 pairNumber
    );
    event TierConfigured(
        uint8   indexed tierIndex,
        address pairManager,
        uint256 matrixSize
    );

    // -- Custom errors --------------------------------------------------------
    error MF_NotAdmin();
    error MF_InvalidTier();
    error MF_InvalidSize();
    error MF_AlreadyConfigured();
    error MF_NotConfigured();
    error MF_ZeroAddress();
    error MF_WrongOwner();
    error MF_TierMismatch();

    // -- Constructor ----------------------------------------------------------
    constructor(
        address _admin,
        address _tierRouter,
        address _stabilityFund,
        address _matrixKeeper
    ) {
        if (_admin      == address(0)) revert MF_ZeroAddress();
        if (_tierRouter == address(0)) revert MF_ZeroAddress();
        admin         = _admin;
        tierRouter    = _tierRouter;
        stabilityFund = _stabilityFund;
        matrixKeeper  = _matrixKeeper;
    }

    // -- Tier configuration ---------------------------------------------------

    /**
     * @notice Register a tier so registerPair() can record new matrix pairs.
     *         Must be called by admin once per tier before the first pair.
     */
    function configureTier(
        uint8   tierIndex,
        address _pairManager,
        uint256 _matrixSize
    ) external {
        if (msg.sender != admin)        revert MF_NotAdmin();
        if (tierIndex  >= MAX_TIERS)    revert MF_InvalidTier();
        if (_pairManager == address(0)) revert MF_ZeroAddress();
        if (_matrixSize  < 3)           revert MF_InvalidSize();
        if (tierConfigured[tierIndex])  revert MF_AlreadyConfigured();

        pairManagerPerTier[tierIndex] = _pairManager;
        matrixSizePerTier[tierIndex]  = _matrixSize;
        tierConfigured[tierIndex]     = true;

        emit TierConfigured(tierIndex, _pairManager, _matrixSize);
    }

    // -- Pair registration ----------------------------------------------------

    /**
     * @notice Record a pre-deployed and pre-wired matA + matB pair.
     *         Caller must be admin. All wiring must be done before this call.
     *
     *         Validity checks:
     *           (1) Both matrices owned by admin
     *           (2) Both report the supplied tierIndex
     *           (3) The tier is already configured in this factory
     */
    function registerPair(
        uint8   tierIndex,
        address matA,
        address matB
    ) external {
        if (msg.sender != admin)              revert MF_NotAdmin();
        if (tierIndex >= MAX_TIERS)           revert MF_InvalidTier();
        if (!tierConfigured[tierIndex])       revert MF_NotConfigured();
        if (matA == address(0) || matB == address(0)) revert MF_ZeroAddress();

        FigureEightMatrixV8 mA = FigureEightMatrixV8(matA);
        FigureEightMatrixV8 mB = FigureEightMatrixV8(matB);

        if (mA.owner()      != admin)         revert MF_WrongOwner();
        if (mB.owner()      != admin)         revert MF_WrongOwner();
        if (mA.tierIndex()  != tierIndex)     revert MF_TierMismatch();
        if (mB.tierIndex()  != tierIndex)     revert MF_TierMismatch();

        pairCountPerTier[tierIndex] += 1;
        allMatA.push(matA);
        allMatB.push(matB);
        deployedTierIndex.push(tierIndex);

        emit PairRegistered(tierIndex, matA, matB, pairCountPerTier[tierIndex]);
    }

    // -- Views ----------------------------------------------------------------

    function totalPairsDeployed() external view returns (uint256) {
        return allMatA.length;
    }

    function getTierInfo(uint8 tierIndex)
        external view
        returns (bool configured, address pairManager, uint256 matrixSize, uint256 pairCount)
    {
        return (
            tierConfigured[tierIndex],
            pairManagerPerTier[tierIndex],
            matrixSizePerTier[tierIndex],
            pairCountPerTier[tierIndex]
        );
    }
}
