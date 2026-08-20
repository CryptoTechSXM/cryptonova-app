"use strict";
/**
 * fixture_gate_apply.js — session 17, 2026-08-20. REAPPLIES THE MEASUREMENT FIXTURE.
 *
 * WHAT IT IS: the `directCount` sponsorship gate of 13.11/16.5, in the smallest honest
 * form, applied to the working tree so its SIZE and GAS can be measured. It is NOT the
 * shipped design — the base ceiling below is a placeholder and the policy is still open.
 * Session 17 measured with it, recorded the numbers in V8_50_HANDOFF.md section 17, and
 * reverted. This file exists so a later session gets the SAME fixture rather than a new
 * one it has to re-argue.
 *
 * ⛔ THE ONE THING TO GET RIGHT, AND SESSION 17 GOT IT WRONG FIRST.
 *   BASE_BPS 10_000 = the gate is PRESENT BUT NEVER BINDS. It performs the router read on
 *   every call, so the gas is real, but the ceiling never drops and the keeper's work list
 *   stays identical to baseline. THAT is how you price the mechanism.
 *   BASE_BPS 1_500 (binding) changes the POPULATION: the fund refuses loans, parked members
 *   are evicted instead of rescued, batch composition moves from PARKED_RESCUEx8/
 *   EVICT_PARKEDx4 to x2/x10, and every gas figure then prices a different world. Session
 *   17 ran that first and the numbers were uninterpretable. Use 10_000 for cost, 1_500 for
 *   the policy question — and never read one as the other.
 *
 * Run (from C:\CryptoNite-Smart-Contracts\CryptoNova):
 *   node scripts/fixture_gate_apply.js            apply, non-binding (cost measurement)
 *   node scripts/fixture_gate_apply.js --binding  apply, binding at 1500 bps (policy effect)
 *   node scripts/fixture_gate_apply.js --undo     put both files back
 *
 * Then:  npx hardhat compile
 *        npx hardhat run scripts/sizes.js
 *        npx hardhat test test/V8_50_GateCost.test.js     (un-skip it first — see its header)
 *        npx hardhat test test/V8_50_KeeperGas.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TR = path.join(ROOT, "contracts", "TierRouter.sol");
const SF = path.join(ROOT, "contracts", "StabilityFund.sol");

const BINDING = process.argv.includes("--binding");
const UNDO    = process.argv.includes("--undo");
const BASE_BPS = BINDING ? "1_500" : "10_000";

const EDITS = [
  [TR,
   "    mapping(address => address) public memberReferrer;\n",
   "    mapping(address => address) public memberReferrer;\n" +
   "    /// FIXTURE session 17 (measurement only): sponsorship counter for the loan gate.\n" +
   "    mapping(address => uint32)  public directCount;\n"],

  [TR,
   "        memberReferrer[msg.sender]    = resolved;\n",
   "        memberReferrer[msg.sender]    = resolved;\n" +
   "        if (resolved != address(0)) directCount[resolved] += 1;\n"],

  [SF,
   "interface ITierRouterTierInfo {\n    function highestOpenTier() external view returns (uint8);\n}\n",
   "interface ITierRouterTierInfo {\n    function highestOpenTier() external view returns (uint8);\n" +
   "    function directCount(address member) external view returns (uint32);\n}\n"],

  [SF,
   "    uint256 public insolvencyFloorBps = 5_000;\n",
   "    uint256 public insolvencyFloorBps = 5_000;\n\n" +
   "    /// FIXTURE session 17: the ceiling a member with ZERO directs may borrow to.\n" +
   `    uint256 public baseAdvanceBps = ${BASE_BPS};\n` +
   "    event BaseAdvanceBpsSet(uint256 bps);\n" +
   "    function setBaseAdvanceBps(uint256 bps) external onlyOwnerOrGovernance {\n" +
   "        require(bps <= 10_000, \"SF: base bps > 100%\");\n" +
   "        baseAdvanceBps = bps;\n" +
   "        emit BaseAdvanceBpsSet(bps);\n" +
   "    }\n"],

  // THE GATE ITSELF — and it goes in loanHeadroom, which is the ONLY place the ceiling
  // arithmetic lives. loanEligibleFor, loanEligible and MatrixKeeperLib._triageParked all
  // derive from it, so the keeper's "can this member be rescued" and the fund's "will I
  // lend" cannot drift apart. The file's own comment says why that matters.
  [SF,
   "        uint256 ceiling = fee * insolvencyFloorBps / 10_000;\n",
   "        uint256 bps = insolvencyFloorBps;\n" +
   "        if (tierRouter != address(0) && ITierRouterTierInfo(tierRouter).directCount(member) == 0) {\n" +
   "            if (baseAdvanceBps < bps) bps = baseAdvanceBps;\n" +
   "        }\n" +
   "        uint256 ceiling = fee * bps / 10_000;\n"],
];

let failed = false;
for (const [file, before, after] of EDITS) {
  const from = UNDO ? after : before;
  const to   = UNDO ? before : after;
  const src  = fs.readFileSync(file, "utf8");
  const n    = src.split(from).length - 1;
  if (n !== 1) {
    console.log(`FAIL  ${path.basename(file)}: anchor matched ${n} times, need exactly 1`);
    failed = true;
    continue;
  }
  fs.writeFileSync(file, src.replace(from, to), "utf8");
  console.log(`ok    ${path.basename(file)}`);
}
if (failed) {
  console.log("\nNOTHING SHOULD BE TRUSTED FROM A PARTIAL APPLY. Run --undo, check `git diff`,");
  console.log("and re-read the anchors against the current source before running again.");
  process.exit(1);
}
console.log(UNDO
  ? "\nREVERTED. `git diff contracts/` must now be empty for these two files."
  : `\nAPPLIED — base ceiling ${BASE_BPS} bps (${BINDING ? "BINDING: changes the population, prices POLICY"
                                                        : "NON-BINDING: same population, prices COST"}).`);
