// diag_sherwyn_redeem.js — READ-ONLY. Sherwyn's 2026-08-26 00:50 bug report:
// "Redeeming CNova tokens — tokens are being redeemed but not reflecting in wallet."
//
// The contract cannot half-do this: redeemAtFloor() burns and safeTransfers USDC in
// ONE transaction (CNOVATreasury.sol:263). So the answer is one of: (a) the penalty —
// up to 45% of gross inside the first 30 days — made the net far smaller than he
// expected; (b) the USDC arrived on-chain and Rabby just doesn't display the mock
// token; (c) the redeems actually reverted and what he saw was something else.
// This script reads which one it was. Run against LIVE (his redeems are on V8.48):
//
//   ADDRESSES_FILE=deployed_addresses_v8_48.json node scripts/diag_sherwyn_redeem.js
//
// ⚠ .env's ADDRESSES_FILE now names the V8.50 COMMUNITY file (changed 2026-08-26 for
// the deploy) — the env override above is MANDATORY or this reads the wrong chain
// (fresh chain, zero events, and a "no redemptions" conclusion that would be FALSE).
const { ethers } = require("ethers");
const fs = require("fs"); const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const WALLET = "0x7d3c94885d2022200934d4908bca7b47905bbcf6";
const AF = process.env.ADDRESSES_FILE || "";
if (!/v8_48/.test(AF)) {
  console.error(`ADDRESSES_FILE=${AF || "(unset)"} — refusing: this diagnosis is about the LIVE (v8_48) chain.`);
  console.error(`Run: ADDRESSES_FILE=deployed_addresses_v8_48.json node scripts/diag_sherwyn_redeem.js`);
  process.exit(1);
}
const ADDRS = JSON.parse(fs.readFileSync(path.join(__dirname, AF), "utf8"));
const RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const provider = new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true });

const TRE_EV = new ethers.Interface([
  "event FloorRedemption(address indexed member, uint256 cnovaBurned, uint256 usdcPaid, uint256 floorPriceUsed)",
  "event EarlyExitPenalty(address indexed member, uint256 penalty, uint256 penaltyBps, uint256 toTreasury, uint256 toCommunity)",
]);
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const usd6 = v => "$" + (Number(v) / 1e6).toFixed(6);
const cn18 = v => (Number(v) / 1e18).toFixed(4) + " CNOVA";

async function getLogsChunked(filter, from, to, step) {
  const out = [];
  for (let a = from; a <= to; a += step) {
    const b = Math.min(a + step - 1, to);
    try { out.push(...await provider.getLogs({ ...filter, fromBlock: a, toBlock: b })); }
    catch (e) { console.error(`  getLogs ${a}-${b} failed: ${e.message.slice(0,80)} — window has a HOLE, say so in the report`); }
  }
  return out;
}

(async () => {
  const treasury = ADDRS.treasury, usdcAddr = ADDRS.usdc || ADDRS.mockUSDC, cnovaAddr = ADDRS.cnova || ADDRS.cnovaToken;
  const tip = await provider.getBlockNumber();
  const SPAN = 130_000; // ~3 days of Base Sepolia blocks; the report is from last night
  const from = Math.max(0, tip - SPAN);
  console.log(`chain tip ${tip}, scanning ${from}..${tip} (~3 days) — treasury ${treasury}`);
  console.log(`wallet ${WALLET}\n`);

  const member32 = ethers.zeroPadValue(WALLET, 32);
  const redeems = await getLogsChunked({ address: treasury,
    topics: [TRE_EV.getEvent("FloorRedemption").topicHash, member32] }, from, tip, 9_500);
  const pens = await getLogsChunked({ address: treasury,
    topics: [TRE_EV.getEvent("EarlyExitPenalty").topicHash, member32] }, from, tip, 9_500);
  const penByTx = new Map(pens.map(l => [l.transactionHash, TRE_EV.parseLog({topics:[...l.topics],data:l.data})]));

  if (!redeems.length) console.log("NO FloorRedemption events for this wallet in the window — if he redeemed, it was earlier or it REVERTED.");
  let totPaid = 0n, totBurn = 0n, totPen = 0n;
  for (const l of redeems) {
    const ev = TRE_EV.parseLog({ topics: [...l.topics], data: l.data });
    const blk = await provider.getBlock(l.blockNumber);
    const pen = penByTx.get(l.transactionHash);
    totPaid += BigInt(ev.args.usdcPaid); totBurn += BigInt(ev.args.cnovaBurned);
    if (pen) totPen += BigInt(pen.args.penalty);
    console.log(`block ${l.blockNumber}  ${new Date(blk.timestamp*1000).toISOString()}`);
    console.log(`  burned ${cn18(ev.args.cnovaBurned)}  ->  PAID ${usd6(ev.args.usdcPaid)}  (floor ${usd6(ev.args.floorPriceUsed)}/CNOVA)`);
    if (pen) console.log(`  penalty ${usd6(pen.args.penalty)} (${Number(pen.args.penaltyBps)/100}% — joined <121 days ago)`);
    console.log(`  tx ${l.transactionHash}`);
  }
  console.log(`\nTOTAL in window: burned ${cn18(totBurn)}  paid ${usd6(totPaid)}  penalty withheld ${usd6(totPen)}`);
  const usdc = new ethers.Contract(usdcAddr, ERC20, provider);
  const cnova = new ethers.Contract(cnovaAddr, ERC20, provider);
  console.log(`wallet NOW: USDC ${usd6(await usdc.balanceOf(WALLET))}   CNOVA ${cn18(await cnova.balanceOf(WALLET))}`);
  console.log(`\nReading: paid>0 means the USDC IS in his wallet on-chain (Rabby display issue -> tell him to`);
  console.log(`import the mock USDC token ${usdcAddr}); a big penalty explains "less than expected";`);
  console.log(`zero events with him insisting he redeemed means reverted txs — ask for a tx hash.`);
})().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
