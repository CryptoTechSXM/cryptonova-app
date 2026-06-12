const { ethers } = require("hardhat");

const TREASURY = "0xe872C64762a00a154b7793E317f3e757ddbc7263";
const COMMUNITY = "0x517A974CC9C51cB1c92FFf79A57B721c5ABeA294";

const ABI = [
  {"inputs":[{"internalType":"address","name":"cw","type":"address"}],"name":"setCommunityWallet","outputs":[],"stateMutability":"nonpayable","type":"function"},
];

async function main() {
  const [admin] = await ethers.getSigners();
  const treasury = await ethers.getContractAt(ABI, TREASURY);
  console.log("Setting community wallet on Treasury...");
  await (await treasury.setCommunityWallet(COMMUNITY)).wait();
  console.log("✅ communityWallet set to", COMMUNITY);
}
main().catch(e => { console.error(e); process.exit(1); });
