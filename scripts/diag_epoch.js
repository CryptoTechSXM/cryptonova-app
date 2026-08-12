// diag_epoch.js — which epoch thresholds were crossed, and what did they cost?
//
// THE CONCERN (owner, 2026-08-12): the token is on EPOCH 4 already.
//
// WHY THAT MATTERS. epochRewards is a halving schedule:
//
//     epoch 1  Nebula Genesis     50 CNOVA per entry   (super-bonus)
//     epoch 2  Mercury Rise       40
//     epoch 3  Lunar Cluster      20
//     epoch 4  Aurora Zenith      10     <-- reportedly here
//     epoch 5  Solaris Echo        5
//     epoch 6-9                   2.5    (plateau / Final Frontier formula)
//
// So the per-entry reward is already down 80% from the Genesis rate, multiplied by
// tierMultipliers[tier] = [1,2,4,8,20,40,80,160,320,640].
//
// THREE THINGS CAN ADVANCE AN EPOCH (CNOVAToken._tryAdvanceEpoch, any one of them):
//     MINT   (0)  totalMinted - epochStartMinted >= epochMintLimit    (default 1,000,000 CNOVA)
//     MEMBER (1)  epochMemberCount        >= epochMemberLimit         (default 10,000 members)
//     TIME   (2)  block.timestamp         >= epochStartTime + epochTimeLimit (default 30 days)
//
// The V8.47 set deployed 2026-08-05. At seven days old, TIME cannot have fired at the
// default 30 days — so MINT or MEMBER did, three times over. Which one is not a guess:
// EpochAdvanced(newEpoch, timestamp, trigger) records it, and this reads those events.
//
// THE REAL QUESTION IS MAINNET. If stress traffic burned four epochs of a nine-epoch
// schedule in a week, the same limits at launch would hand genuine early members the
// epoch-4 rate while the Genesis super-bonus went to fill wallets. That is a governance
// decision (setEpochMintLimit / setEpochMemberLimit / setEpochTimeLimit are all
// governable) and this script is the evidence for it, not the answer.
//
// Run: npx hardhat run scripts/diag_epoch.js --network baseSepolia
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const ABI = [
  "function currentEpochNumber() view returns (uint8)",
  "function epochRewards(uint256) view returns (uint256)",
  "function tierMultipliers(uint256) view returns (uint256)",
  "function epochMintLimit() view returns (uint256)",
  "function epochMemberLimit() view returns (uint256)",
  "function epochTimeLimit() view returns (uint256)",
  "function epochStartMinted() view returns (uint256)",
  "function epochStartTime() view returns (uint256)",
  "function epochMemberCount() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "event EpochAdvanced(uint8 indexed newEpoch, uint256 timestamp, uint8 trigger)",
];

const TRIGGER = { 0: "MINT   (too much CNOVA minted)", 1: "MEMBER (unique member count)", 2: "TIME   (window elapsed)" };
const NAMES = ["Nebula Genesis", "Mercury Rise", "Lunar Cluster", "Aurora Zenith", "Solaris Echo",
               "Cosmic Core", "Galaxy Grid", "Supernova Spark", "Final Frontier"];
const cn = (v) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 });
const days = (s) => (Number(s) / 86400).toFixed(2);

