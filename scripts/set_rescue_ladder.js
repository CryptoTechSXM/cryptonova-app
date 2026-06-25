// set_rescue_ladder.js
// Owner utility: read or change the SF rescue ladder preset on MatrixKeeper.
//
// V8.24 prerequisite: this script is safe to run only AFTER deploying the V8.24 contract
// (narrow catch that includes "F8V8: insufficient withdrawable for rescue"). Without that
// fix, activating a non-zero preset will cause keeper TX reverts for members who have
// earnings below their rescue share.
//
// Usage (read-only, show current state):
//   npx hardhat run scripts/set_rescue_ladder.js --network baseSepolia
//
// Usage (switch to a preset):
//   PRESET=2 npx hardhat run scripts/set_rescue_ladder.js --network baseSepolia
//
// Presets:
//   0 = Conservative — SF covers almost everything; members with 50%+ earnings pay a small share
//   1 = Default      — graduated 11-step ladder; members with high earnings pay more
//   2 = Generous     — 8-step ladder; SF remains generous but rewards high earners with lower cost
//   3 = Maximum      — SF only covers truly empty members; everyone else pays sliding scale
//
// Preset 1 (Default) is the recommended starting point post-V8.24.
// Once the community has substantial cycle earnings, consider moving to Preset 2.

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");
require("dotenv").config();

// ── address ───────────────────────────────────────────────────────────────────
// Update this to the deployed MatrixKeeper address after each redeploy.
// Check deployed_addresses_v8_24.json (or latest) for the current address.
const ADDRESSES_FILE = process.env.ADDRESSES_FILE
  ? path.join(__dirname, process.env.ADDRESSES_FILE)
  : null;

function getMatrixKeeperAddress() {
  if (ADDRESSES_FILE && fs.existsSync(ADDRESSES_FILE)) {
    const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
    return addrs.matrixKeeper || addrs.MatrixKeeper;
  }
  // fallback: scan for latest v8_2x addresses file
  const scriptsDir = __dirname;
  const files = fs.readdirSync(scriptsDir)
    .filter(f => f.match(/^deployed_addresses_v8_\d+\.json$/))
    .sort()
    .reverse();
  if (files.length > 0) {
    const latest = JSON.parse(fs.readFileSync(path.join(scriptsDir, files[0]), "utf8"));
    const addr = latest.matrixKeeper || latest.MatrixKeeper;
    if (addr) { console.log(`  (auto-detected from ${files[0]})`); return addr; }
  }
  throw new Error("Cannot find MatrixKeeper address. Set ADDRESSES_FILE env var or check scripts/ for deployed_addresses_v8_XX.json");
}

// ── ABI ───────────────────────────────────────────────────────────────────────
const ABI = [
  "function setSfRescueLadderPreset(uint256 preset) external",
  "function sfRescueLadderPreset() external view returns (uint8)",
  "function sfRescueThresholds(uint256) external view returns (uint256)",
  "function sfRescueBpsLadder(uint256) external view returns (uint256)",
  "function owner() external view returns (address)",
];

// ── preset descriptions ───────────────────────────────────────────────────────
const PRESET_META = [
  {
    name: "Conservative",
    desc: "SF covers the full rescue for all but the wealthiest members",
    economy: "Good for early-stage when few members have earnings yet",
    thresholds: [10_000, 9_000, 8_000, 7_000, 6_000, 5_000],
    ladder:     [      0, 1_000, 2_000, 3_000, 4_000, 5_000],
  },
  {
    name: "Default (recommended post-V8.24)",
    desc: "Graduated 11-step ladder — SF stays generous at the low end",
    economy: "Best balance: SF earns net-positive once member cycle earnings build up",
    thresholds: [10_000, 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000],
    ladder:     [      0, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000],
  },
  {
    name: "Generous",
    desc: "8-step ladder — SF leans more toward helping members",
    economy: "Good mid-growth phase when most members have some earnings",
    thresholds: [10_000, 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000],
    ladder:     [      0, 1_500, 2_500, 3_500, 4_500, 5_500, 7_000, 8_000],
  },
  {
    name: "Maximum",
    desc: "10-step ladder — members with any earnings pay most of their rescue",
    economy: "Use at maturity when broad member base has substantial withdrawable earnings",
    thresholds: [10_000, 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000, 2_000, 1_000],
    ladder:     [      0, 1_500, 2_500, 3_500, 5_000, 6_000, 7_000, 8_000, 9_000,10_000],
  },
];

