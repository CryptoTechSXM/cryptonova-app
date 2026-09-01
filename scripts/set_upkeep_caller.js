// scripts/set_upkeep_caller.js — authorize the DO keeper wallet on MatrixKeeper (V8.46 item 1)
// Run: npx hardhat run scripts/set_upkeep_caller.js --network baseSepolia
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const KEEPER_WALLET = process.env.KEEPER_WALLET || "0xd419681BA72992636f05e256168681c939826B4b";

  // 2026-08-16: the fallback was "deployed_addresses_v8_46.json" — two releases
  // stale by V8.48. It never bit only because .env supplies ADDRESSES_FILE on
  // every hardhat run. Lose or clear that line and this script authorizes a
  // keeper EOA on a DEAD MatrixKeeper and prints "AUTHORIZED OK" for it.
  // That is the exact failure CLAUDE.md records under "stale ADDRESSES_FILE
  // defaults — the env var hides them". Replaced with a refusal rather than a
  // newer literal, because a newer literal just resets the same clock.
  //
  // HONEST LIMIT OF THIS CHECK: under `npx hardhat run` it will essentially
  // never fire, because hardhat.config.js:2 calls dotenv.config() and .env
  // supplies the value. It fires under plain `node`. The real protection here
  // is the printout below — read the MatrixKeeper address before confirming.
  // (Stated because the first draft of this comment implied a guarantee the
  // code does not give, which is the same defect this file was fixing.)
  if (!process.env.ADDRESSES_FILE) {
    throw new Error(
      "ADDRESSES_FILE is not set. This script grants keeper authority — it will " +
      "not guess the deployment. Set it explicitly, e.g. " +
      'ADDRESSES_FILE=deployed_addresses_v8_49.json'
    );
  }
  const addrFile = path.join(__dirname, process.env.ADDRESSES_FILE);
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));
  const keeperAddr = addrs.matrixKeeper;
  if (!keeperAddr) throw new Error("matrixKeeper not found in " + addrFile);

  const [signer] = await ethers.getSigners();
  console.log("Signer (owner):", signer.address);
  console.log("MatrixKeeper:  ", keeperAddr);
  console.log("Keeper wallet: ", KEEPER_WALLET);

  const keeper = await ethers.getContractAt("MatrixKeeper", keeperAddr);
  const before = await keeper.upkeepCaller(KEEPER_WALLET);
  console.log("upkeepCaller before:", before);
  if (before) { console.log("Already authorized — nothing to do."); return; }

  const tx = await keeper.setUpkeepCaller(KEEPER_WALLET, true);
  console.log("tx submitted:", tx.hash);
  const rc = await tx.wait();
  console.log(`mined: block ${rc.blockNumber}  status ${rc.status}`);

  // ⛔⛔ 2026-09-01: THIS READ-BACK USED TO BE A SINGLE READ AND IT REPORTED "FAILED"
  // ON A TRANSACTION THAT HAD ALREADY SET THE FLAG. Re-running seconds later read
  // `true`. Base Sepolia sheds state reads — the same phenomenon that makes
  // deploy_v8.js see `0x NO CODE` for contracts it just deployed, and that made
  // setGraduationEnabled report "the flag did not change" twice. FOUR independent
  // confirmations now. A guard that cries wolf costs as much as one that hides a
  // fault (session 45), and this one fired during a live outage with members on
  // the site, which is the worst possible moment to be told a good tx failed.
  //
  // ▶ BOUNDED PROBE, deliberately NOT a retry-until-you-like-the-answer loop: if the
  //   flag never reads true inside the window, that is a MINED-BUT-NO-STATE-CHANGE
  //   situation — a contract-level problem to investigate, not to paper over.
  const PROBES = Number(process.env.PROBES || 10), GAP_MS = 3000;
  let after = false;
  for (let i = 1; i <= PROBES; i++) {
    after = await keeper.upkeepCaller(KEEPER_WALLET);
    if (after) { console.log(`upkeepCaller after:  true  AUTHORIZED OK (settled after ${i} probe${i === 1 ? "" : "s"})`); break; }
    if (i < PROBES) {
      console.log(`  probe ${i}: reads false, want true — node is likely behind, waiting 3s`);
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  }
  if (!after) {
    console.log(`upkeepCaller after:  false  ⛔ STILL FALSE AFTER ${PROBES} PROBES`);
    console.log("   The tx mined but the flag did not change. Do NOT just re-send —");
    console.log(`   read tx ${tx.hash} on BaseScan and find out why.`);
    process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
