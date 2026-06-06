// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./FigureEightMatrixV8.sol";

/**
 * @title  MatrixFactory
 * @notice Registry and wiring hub for FigureEightMatrixV8 pairs.
 *
 *         ARCHITECTURE NOTE
 *         -----------------
 *         MatrixFactory does NOT deploy FigureEightMatrixV8 contracts directly.
 *         Embedding the ~18 KB F8V8 creation code would push this contract over
 *         the EIP-170 24,576-byte deployed-bytecode limit.
 *
 *         Instead:
 *         1. The deploy script (or anyone) deploys F8V8 matA + matB instances
 *            with the correct constructor args, owned by `admin`.
 *         2. Caller invokes registerPair(tierIndex, matA, matB).
 *         3. The factory validates ownership + tierIndex, then wires and
 *            registers the pair with TierRouter and PairManager.
 *
 *         PERMISSIONLESS EXPANSION
 *         ------------------------
 *         registerPair() is callable by anyone. It enforces:
 *           - Both matrices are Ownable-owned by `admin`
 *           - Both matrices report the correct tierIndex
 *           - The tier is already configured in this factory
 *
 *         TODO (pre-mainnet): migrate to EIP-1167 clone pattern so pair
 *         deployment is also permissionless without admin pre-deployment.
 */

interface ITierRouterRegistry {
    function registerMatrix(address matrix, uint8 tierIndex) external;
}

interface IPairManagerRegistry {
    function registerPair(address matA, address matB) external;
}

contract MatrixFactory {

    // -- Immutable configuration ----------------------------------------------
    address public immutable admin;
    address public immutable tierRouter;
    address public immutable stabilityFund;
    address public immutable matrixKeeper;

    uint8 public constant MAX_TIERS = 7;

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
     * @notice Register a tier so registerPair() can wire new matrices into it.
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
     * @notice Wire and register a pre-deployed matA + matB pair.
     *         Permissionless: anyone may register a valid pair.
     *
     *         Validity checks:
     *           (1) Both matrices owned by `admin` (proves legitimacy)
     *           (2) Both report the supplied tierIndex
     *           (3) The tier is already configured in this factory
     */
    function registerPair(
        uint8   tierIndex,
        address matA,
        address matB
    ) external {
        if (tierIndex >= MAX_TIERS)       revert MF_InvalidTier();
        if (!tierConfigured[tierIndex])   revert MF_NotConfigured();
        if (matA == address(0) || matB == address(0)) revert MF_ZeroAddress();

        FigureEightMatrixV8 mA = FigureEightMatrixV8(matA);
        FigureEightMatrixV8 mB = FigureEightMatrixV8(matB);

        if (mA.owner()      != admin)     revert MF_WrongOwner();
        if (mB.owner()      != admin)     revert MF_WrongOwner();
        if (mA.tierIndex()  != tierIndex) revert MF_TierMismatch();
        if (mB.tierIndex()  != tierIndex) revert MF_TierMismatch();

        address pm = pairManagerPerTier[tierIndex];

        mA.setPartner(matB);
        mB.setPartner(matA);
        _wireMatrix(mA, pm);
        _wireMatrix(mB, pm);

        ITierRouterRegistry(tierRouter).registerMatrix(matB, tierIndex);
        IPairManagerRegistry(pm).registerPair(matA, matB);

        pairCountPerTier[tierIndex] += 1;
        allMatA.push(matA);
        allMatB.push(matB);
        deployedTierIndex.push(tierIndex);

        emit PairRegistered(tierIndex, matA, matB, pairCountPerTier[tierIndex]);
    }

    // -- Internal helpers -----------------------------------------------------

    function _wireMatrix(FigureEightMatrixV8 m, address pm) internal {
        m.setTierRouter(tierRouter);
        m.setPairManager(pm);
        if (stabilityFund != address(0)) m.setStabilityFund(stabilityFund);
        if (matrixKeeper  != address(0)) m.setMatrixKeeper(matrixKeeper);
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
