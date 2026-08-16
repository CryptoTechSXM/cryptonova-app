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
  await tx.wait();
  const after = await keeper.upkeepCaller(KEEPER_WALLET);
  console.log("upkeepCaller after: ", after, after ? "AUTHORIZED OK" : "FAILED");
}
main().catch(e => { console.error(e); process.exit(1); });
