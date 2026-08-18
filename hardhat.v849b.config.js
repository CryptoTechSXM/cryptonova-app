require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * hardhat.v849b.config.js — THE CONTROL ARM OF THE V8.49b vs V8.50 A/B.
 *
 * WHY THIS FILE EXISTS
 *   Every remaining V8.50 claim is COMPARATIVE — "removes 62-65% of funding parks",
 *   "frees 67 of 67 MatA parkers", "the fund stops draining". Those are claims about a
 *   DIFFERENCE, and right now the difference is measured against a PROJECTION onto V8.48
 *   data. The V8.49 private run's own worst failure was the same shape: "T6 UNANSWERED —
 *   the run had NO VALID CONTROL", because the control's bigfill exited after registration
 *   and it quietly became a second subject.
 *
 *   So: a real control, compiled from the exact commit the V8.49 private chain was
 *   deployed from.
 *
 * WHAT THE CONTROL IS, EXACTLY
 *   contracts_v849b/ is `git archive de27329 contracts` — the V8.49 private-deploy commit
 *   (2026-08-16 03:13 local; the chain went up at 03:07:33). Verified with
 *   `git log de27329..HEAD -- contracts/`: SIX commits, all V8.50, nothing unrelated. So
 *   the A/B isolates exactly the release —
 *       item A + item B + E1 + defects 2, 4, 5, 6, 7, 8, 9
 *   — across 8 contracts, +1033/-136.
 *
 * ⛔ WHAT IT DOES *NOT* ISOLATE, AND THE CONFOUND TO DESIGN AROUND
 *   FOUR of those defects change KEEPER BEHAVIOUR rather than economics: defect 6 reorders
 *   discovery by deadline, defect 5 raised maxItemsPerUpkeep, defect 8 added the gas floor,
 *   defect 7 stopped the batch truncating. So a raw comparison of "parks remaining" or
 *   "rescues completed" conflates ITEM A'S ECONOMICS with THE KEEPER SIMPLY DOING MORE WORK
 *   PER TICK. Two consequences, both load-bearing:
 *
 *   1. Item A's headline claim does NOT need this control. "Frees 67 of 67 MatA parkers
 *      outright" is a WITHIN-ARM measurement — count rescues where the StabilityFund
 *      contributes zero. Measure it on the V8.50 arm alone.
 *   2. What the control IS for: the system-level claims — the fund's trajectory, total park
 *      volume, the 83.2% repeat rate. Read those as PER-UNIT figures (SF outstanding per
 *      rescue, share of parks that are self-funded), not raw totals, and the throughput
 *      confound largely cancels. Quote a raw total and it does not.
 *
 * ISOLATION FROM THE V8.50 TREE
 *   sources / artifacts / cache all point at *_v849b directories. Nothing here can write
 *   into contracts/, artifacts/ or cache/, so the V8.50 build and its 606-passing suite
 *   cannot be perturbed by compiling or running the control.
 *
 * Compile:  npx hardhat compile --config hardhat.v849b.config.js --force
 * ⚠ NEVER run the main suite against this config. paths.tests points at test_ab/, which
 *   holds the A/B replay harness only — not the 606 tests, which are V8.50's.
 */

const SOLC = {
  version: "0.8.26",
  settings: {
    optimizer: { enabled: true, runs: 1 },
    viaIR: false,
    evmVersion: "cancun",
  },
};
const SOLC_VIA_IR = {
  version: "0.8.26",
  settings: {
    optimizer: { enabled: true, runs: 1 },
    viaIR: true,
    evmVersion: "cancun",
  },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [SOLC],
    // Same two contracts as the main config need viaIR to fit under EIP-170 — but the
    // KEYS must name contracts_v849b/, not contracts/. An override whose path does not
    // match a source file is SILENTLY IGNORED: the contract would compile without viaIR,
    // blow the 24576-byte limit, and fail with a size error that looks nothing like a
    // misconfigured override.
    overrides: {
      "contracts_v849b/MatrixPairFactory.sol": SOLC_VIA_IR,
      "contracts_v849b/TierRouter.sol": SOLC_VIA_IR,
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      accounts: { count: 300 },
      allowUnlimitedContractSize: true,
    },
  },

  paths: {
    sources:   "./contracts_v849b",
    tests:     "./test_ab",
    cache:     "./cache_v849b",
    artifacts: "./artifacts_v849b",
  },
};
