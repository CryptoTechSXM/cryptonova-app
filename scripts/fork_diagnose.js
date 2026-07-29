"use strict";
/**
 * fork_diagnose.js
 *
 * Forks Base Sepolia on the local Hardhat network, impersonates a parked
 * wallet, sets allowance, and calls selfRescue() to get the EXACT revert
 * reason — no RPC stripping of state-override responses.
 *
 * Run (PowerShell — one line at a time):
 *   $env:FORK="1"
 *   npx hardhat run scripts/fork_diagnose.js --network hardhat
 *
 * The FORK=1 env var tells hardhat.config.js to activate the Base Sepolia
 * fork + chains config at startup, so hardhat_reset is not needed here.
 *
 * Optional env override:
 *   PARKED_ADDR=0x...   force-use this wallet instead of scanning
 */
const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_37.json"
);

const SELECTORS = {
  "0x08c379a0": "Error(string)",
  "0x4e487b71": "Panic(uint256)",
  "0x5274afe7": "SafeERC20FailedOperation(address)",
  "0xe450d38c": "ERC20InsufficientBalance(address,uint256,uint256)",
  "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
  "0x3e3f8f73": "ReentrancyGuardReentrantCall()",   // OZ v5
  "0x94280d62": "ERC20InvalidSpender(address)",      // OZ v5
  "0xe602df05": "ERC20InvalidApprover(address)",     // OZ v5
  "0x96c6fd1e": "ERC20InvalidReceiver(address)",     // OZ v5
  "0xec442f05": "ERC20InvalidSender(address)",       // OZ v5
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
      const codes = {1:"assertion",17:"overflow",18:"div-by-zero",32:"array-bounds",50:"pop-empty",65:"too-much-mem"};
      return `Panic(${code}): ${codes[Number(code)] || "unknown"}`;
    }
    if (sel === "0xfb8f41b2") {
      const [spender, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientAllowance: spender=${spender}  allowance=${fmt6(have)}  needed=${fmt6(need)}`;
    }
    if (sel === "0xe450d38c") {
      const [acct, have, need] = abi.decode(["address","uint256","uint256"], pay);
      return `ERC20InsufficientBalance: account=${acct}  have=${fmt6(have)}  need=${fmt6(need)}`;
    }
    if (sel === "0x94280d62") {
      const [addr] = abi.decode(["address"], pay);
      return `ERC20InvalidSpender: ${addr}`;
    }
    if (sel === "0x3e3f8f73") return "ReentrancyGuardReentrantCall()";
    const known = SELECTORS[sel];
    return `${known || ("UNKNOWN selector " + sel)}  raw=${hex.slice(0, 130)}`;
  } catch (e) {
    return `(decode failed: ${e.message?.slice(0,60)})  raw=${hex.slice(0,130)}`;
  }
}

function extractData(err) {
  for (const v of [err?.data, err?.error?.data, err?.info?.error?.data, err?.revert?.data]) {
    if (typeof v === "string" && v.length >= 2) return v;
  }
  return null;
}

async function main() {
  // Fork is already active — configured in hardhat.config.js via FORK=1.
  // We only need to verify it actually loaded.
  const blockNum = await ethers.provider.getBlockNumber();
  console.log(`Fork ready — tip block ${blockNum}\n`);

  const addrs    = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  const T1       = addrs.tiers?.T1 || { matA: addrs.T1?.matA, matB: addrs.T1?.matB };
  const USDC_ADDR = addrs.usdc || addrs.USDC;

  const usdc  = await ethers.getContractAt("MockUSDC",            USDC_ADDR);
  const matA1 = await ethers.getContractAt("FigureEightMatrixV8", T1.matA);
  const matB1 = await ethers.getContractAt("FigureEightMatrixV8", T1.matB);

  // ── Find a parked wallet ──────────────────────────────────────────────────
  let parkedAddr = process.env.PARKED_ADDR || null;
  if (!parkedAddr) {
    const count = await matA1.getParkedCount();
    for (let i = 0; i < count; i++) {
      const addr = await matA1.getParkedMember(i);
      const ts   = await matA1.parkedAt(addr);
      if (ts > 0n) { parkedAddr = addr; break; }
    }
  }
  if (!parkedAddr) { console.log("No parked wallet found."); return; }
  console.log(`Parked wallet : ${parkedAddr}`);

  const m = await matA1.getMember(parkedAddr);
  const entryFee = await matB1.ENTRY_FEE();
  const effectiveContrib = m.crossingReserve + m.withdrawable;
  const shortfall = entryFee > effectiveContrib ? entryFee - effectiveContrib : 0n;
  console.log(`  withdrawable   = ${fmt6(m.withdrawable)}`);
  console.log(`  crossingReserve= ${fmt6(m.crossingReserve)}`);
  console.log(`  shortfall      = ${fmt6(shortfall)}`);
  console.log(`  walletUSDC     = ${fmt6(await usdc.balanceOf(parkedAddr))}`);

  // ── Fund wallet with ETH and impersonate ─────────────────────────────────
  await network.provider.request({ method: "hardhat_impersonateAccount",   params: [parkedAddr] });
  await network.provider.send   ("hardhat_setBalance", [parkedAddr, "0x1000000000000000000"]); // 1 ETH
  const signer = await ethers.getSigner(parkedAddr);

  // ── Set allowance: approve T1.1 MatA for $15 ─────────────────────────────
  console.log(`\nSetting usdc.approve(T1.matA, $15) from ${parkedAddr.slice(0,10)}...`);
  const approveTx = await usdc.connect(signer).approve(T1.matA, 15_000_000n);
  await approveTx.wait();
  const allowanceAfter = await usdc.allowance(parkedAddr, T1.matA);
  console.log(`allowance after approve: ${fmt6(allowanceAfter)}`);

  // ── staticCall first to capture rich revert ──────────────────────────────
  console.log(`\nstaticcall selfRescue() from ${parkedAddr.slice(0,10)}...`);
  try {
    await matA1.connect(signer).selfRescue.staticCall({ gasLimit: 15_000_000 });
    console.log("staticCall SUCCEEDED — unexpected!");
  } catch (se) {
    const sd = extractData(se);
    console.log(`raw hex : ${sd ?? "(none)"}`);
    console.log(`decoded : ${sd ? decodeRevert(sd) : "(none)"}`);
    console.log(`reason  : ${se.reason ?? "(none)"}`);
    if (se.revert) console.log(`revert  :`, JSON.stringify(se.revert));
    if (!sd) console.log(`err keys: ${Object.keys(se).join(", ")}`);
  }

  // ── Real call to get full error context ──────────────────────────────────
  console.log(`\nReal call selfRescue()...`);
  try {
    const tx = await matA1.connect(signer).selfRescue({ gasLimit: 15_000_000 });
    const rcpt = await tx.wait();
    console.log("TX SUCCEEDED!  gasUsed=", rcpt.gasUsed.toString());
    console.log("rotationCount after:", await matB1.rotationCount());
  } catch (e) {
    const ed = extractData(e);
    console.log(`raw hex : ${ed ?? "(none)"}`);
    console.log(`decoded : ${ed ? decodeRevert(ed) : "(none)"}`);
    console.log(`reason  : ${e.reason ?? "(none)"}`);
    console.log(`code    : ${e.code}`);
    console.log(`message : ${e.message?.slice(0, 400)}`);
    // Try to extract from JSON body if present
    if (e.body) {
      try { console.log("body:", JSON.stringify(JSON.parse(e.body), null, 2).slice(0, 600)); } catch {}
    }
  }

  console.log("\n════ DONE ════");
}

main().catch(e => { console.error(e); process.exit(1); });
