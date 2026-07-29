const { ethers } = require("hardhat");
async function main() {
  const SF_ADDR = "0x1Bcb0A0cfa161716Ad96B98d7eC6E8894E2773c0";
  const ABI = [
    "function communityCarveOutBps() view returns (uint256)",
    "function totalBalance() view returns (uint256)",
    "function stabilityFloor() view returns (uint256)",
    "function communityWallet() view returns (address)",
  ];
  const [signer] = await ethers.getSigners();
  const sf = new ethers.Contract(SF_ADDR, ABI, signer);
  const [carve, bal, floor, cw] = await Promise.all([
    sf.communityCarveOutBps(),
    sf.totalBalance(),
    sf.stabilityFloor(),
    sf.communityWallet(),
  ]);
  console.log(`communityCarveOutBps : ${carve} bps (${Number(carve)/100}%)`);
  console.log(`totalBalance         : $${Number(bal)/1e6}`);
  console.log(`stabilityFloor       : $${Number(floor)/1e6}`);
  console.log(`communityWallet      : ${cw}`);
}
main().catch(e => { console.error(e); process.exit(1); });
