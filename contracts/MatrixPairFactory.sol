// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./FigureEightMatrixV8.sol";

// --- Peripheral interfaces -------------------------------------------------------
// Minimal selectors needed for factory wiring calls.

interface IMPFStabilityFund {
    function setMatrixAuthorized(address matrix, bool authorized) external;
}
interface IMPFCouponRegistry {
    function setAuthorizedMatrix(address matrix, bool authorized) external;
}
interface IMPFTreasury {
    function setAuthorizedCaller(address caller, bool authorized) external;
}
interface IMPFTierRouter {
    function registerMatrix(address matrix, uint8 tierIndex) external;
}
interface IMPFPairManager {
    function addPair(address matrixA, address matrixB) external;
}
/// @notice Minimal CNOVAToken interface -- only the selector the factory needs.
interface IMPFCNOVAToken {
    function grantRole(bytes32 role, address account) external;
}

/**
 * @title  MatrixPairFactory
 * @notice Autonomous on-chain expansion engine for FigureEightMatrixV8 pair capacity.
 *
 * ## How it works
 *
 *   PairManagerV8._tryAdvancePair() detects that the active pair has crossed the
 *   expand threshold (default 80%) AND no pre-deployed next pair exists.
 *   It calls MatrixPairFactory.deployAndWire(pairManager), which:
 *
 *     1. Deploys two new FigureEightMatrixV8 contracts (MatA + MatB) for the tier.
 *     2. Wires every setter on the new matrices (partner, tierRouter, pairManager,
 *        stabilityFund, buybackReserve, liquidityReserve, governance, matrixKeeper,
 *        couponRegistry, chainNext).
 *     3. Authorises the new matrices with each peripheral contract
 *        (StabilityFund, CouponRegistry, CNOVATreasury, TierRouter).
 *     4. Calls pairManager.addPair(matA, matB), which wires the circular chain
 *        and advances activePairIndex automatically.
 *     5. Transfers ownership of both new matrices from factory -> real admin.
 *
 *   The triggering member's registration tx pays all gas -- on Base this is
 *   typically $0.05-0.15 for the extra deployment. Subsequent registrations
 *   behave normally (300-500k gas).
 *
 * ## Authorization model
 *
 *   Only PairManagers that have been registered with registerPairManager() may
 *   call deployAndWire().  Each peripheral contract exposes setFactory(address)
 *   (onlyOwner) and accepts factory calls on the one setter that wires new matrices.
 *
 * ## EIP-170
 *
 *   FigureEightMatrixV8 creation bytecode ~17 700 bytes (post external-library split).
 *   MatrixPairFactory runtime ~5 000 bytes own logic + 17 700 embedded init code
 *   ~22 700 bytes -- safely under the 24 576-byte limit.
 */
