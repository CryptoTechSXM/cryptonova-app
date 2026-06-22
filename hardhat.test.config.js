"use strict";
/**
 * hardhat.test.config.js — SANDBOX-ONLY test config, NOT for deploy.
 *
 * Root cause of "npx hardhat compile" never finishing in the agent sandbox:
 * the sandbox's native solc binary doesn't run (architecture mismatch / no
 * native binary fetch), so Hardhat silently falls back to solc-js (pure JS,
 * far slower). Combined with viaIR:true (needed under the old monolithic
 * FigureEightMatrixV8 to fit under the 24,576-byte EIP-170 limit) and
 * optimizer runs=200 across ~20 contracts + OZ deps, a from-scratch compile
 * via solc-js takes many minutes -- well past any single tool-call window.
 *
 * This file disables viaIR for a throwaway, sandbox-local test compile only.
 * It is NEVER used for deploy_v8.js or any real network. Real deploys keep
 * using hardhat.config.js (viaIR:true) so deployed bytecode/addresses are
 * unaffected by this file's existence.
 *
 * Usage: npx hardhat test --config hardhat.test.config.js <files...>
 */
const base = require("./hardhat.config.js");

module.exports = {
  ...base,
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
};
