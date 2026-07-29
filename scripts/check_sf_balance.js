/**
 * check_sf_balance.js
 * Quick read: current SF totalBalance + deployer USDC balance.
 * Run after seed_sf_v8_27.js to verify the deposit landed.
 *
 *   npx hardhat run scripts/check_sf_balance.js --network baseSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

const SF_ADDR       = "0x77243188415c6ec7E899303766E4425fa814b6Aa"; // V8.29
const USDC_ADDR     = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const DEPLOYER_ADDR = "0xCd0Af6a4116f2062c1594aDf34c1821D45175506";

const SF_ABI = [
  "function totalBalance() external view returns (uint256)",
  "function stabilityFloor() external view returns (uint256)",
];
const USDC_ABI = [
  "function balanceOf(address) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

async function main() {
  const provider = hre.ethers.provider;

  const sf   = new ethers.Contract(SF_ADDR,   SF_ABI,   provider);
  const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, provider);

  const block       = await provider.getBlockNumber();
  const sfBal       = await sf.totalBalance();
  const sfFloor     = await sf.stabilityFloor();
  const deployerBal = await usdc.balanceOf(DEPLOYER_ADDR);
  const sfUSDCRaw   = await usdc.balanceOf(SF_ADDR);
  const allowance   = await usdc.allowance(DEPLOYER_ADDR, SF_ADDR);

  console.log("\n-- SF Balance Check -- block", block, "--");
  console.log("SF totalBalance  :", "$" + (Number(sfBal) / 1e6).toFixed(2));
  console.log("SF raw USDC held :", "$" + (Number(sfUSDCRaw) / 1e6).toFixed(2));
  console.log("SF floor         :", "$" + (Number(sfFloor) / 1e6).toFixed(2));
  console.log("Deployer USDC    :", "$" + (Number(deployerBal) / 1e6).toFixed(2));
  console.log("SF allowance     :", "$" + (Number(allowance) / 1e6).toFixed(2), "(remaining approval)");
}

main().catch(e => { console.error(e); process.exit(1); });
