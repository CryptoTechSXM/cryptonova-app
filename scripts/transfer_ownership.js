// scripts/transfer_ownership.js — hand every contract in a book to the hardware wallet (P3, MAINNET_READINESS §2).
//
// CENSUS (contracts/, 2026-09-08 — 46 book rows):
//   Ownable2Step (37): treasury, stabilityFund, buybackReserve, tierRouter, communityWallet, directSale,
//                      couponRegistry, tiers.T*.pm ×10, tiers.T*.matA/matB ×20
//   Ownable, 1-step (3): matrixKeeper, v8Governance, pairFactory (MatrixPairFactory)
//   AccessControl admin (2): cnova (DEFAULT_ADMIN_ROLE), communityWallet (DEFAULT_ADMIN_ROLE + GOVERNOR_ROLE)
//   No owner: matrixFactory (MatrixFactory has no Ownable), libraries.*; wallets: deployer admin accountOne
//   devWallet opsWallet liquidityReserve; usdc = external on mainnet (MockUSDC on testnet, ignored).
// The kinds are NOT trusted from this table — every row is probed on chain (owner(), pendingOwner(),
// hasRole) and a probe that disagrees with the table is a FAIL. Measure, then act.
//
// MODES  (ADDRESSES_FILE required; --network must match the book's chainId — chain_guard):
//   --census               read-only: owner / pendingOwner / roles per row; exit 1 on any surprise
//   --propose 0xNEW        from the CURRENT owner key: Ownable2Step → transferOwnership(NEW) (pending until
//                          NEW accepts); Ownable → transferOwnership(NEW) (immediate); AccessControl →
//                          grantRole(DEFAULT_ADMIN_ROLE [+GOVERNOR_ROLE], NEW). Idempotent: skips rows already done.
//   --verify  0xNEW        read-only: every owner() == NEW, every pendingOwner() == 0, NEW holds the roles;
//                          exit 1 otherwise. Run after the hardware wallet has accepted (37 acceptOwnership txs —
//                          the accept side is signed by the NEW owner, not by this script).
//   --renounce-roles 0xOLD from OLD (the deployer): revoke OLD's DEFAULT_ADMIN_ROLE/GOVERNOR_ROLE — ONLY after
//                          --verify is green, so an admin always exists.
// Run: ADDRESSES_FILE=deployed_addresses_v8_53.json npx hardhat run scripts/transfer_ownership.js --network baseSepolia -- --census
//      (hardhat swallows argv after `run`; pass the mode via TO_MODE / TO_ADDR env instead when that happens:
//       TO_MODE=propose TO_ADDR=0x... npx hardhat run scripts/transfer_ownership.js --network baseSepolia)
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { assertChain } = require("./chain_guard");

const TWO_STEP = ["treasury", "stabilityFund", "buybackReserve", "tierRouter", "communityWallet", "directSale", "couponRegistry"];
const ONE_STEP = ["matrixKeeper", "v8Governance", "pairFactory"];
const ROLES    = { cnova: ["DEFAULT_ADMIN_ROLE"], communityWallet: ["DEFAULT_ADMIN_ROLE", "GOVERNOR_ROLE"] };
const ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)",
  "function revokeRole(bytes32,address)",
  "function GOVERNOR_ROLE() view returns (bytes32)",
];
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

function parseArgs() {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a.startsWith("--"));
  let mode = i >= 0 ? argv[i].slice(2) : (process.env.TO_MODE || "");
  let addr = i >= 0 ? argv[i + 1] : process.env.TO_ADDR;
  if (!["census", "propose", "verify", "renounce-roles"].includes(mode)) {
    throw new Error("mode required: --census | --propose 0xNEW | --verify 0xNEW | --renounce-roles 0xOLD  (or TO_MODE/TO_ADDR env)");
  }
  if (mode !== "census" && !(addr && ethers.isAddress(addr))) throw new Error(`--${mode} needs an address`);
  return { mode, addr: addr ? ethers.getAddress(addr) : null };
}

function rows(book) {
  const out = [];
  for (const k of TWO_STEP) if (book[k]) out.push({ label: k, addr: book[k], kind: "2step" });
  for (const [t, v] of Object.entries(book.tiers || {})) {
    for (const f of ["pm", "matA", "matB"]) if (v[f]) out.push({ label: `tiers.${t}.${f}`, addr: v[f], kind: "2step" });
  }
  for (const k of ONE_STEP) if (book[k]) out.push({ label: k, addr: book[k], kind: "1step" });
  for (const [k, roles] of Object.entries(ROLES)) if (book[k]) out.push({ label: `${k} (roles)`, addr: book[k], kind: "roles", roles });
  return out;
}

async function probe(c, row, who) {
  const r = { owner: null, pending: null, roles: {} };
  if (row.kind !== "roles") {
    r.owner = await c.owner();
    if (row.kind === "2step") r.pending = await c.pendingOwner();   // a 1-step contract has no pendingOwner → BAD_DATA = table wrong
    else {
      try { await c.pendingOwner(); throw new Error(`${row.label}: table says Ownable but pendingOwner() answered — it is Ownable2Step; fix the table`); }
      catch (e) { if (e.code !== "BAD_DATA" && e.code !== "CALL_EXCEPTION") throw e; }
    }
  } else {
    for (const name of row.roles) {
      const id = name === "DEFAULT_ADMIN_ROLE" ? DEFAULT_ADMIN_ROLE : await c[name]();
      r.roles[name] = {};
      for (const a of who) r.roles[name][a] = await c.hasRole(id, a);
    }
  }
  return r;
}

