// validate_loans.js
// Validates the V8.26 rescueDebt (loan) system end-to-end.
//
// What we verify:
//   1. RescueLoanIssued events — SF covered shortfall, debt recorded per member
//   2. Current rescueDebtOf() — outstanding balance per rescued member
//   3. RescueDebtRepaid events — debt repaid at cycle-out, USDC returned to SF
//   4. SF receiveDebtRepayment events — SF received repayments
//   5. Summary: total loaned, total repaid, outstanding, % recovered
//
// Run: npx hardhat run scripts/validate_loans.js --network baseSepolia

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ── addresses ──────────────────────────────────────────────────────────────
// ADDRESSES_FILE in .env is a bare filename — actual file lives in scripts/
const _addrName = process.env.ADDRESSES_FILE || "deployed_addresses_v8_26.json";
const addrFile  = fs.existsSync(_addrName)
  ? _addrName
  : path.join(__dirname, _addrName);
const addrs    = JSON.parse(fs.readFileSync(addrFile, "utf8"));

// Structure: addrs.tiers.T1.matA / matB
const T1_MATA    = addrs.tiers?.T1?.matA || addrs.t1MatA;
const T1_MATB    = addrs.tiers?.T1?.matB || addrs.t1MatB;
const SF_ADDR    = addrs.stabilityFund || addrs.StabilityFund;

if (!T1_MATA) { console.error("T1 MatA not found in", addrFile, "\nKeys:", JSON.stringify(Object.keys(addrs))); process.exit(1); }
if (!SF_ADDR) { console.error("StabilityFund not found in", addrFile); process.exit(1); }

// Validate loans on both T1 matrices (MatA active + MatB active)
// The keeper rescues from whichever matrix the member is parked in.
// We'll check both and merge results.
const MATRICES = [];
if (T1_MATA) MATRICES.push({ name: "T1 MatA", addr: T1_MATA });
if (T1_MATB) MATRICES.push({ name: "T1 MatB", addr: T1_MATB });

console.log("Matrices to scan:", MATRICES.map(m => `${m.name}=${m.addr}`).join(", "));

// ── ABIs ───────────────────────────────────────────────────────────────────
const MATRIX_ABI = [
  "function rescueDebtOf(address member) external view returns (uint256)",
  "function memberInfo(address member) external view returns (bool hasEverJoined, bool isInMatrix, uint256 withdrawable, uint256 cyclesCompleted, uint8 matrixIndex, uint256 matrixPos)",
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
  "event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex)",
];

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function balance() external view returns (uint256)",
  "event DebtRepaymentReceived(address indexed from, uint256 amount)",
];

