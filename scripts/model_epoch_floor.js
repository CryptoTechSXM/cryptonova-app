// model_epoch_floor.js — what epoch policy does to the CNOVA floor price.
//
// THE MECHANISM, STATED PLAINLY
//   floorPrice() = usdcReserve * 1e18 / totalSupply      (CNOVATreasury:213)
//
//   Every entry does two things at once: it adds `entryFee * treasuryBps` USDC to the
//   treasury (5% — MatrixLogicLib:906, payBase == entryFee), and it MINTS
//   `epochRewards[epoch] * tierMultipliers[tier]` CNOVA.
//
//   So each entry arrives at its own implied price:
//
//       marginal = (entryFee * treasuryBps) / (epochReward * tierMultiplier)
//
//   Above the current floor, that entry RAISES it. Below, it DILUTES it. Nothing else
//   in the entry path moves the floor.
//
// THE COUNTER-INTUITIVE PART
//   Epochs do not lift the price by "growing". They lift it by MINTING LESS. Burning
//   through epochs quickly is floor-POSITIVE — the cost is paid by early members, who
//   get fewer tokens, not by the token. The real trade-off is generosity to early
//   members versus dilution of everyone, and it is a distribution question wearing a
//   price-mechanism costume.
//
// WHERE IT ENDS
//   Epoch 9 (Final Frontier) stops using the fixed table and computes
//       base = rewardPct * TREASURY_PER_ENTRY * 1e18 / (100 * floorPrice)   [capped 2.5]
//   which is SELF-REGULATING: as the floor rises, the reward falls. So the fixed
//   schedule is a BRIDGE from launch to that regime. The policy question is how much
//   fixed-reward runway to spend before arriving there — not whether to arrive.
//
// Run: npx hardhat run scripts/model_epoch_floor.js --network baseSepolia
//   MEMBER_LIMIT=1000   model an alternative epochMemberLimit (owner proposal)
//   MIX=T1              tier mix to model: T1 | EVEN | WHALE  (default T1)
const { ethers } = require("hardhat");
const path = require("path");
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json"));

const TOK = [
  "function currentEpochNumber() view returns (uint8)",
  "function epochRewards(uint256) view returns (uint256)",
  "function tierMultipliers(uint256) view returns (uint256)",
  "function epochMintLimit() view returns (uint256)",
  "function epochMemberLimit() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
];
const TRE = [
  "function floorPrice() view returns (uint256)",
  "function usdcReserve() view returns (uint256)",
];
const TR = ["function tierEntryFees(uint256) view returns (uint256)"];

const usd6 = (v) => "$" + (Number(v) / 1e6).toFixed(4);
const cn = (v) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 1 });
const TREASURY_BPS = 500n;   // SPLITS_ALL[3], deploy_v8.js:103 — 5% of the entry fee

