// scripts/set_pauser.js — set the pause-only `pauser` key on TierRouter (V8.53, P2 watchdog; R15)
// Run: PAUSER_WALLET=0x... ADDRESSES_FILE=deployed_addresses_v8_53.json npx hardhat run scripts/set_pauser.js --network baseSepolia
//
// Same shape and same lessons as set_upkeep_caller.js (read that file's comments):
//   - ADDRESSES_FILE is REQUIRED, never defaulted — this script grants a right on a specific deployment.
//   - PAUSER_WALLET is REQUIRED — there is no sensible default for a key that lives on the VPS watchdog.
//   - read-back is a bounded probe, not a retry loop (Base Sepolia sheds fresh state reads).
// The pauser may ONLY call pauseSystem(); unpause/resume/setters stay onlyOwner (TierRouter.sol:730-733).
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  if (!process.env.ADDRESSES_FILE) {
    throw new Error("ADDRESSES_FILE is not set. This script grants pause authority — it will not guess the deployment.");
  }
  const PAUSER_WALLET = process.env.PAUSER_WALLET;
  if (!PAUSER_WALLET || !ethers.isAddress(PAUSER_WALLET)) {
    throw new Error("PAUSER_WALLET is not set or not an address. Set it to the VPS watchdog's pause-only key.");
  }
  const addrFile = path.join(__dirname, process.env.ADDRESSES_FILE);
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));
  if (!addrs.tierRouter) throw new Error("tierRouter not found in " + addrFile);

  const [signer] = await ethers.getSigners();
  const tr = await ethers.getContractAt("TierRouter", addrs.tierRouter);
  console.log("Signer (owner):", signer.address);
  console.log("TierRouter:    ", addrs.tierRouter);
  console.log("Pauser wallet: ", PAUSER_WALLET);

  // The three keys must differ on a real network (P3: keeper != pauser != owner).
  const owner = await tr.owner();
  if (PAUSER_WALLET.toLowerCase() === owner.toLowerCase()) {
    throw new Error(`PAUSER_WALLET equals the owner ${owner}. The pauser must be a separate pause-only key (P3).`);
  }
  const keeper = (process.env.KEEPER_WALLET || "0xd419681BA72992636f05e256168681c939826B4b").toLowerCase();
  if (PAUSER_WALLET.toLowerCase() === keeper) {
    throw new Error(`PAUSER_WALLET equals the keeper wallet ${keeper}. The pauser must be a separate pause-only key (P3).`);
  }

  const before = await tr.pauser();
  console.log("pauser before:", before);
  if (before.toLowerCase() === PAUSER_WALLET.toLowerCase()) { console.log("Already set — nothing to do."); return; }

  const tx = await tr.setPauser(PAUSER_WALLET);
  console.log("tx submitted:", tx.hash);
  const rc = await tx.wait();
  console.log(`mined: block ${rc.blockNumber}  status ${rc.status}`);

  const PROBES = Number(process.env.PROBES || 10), GAP_MS = 3000;
  let ok = false;
  for (let i = 1; i <= PROBES; i++) {
    const after = await tr.pauser();
    if (after.toLowerCase() === PAUSER_WALLET.toLowerCase()) { ok = true; console.log(`pauser after:  ${after}  SET OK (settled after ${i} probe${i === 1 ? "" : "s"})`); break; }
    if (i < PROBES) { console.log(`  probe ${i}: reads ${after}, want ${PAUSER_WALLET} — node is likely behind, waiting 3s`); await new Promise(r => setTimeout(r, GAP_MS)); }
  }
  if (!ok) {
    console.log(`pauser after:  ⛔ NOT SET AFTER ${PROBES} PROBES — the tx mined but state did not change. Read tx ${tx.hash} on BaseScan; do NOT just re-send.`);
    process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
