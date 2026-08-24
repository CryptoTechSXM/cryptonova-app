// fund_leaders_30k.js — top selected tester/leader wallets up to EXACTLY $30,000 USDC
// (owner 2026-08-08, V8.48 shakedown wave: wallet-funded upgrades all tiers).
//
// Rules (owner): target $30,000 TOTAL per wallet — mint only the shortfall,
// SKIP any wallet already at or above $30,000. Never reduces anyone.
// MockUSDC.mint is onlyOwner — run with the deployer key (default signer).
//
// ─────────────────────────────────────────────────────────────────────────────────────
// ⛔ THE HARDCODED `LEADERS` ARRAY IS GONE (session 36, 2026-08-24). READ THIS BEFORE
//    EVER TYPING AN ADDRESS INTO THIS FILE AGAIN.
//
//    Three lists existed and all three had diverged:
//      this script's hardcoded array      96 wallets
//      CryptoNova-Keepers/fund_list.txt  100 wallets
//      the owner's own document          101 wallets
//      union                             110 wallets
//
//    This script's array turned out to be a strict SUBSET of the owner document — no
//    rogue entries, just five missing. The damage was on the other side: **the nine
//    wallets in the keepers list but not the owner document are the BUG REPORTERS** —
//    Sherwyn x4 (more accepted bounties than anyone), @Koach100/June, @queensonnie,
//    Cynthia Brown x2, CryptoJan22. This script would never have funded any of them,
//    and it would have printed a clean summary while not doing so. **A funding run
//    cannot report a wallet it was never told about. That is why the list moved out.**
//
//    Owner, 2026-08-24: "i have a list that grows when new testers / leaders are added."
//    A growing list cannot live in source. It lives in ONE file, and everything reads it.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// Run (contracts repo):
//   ADDRESSES_FILE=deployed_addresses_v8_48.json DRY_RUN=1 \
//     npx hardhat run scripts/fund_leaders_30k.js --network baseSepolia
//   ADDRESSES_FILE=deployed_addresses_v8_48.json \
//     npx hardhat run scripts/fund_leaders_30k.js --network baseSepolia
//
//   LIST_FILE=<path>   override the canonical list (default: the testnet-app copy)
//   TARGET_USD=30000   override the per-wallet target
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// 34.1 / 34.7 item 5: NO STALE DEFAULT. This file used to default to
// `deployed_addresses_v8_47.json` — the dead deployment that a "current" symlink pointed
// at for eleven days after V8.48 went live, and that 34.1 was written about.
if (!process.env.ADDRESSES_FILE) {
  console.error("FATAL: ADDRESSES_FILE not set — refusing to start with a stale default.");
  console.error("  ADDRESSES_FILE=deployed_addresses_v8_48.json \\");
  console.error("    npx hardhat run scripts/fund_leaders_30k.js --network baseSepolia");
  process.exit(1);
}
const ADDRESSES_FILE = process.env.ADDRESSES_FILE;

// THE CANONICAL LIST. One file, read by every funding script, appended to automatically
// by api/submit-bug.js when a bug report carries a new wallet.
const LIST_FILE = process.env.LIST_FILE ||
  path.join(__dirname, "..", "..", "..", "CryptoNova-Testnet-App", "fund_list.txt");

const TARGET = BigInt(Number(process.env.TARGET_USD || 30000)) * 1_000_000n;
const DRY    = process.env.DRY_RUN === "1";
const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

// Parse the list: one address per line, '#' starts a comment, blanks ignored. The
// trailing comment is kept because it carries WHO the wallet is, and a run that names
// people is a run whose omissions are visible.
function loadList(file) {
  if (!fs.existsSync(file)) {
    console.error(`FATAL: list file not found: ${file}`);
    console.error("  This script no longer carries its own copy of the list — see the header.");
    console.error("  Pass LIST_FILE=<path> if the canonical file has moved.");
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8");
  const out = [], bad = [], seen = new Map();
  raw.split(/\r?\n/).forEach((line, i) => {
    const body = line.split("#")[0].trim();
    if (!body) return;
    const note = (line.includes("#") ? line.slice(line.indexOf("#") + 1).trim() : "");
    let c = null;
    try { c = ethers.getAddress(body); }
    catch { bad.push(`line ${i + 1}: ${body}`); return; }
    if (seen.has(c)) { bad.push(`line ${i + 1}: ${c} DUPLICATE of line ${seen.get(c)}`); return; }
    seen.set(c, i + 1);
    out.push({ addr: c, note });
  });
  return { list: out, bad, mtime: fs.statSync(file).mtime };
}

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRESSES_FILE), "utf8"));
  const [deployer] = await ethers.getSigners();
  const usdc  = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC, deployer);
  const owner = await usdc.owner();
  console.log(`Funder (deployer): ${deployer.address} | USDC owner: ${owner}${DRY ? "  [DRY RUN]" : ""}`);
  console.log(`Addresses  : ${ADDRESSES_FILE}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("deployer is not MockUSDC owner — cannot mint");
  }

  // ── PRE-FLIGHT: validate EVERY address before the first mint (session 33). ──────────
  // `ethers.getAddress` throws on a bad EIP-55 checksum. It used to be called inside the
  // mint loop, so a bad entry at position 90 aborted the run AFTER 89 mints had been
  // sent. A validation that can only fail halfway through is not a validation.
  const { list, bad, mtime } = loadList(LIST_FILE);
  const ageDays = (Date.now() - mtime.getTime()) / 86400000;
  console.log(`List file  : ${LIST_FILE}`);
  console.log(`             ${list.length} wallets, last modified ${mtime.toISOString().slice(0, 10)}` +
              (ageDays > 7 ? `  ⚠ ${Math.floor(ageDays)} days old — has anyone joined since?` : ""));
  if (bad.length) {
    console.error(`REFUSING TO RUN — ${bad.length} bad entr${bad.length === 1 ? "y" : "ies"} in the list:`);
    for (const b of bad) console.error(`   ${b}`);
    throw new Error("fix the list file before funding");
  }
  if (!list.length) throw new Error("list file parsed to zero addresses — refusing to run");
  const named = list.filter(x => x.note).length;
  console.log(`Pre-flight : all ${list.length} checksum-valid, no duplicates (${named} carry a name).`);

  let nonce = await ethers.provider.getTransactionCount(deployer.address);
  let topped = 0, skipped = 0, minted = 0n;
  for (const { addr, note } of list) {
    const who = note ? `  [${note}]` : "";
    const bal = BigInt(await usdc.balanceOf(addr));
    if (bal >= TARGET) {
      console.log(`  SKIP  ${addr}  already ${usd(bal)}${who}`);
      skipped++;
      continue;
    }
    const need = TARGET - bal;
    if (DRY) {
      console.log(`  WOULD MINT ${usd(need)} -> ${addr}  (has ${usd(bal)})${who}`);
    } else {
      const tx = await usdc.mint(addr, need, { nonce: nonce++ });
      await tx.wait();
      console.log(`  MINT  ${usd(need)} -> ${addr}  (had ${usd(bal)})  tx ${tx.hash.slice(0, 18)}…${who}`);
    }
    topped++; minted += need;
    await new Promise(r => setTimeout(r, 150)); // pace under the RPC cap
  }
  console.log(`\nDone: ${topped} topped up (${usd(minted)} total minted), ${skipped} already at/above ` +
              `${usd(TARGET)}, ${list.length} wallets checked from ${path.basename(LIST_FILE)}.`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
