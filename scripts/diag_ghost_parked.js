// diag_ghost_parked.js — V8.48 item 45: the persistent parked-queue GHOSTS.
//
// THE OBSERVATION (copay.log, 2026-08-13): the same 16 wallets revert
// "F8V8: already in matrix" on EVERY copay run — including the keeper signer
// 0xd419681B itself, parked in T2.1 MatB. State: a live parked-queue slot
// (parkedAt > 0) in matrix M while SEATED somewhere in the same tier. Every
// rescue attempt hits the V8.46 universal pair guard and reverts, the queue slot
// never clears, and eviction (which has never fired — item 47) is the only path
// out. The 2026-08-11 "queue clean, 0 stale" claim is stale.
//
// WHY GHOSTS CAN EXIST BY CONSTRUCTION (verified against source 2026-08-13):
// the V8.46 fix at MatrixLogicLib enterMatrix (:315-334, "TAKING A SEAT CLEARS
// ANY PARK RECORD FOR THIS MATRIX") is deliberately MATRIX-LOCAL — it clears
// self.parkedAt/queue in the matrix being ENTERED. A member parked in M and
// later seated in a DIFFERENT matrix D (rescue routed to another pair, item-31
// freePairFor, a crossing, a fresh register) leaves M's record untouched: M
// never hears about D's seat. So the question this diag answers is not "is
// there residue" but WHICH PATH seats cross-matrix without dequeuing — and it
// distinguishes the two possible orders:
//
//   SEATED-AFTER-PARKED  — MemberEntered fired in D after M's parkedAt.
//                          The re-seat path is the culprit; the fix belongs
//                          where items 46/47 land (dequeue-on-seat must reach
//                          the ORIGIN matrix, or eviction must clear ghosts).
//   SEATED-BEFORE-PARKED — no MemberEntered after parkedAt: the member already
//                          held D's seat when M parked them. Then the PARK path
//                          pushed a seated member — a different defect (the
//                          park sites at :443/:753/:780/:810/:837 check only
//                          THIS matrix's state).
//
// CONSEQUENCE FOR ITEM 47 (why this diag runs before the valve is designed):
// an eviction valve must treat a ghost as DEQUEUE-ONLY — the member is seated
// and earning; "evicting" them with the reserve-return path would touch a live
// position. Item 46's floor must likewise not count a ghost as a stranded
// borrower.
//
// STRICT READS ONLY (model_epoch_policy v1 lesson): a failed read retries then
// kills the run with its label. No value-returning fallbacks.
//
// Run (owner, Windows, contracts repo):
//   npx hardhat run scripts/diag_ghost_parked.js --network baseSepolia
// Env:
//   TIERS=2,3        restrict tiers (default: all configured)
//   CHUNK=1800       eth_getLogs block-chunk size (free endpoint cap ~2000)
//   ATTR_HOURS=96    cap the per-ghost attribution window (log scan) at N hours
//   NO_ATTR=1        census only — skip the log attribution pass entirely
//
// Cost note: the census reads every live queue entry (~1k) plus a tier-wide
// isInMatrix sweep per unique parked member (~6 reads each) — roughly 7k RPC
// calls, several minutes on the free endpoint. Attribution adds ~30-60 getLogs
// per ghost (16 expected).
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const KEEPER = [
  "function configuredTierCount() view returns (uint8)",
  "function pairManagerForTier(uint8) view returns (address)",
];
const PM = [
  "function activePairCount() view returns (uint256)",
  "function getPairAt(uint256) view returns (address,address)",
];
const MX = [
  "function getParkedCount() view returns (uint256)",
  "function getParkedMember(uint256) view returns (address)",
  "function parkedAt(address) view returns (uint256)",
  "function isInMatrix(address) view returns (bool)",
  "function matrixPos(address) view returns (uint256)",
  "function withdrawableOf(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function ENTRY_FEE() view returns (uint256)",
];

// Event signatures from MatrixLogicLib (topic0 computed at runtime — a typo here
// yields an unknown topic printed raw, never a wrong attribution).
const EVENT_SIGS = {
  "MemberEntered(address,uint256,uint256,address)": "MemberEntered",
  "MemberCycledOut(address,uint256,uint256,address)": "MemberCycledOut",
  "MemberCrossedToPartner(address,address,address)": "MemberCrossedToPartner",
  "MemberParked(address,uint256)": "MemberParked",
  "CoPayRescue(address,uint256,uint256,uint256)": "CoPayRescue",
  "SelfRescue(address,uint256,uint256)": "SelfRescue",
  "MemberEvicted(address,uint256)": "MemberEvicted",
  "SlotParkedIdle(address,uint256,uint256)": "SlotParkedIdle",
  "SlotReclaimed(address,uint256,uint256)": "SlotReclaimed",
  "MemberExitedSeat(address,uint256,uint256,uint256)": "MemberExitedSeat",
};
// Selector table carried from the V8.45-era audit (CLAUDE.md "EVERY SEATING
// SELECTOR, ACCOUNTED FOR") — selectors are stable for unchanged signatures.
const SELECTORS = {
  "0x37fb13fa": "coPayRescue (keeper)",
  "0xb62847e9": "selfRescue (keeper batch)",
  "0xfed7e53b": "manualUpgrade",
  "0xcb1de45b": "bulkUpgrade",
  "0x4585e33b": "performUpkeep",
  "0x240d6f87": "adminForceRotateRoot",
  "0x4420e486": "register(address)",
  "0xcef6d209": "chainlink transmit",
};

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(2);
const hrs = (s) => (Number(s) / 3600).toFixed(1) + "h";
const short = (a) => a.slice(0, 10) + "…";

