// tx_decode.js — decode every event in one transaction, and dump the member's
// CURRENT full struct in the contract it touched.
//
// WHY (2026-07-29): tx 0xb11eee58 called withdrawPartial(uint256) on T3.1 MatA
// and USDC moved $51.71 to the caller, yet that matrix's totalWithdrawn for the
// caller reads $0.00. That cannot happen inside withdrawCore:
//
//     :995   self.members[member].withdrawable   -= amt;
//     :996   self.members[member].totalWithdrawn += amt;      <- consecutive
//     :999   fee    = amt * withdrawalFeeBps / BPS_DENOM;
//     :1007  cfg.usdc.safeTransfer(recipient, payout);        <- same function
//     :1008  emit EarningsWithdrawn(member, payout);
//
// Fifteen sibling transactions in the same minute, same function, same frontend
// loop, all recorded correctly. So one of two things is true:
//
//   (A) withdrawCore DID run -> EarningsWithdrawn + WithdrawalFeeCharged will be
//       in this receipt. Then the counter was written and something ZEROED IT
//       LATER. The candidate is struct re-initialisation: MatrixLogicLib:340
//       creates a Member with `totalWithdrawn: 0`, so any path that re-creates
//       the record instead of updating it wipes the member's whole history.
//       T3.1 MatA is a tier this member was actively cycling, which is exactly
//       where a re-entry would land.
//
//   (B) withdrawCore did NOT run -> no EarningsWithdrawn in the receipt, and the
//       $51.71 left by some other route. That would be far more serious.
//
// The receipt distinguishes them in ONE call. Do not infer it from the amount.
//
// Read-only. No key.
//
// Run:  TX=0xb11eee58... ADDR=0x... node tx_decode.js

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const CANDIDATE_DIRS = [
  __dirname, process.cwd(),
  "C:/CryptoNite-MT5-Bots", "C:/CryptoNite-Smart-Contracts/CryptoNova", "/root/keeper",
  path.join(__dirname, "..", "CryptoNite-Smart-Contracts", "CryptoNova"),
];
function findFile(n) { for (const d of CANDIDATE_DIRS) { try { const f = path.join(d, n); if (fs.existsSync(f)) return f; } catch (_) {} } return null; }
for (const d of CANDIDATE_DIRS) { try { const f = path.join(d, ".env"); if (fs.existsSync(f)) require("dotenv").config({ path: f }); } catch (_) {} }

const RPC_URL    = process.env.RPC || process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_SEPOLIA_RPC;
const ADDRS_PATH = process.env.ADDRESSES_PATH || findFile(process.env.ADDRESSES_FILE || "deployed_addresses_v8_45.json");
const TX         = (process.env.TX || "0xb11eee5801310dc5b1ce2b6df595e0ecb094f19d36a0ed2e6a56cff1e493fb27").trim();
const WHO        = (process.env.ADDR || "0xe8Ad7bbA862002414566a3e28f664E8BeA7F5ad5").trim();

// Every event these contracts can emit that matters for a withdrawal, plus the
// entry/seating events that would prove a re-registration wiped the struct.
const EVENT_ABI = [
  "event EarningsWithdrawn(address indexed member, uint256 amount)",
  "event WithdrawalFeeCharged(address indexed member, uint256 fee)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event MemberRegistered(address indexed member, uint256 position, address indexed referrer)",
  "event MemberSeated(address indexed member, uint256 position)",
  "event MemberParked(address indexed member, uint256 shortfall)",
  "event MemberExitedSeat(address indexed member, uint256 position, uint256 reserveReleased, uint256 penalty)",
  "event MemberEvicted(address indexed member, uint256 totalWithdrawn)",
  "event SlotReclaimed(address indexed member, uint256 position, uint256 idleDuration)",
  "event RotationCompleted(uint256 rotationCount, address indexed cycledOut)",
  "event PoolDistributed(uint256 amount, uint256 seats)",
  "event CrossedToPartner(address indexed member, address indexed partner)",
  "event StrandedReserveReleased(address indexed member, uint256 amount)",
  "event RescueDebtRepaid(address indexed member, uint256 amount, uint256 remaining)",
  "event CycleOutFailed(address indexed member, uint8 tierIndex)",
];
const MEMBER_ABI = [
  "function getMember(address) view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 totalWithdrawn, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))",
  "function getMemberTotalWithdrawn(address) view returns (uint256)",
  "function crossingReserveOf(address) view returns (uint256)",
  "function parkedAt(address) view returns (uint256)",
  "function matrixPos(address) view returns (uint256)",
  "function occupancy() view returns (uint256)",
  "function rotationCount() view returns (uint256)",
];

const usd = v => "$" + Number(ethers.formatUnits(v, 6)).toFixed(2);
async function rd(fn, d = "READ FAILED") { try { return await fn(); } catch (e) { return d; } }