// run({ mode, addr, book, bookLabel, signer, log }) → { fails, txs, rows }  (no process.exit — callers decide)
async function run({ mode, addr, book, bookLabel = "book", signer, log = console.log }) {
  if (addr) addr = ethers.getAddress(addr);
  const me = signer.address;
  const list = rows(book);
  log(`=== transfer_ownership --${mode} ${addr || ""}  book=${bookLabel} network=${network.name} signer=${me} rows=${list.length} ===`);

  let fails = 0, txs = 0;
  const bad = (l, m) => { log(`  FAIL  ${l.padEnd(22)} ${m}`); fails++; };
  for (const row of list) {
    const c = new ethers.Contract(row.addr, ABI, signer);
    let p;
    try { p = await probe(c, row, [me, addr].filter(Boolean)); }
    catch (e) { bad(row.label, `probe: ${(e.shortMessage || e.message).slice(0, 140)}`); continue; }

    if (mode === "census") {
      if (row.kind === "roles") log(`  ${row.label.padEnd(22)} ${Object.entries(p.roles).map(([n, m]) => `${n}: signer=${m[me]}`).join("  ")}`);
      else log(`  ${row.label.padEnd(22)} owner ${p.owner}${row.kind === "2step" ? `  pending ${p.pending === ethers.ZeroAddress ? "-" : p.pending}` : ""}`);
      continue;
    }

    if (mode === "verify") {
      if (row.kind === "roles") {
        for (const [n, m] of Object.entries(p.roles)) if (!m[addr]) bad(row.label, `${n} not held by ${addr}`);
        continue;
      }
      if (p.owner.toLowerCase() !== addr.toLowerCase()) { bad(row.label, `owner ${p.owner} != ${addr}`); continue; }
      if (row.kind === "2step" && p.pending !== ethers.ZeroAddress) { bad(row.label, `pendingOwner still ${p.pending}`); continue; }
      log(`  OK    ${row.label.padEnd(22)} owner ${p.owner}`);
      continue;
    }

    if (mode === "propose") {
      if (row.kind === "roles") {
        for (const n of row.roles) {
          if (p.roles[n][addr]) { log(`  skip  ${row.label.padEnd(22)} ${n} already granted`); continue; }
          if (!p.roles[n][me]) { bad(row.label, `signer lacks ${n}; cannot grant`); continue; }
          const id = n === "DEFAULT_ADMIN_ROLE" ? DEFAULT_ADMIN_ROLE : await c[n]();
          const tx = await c.grantRole(id, addr); await tx.wait(); txs++;
          log(`  tx    ${row.label.padEnd(22)} grantRole(${n}, ${addr}) ${tx.hash}`);
        }
        continue;
      }
      if (p.owner.toLowerCase() === addr.toLowerCase()) { log(`  skip  ${row.label.padEnd(22)} already owned by ${addr}`); continue; }
      if (row.kind === "2step" && p.pending.toLowerCase() === addr.toLowerCase()) { log(`  skip  ${row.label.padEnd(22)} already pending → ${addr} (accept from the new owner)`); continue; }
      if (p.owner.toLowerCase() !== me.toLowerCase()) { bad(row.label, `owner is ${p.owner}, signer ${me} cannot transfer`); continue; }
      const tx = await c.transferOwnership(addr); await tx.wait(); txs++;
      log(`  tx    ${row.label.padEnd(22)} transferOwnership(${addr}) ${tx.hash}${row.kind === "2step" ? "  → PENDING, accept from the new owner" : "  → DONE (1-step)"}`);
      continue;
    }

    if (mode === "renounce-roles") {
      if (row.kind !== "roles") continue;
      for (const n of row.roles) {
        if (!p.roles[n][addr]) { log(`  skip  ${row.label.padEnd(22)} ${addr} does not hold ${n}`); continue; }
        const id = n === "DEFAULT_ADMIN_ROLE" ? DEFAULT_ADMIN_ROLE : await c[n]();
        // never leave the contract without an admin: the SIGNER (new admin) must hold DEFAULT_ADMIN_ROLE, and must not be OLD
        if (!(await c.hasRole(DEFAULT_ADMIN_ROLE, me))) { bad(row.label, `signer ${me} lacks DEFAULT_ADMIN_ROLE; refuse`); continue; }
        if (addr.toLowerCase() === me.toLowerCase()) { bad(row.label, `refusing to renounce from the signer itself — run this from the NEW admin`); continue; }
        const tx = await c.revokeRole(id, addr); await tx.wait(); txs++;
        log(`  tx    ${row.label.padEnd(22)} revokeRole(${n}, ${addr}) ${tx.hash}`);
      }
    }
  }
  log(`=== ${mode}: ${list.length} rows, ${txs} tx, ${fails} FAIL ===`);
  if (mode === "propose" && fails === 0) {
    const n2 = list.filter((r) => r.kind === "2step").length;
    log(`  NEXT: ${addr} must call acceptOwnership() on the ${n2} Ownable2Step rows (hardware wallet), then run --verify ${addr}.`);
  }
  return { fails, txs, rows: list.length };
}

async function main() {
  const { mode, addr } = parseArgs();
  if (!process.env.ADDRESSES_FILE) throw new Error("ADDRESSES_FILE not set — this script acts on a specific deployment.");
  const book = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE), "utf8"));
  await assertChain(book, ethers.provider, process.env.ADDRESSES_FILE);
  const [signer] = await ethers.getSigners();
  const { fails } = await run({ mode, addr, book, bookLabel: process.env.ADDRESSES_FILE, signer });
  if (fails) process.exit(1);
}
module.exports = { run, rows, TWO_STEP, ONE_STEP, ROLES };
if (require.main === module) main().catch((e) => { console.error("FATAL:", e.shortMessage || e.message || e); process.exit(1); });
