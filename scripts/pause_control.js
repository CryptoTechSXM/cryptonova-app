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
//
// ⛔ R18 (2026-09-10, session 70) — WHY `pauser()` IS PROBED ALONE AND A REVERT IS NOT FATAL.
// The `pauser` role was added in V8.53 (R15). `pauseSystem()` itself has existed since long before —
// owner-only on V8.52 and earlier, owner-OR-pauser from V8.53. This script used to read
// owner/pauser/systemPaused in ONE Promise.all, so on any pre-V8.53 router the missing `pauser()`
// took the WHOLE script down before it could do anything.
// MEASURED on the LIVE V8.52 community router 0xBacE079aDB755Ea42b32310FE2E414CF036dd318,
// 2026-09-10 (owner ran it): `ProviderError: execution reverted … at Proxy.pauser … at async
// Promise.all (index 1) … pause_control.js:30`. So the chain our MEMBERS are on had NO working
// one-command pause — the contract could always be paused, our tooling just could not reach it.
// `sf_floor_watchdog.js` carries the identical shape and documents it in its own header; that one
// is correct to refuse (it NEEDS the pauser role). This one is not — it only needs `owner`.
// Fix: probe `pauser()` on its own, report `n/a` on a revert, carry on. Same tolerance
// postdeploy_check.js already has for its pauser row.
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

  // owner + systemPaused are the two this script actually NEEDS; both exist on every version.
  const [owner, paused] = await Promise.all([tr.owner(), tr.systemPaused()]);

  // pauser is V8.53+ only — probed alone so a pre-V8.53 revert is information, not a crash (R18).
  let pauser = null, pauserErr = null;
  try {
    pauser = await tr.pauser();
  } catch (e) {
    pauserErr = (e.shortMessage || e.message || String(e)).split("\n")[0].slice(0, 90);
  }

  const isOwner = signer.address.toLowerCase() === owner.toLowerCase();
  console.log("book:          ", path.basename(addrFile), "chainId", addrs.chainId ?? "(none)");
  console.log("TierRouter:    ", addrs.tierRouter);
  console.log("signer:        ", signer.address);
  console.log("owner:         ", owner, isOwner ? "✅ signer is owner" : "⛔ signer is NOT the owner");
  if (pauser) {
    console.log("pauser:        ", pauser);
  } else {
    console.log("pauser:         n/a — pre-V8.53 router, no pauser role on this deployment (pause is owner-only here)");
    console.log("                probe said:", pauserErr);
    console.log("                ⚠ the automated SF-floor watchdog CANNOT arm on this chain; this script is the only pause.");
  }
  console.log("systemPaused:  ", paused);
  if (ACTION === "status") return;

  if (!isOwner) throw new Error("signer is not the owner — unpause is onlyOwner, and the owner's pause should come from the owner key. Refusing.");
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