function bpsToPercent(bps) { return (bps / 100).toFixed(0) + "%"; }

function printPreset(preset) {
  const m = PRESET_META[preset];
  console.log(`\n  Preset ${preset}: ${m.name}`);
  console.log(`    ${m.desc}`);
  console.log(`    ${m.economy}`);
  console.log(`    Rungs:`);
  for (let i = 0; i < m.thresholds.length; i++) {
    const wBpsMin = (i + 1 < m.thresholds.length) ? m.thresholds[i + 1] : 0;
    const sfPct   = bpsToPercent(m.ladder[i]);
    const memPct  = bpsToPercent(10_000 - m.ladder[i]);
    const range   = i + 1 < m.thresholds.length
      ? `withdrawable ${bpsToPercent(wBpsMin)} – ${bpsToPercent(m.thresholds[i])}`
      : `withdrawable < ${bpsToPercent(m.thresholds[i])}`;
    console.log(`      ${range.padEnd(36)} SF pays ${sfPct.padEnd(5)}  member pays ${memPct}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const mkAddr = getMatrixKeeperAddress();
  const mk = new hre.ethers.Contract(mkAddr, ABI, deployer);

  console.log("\n  ── SF Rescue Ladder Status ─────────────────────────────────────────────");
  console.log(`  MatrixKeeper : ${mkAddr}`);
  console.log(`  Caller       : ${deployer.address}`);

  const contractOwner = await mk.owner();
  const isOwner = deployer.address.toLowerCase() === contractOwner.toLowerCase();
  console.log(`  Contract owner: ${contractOwner}  (you are ${isOwner ? "✓ owner" : "NOT owner — read-only"})`);

  const currentPreset = await mk.sfRescueLadderPreset();
  console.log(`\n  Current preset: ${currentPreset} (${PRESET_META[currentPreset]?.name || "unknown"})`);

  // read live ladder rungs
  console.log("  Live rungs on-chain:");
  for (let i = 0; ; i++) {
    try {
      const thr = await mk.sfRescueThresholds(i);
      const bps = await mk.sfRescueBpsLadder(i);
      const sfPct  = bpsToPercent(Number(bps));
      const memPct = bpsToPercent(10_000 - Number(bps));
      console.log(`    [${i}] threshold=${bpsToPercent(Number(thr)).padEnd(5)}  SF=${sfPct.padEnd(5)}  member=${memPct}`);
    } catch {
      break;
    }
  }

  // show all preset options
  console.log("\n  ── Available Presets ───────────────────────────────────────────────────");
  for (let p = 0; p < 4; p++) printPreset(p);

  // change preset if PRESET env var is set
  const desiredPreset = process.env.PRESET !== undefined ? parseInt(process.env.PRESET, 10) : null;
  if (desiredPreset === null) {
    console.log("\n  No PRESET env var set — read-only run complete.");
    console.log("  To switch: PRESET=1 npx hardhat run scripts/set_rescue_ladder.js --network baseSepolia");
    return;
  }

  if (desiredPreset < 0 || desiredPreset > 3 || isNaN(desiredPreset)) {
    console.error(`\n  ERROR: PRESET must be 0, 1, 2, or 3 (got "${process.env.PRESET}")`);
    process.exit(1);
  }

  if (!isOwner) {
    console.error(`\n  ERROR: caller is not the owner — cannot call setSfRescueLadderPreset`);
    process.exit(1);
  }

  if (Number(currentPreset) === desiredPreset) {
    console.log(`\n  Preset is already ${desiredPreset} — nothing to do.`);
    return;
  }

  console.log(`\n  ── Switching to Preset ${desiredPreset}: ${PRESET_META[desiredPreset].name} ──`);
  console.log("  Sending TX...");
  const tx = await mk.setSfRescueLadderPreset(desiredPreset);
  console.log(`  TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  const ok = receipt.status === 1;
  console.log(`  Confirmed — block=${receipt.blockNumber}  status=${ok ? "OK ✓" : "FAILED ✗"}  gas=${receipt.gasUsed.toLocaleString()}`);

  if (ok) {
    console.log(`\n  Rescue ladder is now Preset ${desiredPreset}: ${PRESET_META[desiredPreset].name}`);
    console.log("  Members who cannot cover their rescue share will emit WorkItemFailed and be skipped");
    console.log("  (V8.24 narrow catch required — confirm MatrixKeeper is V8.24 before relying on this)");
  } else {
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