contract MatrixPairFactory is Ownable {

    // -- Immutable core (set in constructor, never change) -----------------------
    address public immutable usdc;
    address public immutable cnova;
    address public immutable treasuryAddr; // CNOVATreasury (DeployParams + setAuthorizedCaller)

    // -- Mutable peripherals (updateable if contracts redeploy) ------------------
    address public devWallet;
    address public opsWallet;
    address public accountOne;         // W1 wallet -- first-seat tracking in matrix state

    address public stabilityFund;
    address public couponRegistry;
    address public tierRouterAddr;
    address public matrixKeeper;
    address public governance;
    address public buybackReserve;
    address public liquidityReserve;

    // -- Per-tier deployment config ----------------------------------------------
    struct TierConfig {
        uint256 entryFee;
        uint256 matrixSize;
        FigureEightMatrixV8.SplitConfig splits;
        uint256[6] chainPayBps;
        bool configured;
    }
    // tierNum is 1-based (T1=1 ... T10=10) matching the rest of the codebase.
    mapping(uint8 => TierConfig) public tierConfigs;

    // -- PairManager registry ----------------------------------------------------
    // Only registered PairManagers can trigger deployAndWire().
    mapping(address => bool)  public isPairManager;
    mapping(address => uint8) public pairManagerTierNum; // pm -> tierNum (1-based)

    // -- CNOVA role constant -----------------------------------------------------
    /// @dev Must match CNOVAToken.MINTER_ROLE. Factory is granted DEFAULT_ADMIN_ROLE
    ///      on CNOVAToken in deploy_v8.js so it can forward this grant to new pairs.
    bytes32 private constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // -- Reentrancy guard --------------------------------------------------------
    // Prevents a malicious/misconfigured factory callback from re-entering
    // the PairManager routing path during expansion.
    bool private _expanding;

    /// @notice V8.39: Explicit admin address transferred to factory-created matrices.
    ///         Defaults to the constructor _admin (same as Ownable initial owner) but
    ///         can be overridden via setPairAdmin() to decouple matrix ownership from
    ///         factory contract ownership.
    ///
    ///         Root cause fixed: MatrixPairFactory is Ownable(_admin), but the deploy
    ///         script sets admin = process.env.ADMIN_WALLET_ADDRESS (may differ from
    ///         DEPLOYER_PRIVATE_KEY).  Factory-created MatBs were receiving
    ///         transferOwnership(owner()) = ADMIN_WALLET_ADDRESS, while the keeper
    ///         was signing with DEPLOYER_PRIVATE_KEY — causing OwnableUnauthorizedAccount
    ///         on adminForceRotateRoot().  keeperForceRotateRoot() sidesteps this by
    ///         checking matrixKeeper instead of owner, and pairAdmin makes the assign
    ///         explicit so future deploys don't silently inherit the wrong address.
    address public pairAdmin;

    // -- Events ------------------------------------------------------------------
    event PairExpanded(
        uint8   indexed tierNum,
        address         pairManager,
        address         matA,
        address         matB
    );
    event PMRegistered(address indexed pm, uint8 tierNum);
    event TierConfigured(uint8 indexed tierNum, uint256 entryFee, uint256 matrixSize);
    event PairAdminSet(address indexed newAdmin);

    // -- Errors ------------------------------------------------------------------
    error MPF_UnauthorizedPM();
    error MPF_TierNotConfigured();
    error MPF_InvalidTier();
    error MPF_ZeroAddress();
    error MPF_Reentrant();

    // -- Constructor -------------------------------------------------------------

    constructor(
        address _admin,
        address _usdc,
        address _cnova,
        address _treasury
    ) Ownable(_admin) {
        if (_usdc     == address(0)) revert MPF_ZeroAddress();
        if (_cnova    == address(0)) revert MPF_ZeroAddress();
        if (_treasury == address(0)) revert MPF_ZeroAddress();
        usdc         = _usdc;
        cnova        = _cnova;
        treasuryAddr = _treasury;
        pairAdmin    = _admin; // V8.39: explicit matrix-ownership target (matches Ownable default)
    }

    // -- Config setters (all onlyOwner, all called by deploy script) -------------

    /// @notice V8.39: Override the address that factory-created matrices are transferred to.
    ///         Call this in deploy_v8.js after factory deployment if ADMIN_WALLET_ADDRESS
    ///         differs from DEPLOYER_PRIVATE_KEY, so that the keeper (which signs with
    ///         DEPLOYER_PRIVATE_KEY) can call adminForceRotateRoot() on new pairs.
    ///         In practice, keeperForceRotateRoot() is the preferred path — it uses
    ///         matrixKeeper auth and bypasses ownership entirely.
    function setPairAdmin(address _pairAdmin) external onlyOwner {
        if (_pairAdmin == address(0)) revert MPF_ZeroAddress();
        pairAdmin = _pairAdmin;
        emit PairAdminSet(_pairAdmin);
    }

    /// @notice Set wallet addresses passed to every new matrix's DeployParams.
    function setWallets(
        address _devWallet,
        address _opsWallet,
        address _accountOne
    ) external onlyOwner {
        devWallet   = _devWallet;
        opsWallet   = _opsWallet;
        accountOne  = _accountOne;
    }

    /// @notice Set peripheral contract addresses that new matrices connect to.
    function setPeripherals(
        address _sf,
        address _cr,
        address _tr,
        address _keeper,
        address _gov,
        address _bbr,
        address _lr
    ) external onlyOwner {
        stabilityFund    = _sf;
        couponRegistry   = _cr;
        tierRouterAddr   = _tr;
        matrixKeeper     = _keeper;
        governance       = _gov;
        buybackReserve   = _bbr;
        liquidityReserve = _lr;
    }

    /// @notice Store the deployment config for one tier.
    ///         Called once per tier during deploy, before any expansion can occur.
    function configureTier(
        uint8 tierNum,
        uint256 entryFee,
        uint256 matrixSize,
        FigureEightMatrixV8.SplitConfig calldata splits,
        uint256[6] calldata chainPayBps
    ) external onlyOwner {
        if (tierNum < 1 || tierNum > 10) revert MPF_InvalidTier();
        tierConfigs[tierNum] = TierConfig({
            entryFee:    entryFee,
            matrixSize:  matrixSize,
            splits:      splits,
            chainPayBps: chainPayBps,
            configured:  true
        });
        emit TierConfigured(tierNum, entryFee, matrixSize);
    }

    /// @notice Register a PairManager so it can call deployAndWire().
    ///         Must be called once per deployed PairManager during setup.
    function registerPairManager(address pm, uint8 tierNum) external onlyOwner {
        if (pm == address(0)) revert MPF_ZeroAddress();
        if (tierNum < 1 || tierNum > 10) revert MPF_InvalidTier();
        isPairManager[pm]      = true;
        pairManagerTierNum[pm] = tierNum;
        emit PMRegistered(pm, tierNum);
    }

    // -- Core expansion function -------------------------------------------------

    /**
     * @notice Deploy and fully wire a new MatA + MatB pair for the caller's tier.
     *
     *         Called by PairManagerV8._tryAdvancePair() when:
     *           (a) the active pair's combined occupancy >= expandThresholdBps, AND
     *           (b) no pre-deployed next pair exists (activePairIndex+1 >= pairs.length).
     *
     *         Gas cost: ~3-5 M gas on Base (two contract deploys + ~20 wiring calls).
     *         At Base gas prices this is typically under $0.15 -- paid by the
     *         triggering member's registration transaction.
     *
     * @param pairManager  Address of the calling PairManagerV8 instance.
     * @return matA        Address of the newly deployed MatrixA.
     * @return matB        Address of the newly deployed MatrixB.
     */
    function deployAndWire(address pairManager)
        external
        returns (address matA, address matB)
    {
        if (!isPairManager[pairManager]) revert MPF_UnauthorizedPM();
        if (_expanding) revert MPF_Reentrant();
        _expanding = true;

        uint8 tierNum = pairManagerTierNum[pairManager];
        TierConfig storage cfg = tierConfigs[tierNum];
        if (!cfg.configured) revert MPF_TierNotConfigured();

        uint8 tierIndex = tierNum - 1; // FigureEightMatrixV8 uses 0-based tierIndex

        // -- 1. Build DeployParams (factory is temporary admin for wiring) -------
        FigureEightMatrixV8.DeployParams memory dp = FigureEightMatrixV8.DeployParams({
            usdc:       usdc,
            cnova:      cnova,
            treasury:   treasuryAddr,
            devWallet:  devWallet,
            opsWallet:  opsWallet,
            accountOne: accountOne,
            admin:      address(this)  // factory owns new matrices until wiring done
        });

        // -- 2. Deploy MatA and MatB ---------------------------------------------
        FigureEightMatrixV8 mA = new FigureEightMatrixV8(
            dp, cfg.entryFee, cfg.matrixSize,
            true,  tierIndex, cfg.splits, cfg.chainPayBps
        );
        FigureEightMatrixV8 mB = new FigureEightMatrixV8(
            dp, cfg.entryFee, cfg.matrixSize,
            false, tierIndex, cfg.splits, cfg.chainPayBps
        );
        matA = address(mA);
        matB = address(mB);

        // -- 3. Wire setters on new matrices (factory is owner -- all allowed) ---
        mA.setPartner(matB);
        mB.setPartner(matA);

        // tierRouter and pairManager are required -- new matrices won't function without them.
        if (tierRouterAddr != address(0)) {
            mA.setTierRouter(tierRouterAddr);
            mB.setTierRouter(tierRouterAddr);
        }
        mA.setPairManager(pairManager);
        mB.setPairManager(pairManager);

        // Optional peripherals -- zero-address means "not deployed yet", skip silently.
        if (stabilityFund != address(0)) {
            mA.setStabilityFund(stabilityFund);
            mB.setStabilityFund(stabilityFund);
        }
        if (buybackReserve != address(0)) {
            mA.setBuybackReserve(buybackReserve);
            mB.setBuybackReserve(buybackReserve);
        }
        if (liquidityReserve != address(0)) {
            mA.setLiquidityReserve(liquidityReserve);
            mB.setLiquidityReserve(liquidityReserve);
        }
        if (governance != address(0)) {
            mA.setGovernance(governance);
            mB.setGovernance(governance);
        }
        if (matrixKeeper != address(0)) {
            mA.setMatrixKeeper(matrixKeeper);
            mB.setMatrixKeeper(matrixKeeper);
        }
        if (couponRegistry != address(0)) {
            mA.setCouponRegistry(couponRegistry);   // MatA only -- MatB doesn't use coupons
        }
        // Wire matA -> matB in the intra-pair chain.
        // matB -> chainHead is wired by PairManager.addPair() -- do NOT set here.
        mA.setChainNext(matB);

        // -- 4. Authorise new matrices with peripheral contracts -----------------
        if (stabilityFund != address(0)) {
            IMPFStabilityFund(stabilityFund).setMatrixAuthorized(matA, true);
            IMPFStabilityFund(stabilityFund).setMatrixAuthorized(matB, true);
        }
        if (couponRegistry != address(0)) {
            IMPFCouponRegistry(couponRegistry).setAuthorizedMatrix(matA, true);
        }
        IMPFTreasury(treasuryAddr).setAuthorizedCaller(matA, true);
        IMPFTreasury(treasuryAddr).setAuthorizedCaller(matB, true);
        if (tierRouterAddr != address(0)) {
            IMPFTierRouter(tierRouterAddr).registerMatrix(matA, tierIndex);
            IMPFTierRouter(tierRouterAddr).registerMatrix(matB, tierIndex);
        }
        // V8.36 Bug Fix #1: Grant MINTER_ROLE on CNOVAToken to new matrices so they
        // can call mintReward() for members entering factory-created pairs (T1.2+, T2.2+, ...).
        // Requires factory to hold DEFAULT_ADMIN_ROLE on CNOVAToken -- granted in deploy_v8.js.
        IMPFCNOVAToken(cnova).grantRole(MINTER_ROLE, matA);
        IMPFCNOVAToken(cnova).grantRole(MINTER_ROLE, matB);

        // -- 5. Register in PairManager ------------------------------------------
        //   addPair() wires the circular chain (matB.chainNext -> chainHead,
        //   cross-authorises matB <-> chainHead) and advances activePairIndex.
        IMPFPairManager(pairManager).addPair(matA, matB);

        // -- 6. Hand ownership back to real admin --------------------------------
        // V8.39: use pairAdmin (explicit) rather than owner() so factory-created
        // matrices are always owned by the intended deployer wallet, regardless of
        // whether factory contract ownership differs (ADMIN_WALLET_ADDRESS vs DEPLOYER).
        address realAdmin = pairAdmin != address(0) ? pairAdmin : owner();
        mA.transferOwnership(realAdmin);
        mB.transferOwnership(realAdmin);

        _expanding = false;
        emit PairExpanded(tierNum, pairManager, matA, matB);
    }
}