async function main() {
  const p = ethers.provider;
  const tok = new ethers.Contract(A.cnova, TOK, p);
  const tre = new ethers.Contract(A.treasury, TRE, p);
  const tr  = new ethers.Contract(A.tierRouter, TR, p);

  const [epoch, supply, minted, maxSupply, floor, reserve, mintLim, memLim] = await Promise.all([
    tok.currentEpochNumber().then(Number), tok.totalSupply(), tok.totalMinted(),
    tok.MAX_SUPPLY(), tre.floorPrice(), tre.usdcReserve(),
    tok.epochMintLimit(), tok.epochMemberLimit(),
  ]);
  const fees = [], mults = [], rewards = [];
  for (let i = 0; i < 10; i++) { fees.push(await tr.tierEntryFees(i).catch(() => 0n)); mults.push(await tok.tierMultipliers(i)); }
  for (let e = 0; e < 9; e++) rewards.push(await tok.epochRewards(e));

  console.log(`\n  ── WHERE THE FLOOR IS NOW ──`);
  console.log(`    treasury reserve : ${usd6(reserve)}`);
  console.log(`    CNOVA supply     : ${cn(supply)}   (minted ${cn(minted)} of ${cn(maxSupply)})`);
  console.log(`    FLOOR PRICE      : ${usd6(floor)} per CNOVA`);
  console.log(`    epoch ${epoch}, base reward ${cn(rewards[epoch - 1])} CNOVA/entry`);

  // ── the marginal price of one entry, per tier per epoch ───────────────────
  console.log(`\n  ── WHAT ONE ENTRY IS WORTH TO THE FLOOR ──`);
  console.log(`     marginal = (fee x 5%) / (epochReward x tierMultiplier)`);
  console.log(`     ABOVE the floor lifts it; BELOW dilutes it. Floor now ${usd6(floor)}.\n`);
  const marginal = (feeI, e, i) => {
    const cnovaOut = rewards[e] * mults[i];
    if (cnovaOut === 0n) return 0n;
    return (feeI * TREASURY_BPS / 10000n) * (10n ** 18n) / cnovaOut;
  };
  const show = [0, 3, 5, 9];   // T1, T4, T6, T10
  process.stdout.write("     epoch |");
  for (const i of show) process.stdout.write(`   T${i + 1} (${usd6(fees[i])})`.padEnd(22));
  console.log();
  for (let e = 0; e < 9; e++) {
    process.stdout.write(`       ${e + 1}   |`);
    for (const i of show) {
      const m = marginal(fees[i], e, i);
      const tag = m > floor ? "+" : m < floor ? "-" : "=";
      process.stdout.write(`   ${usd6(m)}${tag}`.padEnd(22));
    }
    console.log(e + 1 === epoch ? "   <- now" : "");
  }
  console.log(`\n     A '+' entry raises the floor, '-' dilutes it. Note the pattern: the`);
  console.log(`     SAME tier flips from dilutive to accretive purely by advancing epochs.`);

  // ── the owner's proposal ──────────────────────────────────────────────────
  const proposedMembers = BigInt(process.env.MEMBER_LIMIT || 1000);
  const mix = (process.env.MIX || "T1").toUpperCase();
  const mixIdx = mix === "WHALE" ? [6, 7, 8, 9] : mix === "EVEN" ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [0];

  console.log(`\n  ── PROPOSAL: epochMemberLimit ${memLim} -> ${proposedMembers}, mix ${mix} ──`);
  let totalCnova = 0n, totalUsdc = 0n, members = 0n;
  for (let e = 0; e < 9; e++) {
    let epochCnova = 0n, epochUsdc = 0n;
    for (let k = 0n; k < proposedMembers; k++) {
      const i = mixIdx[Number(k % BigInt(mixIdx.length))];
      epochCnova += rewards[e] * mults[i];
      epochUsdc  += fees[i] * TREASURY_BPS / 10000n;
    }
    // MINT still backstops: if this epoch's emission exceeds the mint limit, MINT
    // fires FIRST and the epoch ends early — the member target is never reached.
    const mintBinds = epochCnova > mintLim;
    totalCnova += mintBinds ? mintLim : epochCnova;
    totalUsdc  += mintBinds ? epochUsdc * mintLim / epochCnova : epochUsdc;
    members    += mintBinds ? proposedMembers * mintLim / epochCnova : proposedMembers;
    console.log(`     epoch ${e + 1}: ${cn(epochCnova).padStart(12)} CNOVA, ${usd6(epochUsdc).padStart(12)} to treasury` +
      (mintBinds ? `   <- MINT BINDS FIRST (limit ${cn(mintLim)}), epoch ends early` : ""));
  }
  const endSupply = supply + totalCnova;
  const endReserve = reserve + totalUsdc;
  const endFloor = endSupply > 0n ? endReserve * (10n ** 18n) / endSupply : 0n;
  console.log(`\n     across all 9 epochs: ${members} members, ${cn(totalCnova)} CNOVA minted, ${usd6(totalUsdc)} to treasury`);
  console.log(`     supply ${cn(supply)} -> ${cn(endSupply)}   (${(Number(endSupply) * 100 / Number(maxSupply)).toFixed(1)}% of max)`);
  console.log(`     FLOOR  ${usd6(floor)} -> ${usd6(endFloor)}   ${endFloor > floor ? "RISES" : "FALLS"}`);

  console.log(`\n  ── THE TRADE-OFF, IN ONE LINE ──`);
  console.log(`     A lower member limit ends epochs sooner: less CNOVA per entry, a higher`);
  console.log(`     floor, and early members receive less. A higher limit is the reverse.`);
  console.log(`     Neither is 'correct' — it is how much of the fixed-reward runway you`);
  console.log(`     want to spend before the Final Frontier formula takes over and starts`);
  console.log(`     regulating the reward against the floor by itself.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
