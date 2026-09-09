// scripts/pause_control.js — the OWNER's pause / unpause switch on TierRouter (V8.53, MAINNET_READINESS P2 item 3).
// Run (PowerShell, contracts repo):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_53_private.json"; $env:ACTION="status"  ; npx hardhat run scripts/pause_control.js --network baseSepolia
//   $env:ADDRESSES_FILE="…";                                      $env:ACTION="pause"   ; npx hardhat run scripts/pause_control.js --network baseSepolia
//   $env:ADDRESSES_FILE="…";                                      $env:ACTION="unpause" ; npx hardhat run scripts/pause_control.js --network baseSepolia
// Same lessons as set_pauser.js / set_upkeep_caller.js:
//   - ADDRESSES_FILE is REQUIRED, never defaulted — this acts on ONE deployment.
//   - ACTION is REQUIRED and explicit: status | pause | unpause. No default — a pause is a member-facing event.
//   - read-back is a bounded probe, not a retry loop (Base Sepolia sheds fresh state reads).
// What pause does (TierRouter.sol:731): systemPaused = true → register ×4 and manual/hybrid/bulk upgrades revert
// whenNotPaused; withdrawals are NOT gated (proven: test/V8_53_WithdrawWhilePaused, 18 passing 2026-09-08).
// unpause (:742) is owner-only and also resets the inactivity clocks so the automatic guard does not re-trip.
// The pauser key (VPS watchdog) can only PAUSE; this script is the owner's side of the pair.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  if (!process.env.ADDRESSES_FILE) throw new Error("ADDRESSES_FILE is not set. This script pauses/unpauses ONE deployment — it will not guess which.");
  const ACTION = String(process.env.ACTION || "").toLowerCase();
  if (!["status", "pause", "unpause"].includes(ACTION)) throw new Error('ACTION must be "status", "pause" or "unpause" — no default.');
  const REASON = process.env.REASON || `owner pause_control.js at ${new Date().toISOString()}`;

  const addrFile = path.join(__dirname, process.env.ADDRESSES_FILE);
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));
  if (!addrs.tierRouter) throw new Error("tierRouter not found in " + addrFile);

  const [signer] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter);
  const [owner, pauser, paused] = await Promise.all([tr.owner(), tr.pauser(), tr.systemPaused()]);
  console.log("book:          ", path.basename(addrFile), "chainId", addrs.chainId ?? "(none)");
  console.log("TierRouter:    ", addrs.tierRouter);
  console.log("signer:        ", signer.address);
  console.log("owner:         ", owner, signer.address.toLowerCase() === owner.toLowerCase() ? "✅ signer is owner" : "⛔ signer is NOT the owner");
  console.log("pauser:        ", pauser);
  console.log("systemPaused:  ", paused);
  if (ACTION === "status") return;

  if (signer.address.toLowerCase() !== owner.toLowerCase()) throw new Error("signer is not the owner — unpause is onlyOwner, and the owner's pause should come from the owner key. Refusing.");
  const want = ACTION === "pause";
  if (paused === want) { console.log(`already ${want ? "paused" : "running"} — nothing to do.`); return; }

  console.log(`\nsending ${want ? `pauseSystem("${REASON}")` : "unpauseSystem()"} …`);
  const tx = want ? await tr.pauseSystem(REASON) : await tr.unpauseSystem();
  console.log("tx submitted:", tx.hash);
  const rc = await tx.wait();
  console.log(`mined: block ${rc.blockNumber}  status ${rc.status}`);

  const PROBES = Number(process.env.PROBES || 10), GAP_MS = 3000;
  for (let i = 1; i <= PROBES; i++) {
    const now = await tr.systemPaused();
    if (now === want) { console.log(`systemPaused after: ${now}  ${want ? "PAUSED" : "RUNNING"} OK (settled after ${i} probe${i === 1 ? "" : "s"})`); return; }
    if (i < PROBES) { console.log(`  probe ${i}: reads ${now}, want ${want} — node is likely behind, waiting 3s`); await new Promise(r => setTimeout(r, GAP_MS)); }
  }
  console.log(`⛔ systemPaused did not read ${want} after ${PROBES} probes — the tx mined but state did not change. Read tx ${tx.hash} on BaseScan; do NOT just re-send.`);
  process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