async function main() {
  const p = ethers.provider;
  const addr = A.cnova || A.CNOVA || A.cnovaToken;
  const t = new ethers.Contract(addr, ABI, p);
  const now = (await p.getBlock("latest")).timestamp;

  console.log("\n  CNOVAToken:", addr);

  const [epochNum, mintLim, memLim, timeLim, startMinted, startTime, memCount, minted, burned, maxSupply] =
    await Promise.all([
      t.currentEpochNumber().then(Number), t.epochMintLimit(), t.epochMemberLimit(),
      t.epochTimeLimit(), t.epochStartMinted(), t.epochStartTime(),
      t.epochMemberCount(), t.totalMinted(), t.totalBurned().catch(() => 0n), t.MAX_SUPPLY(),
    ]);

  console.log(`\n  ── WHERE WE ARE ──`);
  console.log(`    epoch ${epochNum} of 9 — ${NAMES[epochNum - 1] || "?"}`);
  const rewardNow = await t.epochRewards(epochNum - 1);
  const rewardGen = await t.epochRewards(0);
  console.log(`    base reward now : ${cn(rewardNow)} CNOVA per entry`);
  console.log(`    Genesis rate was: ${cn(rewardGen)} CNOVA — now at ${(Number(rewardNow) * 100 / Number(rewardGen)).toFixed(0)}% of it`);
  console.log(`    total minted    : ${cn(minted)} CNOVA of ${cn(maxSupply)} max (${(Number(minted) * 100 / Number(maxSupply)).toFixed(2)}%)`);
  if (burned > 0n) console.log(`    total burned    : ${cn(burned)} CNOVA`);

  // ── what each tier earns right now vs at Genesis ─────────────────────────
  console.log(`\n  ── PER-ENTRY REWARD BY TIER (now vs Genesis) ──`);
  for (let i = 0; i < 10; i++) {
    const mult = await t.tierMultipliers(i);
    const nowAmt = rewardNow * mult, genAmt = rewardGen * mult;
    console.log(`    T${String(i + 1).padEnd(2)} x${String(mult).padStart(3)}   now ${cn(nowAmt).padStart(10)}   Genesis ${cn(genAmt).padStart(10)}   lost ${cn(genAmt - nowAmt).padStart(10)}`);
  }

  // ── THE ANSWER: which threshold fired, each time ─────────────────────────
  console.log(`\n  ── WHICH THRESHOLD CROSSED, AND WHEN ──`);
  let logs = [];
  try {
    logs = await t.queryFilter(t.filters.EpochAdvanced(), 0, "latest");
  } catch (_) {
    // Some RPCs refuse an unbounded range; walk back in chunks from the tip.
    const tip = await p.getBlockNumber();
    const CHUNK = 9000;
    for (let from = Math.max(0, tip - 400_000); from <= tip; from += CHUNK) {
      try {
        const part = await t.queryFilter(t.filters.EpochAdvanced(), from, Math.min(from + CHUNK - 1, tip));
        logs = logs.concat(part);
      } catch (_) { /* skip an unreadable window rather than report a partial set as complete */ }
    }
  }
  if (logs.length === 0) {
    console.log("    NO EpochAdvanced EVENTS FOUND.");
    console.log("    Either the range was not readable, or the epoch was set another way —");
    console.log("    forceAdvanceEpoch() emits the event too, so a silent jump would mean");
    console.log("    the token was deployed already past epoch 1. Worth checking the deploy.");
  } else {
    let prev = null;
    for (const l of logs) {
      const blk = await p.getBlock(l.blockNumber);
      const when = new Date(Number(l.args.timestamp) * 1000).toISOString();
      const gap = prev ? ` · ${days(Number(l.args.timestamp) - prev)} days after the previous` : "";
      console.log(`    -> epoch ${l.args.newEpoch}  ${when}  ${TRIGGER[Number(l.args.trigger)] || l.args.trigger}${gap}`);
      console.log(`       block ${l.blockNumber}  tx ${l.transactionHash}`);
      prev = Number(l.args.timestamp);
    }
  }

  // ── how close is the NEXT one ─────────────────────────────────────────────
  console.log(`\n  ── HOW CLOSE IS THE NEXT ADVANCE ──`);
  const mintedThisEpoch = minted - startMinted;
  const elapsed = BigInt(now) - startTime;
  const pct = (a, b) => b > 0n ? (Number(a) * 100 / Number(b)).toFixed(1) + "%" : "n/a";
  console.log(`    MINT  : ${cn(mintedThisEpoch)} of ${cn(mintLim)} CNOVA   ${pct(mintedThisEpoch, mintLim)}`);
  console.log(`    MEMBER: ${memCount} of ${memLim} members          ${pct(memCount, memLim)}`);
  console.log(`    TIME  : ${days(elapsed)} of ${days(timeLim)} days           ${pct(elapsed, timeLim)}`);
  const closest = [
    ["MINT", Number(mintedThisEpoch) / Number(mintLim)],
    ["MEMBER", Number(memCount) / Number(memLim)],
    ["TIME", Number(elapsed) / Number(timeLim)],
  ].sort((a, b) => b[1] - a[1])[0];
  console.log(`    -> ${closest[0]} is nearest, at ${(closest[1] * 100).toFixed(1)}% of its limit.`);

  console.log(`\n  ── WHAT TO DO WITH THIS ──`);
  console.log("    All three limits are GOVERNABLE (setEpochMintLimit / setEpochMemberLimit /");
  console.log("    setEpochTimeLimit). The question this answers is not 'is testnet broken' —");
  console.log("    it is whether the SAME limits at mainnet launch would spend the Genesis");
  console.log("    super-bonus on the first week of traffic. Compare the trigger above against");
  console.log("    real expected launch volume before deciding. Epochs do not go backwards.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
