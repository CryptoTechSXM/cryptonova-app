const { ethers } = require("ethers");
require("dotenv").config();

const MATA = "0x62D2b758c2bC4cd73DCe8bF895e189e6FD57dCA3";
const MK   = "0xFe7ADd5c62695F0E437835670Bc88223EaA51865";

const MAT_ABI = [
  "function getParkedCount() external view returns (uint256)",
  "function getParkedMember(uint256) external view returns (address)",
  "function withdrawableOf(address) external view returns (uint256)",
  "function getMemberTotalWithdrawn(address) external view returns (uint256)",
  "function isParked(address) external view returns (bool)",
  "function parkedAt(address) external view returns (uint256)",
  "function rescueDebtOf(address) external view returns (uint256)",
  "function ENTRY_FEE() external view returns (uint256)",
];
const MK_ABI = [
  "function parkedGracePeriod() external view returns (uint256)",
  "function rescueRatioBps() external view returns (uint256)",
  "function sfRescueThresholds(uint256) external view returns (uint256)",
  "function sfRescueBpsLadder(uint256) external view returns (uint256)",
];

async function sfRescueBps(withdrawable, fee, thresholds) {
  const n = thresholds.length;
  if (n === 0) return 10000;
  const wBps = Number(withdrawable) * 10000 / Number(fee);
  for (let i = 0; i < n; i++) {
    if (wBps >= thresholds[i]) return thresholds[i] === 0 ? 0 : undefined; // placeholder
  }
  return null; // type(uint256).max — cannot rescue
}

async function main() {
  const { JsonRpcProvider } = require("ethers");
  const provider = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");

  const matA = new ethers.Contract(MATA, MAT_ABI, provider);
  const mk   = new ethers.Contract(MK, MK_ABI, provider);

  const fee = await matA.ENTRY_FEE();
  const grace = await mk.parkedGracePeriod();
  const ratioBps = await mk.rescueRatioBps().catch(() => 9000n);
  const nowSecs = Math.floor(Date.now() / 1000);

  // Read thresholds and bps
  const thresholds = [], bps = [];
  for (let i = 0; i < 12; i++) {
    try {
      thresholds.push(Number(await mk.sfRescueThresholds(i)));
      bps.push(Number(await mk.sfRescueBpsLadder(i)));
    } catch { break; }
  }

  const count = Number(await matA.getParkedCount());
  console.log(`\nParked in MatA: ${count}  fee=$${Number(fee)/1e6}  grace=${Number(grace)/3600}h  rescueRatioBps=${ratioBps}`);
  console.log(`Rescue ladder: ${thresholds.length} steps (lowest threshold=${thresholds[thresholds.length-1]}bps = ${thresholds[thresholds.length-1]/100}%)\n`);
  console.log("addr                                       withdrawable  withdrawn  wBps   rescue_action  age(h)  parkedAt");
  console.log("─".repeat(120));

  let rescueEligible = 0, evictEligible = 0, inGrace = 0;
  for (let i = 0; i < count; i++) {
    const addr = await matA.getParkedMember(i);
    const w    = await matA.withdrawableOf(addr).catch(() => 0n);
    const wdrn = await matA.getMemberTotalWithdrawn(addr).catch(() => 0n);
    const ts   = await matA.parkedAt(addr).catch(() => 0n);
    const debt = await matA.rescueDebtOf(addr).catch(() => 0n);
    const isP  = await matA.isParked(addr).catch(() => false);

    const wNum = Number(w); const wdrnNum = Number(wdrn);
    const totalEarned = wNum + wdrnNum;
    const withdrawRatio = totalEarned > 0 ? wdrnNum * 10000 / totalEarned : 0;
    const wBps = Number(w) * 10000 / Number(fee);
    const ageH = (nowSecs - Number(ts)) / 3600;
    const pastGrace = nowSecs >= Number(ts) + Number(grace);

    let rescueAction;
    if (!pastGrace) { rescueAction = "IN_GRACE"; inGrace++; }
    else if (withdrawRatio > Number(ratioBps)) { rescueAction = "EVICT(ratio)"; evictEligible++; }
    else {
      // find sfBps
      let sfBpsVal = null;
      for (let j = 0; j < thresholds.length; j++) {
        if (wBps >= thresholds[j]) { sfBpsVal = bps[j]; break; }
      }
      if (sfBpsVal === null) { rescueAction = "EVICT(no_ladder)"; evictEligible++; }
      else { rescueAction = `RESCUE(sf=${sfBpsVal/100}%)`; rescueEligible++; }
    }

    console.log(`${addr}  $${(wNum/1e6).toFixed(2).padStart(6)}  $${(wdrnNum/1e6).toFixed(2).padStart(6)}  ${wBps.toFixed(0).padStart(5)}  ${rescueAction.padEnd(20)}  ${ageH.toFixed(1).padStart(5)}h  debt=$${Number(debt)/1e6}`);
  }
  console.log("─".repeat(120));
  console.log(`\nSummary: RESCUE=${rescueEligible}  EVICT=${evictEligible}  IN_GRACE=${inGrace}`);
}
main().catch(console.error);
