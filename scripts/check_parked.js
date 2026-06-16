"use strict";
/**
 * check_parked.js — scan all 20 matrices for stuck/parked members
 *                   and verify MatrixKeeper wiring on V8.15 deployment
 *
 * Run:
 *   npx hardhat run scripts/check_parked.js --network baseSepolia
 */
const { ethers } = require("hardhat");
require("dotenv").config();

const MATRIX_ABI = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256 idx) view returns (address)",
  "function isParked(address) view returns (bool)",
  "function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
  "function ENTRY_FEE() view returns (uint256)",
  "function matrixKeeper() view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function isMatrixA() view returns (bool)",
];

async function main() {
  const addrs = require("./deployed_addresses_v8_16.json");

  const matrices = [
    { label: "T1-A",  addr: addrs.tiers.T1.matA  },
    { label: "T1-B",  addr: addrs.tiers.T1.matB  },
    { label: "T2-A",  addr: addrs.tiers.T2.matA  },
    { label: "T2-B",  addr: addrs.tiers.T2.matB  },
    { label: "T3-A",  addr: addrs.tiers.T3.matA  },
    { label: "T3-B",  addr: addrs.tiers.T3.matB  },
    { label: "T4-A",  addr: addrs.tiers.T4.matA  },
    { label: "T4-B",  addr: addrs.tiers.T4.matB  },
    { label: "T5-A",  addr: addrs.tiers.T5.matA  },
    { label: "T5-B",  addr: addrs.tiers.T5.matB  },
    { label: "T6-A",  addr: addrs.tiers.T6.matA  },
    { label: "T6-B",  addr: addrs.tiers.T6.matB  },
    { label: "T7-A",  addr: addrs.tiers.T7.matA  },
    { label: "T7-B",  addr: addrs.tiers.T7.matB  },
    { label: "T8-A",  addr: addrs.tiers.T8.matA  },
    { label: "T8-B",  addr: addrs.tiers.T8.matB  },
    { label: "T9-A",  addr: addrs.tiers.T9.matA  },
    { label: "T9-B",  addr: addrs.tiers.T9.matB  },
    { label: "T10-A", addr: addrs.tiers.T10.matA },
    { label: "T10-B", addr: addrs.tiers.T10.matB },
  ];

  const expectedKeeper = addrs.matrixKeeper;
  console.log("MatrixKeeper expected:", expectedKeeper);
  console.log("Scanning 20 matrices...\n");

  let totalParked = 0;
  const allParked = [];
  const keeperMismatches = [];

  for (const m of matrices) {
    const mc = await ethers.getContractAt("FigureEightMatrixV8", m.addr);

    const [count, keeperAddr, entryFee] = await Promise.all([
      mc.getParkedCount().catch(() => 0n),
      mc.matrixKeeper().catch(() => ethers.ZeroAddress),
      mc.ENTRY_FEE().catch(() => 0n),
    ]);

    const keeperOk = keeperAddr.toLowerCase() === expectedKeeper.toLowerCase();
    if (!keeperOk) keeperMismatches.push({ label: m.label, addr: m.addr, keeper: keeperAddr });

    if (Number(count) > 0) {
      process.stdout.write(`  ${m.label}: ${count} parked`);
      for (let i = 0; i < Number(count); i++) {
        const member = await mc.getParkedMember(i);
        const info   = await mc.getMember(member).catch(() => null);
        const since  = await mc.parkedAt(member).catch(() => 0n);
        const withdrawable = info ? BigInt(info.withdrawable) : 0n;
        const shortfall    = entryFee > withdrawable ? entryFee - withdrawable : 0n;
        const hoursAgo     = since > 0n ? ((BigInt(Math.floor(Date.now()/1000)) - since) / 3600n).toString() : '?';
        allParked.push({
          matrix:      m.label,
          matAddr:     m.addr,
          member,
          withdrawable,
          entryFee,
          shortfall,
          hoursAgo,
        });
      }
      console.log();
    } else {
      console.log(`  ${m.label}: none`);
    }
    totalParked += Number(count);
  }

  // ── Summary ──
  console.log("\n" + "═".repeat(62));
  console.log(`  Total parked members: ${totalParked}`);
  console.log("═".repeat(62));

  if (allParked.length > 0) {
    console.log("\n── Parked member details ──");
    for (const p of allParked) {
      console.log(`\n  Matrix:      ${p.matrix} (${p.matAddr})`);
      console.log(`  Member:      ${p.member}`);
      console.log(`  Withdrawable: $${(Number(p.withdrawable)/1e6).toFixed(2)}`);
      console.log(`  Entry fee:   $${(Number(p.entryFee)/1e6).toFixed(2)}`);
      console.log(`  Shortfall:   $${(Number(p.shortfall)/1e6).toFixed(2)}`);
      console.log(`  Parked ~${p.hoursAgo}h ago`);
    }
  }

  // ── Keeper wiring ──
  console.log("\n── MatrixKeeper wiring ──");
  if (keeperMismatches.length === 0) {
    console.log("  All 20 matrices have correct MatrixKeeper ✅");
  } else {
    console.log(`  ❌ ${keeperMismatches.length} matrices have wrong keeper:`);
    for (const k of keeperMismatches) {
      console.log(`    ${k.label}: has ${k.keeper}`);
      console.log(`            expected ${expectedKeeper}`);
    }
    console.log("\n  → Run fix_set_keeper.js to correct wiring");
  }

  // ── Chainlink check hint ──
  console.log("\n── Chainlink upkeep ──");
  console.log("  Keeper contract:", expectedKeeper);
  console.log("  To check if upkeep is registered, verify at:");
  console.log("  https://automation.chain.link/base-sepolia");
  console.log("  (Task #86 — register new upkeep for V8.15 — is still pending)");
}

main().catch(e => { console.error(e); process.exit(1); });