function fmt(n) { return (Number(n) / 1e6).toFixed(2); }

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const sf       = new hre.ethers.Contract(SF_ADDR, SF_ABI, signer);

  console.log("=== V8.26 Loan System Validation ===");
  console.log("SF        :", SF_ADDR);

  // ── SF current balance ────────────────────────────────────────────────────
  let sfBal = 0n;
  try { sfBal = await sf.totalBalance(); }
  catch { try { sfBal = await sf.balance(); } catch {} }
  console.log("\nSF current balance :", fmt(sfBal), "USDC");

  // ── Pull events from all matrices ─────────────────────────────────────────
  const provider    = hre.ethers.provider;
  const latestBlock = Number(await provider.getBlockNumber());
  const fromBlock   = Math.max(0, latestBlock - 50_000); // ~3 days of Base Sepolia blocks
  console.log(`\nScanning blocks ${fromBlock} → ${latestBlock} (~${latestBlock - fromBlock} blocks)`);

  const loanByMember   = new Map();
  const repaidByMember = new Map();
  let totalLoaned = 0n;
  let totalRepaid = 0n;
  const matrixForMember = new Map(); // track which matrix the member belongs to

  for (const { name, addr } of MATRICES) {
    const matrix = new hre.ethers.Contract(addr, MATRIX_ABI, signer);
    console.log(`\n--- ${name} (${addr}) ---`);

    const loanEvents   = await matrix.queryFilter(matrix.filters.RescueLoanIssued(), fromBlock, latestBlock);
    const repaidEvents = await matrix.queryFilter(matrix.filters.RescueDebtRepaid(), fromBlock, latestBlock);

    console.log(`  RescueLoanIssued : ${loanEvents.length}`);
    for (const ev of loanEvents) {
      const { member, loanAmount, rescueType } = ev.args;
      const existing = loanByMember.get(member) || { total: 0n, type: rescueType, matrix };
      existing.total += loanAmount;
      loanByMember.set(member, existing);
      matrixForMember.set(member, matrix);
      totalLoaned += loanAmount;
      console.log(`    block=${ev.blockNumber}  ${member.slice(0,10)}...  $${fmt(loanAmount)}  [${rescueType}]`);
    }

    console.log(`  RescueDebtRepaid : ${repaidEvents.length}`);
    for (const ev of repaidEvents) {
      const { member, repaid, remaining } = ev.args;
      repaidByMember.set(member, (repaidByMember.get(member) || 0n) + repaid);
      totalRepaid += repaid;
      console.log(`    block=${ev.blockNumber}  ${member.slice(0,10)}...  repaid=$${fmt(repaid)}  remaining=$${fmt(remaining)}`);
    }
  }

  // ── Live on-chain debt per rescued member ─────────────────────────────────
  console.log(`\n=== Live rescueDebtOf() per rescued member ===`);
  const members = [...loanByMember.keys()];
  let totalOutstanding = 0n;

  for (const member of members) {
    const matrix = matrixForMember.get(member);
    const debt   = await matrix.rescueDebtOf(member);
    let info;
    try { info = await matrix.memberInfo(member); } catch { info = null; }
    totalOutstanding += debt;

    const loaned   = loanByMember.get(member)?.total || 0n;
    const repaid   = repaidByMember.get(member) || 0n;
    const inMatrix = info ? info.isInMatrix : "?";
    const cycles   = info ? Number(info.cyclesCompleted) : "?";
    const matIdx   = info ? Number(info.matrixIndex) : "?"; // 0=MatA, 1=MatB
    const matLabel = matIdx === 0 ? "MatA" : matIdx === 1 ? "MatB" : "?";

    console.log(
      `  ${member.slice(0,10)}...` +
      `  loaned=$${fmt(loaned)}` +
      `  repaid=$${fmt(repaid)}` +
      `  live_debt=$${fmt(debt)}` +
      `  inMatrix=${inMatrix}` +
      `  mat=${matLabel}` +
      `  cycles=${cycles}`
    );
  }

  // ── SF repayment receipts ─────────────────────────────────────────────────
  let sfRepayReceived = 0n;
  try {
    const sfRepayFilter = sf.filters.DebtRepaymentReceived();
    const sfRepayEvents = await sf.queryFilter(sfRepayFilter, fromBlock, latestBlock);
    for (const ev of sfRepayEvents) sfRepayReceived += ev.args.amount;
    if (sfRepayEvents.length > 0) {
      console.log(`\n=== SF DebtRepaymentReceived events: ${sfRepayEvents.length} ===`);
      for (const ev of sfRepayEvents) {
        console.log(`  block=${ev.blockNumber}  amount=$${fmt(ev.args.amount)}`);
      }
    }
  } catch {}

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║           LOAN SYSTEM SUMMARY                  ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Members with loans issued   : ${String(members.length).padStart(6)}              ║`);
  console.log(`║  Total loaned by SF          : $${fmt(totalLoaned).padStart(10)}        ║`);
  console.log(`║  Total repaid to SF          : $${fmt(totalRepaid).padStart(10)}        ║`);
  console.log(`║  SF repayments received      : $${fmt(sfRepayReceived).padStart(10)}        ║`);
  console.log(`║  Outstanding debt (live)     : $${fmt(totalOutstanding).padStart(10)}        ║`);
  const pct = totalLoaned > 0n ? Number(totalRepaid * 10000n / totalLoaned) / 100 : 0;
  console.log(`║  Recovery rate               : ${String(pct.toFixed(1) + "%").padStart(8)}            ║`);
  console.log(`║  SF current balance          : $${fmt(sfBal).padStart(10)}        ║`);
  console.log("╚══════════════════════════════════════════════════╝");

  if (loanEvents.length === 0) {
    console.log("\nNOTE: No RescueLoanIssued events found in scan window.");
    console.log("  → Either no loans have been issued yet, or they're outside the 50k block window.");
    console.log("  → Try increasing fromBlock range or checking the correct matrix address.");
  }
}

main().catch(console.error);
