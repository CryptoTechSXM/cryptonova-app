/**
 * diagnose_revert.js
 * Registers 15 wallets into T1, then attempts wallet[14] and captures the EXACT revert.
 * Uses provider.call() to get raw revert data, then tries eth_call trace.
 *
 * Run: npx hardhat run scripts/diagnose_revert.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const ADDRS_FILE = path.join(__dirname, "deployed_addresses_v8.json");

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const MNEMONIC    = "test test test test test test test test test test test junk";
const HDR_OFFSET  = 500;
const ETH_PER     = ethers.parseEther("0.01");
const T1_FEE      = 10_000_000n; // $10 USDC (6 dec)

function makeWallets(count) {
  return Array.from({ length: count }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i + HDR_OFFSET}`)
  );
}

async function main() {
  const addrs  = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider   = ethers.provider;

  const usdcAbi = [
    "function mint(address to, uint256 amount) external",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address) external view returns (uint256)",
  ];
  const routerAbi = [
    "function register(address referrer) external",
    "function globalJoined(address) external view returns (bool)",
  ];
  const matrixAbi = [
    "function occupancy() external view returns (uint256)",
    "function MATRIX_SIZE() external view returns (uint256)",
    "function escrowBalance(address) external view returns (uint256)",
    "function members(address) external view returns (uint256 id, address referrer, address l2, address l3, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined)",
    "function posToMember(uint256) external view returns (address)",
    "function nextSlot() external view returns (uint256)",
  ];
  const pmAbi = [
    "function totalRegistrations() external view returns (uint256)",
  ];

  const usdc      = new ethers.Contract(addrs.USDC,            usdcAbi,   deployer);
  const tierRouter = new ethers.Contract(addrs.TierRouter,     routerAbi, deployer);
  const matA      = new ethers.Contract(addrs.T1.MatrixA,      matrixAbi, deployer);
  const matB      = new ethers.Contract(addrs.T1.MatrixB,      matrixAbi, deployer);
  const pm1       = new ethers.Contract(addrs.T1.PairManager,  pmAbi,     deployer);

  const W1_ADDR = addrs.AccountOne;

  // ── Snapshot current state ─────────────────────────────────────────────────
  const occA   = await matA.occupancy();
  const occB   = await matB.occupancy();
  const msize  = await matA.MATRIX_SIZE();
  const totalR = await pm1.totalRegistrations();

  console.log("=== Current chain state ===");
  console.log(`MatA occupancy:  ${occA} / ${msize}`);
  console.log(`MatB occupancy:  ${occB} / ${msize}`);
  console.log(`Total registered: ${totalR}`);

  // Check W1 state in MatA
  const w1EscrowA = await matA.escrowBalance(W1_ADDR);
  const w1MembA   = await matA.members(W1_ADDR);
  console.log(`W1 escrow in MatA: $${Number(w1EscrowA)/1e6}`);
  console.log(`W1 isInMatrix MatA: ${w1MembA.isInMatrix}`);
  console.log(`W1 hasEverJoined MatA: ${w1MembA.hasEverJoined}`);

  // Which slot is the next available?
  const nextSlotA = await matA.nextSlot();
  console.log(`MatA nextSlot: ${nextSlotA}`);
  console.log(`MatA pos[1]: ${await matA.posToMember(1)}`);

  // ── Find wallets that haven't registered yet ────────────────────────────────
  const wallets   = makeWallets(60);
  const unjoined  = [];
  for (const w of wallets) {
    const joined = await tierRouter.globalJoined(w.address);
    if (!joined) unjoined.push(w);
    if (unjoined.length >= 2) break; // we only need up to 2 unjoined for the test
  }

  if (unjoined.length === 0) {
    console.log("All wallets already registered — nothing to test");
    return;
  }

  console.log(`\nFound ${unjoined.length} unjoined wallet(s) to test with`);

  // ── If MatA is not yet full, fund and fill it ───────────────────────────────
  const remaining = Number(msize) - Number(occA);
  console.log(`\nMatA needs ${remaining} more members to fill`);

  if (remaining > 0 && unjoined.length < remaining + 1) {
    console.log("Not enough unjoined wallets — increase wallet count at top of script");
    return;
  }

  // Fund wallets that need it
  const toFund = unjoined.slice(0, Math.min(remaining + 1, unjoined.length));
  console.log(`\nFunding ${toFund.length} wallets...`);
  let nonce = await provider.getTransactionCount(deployer.address, "pending");
  const ethTxs = await Promise.all(
    toFund.map((w, j) =>
      deployer.sendTransaction({ to: w.address, value: ETH_PER, nonce: nonce + j })
    )
  );
  nonce += toFund.length;
  await Promise.all(ethTxs.map(tx => tx.wait()));
  console.log("ETH funded");

  await sleep(4000); // RPC lag

  // Mint USDC
  const mintTxs = await Promise.all(
    toFund.map((w, j) =>
      usdc.mint(w.address, T1_FEE * 2n, { nonce: nonce + j })
    )
  );
  nonce += toFund.length;
  await Promise.all(mintTxs.map(tx => tx.wait()));
  console.log("USDC minted");

  await sleep(3000);

  // Approve PairManager & register — fill up to MATRIX_SIZE
  for (let i = 0; i < remaining && i < toFund.length; i++) {
    const w       = toFund[i];
    const conn    = w.connect(provider);
    const usdcW   = usdc.connect(conn);
    const routerW = tierRouter.connect(conn);

    const bal = await provider.getBalance(w.address);
    console.log(`  [fill ${i+1}/${remaining}] ${w.address.slice(0,10)} ETH=${ethers.formatEther(bal)}`);

    const allowance = await usdc.allowance(w.address, addrs.T1.PairManager);
    if (allowance < T1_FEE) {
      await (await usdcW.approve(addrs.T1.PairManager, T1_FEE * 10n)).wait();
    }
    const tx = await routerW.register(W1_ADDR);
    await tx.wait();
    console.log(`    ✓ registered`);
  }

  // ── Now the CRITICAL test: the cycle-out wallet ─────────────────────────────
  const triggerWallet = toFund[remaining];
  if (!triggerWallet) {
    console.log("\nNo cycle-out trigger wallet — re-run with more wallets");
    return;
  }

  const occ2 = await matA.occupancy();
  console.log(`\nMatA occupancy after fill: ${occ2} / ${msize}`);
  console.log(`Cycle-out trigger wallet: ${triggerWallet.address}`);

  // State inspection BEFORE trigger
  const w1EscrowBefore = await matA.escrowBalance(W1_ADDR);
  const w1WithdBefore  = (await matA.members(W1_ADDR)).withdrawable;
  console.log(`W1 escrow before trigger: $${Number(w1EscrowBefore)/1e6}`);
  console.log(`W1 withdrawable before trigger: $${Number(w1WithdBefore)/1e6}`);
  console.log(`W1 escrow + withdrawable: $${(Number(w1EscrowBefore) + Number(w1WithdBefore))/1e6}`);
  console.log(`T1 ENTRY_FEE (reentry needed): $10`);

  const connTrigger    = triggerWallet.connect(provider);
  const usdcTrigger    = usdc.connect(connTrigger);
  const routerTrigger  = tierRouter.connect(connTrigger);

  // Ensure trigger wallet has allowance
  const allowT = await usdc.allowance(triggerWallet.address, addrs.T1.PairManager);
  if (allowT < T1_FEE) {
    console.log("  Approving PairManager for trigger wallet...");
    await (await usdcTrigger.approve(addrs.T1.PairManager, T1_FEE * 10n)).wait();
  }

  // ── Attempt 1: callStatic to get revert reason ─────────────────────────────
  console.log("\n=== callStatic test (should capture revert reason) ===");
  try {
    await routerTrigger.register.staticCall(W1_ADDR);
    console.log("callStatic PASSED — no revert (unexpected)");
  } catch (e) {
    console.log("callStatic REVERTED");
    console.log("  e.code:       ", e.code);
    console.log("  e.reason:     ", e.reason);
    console.log("  e.data:       ", e.data);
    console.log("  e.message:    ", e.message?.slice(0, 300));
    if (e.transaction) console.log("  e.transaction.data:", e.transaction?.data?.slice(0,20));
  }

  // ── Attempt 2: raw provider.call() for revert data ────────────────────────
  console.log("\n=== Raw provider.call() ===");
  const iface = new ethers.Interface(routerAbi);
  const calldata = iface.encodeFunctionData("register", [W1_ADDR]);
  try {
    const result = await provider.call({
      from: triggerWallet.address,
      to:   addrs.TierRouter,
      data: calldata,
    });
    console.log("provider.call() succeeded:", result);
  } catch (e) {
    console.log("provider.call() REVERTED");
    console.log("  raw data: ", e.data ?? e.info?.error?.data ?? "none");
    // Try to decode as Error(string)
    if (e.data && e.data.startsWith("0x08c379a0")) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string"],
        "0x" + e.data.slice(10)
      );
      console.log("  Decoded Error(string):", decoded[0]);
    }
    // Try Panic
    if (e.data && e.data.startsWith("0x4e487b71")) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        "0x" + e.data.slice(10)
      );
      console.log("  Decoded Panic code:", decoded[0].toString(), "(1=assert, 17=overflow, 18=divZero, 32=OOB, 50=emptyArray, 65=allocTooLarge)");
    }
    console.log("  e.message:", e.message?.slice(0, 400));
  }

  // ── Attempt 3: estimateGas ─────────────────────────────────────────────────
  console.log("\n=== estimateGas ===");
  try {
    const gas = await provider.estimateGas({
      from: triggerWallet.address,
      to:   addrs.TierRouter,
      data: calldata,
    });
    console.log("estimateGas succeeded:", gas.toString());
  } catch (e) {
    console.log("estimateGas REVERTED");
    console.log("  data:", e.data ?? e.info?.error?.data ?? "none");
    console.log("  msg: ", e.message?.slice(0, 400));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
