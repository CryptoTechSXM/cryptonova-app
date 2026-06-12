"use strict";
const { ethers } = require("hardhat");

const T1 = "0xaCaFa367Ee367aF933FEc35503163081cdfbe6b6";
const TM = "0x556D1aE584EBAcD92AaEB50B66BF04C959fcAAc7";

const T1_ABI = [
  {"inputs":[],"name":"totalMembers","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"memberById","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
];
const TM_ABI = [
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"memberTier","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"member","type":"address"},{"internalType":"uint8","name":"tier","type":"uint8"}],"name":"adminSetMemberTier","outputs":[],"stateMutability":"nonpayable","type":"function"},
];

async function main() {
  const [admin] = await ethers.getSigners();
  const t1 = await ethers.getContractAt(T1_ABI, T1);
  const tm = await ethers.getContractAt(TM_ABI, TM);
  
  const total = Number(await t1.totalMembers());
  console.log(`Syncing ${total} Tier 1 members to TierManager...`);
  
  let synced = 0, skipped = 0;
  for (let i = 1; i <= total; i++) {
    const addr = await t1.memberById(i);
    const currentTier = Number(await tm.memberTier(addr));
    if (currentTier === 0) {
      process.stdout.write(`  Syncing member #${i} (${addr.slice(0,8)}…) ... `);
      try { await (await tm.adminSetMemberTier(addr, 1)).wait(); } catch(e2) { if(e2.message&&e2.message.includes("already known")) { console.log("(pending - will confirm)"); } else { throw e2; } }
      console.log('✓');
      synced++;
    } else {
      skipped++;
    }
  }
  console.log(`\n✅ Done — ${synced} synced, ${skipped} already set`);
}
main().catch(e => { console.error(e); process.exit(1); });
