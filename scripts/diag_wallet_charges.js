// diag_wallet_charges.js — WAS THIS WALLET CHARGED TWICE?
//
// THE QUESTION (owner, 2026-08-24): during the self-rescue QA the wallet popup came back
// while the dashboard was mid-refresh, and the owner pressed it more than once. Did any
// shortfall get taken twice? Screen balances are not evidence - they are a rendering of
// state at two moments, and the whole reason this session exists is that a rendering can
// disagree with the chain. So this reads the LEDGER: every USDC Transfer this wallet paid
// out and every one it received, labelled against the deployed matrices.
//
// READ-ONLY. Sends nothing, needs no key.
//
//   Run:
//   ADDRESSES_FILE=deployed_addresses_v8_48.json MEMBER=0x... \
//     npx hardhat run scripts/diag_wallet_charges.js --network baseSepolia
//
//   BLOCKS=20000   how far back to scan (default 20000 ~ 11h on Base Sepolia)
//   CHUNK=9000     log window per request (the RPC caps this; do not raise blindly)
//
const { ethers } = require("hardhat");
const path = require("path");

// 34.1 / 34.7 item 5: NO DEFAULT ADDRESSES FILE. A confident number about a dead
// deployment is worse than no number.
if (!process.env.ADDRESSES_FILE) {
  console.log("FATAL: ADDRESSES_FILE not set - refusing to start with a stale default.");
  process.exit(1);
}
if (!process.env.MEMBER) {
  console.log("FATAL: MEMBER not set. MEMBER=0x... is the wallet to audit.");
  process.exit(1);
}
const A = require(path.join(__dirname, process.env.ADDRESSES_FILE));
const MEMBER = ethers.getAddress(process.env.MEMBER.trim());
const BLOCKS = Number(process.env.BLOCKS || 20000);
const CHUNK  = Number(process.env.CHUNK  || 9000);

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");

function labelMap() {
  const m = new Map();
  const put = (addr, label) => { if (addr) m.set(ethers.getAddress(addr).toLowerCase(), label); };
  for (const [tier, t] of Object.entries(A.tiers || {})) {
    put(t.matA, `${tier} MatA`); put(t.matB, `${tier} MatB`); put(t.pm, `${tier} PairManager`);
  }
  put(A.stabilityFund, "StabilityFund"); put(A.tierRouter, "TierRouter");
  put(A.treasury, "Treasury");           put(A.communityWallet, "CommunityWallet");
  put(A.accountOne, "accountOne");       put(A.buybackReserve, "BuybackReserve");
  put(A.liquidityReserve, "LiquidityReserve"); put(A.directSale, "DirectSale");
  put(A.devWallet, "devWallet");         put(A.opsWallet, "opsWallet");
  return m;
}

