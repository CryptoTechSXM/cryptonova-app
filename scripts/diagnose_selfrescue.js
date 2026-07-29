"use strict";
/**
 * diagnose_selfrescue.js — Why does selfRescue() revert for all T1.1 MatA parked wallets?
 *
 * No MNEMONIC needed — pulls parked addresses directly from the contract.
 *
 * Run:
 *   npx hardhat run scripts/diagnose_selfrescue.js --network baseSepolia
 *
 * Optional env overrides:
 *   ADDRESSES_FILE=deployed_addresses_v8_37.json   (default)
 *   PARKED_ADDR=0x...    skip scan, use this address directly
 */
const { ethers } = require("hardhat");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

// ── Known revert selectors ───────────────────────────────────────────────────
const SELECTORS = {
  "0x08c379a0": "Error(string)",
  "0x4e487b71": "Panic(uint256)",
  "0x5274afe7": "SafeERC20FailedOperation(address)",
  "0xe450d38c": "ERC20InsufficientBalance(address,uint256,uint256)",
  "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
};
const PANIC_CODES = {
  1:"assertion",17:"overflow/underflow",18:"div-by-zero",
  34:"array out-of-bounds",50:"pop empty array",65:"too much memory",
};

const fmt6 = n => "$" + (Number(n) / 1e6).toFixed(4);

