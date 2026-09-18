// scripts/diag_debt_events.js — READ-ONLY. Every MemberDebtIncreased / MemberDebtRepaid for one member
// on the book's StabilityFund, with the tx sender, the called contract and 4-byte selector, so a debt
// can be traced to WHO booked it. Session 92: W1 read debt $11.73 before prove_v856_debt booked anything.
// Run: $env:ADDRESSES_FILE="deployed_addresses_v8_56_private.json"; $env:MEMBER="0x..."
//      npx hardhat run scripts/diag_debt_events.js --network baseSepolia
const path = require("path");
require("./rpc_resilience");
const { ethers } = require("hardhat");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "__missing__"));
const MEMBER = process.env.MEMBER || A.accountOne;
const usd = v => "$" + (Number(v) / 1e6).toFixed(6);
async function main() {
  const p = ethers.provider;
  const sf = await ethers.getContractAt("StabilityFund", A.stabilityFund);
  const head = await p.getBlockNumber();
  // start near the deploy: deployedAt -> ~2 s blocks on Base; widen generously
  const from = Math.max(0, head - Math.ceil((Date.now() - Date.parse(A.deployedAt)) / 2000) - 2000);
  console.log(`diag_debt_events  book ${process.env.ADDRESSES_FILE}  SF ${A.stabilityFund}  member ${MEMBER}  blocks ${from}..${head}`);
  const evs = [];
  for (const name of ["MemberDebtIncreased", "MemberDebtRepaid"]) {
    const f = sf.filters[name](MEMBER);
    for (let s = from; s <= head; s += 9000) {
      const e = Math.min(head, s + 8999);
      for (let k = 0; ; k++) { try { evs.push(...(await sf.queryFilter(f, s, e))); break; }
        catch (err) { if (k > 5) throw err; await new Promise(r => setTimeout(r, 3000)); } }
    }
  }
  evs.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  if (!evs.length) console.log("  NO debt events for this member in range.");
  for (const ev of evs) {
    const tx = await p.getTransaction(ev.transactionHash);
    const blk = await p.getBlock(ev.blockNumber);
    const a = ev.args;
    const what = ev.fragment.name === "MemberDebtIncreased"
      ? `+${usd(a.amount)} tier ${a.tier} → total ${usd(a.newTotal)}`
      : `-${usd(a.amount)} → total ${usd(a.newTotal)}`;
    console.log(`  ${new Date(blk.timestamp * 1000).toISOString()} block ${ev.blockNumber} ${ev.fragment.name} ${what}`);
    console.log(`      tx ${ev.transactionHash}  from ${tx.from}  to ${tx.to}  selector ${tx.data.slice(0, 10)}`);
  }
  console.log(`  memberDebtOf now (@${head}): ${usd(await sf.memberDebtOf(MEMBER, { blockTag: head }))}`);
  console.log(`  known: deployer ${A.deployer} · W1 ${A.accountOne} · router ${A.tierRouter}`);
}
main().catch(e => { console.error("FATAL:", e.shortMessage || e.message); process.exit(1); });
