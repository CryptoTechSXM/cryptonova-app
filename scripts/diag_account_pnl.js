// diag_account_pnl.js — full money-in / money-out ledger for one or more accounts.
//
// Built 2026-08-10 for the "dissect an account thoroughly" exercise: what a member
// actually PUT IN (out of pocket) versus what came BACK (realised + still working),
// so the community can be told honest numbers instead of impressions.
//
// ─── THE ONE RULE THIS SCRIPT IS BUILT AROUND ────────────────────────────────
//
// IT MUST NEVER REPORT A PARTIAL TOTAL AS A LIFETIME TOTAL.
//
// A shared log helper on this project (`safeGetLogs`) silently truncated every
// "lifetime" figure on the website to a 2.3-day window AND swallowed dropped
// ranges. Every number it produced looked complete and was not. This script scans
// from the DEPLOY BLOCK (binary-searched from deployedAt, not guessed), chunks the
// range, retries each chunk, and if any chunk is still unreadable it prints
// "*** INCOMPLETE ***" and refuses to present the totals as lifetime figures.
// A missing number is recoverable. A confident wrong number is not.
//
// Run: npx hardhat run scripts/diag_account_pnl.js --network baseSepolia
//   WALLETS=0xabc,0xdef   (required)
//   FROM_BLOCK=123456     (optional; default = binary search on deployedAt)
//   CHUNK=9000            (optional; blocks per getLogs call)
const { ethers } = require("hardhat");
const path = require("path");
const AF = process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json";
const A  = require(path.join(__dirname, AF));

const usd = (v) => "$" + (Number(v || 0n) / 1e6).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

// Every event we care about has the member as the FIRST indexed parameter, so one
// getLogs with an address array + a topic1 filter collapses all matrices, all tiers
// and the router into a single query per block chunk.
const EVENTS = [
  "event CrossingFunded(address indexed member, uint256 fromEscrow, uint256 fromEarnings, uint256 total)",
  "event SelfRescue(address indexed member, uint256 shortfallPaid, uint256 withdrawableUsed)",
  "event CoPayRescue(address indexed member, uint256 sfShare, uint256 memberWalletShare, uint256 withdrawableUsed)",
  "event ChainPayDistributed(address indexed recipient, address indexed payer, uint256 level, uint256 amount)",
  "event PoolShareCredited(address indexed member, uint256 position, uint256 amount)",
  "event EarningsWithdrawn(address indexed member, uint256 amount)",
  "event WithdrawalFeeCharged(address indexed member, uint256 fee)",
  "event MemberEntered(address indexed member, uint256 bfsPosition, uint256 memberId, address matrix)",
  "event MemberCycledOut(address indexed member, uint256 cycles, uint256 rotations, address fromMatrix)",
  "event RescueLoanIssued(address indexed member, uint256 loanAmount, string rescueType)",
  "event RescueDebtRepaid(address indexed member, uint256 repaid, uint256 remaining)",
  "event ManualUpgrade(address indexed member, uint8 fromTier, uint8 toTier, uint256 fee)",
  "event BulkUpgrade(address indexed member, uint8 fromTier, uint8 toTier, uint256 totalFee)",
  "event HybridUpgrade(address indexed member, uint8 toTier, uint256 fromEarnings, uint256 fromWallet)",
];
const IFACE = new ethers.Interface(EVENTS);

const PM = ["function pairCount() view returns (uint256)",
            "function getPairAt(uint256) view returns (address,address)"];
