// test_topup.js
// Tests topUpAndCross on the first N parked wallets in the T1 MatA parked queue.
// topUpAndCross: caller pays the full shortfall (entryFee - member.withdrawable).
// For wallets with $0 withdrawable, caller pays the full $10 T1 fee.
// No SF ladder involved — pure caller-funded rescue.
//
// Run: npx hardhat run scripts/test_topup.js --network baseSepolia
//
// Optional env:
//   MAX_RESCUES   max wallets to rescue (default: 5)

const { ethers } = require("hardhat");
require("dotenv").config();

const MATRIX_KEEPER = "0x3de9c7bD20cC82238BC39c98D7A1aC15dd1280df"; // V8.26
const T1_MAT_A      = "0xd5E3742bf458d5442027922DD63b00C98049f370"; // V8.26 T1 MatA
const USDC_ADDR     = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a"; // MockUSDC (unchanged)

const MAX_RESCUES = Number(process.env.MAX_RESCUES || 5);

const KEEPER_ABI = [
  "function checkUpkeep(bytes calldata checkData) external view returns (bool upkeepNeeded, bytes memory performData)",
];

const MATRIX_ABI = [
  "function topUpAndCross(address member) external",
  "function getMember(address member) external view returns (bool hasEverJoined, bool isInMatrix, uint256 withdrawable, uint256 parkedAt, uint256 memberID)",
  "function ENTRY_FEE() external view returns (uint256)",
  "function occupancy() external view returns (uint256)",
];

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const WORK_PARKED_RESCUE = 4;

