// fix_keeper_auth.js
// One-shot post-deploy fix: wire TierRouter.setMatrixKeeper(matrixKeeperAddr).
//
// ROOT CAUSE:
//   deploy_v8.js calls setMatrixKeeper on StabilityFund + all matrices but
//   NEVER calls it on TierRouter. So TierRouter.matrixKeeper = address(0).
//
// EFFECT OF THE BUG:
//   Every performUpkeep triggers _doVelocityCheck (because lastVelocityCheck
//   never updates — performUpkeep always reverts). _doVelocityCheck calls
//   tierRouter.setTierVelocityGreen() which requires msg.sender == matrixKeeper.
//   With matrixKeeper = address(0) every call reverts "TR: not keeper".
//   Result: keeper has been 100% non-functional since V8.16 was deployed.
//
// FIX:
//   Run this ONCE with the deployer key after each fresh deploy until
//   deploy_v8.js is patched to include the call automatically.
//
// Usage:
//   npx hardhat run scripts/fix_keeper_auth.js --network baseSepolia

const hre = require("hardhat");
const path = require("path");
const fs   = require("fs");

const ADDRS_FILE    = path.join(__dirname, "deployed_addresses_v8_16.json");

const TIER_ROUTER_ABI = [
  "function matrixKeeper() view returns (address)",
  "function setMatrixKeeper(address _keeper) external",
  "function owner() view returns (address)"
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const tierRouterAddr  = addrs.tierRouter;
  const matrixKeeperAddr = addrs.matrixKeeper;

  if (!tierRouterAddr || !matrixKeeperAddr) {
    throw new Error("tierRouter or matrixKeeper address missing from addresses file");
  }

  console.log(`TierRouter:    ${tierRouterAddr}`);
  console.log(`MatrixKeeper:  ${matrixKeeperAddr}`);

  const tierRouter = new hre.ethers.Contract(tierRouterAddr, TIER_ROUTER_ABI, deployer);

  // Check current state
  const current = await tierRouter.matrixKeeper();
  console.log(`\nCurrent TierRouter.matrixKeeper: ${current}`);

  if (current.toLowerCase() === matrixKeeperAddr.toLowerCase()) {
    console.log("✓ Already wired correctly — nothing to do.");
    return;
  }

  // Verify we are the owner
  const owner = await tierRouter.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Not the owner. Owner = ${owner}, deployer = ${deployer.address}`);
  }

  console.log("\nCalling tierRouter.setMatrixKeeper(matrixKeeperAddr)...");
  const tx = await tierRouter.setMatrixKeeper(matrixKeeperAddr);
  console.log(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed — block ${receipt.blockNumber}  status=${receipt.status === 1 ? "OK" : "FAILED"}`);

  // Verify
  const after = await tierRouter.matrixKeeper();
  if (after.toLowerCase() !== matrixKeeperAddr.toLowerCase()) {
    throw new Error(`Verification failed — TierRouter.matrixKeeper = ${after}`);
  }
  console.log(`\n✓ TierRouter.matrixKeeper is now set to ${after}`);
  console.log("  Keeper should recover on the next performUpkeep call.");
  console.log("  Watch keeper.log — first successful run will emit VelocityUpdated events.");
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