const MX = ["function getMember(address) view returns (tuple(uint256 id,address referrer,uint256 joinedAt,uint256 withdrawable,uint256 totalEarned,uint256 totalWithdrawn,uint256 cyclesCompleted,bool isInMatrix,bool hasEverJoined))",
            "function matrixPos(address) view returns (uint256)",
            "function crossingReserveOf(address) view returns (uint256)",
            // CORRECTED 2026-08-10. The first version summed getMember().withdrawable and
            // reported it as what the member has. That is the SETTLED balance only —
            // freeWithdrawable() adds pendingPoolOf() (un-settled pool accrual, V8.44 item D)
            // and then subtracts the crossing shortfall and the router's reserve holdback.
            // On 0x1C56C6 the difference was $42.27 vs $91.61: my number was under HALF the
            // real claimable, and I nearly reported the DASHBOARD as over-promising when the
            // dashboard was right and this script was wrong.
            // DO NOT USE freeWithdrawable() FOR CLAIMABLE. Confirmed on-chain 2026-08-10:
            // it summed to $0.00 for 0x1C56C6 while that member withdrew $124.99 in two
            // transactions minutes later. It applies the crossing-reserve lock in EVERY
            // matrix, but withdrawCore only applies it where automation is active
            // (highest tier), so the view reports zero on money that is fully claimable.
            // The frontend already knows and computes the headline itself —
            // index.html:6626 "per matrix: balance = raw withdrawable + pendingPoolOf",
            // with the note "Contract backlog for next redeploy: make the freeWithdrawable
            // VIEW mirror". That is scope item 1. Same rule used here.
            "function freeWithdrawable(address) view returns (uint256)",
            "function withdrawableOf(address) view returns (uint256)",
            "function pendingPoolOf(address) view returns (uint256)"];
const TR = ["function tierEntryFees(uint256) view returns (uint256)",
            "function memberHighestTier(address) view returns (uint8)",
            "function globalJoined(address) view returns (bool)",
            "function tierCycles(address,uint8) view returns (uint256)"];
const SF = ["function memberDebtOf(address) view returns (uint256)"];

