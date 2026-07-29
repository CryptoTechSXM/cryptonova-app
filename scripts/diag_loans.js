// diag_loans.js
// Diagnoses whether SF loan repayments are actually hitting the chain.
// Checks:
//   1. Live stabilityFund() address wired into T1 MatA and MatB
//   2. RescueLoanIssued events (correct event — not CoPayRescue)
//   3. RescueDebtRepaid events on MatA and MatB
//   4. DebtRepaymentReceived events on the SF
//   5. Live rescueDebtOf() for the top 10 most-indebted members
//
// Run: npx hardhat run scripts/diag_loans.js --network baseSepolia

const hre = require("hardhat");
require("dotenv").config();

const ADDRS = {
  T1matA: "0x6dd24D0268F9eD11BC9036d490AE4D58B9764e0b",
  T1matB: "0x6ddF0BF97CEd7D1585dE09ED1238A5d6Ed877Eb8",
  sf:     "0xef9D5aF4baa2cA1160aA2B3285aeD4F312C62aC7",
};

const MATRIX_ABI = [
  "function stabilityFund() external view returns (address)",
  "function rescueDebtOf(address member) external view returns (uint256)",
  "function getParkedCount() external view returns (uint256)",
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
];

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
  "event DebtRepaymentReceived(address indexed from, uint256 amount)",
  "event ForceCrossFunded(address indexed matrix, uint256 amount)",
];

