// scripts/accept_ownership.js — the ACCEPT side of Ownable2Step for every pending row in a book (P3).
// Signed by the NEW owner. On hardhat/localhost that is ACCEPT_INDEX (signer index, default 1) or
// ACCEPT_KEY (raw key). On Sepolia/mainnet the new owner is the HARDWARE WALLET, which never exists as
// a key file — there the accepts are signed from the wallet itself (admin page / BaseScan "Write" with
// MetaMask+Trezor); this script is the rehearsal + verification tool, and with ACCEPT_KEY it can accept
// on behalf of any hot-key rehearsal owner. Idempotent: rows already owned by the signer are skipped.
// Run: ADDRESSES_FILE=deployed_addresses_localtest.json ACCEPT_INDEX=1 npx hardhat run scripts/accept_ownership.js --network hardhat
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { assertChain } = require("./chain_guard");

const TWO_STEP = ["treasury", "stabilityFund", "buybackReserve", "tierRouter", "communityWallet", "directSale", "couponRegistry"];
const ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"];

// accept({ book, bookLabel, signer, log }) → { done, skipped, fails }
async function accept({ book, bookLabel = "book", signer, log = console.log }) {
  const me = signer.address;
  const rows = TWO_STEP.filter((k) => book[k]).map((k) => ({ label: k, addr: book[k] }));
  for (const [t, v] of Object.entries(book.tiers || {})) for (const f of ["pm", "matA", "matB"]) if (v[f]) rows.push({ label: `tiers.${t}.${f}`, addr: v[f] });
  log(`=== accept_ownership  book=${bookLabel} network=${network.name} newOwner=${me} rows=${rows.length} ===`);
  let done = 0, skipped = 0, fails = 0;
  for (const r of rows) {
    const c = new ethers.Contract(r.addr, ABI, signer);
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    if (owner.toLowerCase() === me.toLowerCase()) { skipped++; continue; }
    if (pending.toLowerCase() !== me.toLowerCase()) { log(`  FAIL  ${r.label.padEnd(22)} pending is ${pending}, not ${me} — run transfer_ownership --propose first`); fails++; continue; }
    const tx = await c.acceptOwnership(); await tx.wait();
    log(`  tx    ${r.label.padEnd(22)} acceptOwnership ${tx.hash}`);
    done++;
  }
  log(`=== accepted ${done}, already-owned ${skipped}, FAIL ${fails} of ${rows.length} ===`);
  return { done, skipped, fails };
}

async function main() {
  if (!process.env.ADDRESSES_FILE) throw new Error("ADDRESSES_FILE not set");
  const book = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE), "utf8"));
  await assertChain(book, ethers.provider, process.env.ADDRESSES_FILE);
  let signer;
  if (process.env.ACCEPT_KEY) signer = new ethers.Wallet(process.env.ACCEPT_KEY, ethers.provider);
  else {
    const signers = await ethers.getSigners();
    const i = Number(process.env.ACCEPT_INDEX || 1);
    if (!signers[i]) throw new Error(`no signer at ACCEPT_INDEX=${i} on ${network.name}; set ACCEPT_KEY`);
    signer = signers[i];
  }
  const { fails } = await accept({ book, bookLabel: process.env.ADDRESSES_FILE, signer });
  if (fails) process.exit(1);
}
module.exports = { accept };
if (require.main === module) main().catch((e) => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
