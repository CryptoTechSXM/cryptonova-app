// diag_matb_source.js — are T1.1 MatB's entrants previously-PARKED members?
//
// diag_matb_inflow.js showed 116 entries into T1.1 MatB against only 3 MatA
// cycle-outs in the same window, all 115 unexplained entrants distinct. The
// hypothesis: they cycled out of MatA EARLIER, were parked (crossing fee
// unaffordable -> _finalizeCrossing parks instead of seating), and the rescue
// keeper is now funding their crossing. Entry and cycle-out are decoupled in
// time, so a same-window match was never going to find them.
//
// Run: npx hardhat run scripts/diag_matb_source.js --network baseSepolia
//      BLOCKS=3000 LOOKBACK=120000 npx hardhat run ...
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));
const BLOCKS   = Number(process.env.BLOCKS   || 3000);
const LOOKBACK = Number(process.env.LOOKBACK || 120000);
const CHUNK    = 9000; // stay under the 10k getLogs cap

const PM = ["function pairCount() view returns (uint256)",
            "function getPairAt(uint256) view returns (address,address)"];
const MX = ["event MemberEntered(address indexed member, uint256 position, uint256 id, address matrix)",
            "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
            "event MemberParked(address indexed member, uint256 shortfall)",
            "function parkedCount() view returns (uint256)"];

async function scan(c, filter, from, to) {
  const out = [];
  for (let b = from; b <= to; b += CHUNK) {
    const end = Math.min(b + CHUNK - 1, to);
    const ev = await c.queryFilter(filter, b, end).catch(() => []);
    out.push(...ev);
  }
  return out;
}

async function main() {
  const head = await ethers.provider.getBlockNumber();
  const pm = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const [a1, b1] = await pm.getPairAt(0);
  const MA = await ethers.getContractAt(MX, a1);
  const MB = await ethers.getContractAt(MX, b1);

  const recentFrom = head - BLOCKS;
  const bIn = await scan(MB, MB.filters.MemberEntered(), recentFrom, head);
  const entrants = [...new Set(bIn.map(e => e.args.member.toLowerCase()))];
  console.log(`T1.1 MatB entries in last ${BLOCKS} blocks: ${bIn.length} (${entrants.length} distinct)\n`);

  const deepFrom = Math.max(0, head - LOOKBACK);
  console.log(`scanning T1.1 MatA history ${deepFrom}..${head} for these members...`);
  const aOut    = await scan(MA, MA.filters.MemberCycledOut(), deepFrom, head);
  const aParked = await scan(MA, MA.filters.MemberParked(),    deepFrom, head);

  const outSet    = new Map(aOut.map(e => [e.args.member.toLowerCase(), e.blockNumber]));
  const parkedSet = new Map(aParked.map(e => [e.args.member.toLowerCase(), e.blockNumber]));

  let cycledEarlier = 0, parkedEarlier = 0, neither = [];
  for (const m of entrants) {
    const c = outSet.has(m), p = parkedSet.has(m);
    if (p) parkedEarlier++;
    if (c) cycledEarlier++;
    if (!c && !p) neither.push(m);
  }

  console.log(`\nOF THE ${entrants.length} DISTINCT MatB ENTRANTS:`);
  console.log(`  previously CYCLED OUT of T1.1 MatA : ${cycledEarlier}`);
  console.log(`  previously PARKED at T1.1 MatA     : ${parkedEarlier}`);
  console.log(`  neither (never seen in MatA)       : ${neither.length}`);
  if (neither.length) {
    console.log(`  sample:`);
    for (const m of neither.slice(0, 8)) console.log(`    ${m}`);
    console.log(`  -> these entered MatB WITHOUT passing through MatA. Direct routing,`);
    console.log(`     registerForMatB, or a rescue path seating them straight in.`);
  }

  // lag between MatA departure and MatB entry
  const bBlock = new Map();
  for (const e of bIn) bBlock.set(e.args.member.toLowerCase(), e.blockNumber);
  const lags = entrants
    .map(m => { const src = parkedSet.get(m) ?? outSet.get(m); return src ? bBlock.get(m) - src : null; })
    .filter(x => x !== null && x >= 0)
    .sort((x, y) => x - y);
  if (lags.length) {
    const med = lags[Math.floor(lags.length / 2)];
    console.log(`\nLAG from MatA departure -> MatB entry (blocks): min ${lags[0]}  median ${med}  max ${lags[lags.length - 1]}`);
    console.log(`  ~${Math.round(med * 2 / 60)} min median at 2s blocks. A large lag = parked backlog draining.`);
  }
  try { console.log(`\nT1.1 MatA parkedCount() now: ${Number(await MA.parkedCount())}`); } catch (_) {}
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