async function main() {
  const rp   = ethers.provider;
  const now  = await rp.getBlockNumber();
  const from = Math.max(0, now - BLOCKS);
  const labels = labelMap();

  console.log(`[${new Date().toISOString()}] diag_wallet_charges - READ-ONLY, no transactions sent`);
  console.log(`  addresses : ${process.env.ADDRESSES_FILE}`);
  console.log(`  member    : ${MEMBER}`);
  console.log(`  USDC      : ${A.usdc}`);
  console.log(`  blocks    : ${from} .. ${now}  (${now - from} blocks)`);
  const b0 = await rp.getBlock(from);
  if (b0) console.log(`  window starts: ${new Date(Number(b0.timestamp) * 1000).toISOString()}`);

  const usdc  = new ethers.Contract(A.usdc, [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ], rp);

  // ⛔ DO NOT USE contract.filters.Transfer(...) HERE AND SPREAD IT INTO getLogs.
  // In ethers v6 that returns a DeferredTopicFilter, and `{...filter}` copies NONE of
  // its address/topics - so getLogs runs UNFILTERED and pulls every log on the chain
  // for the window. First run, 2026-08-24: the RPC response blew past Node's string
  // limit ("Cannot create a string longer than 0x1fffffe8 characters") and the scan
  // aborted. Build the topics by hand so the filter is a plain object that survives
  // the spread, and assert it below rather than trusting it.
  const TRANSFER_SIG = ethers.id("Transfer(address,address,uint256)");
  const asTopic = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);
  const topicOut = { address: A.usdc, topics: [TRANSFER_SIG, asTopic(MEMBER), null] };
  const topicIn  = { address: A.usdc, topics: [TRANSFER_SIG, null, asTopic(MEMBER)] };

  // SELFTEST - the filter must actually be a filter. An unfiltered scan does not
  // fail loudly on a quiet chain; it just returns everyone else's transfers and the
  // double-charge check reports on the wrong wallet.
  for (const [nm, f] of [["out", topicOut], ["in", topicIn]]) {
    if (!f.address || !Array.isArray(f.topics) || f.topics[0] !== TRANSFER_SIG) {
      console.log(`FATAL: ${nm} filter is malformed - refusing to scan unfiltered.`);
      process.exit(1);
    }
  }
  console.log("  SELFTEST: both log filters carry the USDC address and the Transfer topic ✅");

  const pull = async (filter) => {
    const out = [];
    for (let s = from; s <= now; s += CHUNK) {
      const e = Math.min(s + CHUNK - 1, now);
      // ONE READ IS NOT A MEASUREMENT (36.7 item 2): an RPC can fail a window
      // transiently, and a silently missing window here reads as "no double charge",
      // which is the exact wrong answer to be confident about. Retry, then abort loudly.
      let got = null;
      for (let attempt = 0; attempt < 4 && got === null; attempt++) {
        try { got = await rp.getLogs({ ...filter, fromBlock: s, toBlock: e }); }
        catch (err) {
          if (attempt === 3) {
            console.log(`  FATAL: window ${s}..${e} failed 4 times - ${err.message}`);
            console.log("  REFUSING to report a total over an incomplete scan.");
            process.exit(1);
          }
          await new Promise(r => setTimeout(r, 1200));
        }
      }
      out.push(...got);
    }
    return out;
  };

  const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const decode = (logs) => logs.map(l => {
    const d = iface.parseLog(l);
    return { block: l.blockNumber, tx: l.transactionHash,
             from: d.args[0], to: d.args[1], value: d.args[2] };
  }).sort((a, b) => a.block - b.block);

  const paid = decode(await pull(topicOut));
  const recv = decode(await pull(topicIn));

  // SECOND SELFTEST, on the RESULT rather than the request: every row must involve
  // this member. If the filter ever silently degrades again, this catches it here
  // instead of in a confident total further down.
  const wrong = [...paid.filter(t => t.from.toLowerCase() !== MEMBER.toLowerCase()),
                 ...recv.filter(t => t.to.toLowerCase()   !== MEMBER.toLowerCase())];
  if (wrong.length) {
    console.log(`FATAL: ${wrong.length} returned log(s) do not involve ${MEMBER}.`);
    process.exit(1);
  }
  console.log(`  SELFTEST: all ${paid.length + recv.length} returned transfers involve this member ✅`);

  const name = (a) => labels.get(a.toLowerCase()) || a;

  console.log(`\n  PAID OUT BY THIS WALLET - ${paid.length} transfer(s)`);
  console.log("  " + "-".repeat(96));
  let totalOut = 0n;
  for (const t of paid) {
    totalOut += t.value;
    console.log(`  block ${t.block}  ${usd(t.value).padStart(12)}  -> ${name(t.to).padEnd(20)} ${t.tx}`);
  }
  console.log(`  TOTAL PAID OUT: ${usd(totalOut)}`);

  console.log(`\n  RECEIVED BY THIS WALLET - ${recv.length} transfer(s)`);
  let totalIn = 0n;
  for (const t of recv) {
    totalIn += t.value;
    console.log(`  block ${t.block}  ${usd(t.value).padStart(12)}  <- ${name(t.from).padEnd(20)} ${t.tx}`);
  }
  console.log(`  TOTAL RECEIVED: ${usd(totalIn)}`);

  // ── THE ACTUAL QUESTION: same spender, same amount, twice ────────────────────
  console.log(`\n  DOUBLE-CHARGE CHECK - same destination AND same amount, more than once`);
  const seen = new Map();
  for (const t of paid) {
    const k = `${t.to.toLowerCase()}|${t.value.toString()}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(t);
  }
  const dupes = [...seen.values()].filter(v => v.length > 1);
  if (dupes.length === 0) {
    console.log("  ✅ NONE. Every payment out of this wallet is a distinct amount/destination pair.");
  } else {
    for (const g of dupes) {
      console.log(`  ⛔ ${g.length}x ${usd(g[0].value)} -> ${name(g[0].to)}`);
      for (const t of g) console.log(`       block ${t.block}  ${t.tx}`);
      const sameTx = new Set(g.map(t => t.tx)).size === 1;
      console.log(sameTx
        ? "       (all in ONE transaction - not a double charge, one tx moving the amount twice)"
        : "       ⚠ SEPARATE TRANSACTIONS - this is a real repeat payment. Check whether the second");
      if (!sameTx) console.log("         one bought a genuinely new parked position or was a duplicate submit.");
    }
  }

  // ── LEFTOVER APPROVALS. approveSelfRescue approves the ENTRY FEE, and only the
  // shortfall is taken (ca66731), so a remainder stays approved by design. Print it
  // so the design choice is visible rather than discovered later as a surprise.
  console.log(`\n  LEFTOVER ALLOWANCES (approve-the-fee leaves a remainder by design)`);
  const spenders = [...new Set(paid.map(t => t.to.toLowerCase()))];
  let anyAlw = false;
  for (const s of spenders) {
    const alw = await usdc.allowance(MEMBER, s).catch(() => null);
    if (alw === null) { console.log(`  ${name(s).padEnd(20)} allowance UNREADABLE`); continue; }
    if (alw > 0n) { anyAlw = true; console.log(`  ${name(s).padEnd(20)} ${usd(alw)} still approved and unspent`); }
  }
  if (!anyAlw) console.log("  none outstanding");

  const bal = await usdc.balanceOf(MEMBER);
  console.log(`\n  WALLET NOW: ${usd(bal)}`);
  console.log(`  NET OVER WINDOW: -${usd(totalOut - totalIn)}  (paid ${usd(totalOut)} - received ${usd(totalIn)})`);
  console.log(`\n  ⚠ Scanned ${now - from} blocks only. Anything older than that is NOT in these totals.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