function decodeRevert(hex) {
  if (!hex || hex === "0x" || hex === "") return "(empty — bare revert() or OOG)";
  const sel = hex.slice(0, 10).toLowerCase();
  const pay = "0x" + hex.slice(10);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  try {
    if (sel === "0x08c379a0") {
      const [msg] = abi.decode(["string"], pay);
      return `Error(string): "${msg}"`;
    }
    if (sel === "0x4e487b71") {
      const [code] = abi.decode(["uint256"], pay);
      return `Panic(${code}): ${PANIC_CODES[Number(code)] || "unknown"}`;
    }
    if (sel === "0x5274afe7") {
      const [token] = abi.decode(["address"], pay);
      return `SafeERC20FailedOperation: token=${token}`;
    }
    if (sel === "0xe450d38c") {
      const [acct, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientBalance: account=${acct}  have=${fmt6(have)}  need=${fmt6(need)}`;
    }
    if (sel === "0xfb8f41b2") {
      const [spender, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientAllowance: spender=${spender}  allowance=${fmt6(have)}  needed=${fmt6(need)}`;
    }
    return `UNKNOWN selector ${sel}  (raw: ${hex.slice(0, 130)})`;
  } catch (e) {
    return `${SELECTORS[sel] || sel}  (decode failed: ${e.message?.slice(0,60)})  raw=${hex.slice(0,130)}`;
  }
}

function extractData(err) {
  for (const v of [err?.data, err?.error?.data, err?.info?.error?.data]) {
    if (typeof v === "string" && v.length >= 2) return v;
  }
  return null;
}

async function main() {
  const addrs     = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const T1        = addrs.tiers?.T1 || { matA: addrs.T1?.matA, matB: addrs.T1?.matB };
  const SF_ADDR   = addrs.stabilityFund;
  const USDC_ADDR = addrs.usdc || addrs.USDC;
  const TR_ADDR   = addrs.treasury || addrs.CNOVATreasury;

  const usdc     = await ethers.getContractAt("MockUSDC",            USDC_ADDR);
  const matA1    = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const matB1    = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);
  const sf       = SF_ADDR ? await ethers.getContractAt("StabilityFund",  SF_ADDR) : null;
  const treasury = TR_ADDR ? await ethers.getContractAt("CNOVATreasury",  TR_ADDR) : null;

  // ── 1. Find a parked address in T1.1 MatA ──────────────────────────────────
  console.log("\n════ 1. Finding parked wallet in T1.1 MatA ════");
  let parkedAddr = process.env.PARKED_ADDR || null;

  if (!parkedAddr) {
    const count = await matA1.getParkedCount();
    console.log(`parkedMembers.length = ${count}`);
    if (count === 0n) {
      console.log("No parked members in T1.1 MatA — nothing to rescue.");
      return;
    }
    // Pick the first one that still has parkedAt > 0
    for (let i = 0; i < count; i++) {
      const addr = await matA1.getParkedMember(i);
      const ts   = await matA1.parkedAt(addr);
      if (ts > 0n) { parkedAddr = addr; break; }
    }
  }

  if (!parkedAddr) {
    console.log("All parkedMembers entries have parkedAt=0 (already resolved).");
    return;
  }

  const m     = await matA1.getMember(parkedAddr);
  const usdcW = await usdc.balanceOf(parkedAddr);
  console.log(`Using parked address: ${parkedAddr}`);
  console.log(`  hasEverJoined=${m.hasEverJoined}  isInMatrix=${m.isInMatrix}`);
  console.log(`  withdrawable=${fmt6(m.withdrawable)}  crossingReserve=${fmt6(m.crossingReserve)}`);
  console.log(`  wallet USDC=${fmt6(usdcW)}`);

  // ── 2. USDC balances ────────────────────────────────────────────────────────
  console.log("\n════ 2. USDC balances ════");
  const matA1Bal = await usdc.balanceOf(T1.matA);
  const matB1Bal = await usdc.balanceOf(T1.matB);
  console.log(`T1.1 MatA  ${fmt6(matA1Bal)}`);
  console.log(`T1.1 MatB  ${fmt6(matB1Bal)}`);
  if (TR_ADDR)  console.log(`Treasury   ${fmt6(await usdc.balanceOf(TR_ADDR))}`);
  if (SF_ADDR)  console.log(`SF         ${fmt6(await usdc.balanceOf(SF_ADDR))}`);

  // ── 3. T1.1 MatB state ─────────────────────────────────────────────────────
  console.log("\n════ 3. T1.1 MatB state ════");
  const occ  = await matB1.occupancy();
  const pool = await matB1.poolAccumulator();
  const rot  = await matB1.rotationCount();
  const sfSet = await matB1.stabilityFund();
  console.log(`occupancy       ${occ} / 127`);
  console.log(`poolAccumulator ${fmt6(pool)}`);
  console.log(`rotationCount   ${rot}`);
  console.log(`stabilityFund   ${sfSet}`);

  // ── 4. T1.1 MatB root ──────────────────────────────────────────────────────
  console.log("\n════ 4. T1.1 MatB root (pos 1) ════");
  const root = await matB1.posToMember(1);
  console.log(`root = ${root}`);
  if (root !== ethers.ZeroAddress) {
    const rm   = await matB1.getMember(root);
    const debt = await matB1.rescueDebtOf(root);
    console.log(`  withdrawable=${fmt6(rm.withdrawable)}  crossingReserve=${fmt6(rm.crossingReserve)}`);
    console.log(`  rescueDebt=${fmt6(debt)}  isInMatrix=${rm.isInMatrix}`);
  }

  // ── 5. Scan T1.1 MatB for rescueDebt ───────────────────────────────────────
  console.log("\n════ 5. T1.1 MatB rescueDebt scan (pos 1–127) ════");
  let totalDebt = 0n, debtCount = 0;
  for (let pos = 1; pos <= 127; pos++) {
    const addr = await matB1.posToMember(pos);
    if (addr === ethers.ZeroAddress) continue;
    const d = await matB1.rescueDebtOf(addr);
    if (d > 0n) {
      const mm = await matB1.getMember(addr);
      console.log(`  pos=${String(pos).padStart(3)}  ${addr.slice(0,10)}…  debt=${fmt6(d)}  withdrawable=${fmt6(mm.withdrawable)}`);
      totalDebt += d; debtCount++;
    }
  }
  console.log(debtCount === 0
    ? "  (no rescue debt — pendingRepayment path will NOT fire)"
    : `  TOTAL: ${debtCount} members, sum=${fmt6(totalDebt)}`);

  // ── 6. Authorization checks ─────────────────────────────────────────────────
  console.log("\n════ 6. Authorization ════");
  if (sf) {
    console.log(`MatB auth in SF:       ${await sf.authorizedMatrices(T1.matB)}`);
    console.log(`MatA auth in SF:       ${await sf.authorizedMatrices(T1.matA)}`);
    console.log(`SF rescueRepayBps:     ${await sf.rescueRepayBps()}`);
  }
  if (treasury) {
    console.log(`MatB auth in Treasury: ${await treasury.authorizedCallers(T1.matB)}`);
    console.log(`MatA auth in Treasury: ${await treasury.authorizedCallers(T1.matA)}`);
  }

  // ── 7. Raw revert call ──────────────────────────────────────────────────────
  console.log("\n════ 7. Raw selfRescue() revert ════");
  console.log(`Simulating selfRescue on T1.1 MatA  from=${parkedAddr}`);
  const calldata = matA1.interface.encodeFunctionData("selfRescue", []);

  try {
    await ethers.provider.call({ to: T1.matA, from: parkedAddr, data: calldata, gas: "0xE4E1C0" });
    console.log("CALL SUCCEEDED — no revert (unexpected!)");
  } catch (err) {
    const raw = extractData(err);
    console.log(`raw hex : ${raw ?? "(not in error object)"}`);
    console.log(`decoded : ${raw ? decodeRevert(raw) : "—"}`);
    if (!raw) {
      // Dump everything we have for manual inspection
      console.log(`code    : ${err.code}`);
      console.log(`short   : ${err.shortMessage}`);
      console.log(`message : ${err.message?.slice(0, 300)}`);
    }
  }

  // ── 8. State-override call: simulate WITH allowance set ─────────────────────
  // Bigfill wallets DO have approve($15) set before their static call, so their
  // failure is at a later step.  Override the allowance to $15 here and re-run
  // to see what fails AFTER the shortfall pull succeeds.
  console.log("\n════ 8. State-override call (allowance injected = $15) ════");
  try {
    // OZ v5 ERC20: _allowances is at storage slot 1.
    // slot = keccak256(abi.encode(MatA_addr, keccak256(abi.encode(parkedAddr, 1))))
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const innerSlot = ethers.keccak256(abi.encode(['address','uint256'], [parkedAddr, 1]));
    const allowSlot = ethers.keccak256(abi.encode(['address','bytes32'], [T1.matA, innerSlot]));
    const allowVal  = '0x' + (15_000_000).toString(16).padStart(64, '0'); // $15

    const overrideResp = await ethers.provider.send('eth_call', [
      { to: T1.matA, from: parkedAddr, data: calldata, gas: '0xE4E1C0' },
      'latest',
      { [USDC_ADDR]: { stateDiff: { [allowSlot]: allowVal } } }
    ]);
    console.log(`CALL SUCCEEDED with override!  return=${overrideResp}`);
  } catch (ov) {
    const od = extractData(ov);
    console.log(`raw hex : ${od ?? "(not in error object)"}`);
    console.log(`decoded : ${od ? decodeRevert(od) : "—"}`);
    if (!od) {
      // RPC may return error differently — check ov.error.data
      const nested = ov?.error?.data || ov?.info?.error?.data || ov?.body;
      console.log(`nested  : ${JSON.stringify(nested)?.slice(0,300)}`);
      console.log(`message : ${ov.message?.slice(0,300)}`);
    }
  }

  // ── 9. T1.1 MatB immutable config (the actual deployed values) ──────────────
  console.log("\n════ 9. T1.1 MatB immutable config ════");
  const treasuryAddr  = await matB1.treasury();
  const devWalletAddr = await matB1.devWallet();
  const opsWalletAddr = await matB1.opsWallet();
  const splitL1       = await matB1.SPLIT_L1_BPS();
  const splitChain    = await matB1.SPLIT_CHAIN_BPS();
  const splitPool     = await matB1.SPLIT_POOL_BPS();
  const splitTreasury = await matB1.SPLIT_TREASURY_BPS();
  const splitDev      = await matB1.SPLIT_DEV_BPS();
  const splitOps      = await matB1.SPLIT_OPS_BPS();
  const splitCommunity= await matB1.SPLIT_COMMUNITY_BPS();
  const splitStability= await matB1.SPLIT_STABILITY_BPS();
  const splitBuyback  = await matB1.SPLIT_BUYBACK_BPS();
  const splitLiquidity= await matB1.SPLIT_LIQUIDITY_BPS();
  const entryFee      = await matB1.ENTRY_FEE();
  const matrixSize    = await matB1.MATRIX_SIZE();

  console.log(`treasury    : ${treasuryAddr}`);
  console.log(`devWallet   : ${devWalletAddr}`);
  console.log(`opsWallet   : ${opsWalletAddr}`);
  console.log(`ENTRY_FEE   : ${fmt6(entryFee)}   MATRIX_SIZE: ${matrixSize}`);
  console.log(`SPLIT_L1        : ${splitL1} BPS`);
  console.log(`SPLIT_CHAIN     : ${splitChain} BPS`);
  console.log(`SPLIT_POOL      : ${splitPool} BPS`);
  console.log(`SPLIT_TREASURY  : ${splitTreasury} BPS`);
  console.log(`SPLIT_STABILITY : ${splitStability} BPS`);
  console.log(`SPLIT_BUYBACK   : ${splitBuyback} BPS`);
  console.log(`SPLIT_LIQUIDITY : ${splitLiquidity} BPS`);
  console.log(`SPLIT_DEV       : ${splitDev} BPS`);
  console.log(`SPLIT_OPS       : ${splitOps} BPS`);
  console.log(`SPLIT_COMMUNITY : ${splitCommunity} BPS`);
  const bpsSum = splitL1+splitChain+splitPool+splitTreasury+splitDev+splitOps+splitCommunity+splitStability+splitBuyback+splitLiquidity;
  console.log(`SUM (must=4750) : ${bpsSum} BPS`);

  // Compute what depositReserve would receive
  const treasuryPayable = entryFee * splitTreasury / 10000n;
  console.log(`treasury cut on $10 entry: ${fmt6(treasuryPayable)}`);
  if (treasuryPayable === 0n) {
    console.log("  ⚠ SPLIT_TREASURY_BPS = 0 → depositReserve(0) → WILL REVERT with 'Treasury: zero deposit'");
  }

  // Cross-check: is T1.1 MatB's immutable treasury == the addresses file treasury?
  const fileTreasury = addrs.treasury || addrs.CNOVATreasury || "(not in file)";
  console.log(`addresses.json treasury : ${fileTreasury}`);
  if (treasuryAddr.toLowerCase() !== (fileTreasury || "").toLowerCase()) {
    console.log("  ⚠ MISMATCH — MatB's treasury immutable ≠ addresses file!");
  } else {
    console.log("  ✓ treasury address matches");
  }

  console.log("\n════ DONE ════");
}

main().catch(e => { console.error(e); process.exit(1); });
