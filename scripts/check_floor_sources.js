// check_floor_sources.js — compare every floor-price source.
//
// WHY: the frontend had THREE sites computing the floor from
// usdc.balanceOf(treasury) while redemption pays CNOVATreasury.floorPrice()
// (= usdcReserve / totalSupply). usdcReserve is an accumulator fed only by
// depositReserve(), so any USDC reaching the address another way makes the
// displayed floor drift ABOVE what a member is actually paid.
// Fixed frontend-side 2026-08-08 (Testnet-App d25b718). This script is the
// standing check that the two definitions still agree on-chain.
//
// Run:  npx hardhat run scripts/check_floor_sources.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");

// Repo convention: ADDRESSES_FILE in .env, resolved relative to scripts/.
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"
);
const A = require(ADDRESSES_FILE);

async function main() {
  const { treasury, cnova, usdc } = A;
  if (!treasury || !cnova || !usdc) {
    throw new Error("Missing treasury/cnova/usdc in " + ADDRESSES_FILE);
  }
  console.log("addresses file:", path.basename(ADDRESSES_FILE), "(deployed", A.deployedAt + ")");

  const T = await ethers.getContractAt(
    ["function floorPrice() view returns (uint256)",
     "function usdcReserve() view returns (uint256)"], treasury);
  const C = await ethers.getContractAt(["function totalSupply() view returns (uint256)"], cnova);
  const U = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], usdc);

  const [floor, reserve, supply, bal] = await Promise.all([
    T.floorPrice(), T.usdcReserve(), C.totalSupply(), U.balanceOf(treasury),
  ]);

  const usd = v => "$" + (Number(v) / 1e6).toFixed(6);
  const derived = supply > 0n ? (bal * 10n ** 18n) / supply : 0n;

  console.log("treasury          ", treasury);
  console.log("floorPrice()      ", floor.toString().padStart(12), usd(floor), " <-- what redemption PAYS");
  console.log("balance/supply    ", derived.toString().padStart(12), usd(derived), " <-- old frontend formula");
  console.log("usdcReserve()     ", reserve.toString().padStart(12), usd(reserve));
  console.log("usdc.balanceOf(T) ", bal.toString().padStart(12), usd(bal));
  console.log("CNOVA totalSupply ", ethers.formatEther(supply));
  console.log("");

  const drift = bal - reserve;
  console.log("DRIFT balanceOf - usdcReserve =", drift.toString(), "(6-dec USDC)");
  console.log(drift === 0n
    ? "OK - both definitions agree."
    : "*** DIVERGED *** UI would show " + usd(derived) + " but redemption pays " + usd(floor));

  // V8.48 watch item: Option A's T1 mint clamp releases at the epoch-2 halving
  // ONLY while the floor is under $0.0125. Above that it survives the halving.
  const f = Number(floor) / 1e6;
  console.log("");
  console.log("floor $" + f.toFixed(6) + (f < 0.0125
    ? "  < $0.012500 - T1 clamp still releases at the epoch-2 halving"
    : "  >= $0.012500 - T1 clamp would SURVIVE the halving (revisit Option A sizing)"));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
