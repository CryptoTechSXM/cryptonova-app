/**
 * topup_sf.js - top up the StabilityFund the INVARIANT-SAFE way.
 *
 * Owner calls receiveLayer(tier 0, amount, layer 1), which pulls USDC from
 * the deployer AND increments totalBalance in the same tx - so the V8.47
 * SF-conservation invariant (SF USDC == totalBalance) keeps holding.
 * NEVER top up with a raw ERC20 transfer (it leaves totalBalance stale -
 * that is the exact bug seed_sf.js was written to clean up after).
 *
 * Reads the SF address from ADDRESSES_FILE in .env (version-aware, no
 * hardcoded addresses - works for every deploy from v8_47 on).
 *
 * Run:
 *   npx hardhat run scripts/topup_sf.js --network baseSepolia          ($1500 default)
 *   $env:TOPUP_USDC="500"; npx hardhat run scripts/topup_sf.js --network baseSepolia
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const addrFile = path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json");
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8"));
  const sfAddr = addrs.stabilityFund;
  const usdcAddr = addrs.usdc;
  if (!sfAddr || !usdcAddr) throw new Error("stabilityFund/usdc missing in " + addrFile);

  const amountUsd = Number(process.env.TOPUP_USDC || "1500");
  const amount = ethers.parseUnits(String(amountUsd), 6);

  const [owner] = await ethers.getSigners();
  const sf = new ethers.Contract(sfAddr, [
    "function receiveLayer(uint8,uint256,uint8) external",
    "function totalBalance() view returns (uint256)",
    "function owner() view returns (address)",
  ], owner);
  const usdc = new ethers.Contract(usdcAddr, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) external returns (bool)",
  ], owner);

  const fmt = v => "$" + ethers.formatUnits(v, 6);
  console.log("Signer:", owner.address, "| SF owner:", await sf.owner());
  console.log("SF:", sfAddr, "(" + path.basename(addrFile) + ")");
  console.log("Before  totalBalance:", fmt(await sf.totalBalance()), " SF USDC:", fmt(await usdc.balanceOf(sfAddr)));
  console.log("Topping up", fmt(amount), "via receiveLayer(t0, amount, L1)...");

  await (await usdc.approve(sfAddr, amount)).wait();
  await (await sf.receiveLayer(0, amount, 1)).wait();

  const tb = await sf.totalBalance(), ub = await usdc.balanceOf(sfAddr);
  console.log("After   totalBalance:", fmt(tb), " SF USDC:", fmt(ub));
  console.log(tb <= ub ? "INVARIANT OK (totalBalance <= SF USDC)" : "WARNING: totalBalance > SF USDC - investigate");
}
main().catch(e => { console.error(e); process.exit(1); });
