"use strict";
/**
 * enumerate_stranded_v843.js — V8.44 plan item C: enumerate every V8.43 wallet
 * with a STRANDED crossing reserve (cycled out of a MatB, not re-seated, not
 * parked, crossingReserve > 0 — unreachable by any member-facing path on
 * V8.43). Output feeds the community recovery announcement; compensation on
 * V8.44 happens via coupons / grantFreeReentry from this list.
 *
 * Run on Windows against Base Sepolia (V8.43 addresses file):
 *   npx hardhat run scripts/enumerate_stranded_v843.js --network baseSepolia
 *
 * Env: ADDRESSES_FILE must point to deployed_addresses_v8_43.json.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const addrFile = process.env.ADDRESSES_FILE || "deployed_addresses_v8_43.json";
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, addrFile), "utf8"));

  const pmAbi = [
    "function pairCount() view returns (uint256)",
    "function getPairAt(uint256) view returns (address,address)",
  ];
  const matAbi = [
    "function crossingReserveOf(address) view returns (uint256)",
    "function isActiveInMatrix(address) view returns (bool)",
    "function parkedAt(address) view returns (uint256)",
    "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
  ];

  // Collect every tier PairManager from the addresses file (keys vary by
  // deploy script version — match anything containing "pairManager").
  const pms = Object.entries(addrs)
    .filter(([k, v]) => /pairmanager/i.test(k) && /^0x[0-9a-fA-F]{40}$/.test(v))
    .map(([k, v]) => ({ name: k, addr: v }));

  const stranded = [];
  let totalStranded = 0n;

  for (const { name, addr } of pms) {
    const pm = new ethers.Contract(addr, pmAbi, ethers.provider);
    let n;
    try { n = await pm.pairCount(); } catch { continue; }
    for (let p = 0n; p < n; p++) {
      const [, matBAddr] = await pm.getPairAt(p);
      const matB = new ethers.Contract(matBAddr, matAbi, ethers.provider);
      const logs = await matB.queryFilter(matB.filters.MemberCycledOut(), 0);
      const members = [...new Set(logs.map((l) => l.args[0]))];
      for (const m of members) {
        const [inMat, parked, reserve] = await Promise.all([
          matB.isActiveInMatrix(m), matB.parkedAt(m), matB.crossingReserveOf(m),
        ]);
        if (!inMat && parked === 0n && reserve > 0n) {
          stranded.push({ tier: name, matB: matBAddr, member: m, reserve: reserve.toString() });
          totalStranded += reserve;
          console.log(`STRANDED ${name} ${matBAddr} ${m} $${Number(reserve) / 1e6}`);
        }
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    addressesFile: addrFile,
    count: stranded.length,
    totalStrandedUsdc: totalStranded.toString(),
    totalStrandedUsd: Number(totalStranded) / 1e6,
    wallets: stranded,
  };
  const outPath = path.join(__dirname, "stranded_v843.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n${stranded.length} stranded wallets, $${out.totalStrandedUsd} total -> ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
