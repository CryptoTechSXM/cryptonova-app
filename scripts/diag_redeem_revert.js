// diag_redeem_revert.js — WHY DOES "Step 2: Redeem for USDC" FAIL AFTER THE APPROVE SUCCEEDS?
//
// THE REPORT (owner, 2026-08-25, with screenshot): the dashboard's CNOVA redeem approves
// fine, then the redeem itself fails with the frontend's generic
// "Transaction failed on-chain — hard-refresh and try again."
// Observed inputs: 101 CNOVA, "Est. Net Receive $0.67", Approved ✅, then failure.
//
// ⛔ THAT FRONTEND MESSAGE IS A CATCH-ALL AND IT HAS NEVER BEEN RESOLVED TO A REASON.
//    It is on record as a SUSPECTED-but-never-measured report class, with the wallet's
//    public RPC endpoint as the standing prime suspect. A suspect is not a measurement.
//    `CNOVATreasury.redeemAtFloor` has SIX distinct revert paths and the UI collapses all
//    of them — plus every RPC-level failure — into one red line. This separates them.
//
// It sends NO transaction and needs NO key: it re-reads every precondition, then does an
// eth_call of the real function with `from` set to the member, so the chain itself
// produces the revert string.
//
// ─────────────────────────────────────────────────────────────────────────────────────
// THE SIX WAYS redeemAtFloor REVERTS (CNOVATreasury.sol:260) — checked individually below
//   1. "Treasury: zero amount"
//   2. "Treasury: insufficient CNOVA balance"     cnova.balanceOf(member) < amount
//   3. "Treasury: floor not established yet"      floorPrice() == 0
//   4. "Treasury: redemption too small"           amount * floor / 1e18 == 0   <- dust
//   5. "Treasury: reserve insufficient"           usdcOut > usdcReserve
//   6. ERC20 allowance                            burnFrom needs CNOVA approved to the
//                                                 TREASURY as spender
//
// ⚠ #6 IS THE ONE THE UI CANNOT SHOW YOU AND THE ONE THIS REPO HAS BEEN BITTEN BY BEFORE.
//   `redeemAtFloor` calls `cnova.burnFrom(msg.sender, amount)`, and ERC20Burnable.burnFrom
//   SPENDS AN ALLOWANCE — so the member must have approved **CNOVA to the TREASURY**. An
//   approve that targeted the token itself, or the wrong spender, leaves the button showing
//   a green "Approved ✅" that is true about the wrong pair. CLAUDE.md already carries this
//   exact class as a standing correction ("the approval goes to the MATRIX, not TierRouter")
//   after a session told a member to approve the wrong spender.
//
// ✅ RULED OUT BEFORE WRITING THIS, so nobody re-investigates it: vesting is NOT the cause.
//   `CNOVAToken._update` blocks transfers of locked tokens, but the guard is explicitly
//   skipped when `to == address(0)` — "burns bypass the guard above by design" — and a
//   redemption burns. The panel's own copy ("Vesting CNOVA can already be redeemed at
//   floor") agrees with the contract. Reported here anyway, as context, never as a verdict.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json MEMBER=0xYourWallet \
//     npx hardhat run scripts/diag_redeem_revert.js --network baseSepolia
//
//   AMOUNT=101     CNOVA to test with (default 101, the reported case)
//
const { ethers } = require("hardhat");
const path = require("path");

if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  process.exit(1);
}
// ⛔ VALIDATE MEMBER HERE, WITH A SENTENCE — do not let ethers throw a raw stack trace.
//    2026-08-25: the owner was handed a run block containing the literal placeholder
//    `0xYourWalletAddress` and pasted it as given, and `ethers.getAddress` answered with a
//    TypeError and ten frames of library internals. That is this repo's own standing rule
//    turned on its author: an instrument must fail in a sentence that says what to do next.
if (!process.env.MEMBER || !/^0x[0-9a-fA-F]{40}$/.test(process.env.MEMBER.trim())) {
  const got = process.env.MEMBER ? `got "${process.env.MEMBER}"` : "not set";
  console.log(`FATAL: MEMBER must be a 40-hex-digit wallet address — ${got}.`);
  console.log("");
  console.log("  This has to run AS THE WALLET THAT SAW THE FAILURE: allowance and the early-");
  console.log("  exit penalty are both per-member, so any other address answers a different");
  console.log("  question. Use the address shown in your wallet extension while connected to");
  console.log("  the dashboard — the one the failing redeem was signed from.");
  console.log("");
  console.log('  $env:MEMBER="0x1234...cdef"      <- your real address, 0x + 40 hex digits');
  console.log("  npx hardhat run scripts/diag_redeem_revert.js --network baseSepolia");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
let MEMBER;
try { MEMBER = ethers.getAddress(process.env.MEMBER.trim()); }
catch (e) { console.log(`FATAL: MEMBER failed checksum validation: ${e.shortMessage || e.message}`); process.exit(1); }
const rawAmt = String(process.env.AMOUNT || "101").trim();
if (!/^\d+(\.\d+)?$/.test(rawAmt)) {
  console.log(`FATAL: AMOUNT must be a plain number of CNOVA — got "${rawAmt}".`);
  process.exit(1);
}
const AMOUNT = ethers.parseUnits(rawAmt, 18);

const TREASURY_ABI = [
  "function redeemAtFloor(uint256) external",
  "function floorPrice() view returns (uint256)",
  "function usdcReserve() view returns (uint256)",
  "function earlyExitPenaltyBps(address) view returns (uint256)",
  "function communityWallet() view returns (address)",
];
const CNOVA_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function lockedBalanceOf(address) view returns (uint256)",
  "function unlockedBalanceOf(address) view returns (uint256)",
];
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

