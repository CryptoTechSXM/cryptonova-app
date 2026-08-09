// diag_matb_inflow.js — who is actually feeding T1.1 MatB?
//
// Owner question 2026-08-08: members are fed only into T1, bigfill is throttled
// to 1 registration / 5 min, and chainNext confirms the loop does NOT return to
// MatA (T1.1 MatA -> T1.1 MatB -> T1.2 MatA). So MatB's inflow should equal
// MatA's cycle-out rate (~1 per 5 min). Observed: MatB +24 rotations while
// MatA +1 over the same few minutes. This finds the other source.
//
// Run: npx hardhat run scripts/diag_matb_inflow.js --network baseSepolia
//      BLOCKS=3000 npx hardhat run scripts/diag_matb_inflow.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));
const BLOCKS = Number(process.env.BLOCKS || 3000);

const PM = ["function pairCount() view returns (uint256)",
            "function getPairAt(uint256) view returns (address,address)"];
const MX = ["function partner() view returns (address)",
            "function chainNext() view returns (address)",
            "function occupancy() view returns (uint256)",
            "function rotationCount() view returns (uint256)",
            "event MemberEntered(address indexed member, uint256 position, uint256 id, address matrix)",
            "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotation, address matrix)",
            "event MemberCrossedToPartner(address indexed member, address from, address to)"];

async function main() {
  const prov = ethers.provider;
  const head = await prov.getBlockNumber();
  const from = Math.max(0, head - BLOCKS);
  const pm = await ethers.getContractAt(PM, A.tiers.T1.pm);
  const n = Number(await pm.pairCount());

  const mats = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = await pm.getPairAt(i);
    mats.push({ label: `T1.${i + 1} MatA`, addr: a });
    mats.push({ label: `T1.${i + 1} MatB`, addr: b });
  }
  const nameOf = a => (mats.find(x => x.addr.toLowerCase() === String(a).toLowerCase()) || {}).label || a;

  console.log(`scanning blocks ${from}..${head}  (${BLOCKS} blocks)\n`);
  console.log("TOPOLOGY");
  for (const x of mats) {
    const c = await ethers.getContractAt(MX, x.addr);
    x.c = c;
    const [partner, chainNext, occ, rot] = await Promise.all([
      c.partner().catch(() => null), c.chainNext().catch(() => null),
      c.occupancy(), c.rotationCount(),
    ]);
    x.rot = Number(rot);
    const dest = (chainNext && chainNext !== ethers.ZeroAddress) ? chainNext : partner;
    const via  = (chainNext && chainNext !== ethers.ZeroAddress) ? "chainNext" : "partner";
    console.log(`  ${x.label.padEnd(12)} occ ${String(Number(occ)).padStart(3)}  rot ${String(x.rot).padStart(5)}` +
                `  cycle-outs -> ${nameOf(dest).padEnd(12)} (${via})`);
  }

  console.log(`\nINFLOW over last ${BLOCKS} blocks  (MemberEntered per matrix)`);
  const entered = {};
  for (const x of mats) {
    const ev = await x.c.queryFilter(x.c.filters.MemberEntered(), from, head).catch(() => []);
    entered[x.label] = ev;
    console.log(`  ${x.label.padEnd(12)} entries ${String(ev.length).padStart(4)}   unique ${new Set(ev.map(e => e.args.member.toLowerCase())).size}`);
  }

  console.log(`\nOUTFLOW over last ${BLOCKS} blocks  (MemberCycledOut per matrix)`);
  const cycled = {};
  for (const x of mats) {
    const ev = await x.c.queryFilter(x.c.filters.MemberCycledOut(), from, head).catch(() => []);
    cycled[x.label] = ev.map(e => e.args.member.toLowerCase());
    console.log(`  ${x.label.padEnd(12)} cycle-outs ${String(ev.length).padStart(4)}`);
  }

  // Attribute MatB entries: did each entrant cycle out of MatA in this window?
  const B = "T1.1 MatB", Aa = "T1.1 MatA";
  const bIn = entered[B] || [];
  const fromA = new Set(cycled[Aa] || []);
  let matched = 0, unmatched = [];
  for (const e of bIn) {
    const m = e.args.member.toLowerCase();
    if (fromA.has(m)) matched++; else unmatched.push(m);
  }
  console.log(`\nATTRIBUTION for ${B}`);
  console.log(`  entries in window          : ${bIn.length}`);
  console.log(`  explained by ${Aa} cycle-out : ${matched}`);
  console.log(`  NOT explained              : ${unmatched.length}`);
  if (unmatched.length) {
    const counts = {};
    for (const m of unmatched) counts[m] = (counts[m] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top unexplained entrants (address x times):`);
    for (const [m, c] of top) console.log(`    ${m}  x${c}`);
    console.log(`  distinct unexplained members: ${Object.keys(counts).length}`);
    console.log(`  -> repeats mean RE-ENTRY into the same matrix, not new members.`);
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