async function main() {
  if (!RPC_URL) { console.log("FATAL: no RPC"); process.exit(1); }
  const p = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  const a = JSON.parse(fs.readFileSync(ADDRS_PATH, "utf8"));
  const who = ethers.getAddress(WHO);
  const iface = new ethers.Interface(EVENT_ABI);

  const rc = await p.getTransactionReceipt(TX);
  if (!rc) { console.log(`FATAL: receipt not found for ${TX}`); process.exit(1); }
  const tx = await p.getTransaction(TX);

  console.log(`tx_decode — ${TX}`);
  console.log(`block ${rc.blockNumber}  ·  status ${rc.status === 1 ? "SUCCESS" : "REVERTED"}  ·  gas used ${rc.gasUsed}`);
  console.log(`from ${tx.from}\nto   ${tx.to}\ndata ${tx.data.slice(0, 10)}  (${tx.data.length / 2 - 1} bytes)`);
  if (tx.data.length >= 74) {
    try { console.log(`arg  ${usd(BigInt("0x" + tx.data.slice(10, 74)))}  (decoded as uint256 USDC)`); } catch (_) {}
  }

  console.log(`\nEVENTS IN THIS TRANSACTION (${rc.logs.length} logs)`);
  console.log("─".repeat(100));
  let sawWithdrawn = false, sawFee = false;
  for (const lg of rc.logs) {
    let parsed = null;
    try { parsed = iface.parseLog({ topics: [...lg.topics], data: lg.data }); } catch (_) {}
    const src = lg.address.toLowerCase() === a.usdc.toLowerCase() ? "USDC"
              : lg.address.toLowerCase() === tx.to.toLowerCase()  ? "the matrix"
              : lg.address;
    if (!parsed) { console.log(`  [${src}] UNDECODED  topic0=${lg.topics[0].slice(0, 18)}…`); continue; }
    if (parsed.name === "EarningsWithdrawn")   sawWithdrawn = true;
    if (parsed.name === "WithdrawalFeeCharged") sawFee = true;
    const args = parsed.fragment.inputs.map((inp, i) => {
      let v = parsed.args[i];
      if (typeof v === "bigint") v = (inp.name.match(/amount|fee|value|withdrawn|shortfall|released|penalty|remaining/i)) ? usd(v) : v.toString();
      return `${inp.name}=${v}`;
    }).join("  ");
    console.log(`  [${src}] ${parsed.name}  ${args}`);
  }

  const mat = new ethers.Contract(tx.to, MEMBER_ABI, p);
  const m = await rd(() => mat.getMember(who));
  console.log(`\nCURRENT MEMBER RECORD IN THIS MATRIX (read now, ${new Date().toISOString()})`);
  console.log("─".repeat(100));
  if (typeof m === "string") console.log(`  getMember: ${m}`);
  else {
    console.log(`  id              ${m.id}`);
    console.log(`  referrer        ${m.referrer}`);
    console.log(`  joinedAt        ${m.joinedAt} ${m.joinedAt > 0n ? "(" + new Date(Number(m.joinedAt) * 1000).toISOString() + ")" : ""}`);
    console.log(`  withdrawable    ${usd(m.withdrawable)}`);
    console.log(`  totalEarned     ${usd(m.totalEarned)}`);
    console.log(`  totalWithdrawn  ${usd(m.totalWithdrawn)}   <-- the figure in question`);
    console.log(`  cyclesCompleted ${m.cyclesCompleted}`);
    console.log(`  isInMatrix      ${m.isInMatrix}`);
    console.log(`  hasEverJoined   ${m.hasEverJoined}`);
  }
  console.log(`  matrixPos       ${await rd(() => mat.matrixPos(who))}`);
  console.log(`  parkedAt        ${await rd(() => mat.parkedAt(who))}`);
  console.log(`  crossingReserve ${await rd(async () => usd(await mat.crossingReserveOf(who)))}`);
  console.log(`  (matrix occupancy ${await rd(() => mat.occupancy())}, rotations ${await rd(() => mat.rotationCount())})`);

  console.log(`\nVERDICT`);
  if (sawWithdrawn) {
    console.log(`  withdrawCore DID RUN — EarningsWithdrawn was emitted${sawFee ? " (and the fee event)" : " but NOT the fee event"}.`);
    console.log(`  So totalWithdrawn WAS incremented at :996 and has been ZEROED SINCE.`);
    console.log(`  The only code that writes a zero there is the Member struct initialiser`);
    console.log(`  (MatrixLogicLib:340, "totalWithdrawn: 0"). Look at hasEverJoined/joinedAt/id`);
    console.log(`  above: if joinedAt is LATER than this block, the member's record was`);
    console.log(`  re-created after the withdrawal and the whole history went with it —`);
    console.log(`  totalEarned too, not just totalWithdrawn. That is a V8.46 fix: update the`);
    console.log(`  existing record on re-entry instead of constructing a fresh one.`);
  } else {
    console.log(`  withdrawCore DID NOT RUN — no EarningsWithdrawn in this receipt.`);
    console.log(`  The $51.71 left the matrix by another route. Check the UNDECODED logs above`);
    console.log(`  and confirm whether this matrix is linked to the same MatrixLogicLib as its`);
    console.log(`  siblings (libraries are LINKED, not embedded — a matrix deployed against an`);
    console.log(`  older library would behave differently while presenting the same ABI).`);
  }
}

main().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