async function blockAtTimestamp(provider, targetTs) {
  let lo = 1, hi = await provider.getBlockNumber();
  const hiBlk = await provider.getBlock(hi);
  if (hiBlk.timestamp <= targetTs) return hi;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (!b) { lo = mid + 1; continue; }
    if (b.timestamp < targetTs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const p = ethers.provider;
  const wallets = (process.env.WALLETS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!wallets.length) { console.error("\n  Set WALLETS=0x...,0x...\n"); process.exit(1); }

  // ── collect every matrix across every tier ────────────────────────────────
  const mats = [];
  for (let t = 1; t <= 10; t++) {
    const cfg = A.tiers?.["T" + t];
    if (!cfg?.pm) continue;
    try {
      const pm = new ethers.Contract(cfg.pm, PM, p);
      const n  = Number(await pm.pairCount());
      for (let i = 0; i < n; i++) {
        const [a, b] = await pm.getPairAt(i);
        if (a !== ethers.ZeroAddress) mats.push({ addr: a, label: `T${t}.${i + 1} MatA`, tier: t });
        if (b !== ethers.ZeroAddress) mats.push({ addr: b, label: `T${t}.${i + 1} MatB`, tier: t });
      }
    } catch (_) { /* tier not deployed */ }
  }
  const trAddr = A.tierRouter, sfAddr = A.stabilityFund;
  const scanAddrs = [...mats.map(m => m.addr), trAddr];
  console.log(`\n  Scanning ${mats.length} matrices across ${new Set(mats.map(m=>m.tier)).size} tier(s) + TierRouter`);

  // ── block range: from the DEPLOY, not a guess ─────────────────────────────
  const latest = await p.getBlockNumber();
  let fromBlock;
  if (process.env.FROM_BLOCK) {
    fromBlock = Number(process.env.FROM_BLOCK);
    console.log(`  Range: ${fromBlock} → ${latest} (FROM_BLOCK override)`);
  } else {
    const ts = Math.floor(new Date(A.deployedAt).getTime() / 1000);
    fromBlock = await blockAtTimestamp(p, ts);
    console.log(`  Range: ${fromBlock} → ${latest}  (deployedAt ${A.deployedAt} → block ${fromBlock})`);
  }

  const CHUNK = Number(process.env.CHUNK || 9000);
  const tr = new ethers.Contract(trAddr, TR, p);
  const sf = sfAddr ? new ethers.Contract(sfAddr, SF, p) : null;
  const fees = [];
  for (let i = 0; i < 10; i++) { try { fees.push(await tr.tierEntryFees(i)); } catch { fees.push(null); } }

  // ── ONE log pass for ALL wallets ─────────────────────────────────────────
  //
  // topic1 accepts an ARRAY (logical OR), so every wallet is covered by the same
  // getLogs call. Six accounts scanned separately would be ~144 queries against a
  // rate-limited public endpoint (the paid Alchemy key has expired); batched it is
  // ~24. Fewer requests also means fewer chances of a dropped range — and a dropped
  // range is the thing this script exists to never hide.
  const topics1 = wallets.map(w => ethers.zeroPadValue(ethers.getAddress(w), 32));
  const key = (t) => ethers.getAddress("0x" + t.slice(26)).toLowerCase();
  const blank = () => ({ chain: 0n, pool: 0n, selfRescuePaid: 0n, coPayWallet: 0n, coPaySF: 0n,
    upgradeWallet: 0n, hybridWallet: 0n, hybridEarnings: 0n, withdrawnEv: 0n, withdrawFees: 0n,
    entries: 0, cycleOuts: 0, loans: 0n, repaid: 0n, crossFromEscrow: 0n, crossFromEarnings: 0n });
  const ACC = {};
  for (const w of wallets) ACC[w.toLowerCase()] = blank();

  let failedRanges = 0, scanned = 0, skippedUnknown = 0;
  const totalChunks = Math.ceil((latest - fromBlock + 1) / CHUNK);
  for (let from = fromBlock, ci = 0; from <= latest; from += CHUNK, ci++) {
    const to = Math.min(from + CHUNK - 1, latest);
    let logs = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
      try {
        logs = await p.getLogs({ address: scanAddrs, fromBlock: from, toBlock: to, topics: [null, topics1] });
      } catch (_) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
    }
    if (logs === null) { failedRanges++; continue; }      // counted, never ignored
    scanned++;
    if (ci % 5 === 0) process.stdout.write(`\r  scanning ${ci + 1}/${totalChunks} chunks…   `);
    for (const lg of logs) {
      const acc = ACC[key(lg.topics[1])];
      if (!acc) continue;
      // parseLog returns NULL for an event not in our interface — it does NOT throw,
      // so a try/catch alone misses it. The scan legitimately sees events we did not
      // list (MemberParked, MemberReentered, DoubleEntryFired, SlotReclaimed...),
      // and every one of those returns null here.
      let d = null;
      try { d = IFACE.parseLog(lg); } catch { d = null; }
      if (!d) { skippedUnknown++; continue; }
      const a = d.args;
      switch (d.name) {
        case "ChainPayDistributed": acc.chain += a.amount; break;
        case "PoolShareCredited":   acc.pool  += a.amount; break;
        case "SelfRescue":          acc.selfRescuePaid += a.shortfallPaid; break;
        case "CoPayRescue":         acc.coPayWallet += a.memberWalletShare; acc.coPaySF += a.sfShare; break;
        case "ManualUpgrade":       acc.upgradeWallet += a.fee; break;
        case "BulkUpgrade":         acc.upgradeWallet += a.totalFee; break;
        case "HybridUpgrade":       acc.hybridWallet += a.fromWallet; acc.hybridEarnings += a.fromEarnings; break;
        case "EarningsWithdrawn":   acc.withdrawnEv += a.amount; break;
        case "WithdrawalFeeCharged":acc.withdrawFees += a.fee; break;
        case "MemberEntered":       acc.entries++; break;
        case "MemberCycledOut":     acc.cycleOuts++; break;
        case "RescueLoanIssued":    acc.loans += a.loanAmount; break;
        case "RescueDebtRepaid":    acc.repaid += a.repaid; break;
        case "CrossingFunded":      acc.crossFromEscrow += a.fromEscrow; acc.crossFromEarnings += a.fromEarnings; break;
      }
    }
  }
  const complete = failedRanges === 0;
  process.stdout.write("\r" + " ".repeat(46) + "\r");
  console.log(`  Scan: ${scanned}/${totalChunks} range(s) read${complete ? " — complete" : `, ${failedRanges} FAILED`}` + (skippedUnknown ? ` · ${skippedUnknown} log(s) from events outside this ledger (expected)` : ""));

  for (const w of wallets) {
    console.log("\n" + "=".repeat(78));
    console.log(`  ACCOUNT ${w}`);
    console.log("=".repeat(78));
    if (!(await tr.globalJoined(w).catch(() => false))) { console.log("  NOT REGISTERED"); continue; }

    let earned = 0n, withdrawable = 0n, freeNow = 0n, pendPool = 0n, viewSays = 0n, withdrawn = 0n, reserve = 0n, matCycleOuts = 0n;
    const seats = [];
    for (const m of mats) {
      try {
        const mc  = new ethers.Contract(m.addr, MX, p);
        const mem = await mc.getMember(w);
        if (!mem.hasEverJoined) continue;
        earned += mem.totalEarned; withdrawable += mem.withdrawable;
        withdrawn += mem.totalWithdrawn; matCycleOuts += mem.cyclesCompleted;
        reserve  += await mc.crossingReserveOf(w).catch(() => 0n);
        // Rule 1 (index.html:6626): settled balance + un-settled pool accrual.
        //
        // withdrawableOf() ALREADY RETURNS BOTH — FigureEightMatrixV8:589 is literally
        // `members[member].withdrawable + pendingPoolOf(...)`. The previous version added
        // pendingPoolOf on top of it and counted the pool TWICE, inflating every claimable
        // figure. Fourth error on this one number in a single session: settled-only
        // (under), freeWithdrawable (under worse), predicted a revert that did not happen,
        // and now double-counted (over). Read ONE source and check what it already does.
        freeNow  += await mc.withdrawableOf(w).catch(() => 0n);
        pendPool += await mc.pendingPoolOf(w).catch(() => 0n);
        viewSays += await mc.freeWithdrawable(w).catch(() => 0n);   // kept to SHOW the divergence
        if (mem.isInMatrix) seats.push(`${m.label} seat ${await mc.matrixPos(w).catch(() => 0n)}`);
      } catch (_) {}
    }
    const debt = sf ? await sf.memberDebtOf(w).catch(() => 0n) : 0n;
    const tier = Number(await tr.memberHighestTier(w).catch(() => 0));
    const acc  = ACC[w.toLowerCase()];
    // COMPLETED TIER cycles, from the router — the number the dashboard shows and the
    // one that gates upgrades. Per-matrix cyclesCompleted counts a member currently
    // sitting in MatB as having finished, which they have not.
    let tierCycles = 0n, perTier = [];
    for (let i = 0; i < 10; i++) {
      const c = await tr.tierCycles(w, i).catch(() => 0n);
      tierCycles += c;
      if (c > 0n) perTier.push(`T${i + 1}:${c}`);
    }

    const signup      = fees[0] ?? 0n;
    const outOfPocket = signup + acc.upgradeWallet + acc.hybridWallet + acc.selfRescuePaid + acc.coPayWallet;
    const realised    = withdrawn;
    const working     = freeNow + reserve;   // free to claim + locked reserve

    console.log(`\n  Tier T${tier} · ${tierCycles} completed tier cycle(s)${perTier.length ? ` (${perTier.join(' ')})` : ''}`
      + ` · ${acc.entries} entries · ${acc.cycleOuts} matrix cycle-outs`);
    if (seats.length) console.log(`  Seated: ${seats.join(" · ")}`);

    console.log(`\n  -- OUT OF POCKET (money the member ADDED) --`);
    console.log(`    ${pad("signup (T1 entry)", 34)} ${usd(signup)}`);
    console.log(`    ${pad("upgrades paid from wallet", 34)} ${usd(acc.upgradeWallet + acc.hybridWallet)}`);
    console.log(`    ${pad("self-rescue shortfalls", 34)} ${usd(acc.selfRescuePaid)}`);
    console.log(`    ${pad("co-pay rescue (member share)", 34)} ${usd(acc.coPayWallet)}`);
    console.log(`    ${pad("TOTAL OUT OF POCKET", 34)} ${usd(outOfPocket)}`);

    console.log(`\n  -- CAME BACK --`);
    console.log(`    ${pad("withdrawn to wallet", 34)} ${usd(realised)}`);
    console.log(`    ${pad("CLAIMABLE now", 34)} ${usd(freeNow)}   (settled + pending pool)`);
    console.log(`    ${pad("  of which settled", 34)} ${usd(withdrawable)}`);
    console.log(`    ${pad("  freeWithdrawable() VIEW says", 34)} ${usd(viewSays)}` +
      (viewSays < freeNow ? `   <- UNDER-REPORTS by ${usd(freeNow - viewSays)} (scope item 1)` : ""));
    console.log(`    ${pad("locked in crossing reserve", 34)} ${usd(reserve)}`);
    // totalEarned is only incremented when a credit SETTLES. Pool accrued since the
    // member's last settlement is real, owed, and not in it — measured 2026-08-10:
    // 0x1C56C6 read $74.52 earned, withdrew, and the same field read $174.48 minutes
    // later. Nothing was created; ~$100 of pool was simply unsettled. Reporting the
    // settled figure alone UNDERSTATES what a member has made.
    console.log(`    ${pad("TOTAL EARNED (lifetime)", 34)} ${usd(earned + pendPool)}`);
    console.log(`    ${pad("  of which settled", 34)} ${usd(earned)}`);
    console.log(`    ${pad("  unsettled pool (owed, uncredited)", 34)} ${usd(pendPool)}`);

    const attributed = acc.chain + acc.pool;
    const residual   = earned > attributed ? earned - attributed : 0n;
    console.log(`\n  -- WHERE THE EARNINGS CAME FROM --`);
    console.log(`    ${pad("chain pay (6 levels)", 34)} ${usd(acc.chain)}`);
    console.log(`    ${pad("pool shares (rotations)", 34)} ${usd(acc.pool)}`);
    console.log(`    ${pad("referral L1 + 2.5% direct", 34)} ${usd(residual)}   <- DERIVED, not attributable`);

    console.log(`\n  -- CROSSINGS FUNDED WITHOUT NEW MONEY --`);
    console.log(`    ${pad("from crossing reserve", 34)} ${usd(acc.crossFromEscrow)}`);
    console.log(`    ${pad("from earnings", 34)} ${usd(acc.crossFromEarnings)}`);

    if (acc.loans > 0n || debt > 0n) {
      console.log(`\n  -- STABILITY FUND --`);
      console.log(`    ${pad("borrowed (keeper rescues)", 34)} ${usd(acc.loans)}`);
      console.log(`    ${pad("repaid from pool shares", 34)} ${usd(acc.repaid)}`);
      console.log(`    ${pad("STILL OWED", 34)} ${usd(debt)}`);
    }

    const net = realised + working - outOfPocket;
    console.log(`\n  -- NET POSITION --`);
    console.log(`    realised ${usd(realised)} + working ${usd(working)} - out of pocket ${usd(outOfPocket)}`);
    console.log(`    ${pad(net >= 0n ? "NET AHEAD" : "NET BEHIND", 34)} ${usd(net < 0n ? -net : net)}`);
    if (debt > 0n) console.log(`    (before ${usd(debt)} still owed to the Stability Fund)`);
  }

  if (!complete) {
    console.log(`\n  *** INCOMPLETE — ${failedRanges} block range(s) unreadable after 3 attempts.`);
    console.log(`  *** Every EVENT-derived figure above is a FLOOR, not a lifetime total.`);
    console.log(`  *** Re-run before quoting these to anyone. State figures (earned / withdrawable /`);
    console.log(`  *** reserve / debt) are read directly from the contracts and ARE complete.`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
