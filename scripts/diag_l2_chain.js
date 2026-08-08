// diag_l2_chain.js - forensics for "L2 commission not in Total Earned" (Sherwyn, 2026-08-05).
// Walks the ON-CHAIN referral tree under a wallet via MemberRegistered(member, tier, referrer indexed)
// and reports, for each L1/L2 descendant, who their real on-chain referrer is - so we can
// tell "chain-pay never credited" (contract bug) apart from "the tree is not what the
// member thinks" (rotation-pool sponsor took the slot).
//   $env:WALLET="0x7d3c94885d2022200934d4908bca7b47905bbcf6"; npx hardhat run scripts/diag_l2_chain.js --network baseSepolia
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs"), path = require("path");

async function main() {
  const W = (process.env.WALLET || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(W)) throw new Error("set WALLET=0x...");
  const a = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"), "utf8"));
  const p = ethers.provider;
  const tr = new ethers.Contract(a.tierRouter, [
    "event MemberRegistered(address indexed member, uint8 tier, address indexed referrer)",
    "function memberHighestTier(address) view returns (uint8)",
  ], p);

  const blk = await p.getBlockNumber();
  const FROM = Number(process.env.FROM_BLOCK || 45060000);
  const win = 9000;
  const kids = async (ref) => {
    const out = [];
    for (let f = FROM; f <= blk; f += win) {
      const logs = await tr.queryFilter(tr.filters.MemberRegistered(null, null, ref), f, Math.min(f + win - 1, blk)).catch(() => []);
      logs.forEach(l => out.push({ member: l.args[0], tier: Number(l.args[1]), block: l.blockNumber, tx: l.transactionHash }));
      await new Promise(r => setTimeout(r, 120));
    }
    return out;
  };

  console.log("Root:", W, "highestTier:", Number(await tr.memberHighestTier(W)));
  const l1 = await kids(W);
  console.log(`L1 directs on-chain: ${l1.length}`);
  for (const d of l1) {
    console.log(`  L1 ${d.member}  T${d.tier}  block ${d.block}`);
    const l2 = await kids(d.member);
    for (const g of l2) console.log(`      L2 ${g.member}  T${g.tier}  block ${g.block}  tx ${g.tx}`);
    if (l2.length === 0) console.log("      (no on-chain directs under this L1)");
  }
  console.log("\nIf an expected direct is MISSING above, that person registered under a different");
  console.log("on-chain referrer (rotation pool / no ref link) - the chain paid whoever that is.");
  console.log("If the L2 IS listed, paste its tx hash and we trace the chain-pay credits in it.");
}
main().catch(e => { console.error(e); process.exit(1); });