async function strict(label, fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  console.error(`\nFATAL: read failed after ${tries} attempts: ${label}`);
  throw last;
}

async function main() {
  const p = ethers.provider;
  const k = new ethers.Contract(A.matrixKeeper, KEEPER, p);
  const only = process.env.TIERS ? process.env.TIERS.split(",").map((s) => Number(s.trim())) : null;
  const CHUNK = Number(process.env.CHUNK || 1800);
  const ATTR_HOURS = Number(process.env.ATTR_HOURS || 96);
  const latest = await strict("getBlock(latest)", () => p.getBlock("latest"));
  const now = latest.timestamp;

  const topicName = {};
  for (const [sig, name] of Object.entries(EVENT_SIGS)) topicName[ethers.id(sig)] = name;
  const enteredTopic = ethers.id("MemberEntered(address,uint256,uint256,address)");

  console.log(`\n  block ${latest.number}  ${new Date(now * 1000).toISOString()}\n`);
  console.log("== PART A — GHOST CENSUS (parkedAt > 0 in M while seated anywhere in the tier) ==");

  // tier -> [{addr, lbl, mx}]
  const n = Number(await strict("configuredTierCount", () => k.configuredTierCount()));
  const tierMats = new Map();
  for (let t = 0; t < n; t++) {
    if (only && !only.includes(t + 1)) continue;
    const pmAddr = await strict(`pairManagerForTier(${t})`, () => k.pairManagerForTier(t));
    if (!pmAddr || pmAddr === ethers.ZeroAddress) continue;
    const pm = new ethers.Contract(pmAddr, PM, p);
    const pc = Number(await strict(`T${t + 1} activePairCount`, () => pm.activePairCount()));
    const list = [];
    for (let i = 0; i < pc; i++) {
      const [a, b] = await strict(`T${t + 1} getPairAt(${i})`, () => pm.getPairAt(i));
      if (a && a !== ethers.ZeroAddress) list.push({ addr: a, lbl: `T${t + 1}.${i + 1}A`, mx: new ethers.Contract(a, MX, p) });
      if (b && b !== ethers.ZeroAddress) list.push({ addr: b, lbl: `T${t + 1}.${i + 1}B`, mx: new ethers.Contract(b, MX, p) });
    }
    tierMats.set(t, list);
  }

  const ghosts = [];       // {member, t, parkedLbl, parkedAddr, ts, seats:[{lbl,addr,pos}], wd, rs}
  let liveParked = 0, zeroTs = 0, cleanParked = 0;
  const seatCache = new Map(); // `${t}:${member}` -> seats array

  for (const [t, list] of tierMats) {
    for (const { addr, lbl, mx } of list) {
      const cnt = Number(await strict(`${lbl} getParkedCount`, () => mx.getParkedCount()));
      for (let q = 0; q < cnt; q++) {
        const mem = await strict(`${lbl} getParkedMember(${q})`, () => mx.getParkedMember(q));
        if (!mem || mem === ethers.ZeroAddress) continue;
        const ts = Number(await strict(`${lbl} parkedAt(${short(mem)})`, () => mx.parkedAt(mem)));
        if (ts === 0) { zeroTs++; continue; } // queue residue, not a live park
        liveParked++;
        const key = `${t}:${mem.toLowerCase()}`;
        let seats = seatCache.get(key);
        if (seats === undefined) {
          seats = [];
          for (const d of list) {
            const inD = await strict(`${d.lbl} isInMatrix(${short(mem)})`, () => d.mx.isInMatrix(mem));
            if (inD) {
              const pos = Number(await strict(`${d.lbl} matrixPos(${short(mem)})`, () => d.mx.matrixPos(mem)));
              seats.push({ lbl: d.lbl, addr: d.addr, pos });
            }
          }
          seatCache.set(key, seats);
        }
        if (seats.length === 0) { cleanParked++; continue; }
        const wd = await strict(`${lbl} withdrawableOf`, () => mx.withdrawableOf(mem));
        const rs = await strict(`${lbl} crossingReserveOf`, () => mx.crossingReserveOf(mem));
        ghosts.push({ member: mem, t, parkedLbl: lbl, parkedAddr: addr, ts, seats, wd, rs });
      }
    }
  }

  console.log(`  live queue entries (parkedAt > 0): ${liveParked}   queue residue (parkedAt == 0): ${zeroTs}`);
  console.log(`  clean parked (not seated anywhere in tier): ${cleanParked}`);
  console.log(`  GHOSTS: ${ghosts.length}\n`);
  for (const g of ghosts) {
    const seatStr = g.seats.map((s) => `${s.lbl}#${s.pos}`).join(", ");
    console.log(`    ${short(g.member)}  parked ${g.parkedLbl} ${hrs(now - g.ts)} ago  SEATED ${seatStr}  wd ${usd(g.wd)} rs ${usd(g.rs)}`);
  }
  if (ghosts.length === 0) {
    console.log("  No ghosts. If copay.log still shows the 16 reverts, the state cleared");
    console.log("  between the log and this run — re-run during a copay cycle.");
    return;
  }

  if (process.env.NO_ATTR) { console.log("\n  NO_ATTR set — skipping attribution."); return; }

  console.log("== PART B — ATTRIBUTION (which tx seated each ghost, and in which order) ==");
  // For each ghost: scan MemberEntered(member) logs in the SEATED matrices from
  // just before parkedAt to now. Present -> SEATED-AFTER-PARKED (classify the tx).
  // Absent -> SEATED-BEFORE-PARKED (the park path pushed a seated member).
  const attr = { after: [], before: [], capped: [] };
  const pathCount = new Map();
  for (const g of ghosts) {
    const ageS = now - g.ts;
    const cappedWindow = ageS > ATTR_HOURS * 3600;
    const windowS = Math.min(ageS, ATTR_HOURS * 3600);
    // Base ~2s blocks; pad 10% + 2000 blocks so the window definitely covers parkedAt.
    const span = Math.ceil(windowS / 2 * 1.1) + 2000;
    const fromBlock = Math.max(0, latest.number - span);
    const addrs = g.seats.map((s) => s.addr);
    const memTopic = ethers.zeroPadValue(g.member, 32);
    const logs = [];
    for (let b = fromBlock; b <= latest.number; b += CHUNK) {
      const to = Math.min(b + CHUNK - 1, latest.number);
      const part = await strict(`getLogs ${short(g.member)} ${b}-${to}`, () =>
        p.getLogs({ address: addrs, fromBlock: b, toBlock: to, topics: [enteredTopic, memTopic] }));
      logs.push(...part);
    }
    // Keep entries at/after parkedAt (block timestamps: compare via block lookup only
    // for the candidates — cheap, there are few).
    const entriesAfter = [];
    for (const lg of logs) {
      const blk = await strict(`getBlock(${lg.blockNumber})`, () => p.getBlock(lg.blockNumber));
      if (blk.timestamp >= g.ts) entriesAfter.push({ lg, tsB: blk.timestamp });
    }
    if (entriesAfter.length === 0) {
      (cappedWindow ? attr.capped : attr.before).push(g);
      const tag = cappedWindow ? "WINDOW CAPPED — inconclusive, raise ATTR_HOURS" : "SEATED-BEFORE-PARKED (park path pushed a seated member)";
      console.log(`\n  ${short(g.member)}  parked ${g.parkedLbl}: no MemberEntered in ${g.seats.map((s) => s.lbl).join("/")} since parkedAt  -> ${tag}`);
      continue;
    }
    attr.after.push(g);
    console.log(`\n  ${short(g.member)}  parked ${g.parkedLbl} at ${new Date(g.ts * 1000).toISOString()}  -> SEATED-AFTER-PARKED:`);
    for (const { lg, tsB } of entriesAfter) {
      const tx = await strict(`getTransaction(${lg.transactionHash.slice(0, 10)})`, () => p.getTransaction(lg.transactionHash));
      const sel = tx.data.slice(0, 10);
      const selName = SELECTORS[sel] || sel;
      const matLbl = g.seats.find((s) => s.addr.toLowerCase() === lg.address.toLowerCase())?.lbl || short(lg.address);
      pathCount.set(selName, (pathCount.get(selName) || 0) + 1);
      console.log(`    +${hrs(tsB - g.ts)} after park: MemberEntered in ${matLbl}  via ${selName}  from ${short(tx.from)}  tx ${lg.transactionHash}`);
    }
  }

  console.log("\n== PART C — VERDICT ==");
  console.log(`  ghosts: ${ghosts.length}   seated-after-parked: ${attr.after.length}   seated-before-parked: ${attr.before.length}   inconclusive (window): ${attr.capped.length}`);
  if (pathCount.size) {
    console.log("  re-seat paths (seated-after-parked txs):");
    for (const [name, c] of [...pathCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(3)}  ${name}`);
    }
  }
  console.log(`
  Mechanism reminder: enterMatrix's V8.46 dequeue is MATRIX-LOCAL (:331). Any
  cross-matrix seat leaves the origin queue entry alive by construction, so
  seated-after-parked ghosts implicate the RE-SEAT path above; seated-before-
  parked ghosts implicate the PARK sites (:443/:753/:780/:810/:837), which check
  only their own matrix.
  For items 46/47: a ghost must be DEQUEUE-ONLY in the eviction valve (they hold
  a live seat — never run the reserve-return on them), and the insolvency floor
  must not count a ghost as a stranded borrower.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
