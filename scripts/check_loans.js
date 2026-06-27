/**
 * check_loans.js
 * Queries on-chain for RescueLoanIssued, RescueDebtRepaid, and
 * DebtRepaymentReceived events to diagnose whether V8.28 loan
 * repayment is flowing back to the SF.
 *
 * V8.27 behaviour (old bug): debt stored on MatA, repayment never fires on MatB.
 * V8.28 fix: debt stored on MatB via addRescueDebt(), so:
 *   - RescueLoanIssued still emitted on MatA (off-chain tracking)
 *   - RescueDebtRepaid now emitted on MatB (15% gradual + lump cycle-out)
 *   - DebtRepaymentReceived fires on SF as each repayment batch settles
 *
 * Run: npx hardhat run scripts/check_loans.js --network baseSepolia
 */

const hre = require("hardhat");
require("dotenv").config();

// V8.28 — SF loan debt stored on MatB; repayments now fire correctly
const addrs = require("./deployed_addresses_v8_28.json");

const MATRIX_ABI = [
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
];
const SF_ABI = [
  "event DebtRepaymentReceived(address indexed matrix, uint256 amount)",
];
const MATRIXA_DEBT_ABI = [
  "function rescueDebtOf(address member) external view returns (uint256)",
];

async function main() {
  const provider = hre.ethers.provider;
  const blk = await provider.getBlockNumber();
  const CHUNK = 2000;
  const CHUNKS = 10;
  const fromBlock = Math.max(0, blk - CHUNK * CHUNKS);

  console.log(`\n-- check_loans.js  block=${blk}  scanning ${fromBlock}..${blk} (${CHUNK*CHUNKS} blocks) --`);

  const matAAddr = addrs.tiers.T1.matA; // 0x456a8D...
  const matBAddr = addrs.tiers.T1.matB;
  const sfAddr   = addrs.stabilityFund;

  const matA = new hre.ethers.Contract(matAAddr, MATRIX_ABI, provider);
  const matB = new hre.ethers.Contract(matBAddr, MATRIX_ABI, provider);
  const sf   = new hre.ethers.Contract(sfAddr, SF_ABI, provider);

  // 1. RescueLoanIssued on T1matA
  let totalIssued = 0n;
  let loanEvents = [];
  console.log("\n[1] Scanning T1matA for RescueLoanIssued...");
  for (let from = fromBlock; from < blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    const logs = await matA.queryFilter(matA.filters.RescueLoanIssued(), from, to).catch(() => []);
    for (const log of logs) {
      const amount = BigInt(log.args.loanAmount ?? log.args[1] ?? 0n);
      totalIssued += amount;
      loanEvents.push({ block: log.blockNumber, member: log.args.member, amount, type: log.args.rescueType });
    }
  }
  console.log(`  Events found: ${loanEvents.length}  totalIssued=$${(Number(totalIssued)/1e6).toFixed(4)}`);
  for (const e of loanEvents.slice(0, 10)) {
    console.log(`  block=${e.block}  member=${e.member}  amount=$${(Number(e.amount)/1e6).toFixed(4)}  type=${e.type}`);
  }

  // 2. RescueLoanIssued on T1matB (should be 0)
  console.log("\n[2] Scanning T1matB for RescueLoanIssued (expect 0)...");
  let matBLoans = 0;
  for (let from = fromBlock; from < blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    const logs = await matB.queryFilter(matB.filters.RescueLoanIssued(), from, to).catch(() => []);
    matBLoans += logs.length;
  }
  console.log(`  Events found: ${matBLoans}`);

  // 3a. RescueDebtRepaid on T1matA (pre-V8.28 path: _crossToPartner on MatA)
  console.log("\n[3a] Scanning T1matA for RescueDebtRepaid (pre-V8.28 path)...");
  let totalRepaidMatA = 0n;
  let repaidEvents = [];
  for (let from = fromBlock; from < blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    const logs = await matA.queryFilter(matA.filters.RescueDebtRepaid(), from, to).catch(() => []);
    for (const log of logs) {
      const repaid = BigInt(log.args.repaid ?? log.args[1] ?? 0n);
      totalRepaidMatA += repaid;
      repaidEvents.push({ block: log.blockNumber, member: log.args.member, repaid });
    }
  }
  console.log(`  Events found: ${repaidEvents.length}  totalRepaid=$${(Number(totalRepaidMatA)/1e6).toFixed(4)}`);

  // 3b. RescueDebtRepaid on T1matB (V8.28 path: 15% gradual + cycle-out repayment on MatB)
  console.log("\n[3b] Scanning T1matB for RescueDebtRepaid (V8.28 path — should grow after V8.28 deploy)...");
  let totalRepaidMatB = 0n;
  let repaidMatBEvents = [];
  for (let from = fromBlock; from < blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    const logs = await matB.queryFilter(matB.filters.RescueDebtRepaid(), from, to).catch(() => []);
    for (const log of logs) {
      const repaid = BigInt(log.args.repaid ?? log.args[1] ?? 0n);
      totalRepaidMatB += repaid;
      repaidMatBEvents.push({ block: log.blockNumber, member: log.args.member, repaid });
    }
  }
  console.log(`  Events found: ${repaidMatBEvents.length}  totalRepaid=$${(Number(totalRepaidMatB)/1e6).toFixed(4)}`);
  for (const e of repaidMatBEvents.slice(0, 5)) {
    console.log(`  block=${e.block}  member=${e.member}  repaid=$${(Number(e.repaid)/1e6).toFixed(4)}`);
  }

  // 4. DebtRepaymentReceived on SF
  console.log("\n[4] Scanning StabilityFund for DebtRepaymentReceived...");
  let totalSFReceived = 0n;
  let sfEvents = [];
  for (let from = fromBlock; from < blk; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, blk);
    const logs = await sf.queryFilter(sf.filters.DebtRepaymentReceived(), from, to).catch(() => []);
    for (const log of logs) {
      const amount = BigInt(log.args.amount ?? log.args[1] ?? 0n);
      totalSFReceived += amount;
      sfEvents.push({ block: log.blockNumber, matrix: log.args.matrix, amount });
    }
  }
  console.log(`  Events found: ${sfEvents.length}  totalReceived=$${(Number(totalSFReceived)/1e6).toFixed(4)}`);
  for (const e of sfEvents.slice(0, 5)) {
    console.log(`  block=${e.block}  matrix=${e.matrix}  amount=$${(Number(e.amount)/1e6).toFixed(4)}`);
  }

  // 5. Summary
  const totalRepaid = totalRepaidMatA + totalRepaidMatB;
  console.log("\n-- SUMMARY --");
  console.log(`  RescueLoanIssued (T1matA)    : ${loanEvents.length} events  $${(Number(totalIssued)/1e6).toFixed(4)}`);
  console.log(`  RescueDebtRepaid (T1matA)    : ${repaidEvents.length} events  $${(Number(totalRepaidMatA)/1e6).toFixed(4)}  [pre-V8.28 path]`);
  console.log(`  RescueDebtRepaid (T1matB)    : ${repaidMatBEvents.length} events  $${(Number(totalRepaidMatB)/1e6).toFixed(4)}  [V8.28 path -- should increase after deploy]`);
  console.log(`  DebtRepaymentReceived (SF)   : ${sfEvents.length} events  $${(Number(totalSFReceived)/1e6).toFixed(4)}`);
  if (totalIssued > 0n && totalSFReceived === 0n && totalRepaidMatB === 0n) {
    console.log("\n  STATUS: Loans issued but NO SF repayments yet.");
    if (repaidMatBEvents.length === 0) {
      console.log("  If on V8.27: bug is confirmed -- debt stored on MatA, MatB repayment never fires.");
      console.log("  Deploy V8.28 to fix: addRescueDebt() moves debt to MatB (destination).");
    }
  } else if (totalIssued === 0n) {
    console.log("\n  STATUS: No loan events found in this block range — try wider range or check addresses.");
  } else {
    const outstanding = totalIssued > totalRepaid ? totalIssued - totalRepaid : 0n;
    console.log("\n  STATUS: Repayments active. Outstanding debt: $" + (Number(outstanding)/1e6).toFixed(4));
  }
  console.log("\n-- done --");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
