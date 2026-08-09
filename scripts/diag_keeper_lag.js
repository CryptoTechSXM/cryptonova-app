// diag_keeper_lag.js — why are parked members waiting past the grace window?
//
// Found 2026-08-08 via diag_matb_source.js: 111 of 115 T1.1 MatB entrants had
// been PARKED at MatA, median lag 37.6h against a 24h testnet grace. The keeper
// is ~13h behind its own rule. Three candidate causes, and this separates them:
//   (a) MatrixKeeper.maxItemsPerUpkeep = 15  -> batch throttle
//   (b) cron interval on the VPS             -> check crontab separately
//   (c) StabilityFund floor gate             -> "SF: below floor" reverts when
//       totalBalance < cost + stabilityFloor, so rescues stall on funding
//
// Run: npx hardhat run scripts/diag_keeper_lag.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const PM = ["function pairCount() view returns (uint256)",
            "function getPairAt(uint256) view returns (address,address)"];
const MX = ["function getParkedCount() view returns (uint256)",
            "function getParkedMember(uint256) view returns (address)",
            "function parkedAt(address) view returns (uint256)",
            "function ENTRY_FEE() view returns (uint256)"];
const SF = ["function totalBalance() view returns (uint256)",
            "function stabilityFloor() view returns (uint256)",
            "function sfTarget() view returns (uint256)",
            // NOTE: tierEntryFees is a fixed-size array — its auto-getter takes uint256, NOT uint8.
            "function tierEntryFees(uint256) view returns (uint256)"];
const KP = ["function maxItemsPerUpkeep() view returns (uint256)"];

const hrs = s => (s / 3600).toFixed(1);

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const pm  = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const n   = Number(await pm.pairCount());

  console.log("PARKED QUEUES (T1)");
  let total = 0; const dwells = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = await pm.getPairAt(i);
    for (const [label, addr] of [[`T1.${i + 1} MatA`, a], [`T1.${i + 1} MatB`, b]]) {
      const m = await ethers.getContractAt(MX, addr);
      const c = Number(await m.getParkedCount());
      total += c;
      let oldest = 0;
      for (let k = 0; k < Math.min(c, 200); k++) {
        const who = await m.getParkedMember(k);
        const at  = Number(await m.parkedAt(who));
        if (at > 0) { const d = now - at; dwells.push(d); if (d > oldest) oldest = d; }
      }
      console.log(`  ${label.padEnd(12)} parked ${String(c).padStart(4)}` +
                  (c ? `   oldest waiting ${hrs(oldest)}h` : ""));
    }
  }
  dwells.sort((x, y) => x - y);
  if (dwells.length) {
    console.log(`\n  total parked ${total}   median wait ${hrs(dwells[Math.floor(dwells.length / 2)])}h` +
                `   max ${hrs(dwells[dwells.length - 1])}h`);
    const over24 = dwells.filter(d => d > 24 * 3600).length;
    console.log(`  waiting past the 24h testnet grace: ${over24} of ${dwells.length}`);
  }

  console.log("\nSTABILITY FUND CAPACITY  <- cause (c)");
  const sf = await ethers.getContractAt(SF, A.stabilityFund);
  const [bal, floor, target, t1fee] = await Promise.all([
    sf.totalBalance(), sf.stabilityFloor(), sf.sfTarget().catch(() => 0n), sf.tierEntryFees(0),
  ]);
  const usd = v => "$" + (Number(v) / 1e6).toFixed(2);
  const spendable = bal > floor ? bal - floor : 0n;
  const capacity  = t1fee > 0n ? Number(spendable / t1fee) : 0;
  console.log(`  totalBalance   ${usd(bal)}`);
  console.log(`  stabilityFloor ${usd(floor)}   (rescues revert below this)`);
  console.log(`  sfTarget       ${usd(target)}`);
  console.log(`  T1 entry fee   ${usd(t1fee)}`);
  console.log(`  spendable      ${usd(spendable)}  ->  ${capacity} T1 rescue(s) available RIGHT NOW`);
  if (capacity < total) {
    console.log(`  *** CAPACITY-BOUND: ${total} parked but only ${capacity} rescues fundable.`);
    console.log(`      The keeper cannot drain faster than the SF refills. This is the bottleneck.`);
  } else {
    console.log(`  SF can fund the whole queue — so the lag is the batch cap or the cron interval.`);
  }

  console.log("\nKEEPER THROTTLE  <- cause (a)");
  try {
    const kp = await ethers.getContractAt(KP, A.matrixKeeper);
    const mi = Number(await kp.maxItemsPerUpkeep());
    console.log(`  maxItemsPerUpkeep = ${mi}`);
    console.log(`  at 1 upkeep/5min that is ${mi * 12}/hr; the queue of ${total} needs ` +
                `${mi ? (total / (mi * 12)).toFixed(1) : "?"}h of continuous running.`);
  } catch (e) { console.log("  could not read MatrixKeeper: " + e.message); }

  console.log("\nNEXT: check the cron interval on the VPS  <- cause (b)");
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