// OpenZeppelin v5 ERC20 custom-error selectors. A revert that carries DATA is not a
// string, and printing raw hex to the owner is the same failure as the frontend's generic
// red line — one layer down. Name it.
const ERC20_ERRORS = {
  "0xe450d38c": "ERC20InsufficientBalance(address,uint256,uint256)",
  "0x96c6fd1e": "ERC20InvalidSender(address)",
  "0xec442f05": "ERC20InvalidReceiver(address)  <- a transfer TO THE ZERO ADDRESS",
  "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
  "0xe602df05": "ERC20InvalidApprover(address)",
  "0x94280d62": "ERC20InvalidSpender(address)",
};

const problems = [];
const u6 = (v) => `$${Number(ethers.formatUnits(v, 6)).toFixed(2)}`;
const u18 = (v) => Number(ethers.formatUnits(v, 18)).toFixed(4);

async function tryRead(label, fn) {
  try { return await fn(); }
  catch (e) { problems.push(`${label}: ${e.message.split("\n")[0]}`); return null; }
}

async function main() {
  const p = ethers.provider;
  const T = new ethers.Contract(A.treasury, TREASURY_ABI, p);
  const C = new ethers.Contract(A.cnova,    CNOVA_ABI,    p);
  const U = new ethers.Contract(A.usdc,     USDC_ABI,     p);

  console.log("");
  console.log("CNOVA REDEEM — WHICH require() IS FAILING?");
  console.log(`  addresses : ${process.env.ADDRESSES_FILE}  (${A.network})`);
  console.log(`  member    : ${MEMBER}`);
  console.log(`  amount    : ${u18(AMOUNT)} CNOVA`);
  console.log(`  treasury  : ${A.treasury}`);
  console.log(`  cnova     : ${A.cnova}`);
  console.log(`  block     : ${await p.getBlockNumber()}`);
  console.log("");

  const bal       = await tryRead("cnova.balanceOf",        () => C.balanceOf(MEMBER));
  const locked    = await tryRead("cnova.lockedBalanceOf",  () => C.lockedBalanceOf(MEMBER));
  const unlocked  = await tryRead("cnova.unlockedBalanceOf",() => C.unlockedBalanceOf(MEMBER));
  const allowT    = await tryRead("cnova.allowance->treasury", () => C.allowance(MEMBER, A.treasury));
  const floor     = await tryRead("treasury.floorPrice",    () => T.floorPrice());
  const reserve   = await tryRead("treasury.usdcReserve",   () => T.usdcReserve());
  const penalty   = await tryRead("treasury.earlyExitPenaltyBps", () => T.earlyExitPenaltyBps(MEMBER));
  const usdcHeld  = await tryRead("usdc.balanceOf(treasury)",() => U.balanceOf(A.treasury));
  // ⛔ THE PENALTY BRANCH PAYS 20% OF THE PENALTY TO communityWallet
  //    (CNOVATreasury.sol:288, inside `if (penalty > 0)`). If that address is unset, the
  //    transfer targets address(0) and the WHOLE redemption reverts — but only for members
  //    who owe a penalty. A 0% member redeems fine, which is exactly how this hides.
  const cwOnTreasury = await tryRead("treasury.communityWallet", () => T.communityWallet());

  console.log("STATE");
  if (bal      !== null) console.log(`  CNOVA balance            ${u18(bal)}`);
  if (locked   !== null) console.log(`  CNOVA locked (vesting)   ${u18(locked)}   (context only — burns bypass the vest guard by design)`);
  if (unlocked !== null) console.log(`  CNOVA unlocked           ${u18(unlocked)}`);
  if (allowT   !== null) console.log(`  allowance -> TREASURY    ${u18(allowT)}   <- this is what burnFrom spends`);
  if (floor    !== null) console.log(`  floorPrice               ${ethers.formatUnits(floor, 6)} USDC per CNOVA (raw ${floor})`);
  if (reserve  !== null) console.log(`  usdcReserve (accounted)  ${u6(reserve)}`);
  if (usdcHeld !== null) console.log(`  USDC actually held       ${u6(usdcHeld)}`);
  if (penalty  !== null) console.log(`  earlyExitPenaltyBps      ${penalty} (${Number(penalty) / 100}%)`);
  if (cwOnTreasury !== null) {
    const unset = cwOnTreasury === ethers.ZeroAddress;
    console.log(`  treasury.communityWallet ${cwOnTreasury}${unset ? "   ⛔ UNSET" : ""}`);
    if (unset) {
      console.log("      ⛔⛔ THIS IS THE FAULT. redeemAtFloor pays 20% of the early-exit penalty");
      console.log("         to communityWallet (CNOVATreasury.sol:288). Unset, that is a USDC");
      console.log("         transfer to address(0) and the whole redemption reverts with");
      console.log("         ERC20InvalidReceiver(0). It only bites members who OWE a penalty —");
      console.log("         a fully-vested member at 0 bps skips the branch and redeems fine.");
      console.log(`         Expected: ${A.communityWallet || "the CommunityWallet in the addresses file"}`);
    }
  }
  console.log("");

  // Reproduce the contract's own arithmetic rather than trusting the panel's estimate.
  let usdcOut = null, memberOut = null;
  if (floor !== null) {
    usdcOut = (AMOUNT * floor) / (10n ** 18n);
    if (penalty !== null) memberOut = usdcOut - (usdcOut * penalty) / 10_000n;
    console.log("THE CONTRACT'S OWN ARITHMETIC (CNOVATreasury.sol:268-276)");
    console.log(`  usdcOut   = amount * floor / 1e18 = ${u6(usdcOut)}`);
    if (memberOut !== null) console.log(`  memberOut = usdcOut - penalty     = ${u6(memberOut)}   <- compare to the panel's "Est. Net Receive"`);
    console.log("");
  }

  console.log("PRECONDITION CHECKS, in the contract's order");
  const checks = [];
  checks.push(["amount > 0", AMOUNT > 0n]);
  if (bal !== null)     checks.push(["cnova.balanceOf(member) >= amount", bal >= AMOUNT]);
  if (floor !== null)   checks.push(["floorPrice() > 0", floor > 0n]);
  if (usdcOut !== null) checks.push(["usdcOut > 0 (not dust)", usdcOut > 0n]);
  if (usdcOut !== null && reserve !== null) checks.push(["usdcOut <= usdcReserve", usdcOut <= reserve]);
  if (allowT !== null)  checks.push(["allowance(member, TREASURY) >= amount  <- burnFrom", allowT >= AMOUNT]);
  if (cwOnTreasury !== null && penalty !== null && penalty > 0n)
    checks.push(["treasury.communityWallet != 0 (only checked when a penalty is owed)", cwOnTreasury !== ethers.ZeroAddress]);
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "**FAIL**"}  ${name}`);
  console.log("");

  // ── THE MEASUREMENT. Let the chain say it. ───────────────────────────────────────
  console.log("eth_call OF THE REAL FUNCTION, from the member's address");
  let reverted = null;
  try {
    await T.redeemAtFloor.staticCall(AMOUNT, { from: MEMBER });
    console.log("  ✅ THE CALL SUCCEEDS AT THIS BLOCK.");
    console.log("     So the revert the member saw is NOT in this contract's logic at the");
    console.log("     current state. That points at the SEND path, not the call path:");
    console.log("     a stale allowance at signing time, gas, nonce, or the wallet's RPC");
    console.log("     endpoint — the standing prime suspect for this report class, still");
    console.log("     never measured. Next step is the failing tx hash, not another read.");
  } catch (e) {
    reverted = e;
    const reason = e.reason || e.shortMessage || e.message.split("\n")[0];
    console.log(`  ⛔ REVERTED: ${reason}`);
    const data = e.data || (e.info && e.info.error && e.info.error.data) || null;
    if (data) {
      const sel = String(data).slice(0, 10);
      const named = ERC20_ERRORS[sel];
      console.log(`     raw data: ${data}`);
      console.log(`     selector: ${sel}${named ? "  = " + named : "  (not a known ERC20 custom error)"}`);
      if (named && sel === "0xec442f05") {
        const arg = "0x" + String(data).slice(34);
        console.log(`     argument: ${arg}`);
        console.log("     ⛔ A TRANSFER TO THE ZERO ADDRESS. In redeemAtFloor the only recipient");
        console.log("        that can be zero is communityWallet — see the STATE block above.");
      }
    }
    console.log("");
    console.log("  THAT STRING IS THE ANSWER. Match it to the six paths in this file's header;");
    console.log("  the failing PRECONDITION above should agree with it. If they disagree, the");
    console.log("  disagreement is the finding — do not pick the one you prefer.");
  }
  console.log("");

  if (problems.length) {
    console.log(`PROBLEMS: ${problems.length}`);
    for (const x of problems) console.log(`  - ${x}`);
    console.log("");
    process.exit(1);
  }
  console.log("PROBLEMS: 0");
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
