// scripts/set_upkeep_caller.js — authorize the DO keeper wallet on MatrixKeeper (V8.46 item 1)
// Run: npx hardhat run scripts/set_upkeep_caller.js --network baseSepolia
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const KEEPER_WALLET = process.env.KEEPER_WALLET || "0xd419681BA72992636f05e256168681c939826B4b";
  const addrFile = path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_46.json");
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