function fmt6(n) { return "$" + (Number(n) / 1e6).toFixed(2); }

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider   = ethers.provider;

  console.log(`\n── test_topup.js ───────────────────────────────────────────`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`T1 MatA  : ${T1_MAT_A}`);
  console.log(`Max rescues: ${MAX_RESCUES}`);

  const keeper = new ethers.Contract(MATRIX_KEEPER, KEEPER_ABI, deployer);
  const matA   = new ethers.Contract(T1_MAT_A,      MATRIX_ABI, deployer);
  const usdc   = new ethers.Contract(USDC_ADDR,     USDC_ABI,   deployer);

  const entryFee = await matA.ENTRY_FEE();
  console.log(`T1 entry fee: ${fmt6(entryFee)}`);

  // ── Step 1: get parked wallets from checkUpkeep ──────────────────────────────
  console.log(`\n── Getting parked wallets from checkUpkeep ─────────────────`);
  let parkedAddrs = [];
  try {
    const [needed, performData] = await keeper.checkUpkeep("0x");
    if (!needed) {
      console.log("checkUpkeep says no work needed — trying direct queue scan.");
    } else {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const WI_TYPE = "tuple(uint8 workType, uint8 tierIndex, address addr1, address addr2)[]";
      const [items] = coder.decode([WI_TYPE], performData);
      for (const item of items) {
        if (Number(item.workType) === WORK_PARKED_RESCUE) {
          parkedAddrs.push(item.addr2); // addr2 = the parked member
        }
      }
      console.log(`Found ${parkedAddrs.length} parked wallets via checkUpkeep`);
    }
  } catch (e) {
    console.error(`checkUpkeep error: ${e.message.slice(0, 100)}`);
  }

  if (parkedAddrs.length === 0) {
    console.log("No parked wallets found — nothing to rescue.");
    return;
  }

  const targets = parkedAddrs.slice(0, MAX_RESCUES);
  console.log(`\nWill attempt topUpAndCross on ${targets.length} wallets:`);

  // ── Step 2: check each wallet's current state ────────────────────────────────
  console.log(`\n── Pre-rescue state ────────────────────────────────────────`);
  let totalShortfall = 0n;
  for (const addr of targets) {
    const m = await matA.getMember(addr);
    const shortfall = m.withdrawable >= entryFee ? 0n : entryFee - m.withdrawable;
    totalShortfall += shortfall;
    console.log(
      `  ${addr.slice(0,10)}  withdrawable=${fmt6(m.withdrawable)}  ` +
      `parkedAt=${m.parkedAt.toString()}  shortfall=${fmt6(shortfall)}`
    );
  }
  console.log(`Total shortfall to cover: ${fmt6(totalShortfall)}`);

  // ── Step 3: check deployer balance + approve ─────────────────────────────────
  const deployerUsdcBal = await usdc.balanceOf(deployer.address);
  console.log(`\nDeployer USDC balance: ${fmt6(deployerUsdcBal)}`);
  if (deployerUsdcBal < totalShortfall) {
    console.error(`Deployer has insufficient USDC. Need ${fmt6(totalShortfall)}, have ${fmt6(deployerUsdcBal)}.`);
    process.exit(1);
  }

  const currentAllowance = await usdc.allowance(deployer.address, T1_MAT_A);
  if (currentAllowance < totalShortfall) {
    console.log(`Approving T1 MatA for ${fmt6(totalShortfall)} USDC...`);
    const approveTx = await usdc.approve(T1_MAT_A, totalShortfall, { gasLimit: 100_000 });
    await approveTx.wait();
    console.log(`  Approved ✅`);
  } else {
    console.log(`Allowance already sufficient (${fmt6(currentAllowance)})`);
  }

  // ── Step 4: topUpAndCross each wallet ────────────────────────────────────────
  console.log(`\n── Calling topUpAndCross ────────────────────────────────────`);
  let succeeded = 0;
  let failed    = 0;
  const t1bBefore = await matA.occupancy(); // will stay 127 but cycles may trigger

  for (let i = 0; i < targets.length; i++) {
    const addr = targets[i];
    const m    = await matA.getMember(addr);
    const shortfall = m.withdrawable >= entryFee ? 0n : entryFee - m.withdrawable;

    process.stdout.write(
      `  [${i + 1}/${targets.length}] ${addr.slice(0,10)}  shortfall=${fmt6(shortfall)}  `
    );

    if (m.parkedAt === 0n) {
      console.log(`SKIP — no longer parked (keeper may have rescued already)`);
      continue;
    }

    // Approve exact shortfall for this call (top up allowance if needed)
    const allow = await usdc.allowance(deployer.address, T1_MAT_A);
    if (allow < shortfall) {
      await (await usdc.approve(T1_MAT_A, shortfall * 10n, { gasLimit: 100_000 })).wait();
    }

    try {
      const tx      = await matA.topUpAndCross(addr, { gasLimit: 3_000_000 });
      const receipt = await tx.wait();
      const ok      = receipt.status === 1;
      if (ok) {
        succeeded++;
        console.log(`✅  block=${receipt.blockNumber}  gas=${receipt.gasUsed.toLocaleString()}`);
      } else {
        failed++;
        console.log(`❌  TX reverted (status=0)`);
      }
    } catch (e) {
      failed++;
      const reason = e.reason ?? e.message?.slice(0, 120) ?? "unknown";
      console.log(`❌  ${reason}`);
    }

    // small delay between calls
    await new Promise(r => setTimeout(r, 3000));
  }

  // ── Step 5: post-rescue snapshot ─────────────────────────────────────────────
  console.log(`\n── Post-rescue state ───────────────────────────────────────`);
  for (const addr of targets) {
    const m = await matA.getMember(addr);
    const status = m.isInMatrix ? "IN MATRIX ✅" : (m.parkedAt > 0n ? "STILL PARKED ⚠" : "CYCLED OUT");
    console.log(`  ${addr.slice(0,10)}  isInMatrix=${m.isInMatrix}  parkedAt=${m.parkedAt}  → ${status}`);
  }

  const t1bAfter = await matA.occupancy();
  console.log(`\nT1 MatA occupancy: ${t1bBefore} → ${t1bAfter}`);

  console.log(`\n── Summary ─────────────────────────────────────────────────`);
  console.log(`  topUpAndCross calls: ${targets.length}`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);

  if (succeeded > 0) {
    console.log(`\n  ✅ topUpAndCross WORKING on V8.26`);
    console.log(`     Loan path confirmed — third party can rescue parked wallets.`);
  } else {
    console.log(`\n  ❌ All topUpAndCross calls failed — investigate above errors.`);
  }

  console.log(`\n── Done ────────────────────────────────────────────────────\n`);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