function fmt(n) { return (Number(n) / 1e6).toFixed(2); }

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const provider  = hre.ethers.provider;

  const matA = new hre.ethers.Contract(ADDRS.T1matA, MATRIX_ABI, signer);
  const matB = new hre.ethers.Contract(ADDRS.T1matB, MATRIX_ABI, signer);
  const sf   = new hre.ethers.Contract(ADDRS.sf,     SF_ABI,     signer);

  const latest   = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 200_000); // ~4 days of Base Sepolia
  console.log(`Scanning blocks ${fromBlock} → ${latest} (~${latest - fromBlock} blocks)\n`);

  // ── 1. Verify SF is wired into the matrix ──────────────────────────────────
  console.log("=== SF wiring check ===");
  const sfInMatA = await matA.stabilityFund().catch(() => "ERROR");
  const sfInMatB = await matB.stabilityFund().catch(() => "ERROR");
  const sfMatch  = sfInMatA.toLowerCase() === ADDRS.sf.toLowerCase();
  console.log(`  T1 MatA.stabilityFund() = ${sfInMatA}  ${sfMatch ? "✓ MATCH" : "✗ MISMATCH"}`);
  console.log(`  T1 MatB.stabilityFund() = ${sfInMatB}  ${sfInMatB.toLowerCase() === ADDRS.sf.toLowerCase() ? "✓ MATCH" : "✗ MISMATCH"}`);
  console.log(`  Expected SF addr        = ${ADDRS.sf}`);

  // ── 2. SF balance ──────────────────────────────────────────────────────────
  console.log("\n=== SF balance ===");
  const sfBal   = await sf.totalBalance().catch(() => 0n);
  const sfFloor = await sf.stabilityFloor().catch(() => 0n);
  console.log(`  totalBalance  = $${fmt(sfBal)}`);
  console.log(`  stabilityFloor = $${fmt(sfFloor)}`);
  console.log(`  Available above floor = $${fmt(sfBal > sfFloor ? sfBal - sfFloor : 0n)}`);

  // ── 3. RescueLoanIssued events ─────────────────────────────────────────────
  console.log("\n=== RescueLoanIssued events (correct loan event) ===");
  const loanLogsA = await matA.queryFilter(matA.filters.RescueLoanIssued(), fromBlock, latest).catch(() => []);
  const loanLogsB = await matB.queryFilter(matB.filters.RescueLoanIssued(), fromBlock, latest).catch(() => []);
  const allLoans  = [...loanLogsA, ...loanLogsB].sort((a, b) => a.blockNumber - b.blockNumber);

  let totalLoaned = 0n;
  const debtByMember = new Map();
  for (const ev of allLoans) {
    const { member, loanAmount, rescueType } = ev.args;
    totalLoaned += loanAmount;
    debtByMember.set(member, (debtByMember.get(member) || 0n) + loanAmount);
  }
  console.log(`  MatA loan events: ${loanLogsA.length}`);
  console.log(`  MatB loan events: ${loanLogsB.length}`);
  console.log(`  Total events:     ${allLoans.length}`);
  console.log(`  Total loaned:     $${fmt(totalLoaned)}`);

  // ── 4. RescueDebtRepaid events on matrices ─────────────────────────────────
  console.log("\n=== RescueDebtRepaid events (on-matrix repayment trigger) ===");
  const repaidLogsA = await matA.queryFilter(matA.filters.RescueDebtRepaid(), fromBlock, latest).catch(() => []);
  const repaidLogsB = await matB.queryFilter(matB.filters.RescueDebtRepaid(), fromBlock, latest).catch(() => []);
  const allRepaid   = [...repaidLogsA, ...repaidLogsB].sort((a, b) => a.blockNumber - b.blockNumber);

  let totalRepaid = 0n;
  for (const ev of allRepaid) {
    const { member, repaid, remaining } = ev.args;
    totalRepaid += repaid;
    console.log(`  block=${ev.blockNumber}  ${member.slice(0,10)}...  repaid=$${fmt(repaid)}  remaining=$${fmt(remaining)}`);
  }
  if (allRepaid.length === 0) console.log("  ⚠  NO RescueDebtRepaid events found — repayments have not fired yet");
  console.log(`  Total repaid (matrix events): $${fmt(totalRepaid)}`);

  // ── 5. DebtRepaymentReceived on SF ─────────────────────────────────────────
  console.log("\n=== DebtRepaymentReceived events (SF side) ===");
  const sfRepayLogs = await sf.queryFilter(sf.filters.DebtRepaymentReceived(), fromBlock, latest).catch(() => []);
  let sfTotalReceived = 0n;
  for (const ev of sfRepayLogs) {
    sfTotalReceived += ev.args.amount;
    console.log(`  block=${ev.blockNumber}  from=${ev.args.from.slice(0,10)}...  amount=$${fmt(ev.args.amount)}`);
  }
  if (sfRepayLogs.length === 0) console.log("  ⚠  NO DebtRepaymentReceived events on SF — SF has received nothing back");
  console.log(`  SF total received: $${fmt(sfTotalReceived)}`);

  // ── 6. Live rescueDebtOf() for top indebted members ───────────────────────
  console.log("\n=== Live rescueDebtOf() — members with debt ===");
  let checkedA = 0, checkedB = 0, liveTotal = 0n;
  const checked = new Set();

  for (const [member] of debtByMember) {
    if (checked.has(member)) continue;
    checked.add(member);
    const debtA = await matA.rescueDebtOf(member).catch(() => 0n);
    const debtB = await matB.rescueDebtOf(member).catch(() => 0n);
    const debt  = debtA + debtB;
    liveTotal += debt;
    if (debt > 0n) {
      console.log(`  ${member.slice(0,10)}...  debt=$${fmt(debt)}  (MatA=$${fmt(debtA)}  MatB=$${fmt(debtB)})`);
      checkedA++;
    }
  }
  console.log(`  Members with live debt: ${checkedA} / ${checked.size} checked`);
  console.log(`  Total live debt on-chain: $${fmt(liveTotal)}`);

  // ── 7. Summary ─────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║               REPAYMENT DIAGNOSIS                   ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  SF wired correctly:      ${sfMatch ? "YES ✓" : "NO ✗ — THIS IS THE BUG"}           ║`);
  console.log(`║  Total loaned:            $${fmt(totalLoaned).padStart(10)}              ║`);
  console.log(`║  RescueDebtRepaid events: ${String(allRepaid.length).padStart(6)}                   ║`);
  console.log(`║  SF received back:        $${fmt(sfTotalReceived).padStart(10)}              ║`);
  console.log(`║  Live outstanding debt:   $${fmt(liveTotal).padStart(10)}              ║`);
  console.log(`║  SF current balance:      $${fmt(sfBal).padStart(10)}              ║`);
  console.log("╚══════════════════════════════════════════════════════╝");

  if (allRepaid.length === 0 && allLoans.length > 0) {
    console.log("\n⚠  DIAGNOSIS: Loans issued but ZERO repayments on-chain.");
    console.log("   Possible causes:");
    console.log("   A) Rescued members haven't reached MatA root position yet");
    console.log("   B) stabilityFund address mismatch on matrix (check wiring above)");
    console.log("   C) Members cross MatA→MatB with exactly $10 withdrawable (nothing left for repayment)");
    console.log("   D) receiveDebtRepayment() in SF reverts silently (check SF floor/balance)");
  }
}

main().catch(console.error);
