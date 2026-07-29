"use strict";
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
require("dotenv").config();

const WALLETS = {
  "Sherwyn TokenPocket": "0x774481dac8584cfafb5b6b6fad883787b343c573",
  "Sherwyn MetaMask":    "0xfb3adda5454d23f5a60ee12caf75891e9712f9d3",
};

const TR_ABI = [
  "function globalJoined(address) view returns (bool)",
  "function memberHighestTier(address) view returns (uint8)",
  "function tierEntryFees(uint256) view returns (uint256)",
  "function tierWhaleGateActive(uint8) view returns (bool)",
  "function tierVelocityGateOpen(uint8) view returns (bool)",
  "function tierCycles(address,uint8) view returns (uint256)",
  "function manualUpgrade(uint8)",
  "function register(address,bool,bool,bytes32) payable",
];
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const ADDRS = JSON.parse(fs.readFileSync(path.join(__dirname, "deployed_addresses_v8_37.json")));
  const [signer] = await ethers.getSigners();
  const p = signer.provider;
  const tr   = new ethers.Contract(ADDRS.tierRouter, TR_ABI, p);
  const usdc = new ethers.Contract(ADDRS.usdc, USDC_ABI, p);

  // Gate state
  const [whale5, vel2] = await Promise.all([
    tr.tierWhaleGateActive(5).catch(()=>'N/A'),
    tr.tierVelocityGateOpen(2).catch(()=>'N/A'),
  ]);
  const t2Fee = await tr.tierEntryFees(1);
  console.log(`T2 fee: $${(Number(t2Fee)/1e6).toFixed(2)}  whaleGate[5]=${whale5}  velGate[2]=${vel2}\n`);

  for (const [label, addr] of Object.entries(WALLETS)) {
    console.log(`${'='.repeat(50)}`);
    console.log(`${label}: ${addr}`);
    const [joined, highest, cycles0, cycles1, bal, allowance] = await Promise.all([
      tr.globalJoined(addr),
      tr.memberHighestTier(addr).catch(()=>0),
      tr.tierCycles(addr, 0).catch(()=>0n),
      tr.tierCycles(addr, 1).catch(()=>0n),
      usdc.balanceOf(addr),
      usdc.allowance(addr, ADDRS.tierRouter),
    ]);
    console.log(`  globalJoined: ${joined}  memberHighestTier: T${highest}`);
    console.log(`  T1 cycles: ${cycles0}  T2 cycles: ${cycles1}`);
    console.log(`  USDC balance: $${(Number(bal)/1e6).toFixed(4)}`);
    console.log(`  USDC allowance to TierRouter: $${(Number(allowance)/1e6).toFixed(4)}`);

    // Simulate manualUpgrade(1) = T2
    const iface = new ethers.Interface(["function manualUpgrade(uint8)"]);
    try {
      await p.call({ from: addr, to: ADDRS.tierRouter, data: iface.encodeFunctionData("manualUpgrade", [1]) });
      console.log("  ✅ manualUpgrade(1) would SUCCEED");
    } catch(e) {
      console.log(`  ❌ manualUpgrade(1) REVERTS: ${e.reason || e.data || e.shortMessage || e.message?.slice(0,120)}`);
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
