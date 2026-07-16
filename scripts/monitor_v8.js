// ═══════════════════════════════════════════════════════════════════════
// CryptoNova Matrix — Daily Chain Health Monitor
//
// Usage:
//   node scripts/monitor_v8.js
//
// ENV vars (.env):
//   TELEGRAM_BOT_TOKEN=<from @BotFather>
//   TELEGRAM_CHAT_ID=<admin group chat ID>
//
// Schedule (Cowork / cron):
//   Run daily at 08:00 — gets a morning briefing before you start your day
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { ethers } = require('ethers');
const https = require('https');

// ── Network ─────────────────────────────────────────────────────────
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// ── Matrix size ──────────────────────────────────────────────────────
const MATRIX_SIZE = 127;

// ── Contract addresses — loaded from addresses file ──────────────────
// Auto-loaded from ADDRESSES_FILE env var or default deployed_addresses_v8_11.json
// No more hardcoding: just redeploy and the new file is picked up automatically.
const path    = require('path');
const fs_sync = require('fs');
const ADDR_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_11.json');
if (!fs_sync.existsSync(ADDR_FILE)) {
  console.error(`\n❌  ${ADDR_FILE} not found. Run deploy_v8.js first.`);
  process.exit(1);
}
const _raw = JSON.parse(fs_sync.readFileSync(ADDR_FILE, 'utf8'));
// Tier entry fee labels (matches deploy_v8.js TIER_FEES array)
const TIER_FEES_USD = ['$10','$25','$50','$100','$250','$500','$1,000','$2,500','$5,000','$10,000'];
const ADDRS = {
  usdc:           _raw.usdc           || '',
  cnova:          _raw.cnova          || '',
  treasury:       _raw.treasury       || '',
  stabilityFund:  _raw.stabilityFund  || '',
  buybackReserve: _raw.buybackReserve || '',
  tierRouter:     _raw.tierRouter     || '',
  matrixKeeper:   _raw.matrixKeeper   || '',
  communityWallet:_raw.communityWallet|| '',
  // Convert { "T1": { pm, matA, matB }, ... } OR { "1": ... } → array sorted by tier num
  tiers: Object.keys(_raw.tiers || {})
    .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')))
    .map(k => { const n = parseInt(k.replace(/\D/g,'')); return { num: n, fee: TIER_FEES_USD[n-1] || `$?`, ..._raw.tiers[k] }; }),
};
console.log(`📂  Loaded addresses: ${path.basename(ADDR_FILE)}`);

// ── State file (tracks previous run for delta calculations) ──────────
const STATE_FILE = './monitor_state.json';
const fs = require('fs');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Formatting helpers ───────────────────────────────────────────────
const fmt6  = (n) => '$' + (Number(n) / 1e6).toFixed(2);
const fmtE  = (n) => parseFloat(ethers.formatEther(n)).toLocaleString('en-US', { maximumFractionDigits: 0 });
const delta = (now, prev, prefix='') => {
  if (prev === undefined) return '';
  const d = now - prev;
  if (d === 0) return ' (nc)';
  return d > 0 ? ` (+${prefix}${d})` : ` (${prefix}${d})`;
};
const delta6 = (now, prev) => {
  if (prev === undefined) return '';
  const d = (Number(now) - Number(prev)) / 1e6;
  if (d === 0) return ' (nc)';
  return d > 0 ? ` (+$${d.toFixed(2)})` : ` (-$${Math.abs(d).toFixed(2)})`;
};

// ── Thresholds for alerts ────────────────────────────────────────────
const ALERTS = {
  stabilityFundMin:  10_000_000n,   // alert if StabilityFund < $10
  poolStallHours:    12,            // alert if T1 MatB occ unchanged for >12h
  minDailyRegs:      0,             // alert if 0 new registrations in 24h
};

// ── Telegram sender ──────────────────────────────────────────────────
async function _tgSend(chatId, msg, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const r = JSON.parse(data);
        if (!r.ok) console.error('Telegram error:', r.description);
        resolve(r);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('\n─── TELEGRAM NOT CONFIGURED ──────────────────────────');
    console.log('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    console.log('Report (console only):');
    console.log(msg.replace(/<[^>]+>/g, ''));
    return;
  }
  return _tgSend(chatId, msg, token);
}

async function sendChannel(msg) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const channel = process.env.TELEGRAM_ANNOUNCE_CHANNEL_ID;
  if (!token || !channel) return; // silently skip if not configured
  return _tgSend(channel, msg, token).catch(e => console.warn('Channel send failed:', e.message));
}

// ── ABIs (minimal) ───────────────────────────────────────────────────
const MATRIX_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function poolAccumulator() external view returns (uint256)',
  'function totalJoined() external view returns (uint256)',
];
const CNOVA_ABI = [
  'function totalSupply() external view returns (uint256)',
  'function totalBurned() external view returns (uint256)',
  'function currentEpoch() external view returns (uint8)',
  'function epochRewards(uint8) external view returns (uint256)',
];
const SF_ABI   = ['function totalBalance() external view returns (uint256)'];
const USDC_ABI = ['function balanceOf(address) external view returns (uint256)'];
const TR_ABI   = [
  'function systemPaused() external view returns (bool)',
  'function totalSystemCycles() external view returns (uint256)',
  'function globalJoinedCount() external view returns (uint256)', // unique wallets — matches pulse
];
const CW_ABI   = [
  'function totalEnrolled() external view returns (uint256)',
  'function genesisCount() external view returns (uint256)',
  'function pioneerCount() external view returns (uint256)',
  'function availablePool() external view returns (uint256)',
  'function distributeReady() external view returns (bool)',
  'function totalLifetimeClaimed() external view returns (uint256)',
];

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const prev   = loadState();
  const now    = {};
  const alerts = [];
  const today  = new Date().toUTCString();

  const rp = new ethers.JsonRpcProvider(RPC_URL);

  console.log('CryptoNova Matrix — Daily Monitor');
  console.log('Time:', today);
  console.log('RPC: ', RPC_URL);

  // ── Build tier contracts ──────────────────────────────────────────
  const tierContracts = ADDRS.tiers.map(t => ({
    num:  t.num,
    fee:  t.fee,
    matA: new ethers.Contract(t.matA, MATRIX_ABI, rp),
    matB: new ethers.Contract(t.matB, MATRIX_ABI, rp),
  }));

  // ── Read all tier data sequentially (avoid rate-limit burst) ────
  const tierData = [];
  for (const t of tierContracts) {
    const [aOcc, aCycles, aPool, aTotal, bOcc, bCycles, bPool] = await Promise.all([
      t.matA.occupancy(),
      t.matA.rotationCount(),
      t.matA.poolAccumulator(),
      t.matA.totalJoined(),
      t.matB.occupancy(),
      t.matB.rotationCount().catch(() => 0n),
      t.matB.poolAccumulator().catch(() => 0n),
    ]);
    tierData.push({ num: t.num, fee: t.fee, aOcc, aCycles, aPool, aTotal, bOcc, bCycles, bPool });
    await sleep(200);
  }

  await sleep(500);
  // ── Read shared infrastructure ────────────────────────────────────
  const cnovaC = new ethers.Contract(ADDRS.cnova, CNOVA_ABI, rp);
  const sfC    = new ethers.Contract(ADDRS.stabilityFund, SF_ABI, rp);
  const usdcC  = new ethers.Contract(ADDRS.usdc, USDC_ABI, rp);
  const trC    = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);
  const cwC    = new ethers.Contract(ADDRS.communityWallet, CW_ABI, rp);

  const [
    totalSupply, totalBurned, epoch,
    sfBal,
    tUSDC, bbUSDC, cwUSDC,
    paused, systemCycles, globalJoinedCount,
    cwEnrolled, cwGenesis, cwPioneer, cwPool, cwDistReady, cwLifetime,
  ] = await Promise.all([
    cnovaC.totalSupply(),
    cnovaC.totalBurned().catch(() => 0n),
    cnovaC.currentEpoch(),
    sfC.totalBalance(),
    usdcC.balanceOf(ADDRS.treasury),
    usdcC.balanceOf(ADDRS.buybackReserve),
    usdcC.balanceOf(ADDRS.communityWallet),
    trC.systemPaused(),
    trC.totalSystemCycles(),
    trC.globalJoinedCount(),         // unique wallets ever registered
    cwC.totalEnrolled().catch(() => 0n),
    cwC.genesisCount().catch(() => 0n),
    cwC.pioneerCount().catch(() => 0n),
    cwC.availablePool().catch(() => 0n),
    cwC.distributeReady().catch(() => false),
    cwC.totalLifetimeClaimed().catch(() => 0n),
  ]);

  // Read current epoch reward separately (needs epoch value from above)
  const epochReward = await cnovaC.epochRewards(epoch).catch(() => ethers.parseEther('50'));

  // CNOVA floor price: Treasury USDC / total supply (18-dec CNOVA, 6-dec USDC)
  const floorPriceUSD = totalSupply > 0n
    ? (Number(tUSDC) / 1e6) / (Number(totalSupply) / 1e18)
    : 0;

  // ── Save current state ─────────────────────────────────────────────
  now.sfBal        = sfBal.toString();
  now.tUSDC        = tUSDC.toString();
  now.supply       = totalSupply.toString();
  now.burned       = totalBurned.toString();
  now.systemCycles = Number(systemCycles);
  now.timestamp    = Date.now();
  now.paused       = paused;
  now.cwEnrolled   = Number(cwEnrolled);

  // Store per-tier state
  now.tiers = {};
  let totalJoinedNow  = 0;
  let totalJoinedPrev = 0;
  for (const td of tierData) {
    now.tiers[td.num] = {
      aOcc:    Number(td.aOcc),
      aCycles: Number(td.aCycles),
      bOcc:    Number(td.bOcc),
      bCycles: Number(td.bCycles),
      aTotal:  Number(td.aTotal),
    };
    totalJoinedNow += Number(td.aTotal);
    if (prev.tiers?.[td.num]) totalJoinedPrev += (prev.tiers[td.num].aTotal || 0);
  }
  now.totalJoined = totalJoinedNow;
  // globalMembers = unique wallets from TierRouter — the authoritative member count.
  // totalJoinedNow = sum of matA.totalJoined() across all tiers, which counts upgraded
  // members once per tier (always >= globalMembers). Used for tier detail only.
  now.globalMembers = Number(globalJoinedCount);

  // ── Alert checks ──────────────────────────────────────────────────
  if (paused) {
    alerts.push('🚨 CRITICAL: System is PAUSED — no new registrations possible');
  }
  if (sfBal < ALERTS.stabilityFundMin) {
    alerts.push(`🚨 StabilityFund LOW: ${fmt6(sfBal)} (minimum: ${fmt6(ALERTS.stabilityFundMin)})`);
  }

  const hoursSinceLast = prev.timestamp
    ? (Date.now() - prev.timestamp) / 3600000
    : 0;

  const t1Prev = prev.tiers?.[1];
  if (t1Prev && now.tiers[1].bOcc === t1Prev.bOcc && now.tiers[1].bOcc < MATRIX_SIZE && hoursSinceLast >= ALERTS.poolStallHours) {
    alerts.push(`⚠️  T1 MatB STALLED at ${now.tiers[1].bOcc}/${MATRIX_SIZE} for ~${Math.round(hoursSinceLast)}h — consider forceCross`);
  }

  // newRegs: delta of unique members (globalJoinedCount) — not sum-of-tiers
  const newRegs = prev.globalMembers !== undefined
    ? now.globalMembers - prev.globalMembers
    : null;

  if (hoursSinceLast >= 20 && newRegs === 0) {
    alerts.push(`⚠️  No new registrations in ~${Math.round(hoursSinceLast)}h — check frontend`);
  }

  if (now.systemCycles > (prev.systemCycles || 0)) {
    const nc = now.systemCycles - (prev.systemCycles || 0);
    alerts.push(`🎉 ${nc} new matrix cycle${nc > 1 ? 's' : ''} completed since last check!`);
  }

  if (cwDistReady) {
    alerts.push(`🏦 CommunityWallet: distribution is READY — call distribute()`);
  }

  // ── Build tier occupancy table (compact) ─────────────────────────
  const tierRows = tierData.map(td => {
    const pT = prev.tiers?.[td.num];
    const aCy = pT ? delta(Number(td.aCycles), pT.aCycles) : '';
    const bCy = pT ? delta(Number(td.bCycles), pT.bCycles) : '';
    return `T${td.num.toString().padEnd(2)} ${td.fee.padEnd(8)} A:${String(Number(td.aOcc)).padStart(3)}/127(${td.aCycles}${aCy}) B:${String(Number(td.bOcc)).padStart(3)}/127(${td.bCycles}${bCy})`;
  });

  // ── Status line ───────────────────────────────────────────────────
  const statusLine = paused
    ? '🔴 <b>SYSTEM PAUSED</b>'
    : alerts.length > 0
      ? '🟡 Healthy with warnings'
      : '🟢 All systems healthy';

  // ── Build report ──────────────────────────────────────────────────
  const report = [
    `📊 <b>CryptoNova Matrix — Daily Report</b>`,
    `📅 ${today}`,
    ``,
    statusLine,
    ``,
    `<b>── REGISTRATIONS ──────────────────</b>`,
    `  Unique members:  ${now.globalMembers}${newRegs !== null ? delta(now.globalMembers, prev.globalMembers) : ' (first run)'}`,
    `  New (24h est):   ${newRegs === null ? 'first run' : newRegs}`,
    `  Seats filled:    ${totalJoinedNow} (across all tiers — counts upgrades separately)`,
    `  Members enrolled (CW): ${Number(cwEnrolled)}/1000  (G:${Number(cwGenesis)} / P:${Number(cwPioneer)})`,
    ``,
    `<b>── TIER MATRIX SNAPSHOT ────────────</b>`,
    `<pre>Tier Fee       A:occ/127(cyc)   B:occ/127(cyc)\n${tierRows.join('\n')}</pre>`,
    ``,
    `<b>── TREASURY & RESERVES ─────────────</b>`,
    `  Treasury USDC:   ${fmt6(tUSDC)}${delta6(tUSDC, prev.tUSDC)}`,
    `  StabilityFund:   ${fmt6(sfBal)}${delta6(sfBal, prev.sfBal)}`,
    `  BuybackReserve:  ${fmt6(bbUSDC)}`,
    ``,
    `<b>── COMMUNITY WALLET ────────────────</b>`,
    `  USDC balance:    ${fmt6(cwUSDC)}`,
    `  Available pool:  ${fmt6(cwPool)}`,
    `  Lifetime claims: ${fmt6(cwLifetime)}`,
    `  Dist ready:      ${cwDistReady ? '✅ YES — call distribute()' : 'No'}`,
    ``,
    `<b>── CNOVA TOKEN ─────────────────────</b>`,
    `  Total supply:    ${fmtE(totalSupply)} CNOVA`,
    `  Total burned:    ${fmtE(totalBurned)} CNOVA`,
    `  Current epoch:   ${Number(epoch)} (${['Genesis','Pioneer','Expansion','Momentum','Apex','Legacy','Endgame','Infinity'][Number(epoch)] || '?'})`,
    `  Reward/entry:    ${fmtE(epochReward)} CNOVA`,
    `  Floor price:     $${floorPriceUSD.toFixed(4)} USDC/CNOVA`,
    ``,
    `<b>── SYSTEM ──────────────────────────</b>`,
    `  Total cycles:    ${now.systemCycles}${delta(now.systemCycles, prev.systemCycles)}`,
    `  Paused:          ${paused ? '🔴 YES' : '🟢 No'}`,
  ];

  if (alerts.length > 0) {
    report.push('');
    report.push('<b>── ALERTS ──────────────────────────</b>');
    alerts.forEach(a => report.push(`  ${a}`));
  } else {
    report.push('  ✅ No alerts — everything looks normal');
  }

  const msg = report.join('\n');
  saveState(now);
  await sendTelegram(msg);

  // ── Community channel digest (public-friendly) ───────────────────────
  const t1 = tierData[0];
  const t1Progress = `${Number(t1.aOcc)}/127 MatA · ${Number(t1.bOcc)}/127 MatB`;
  const sfHealthIcon = sfBal >= 50_000_000n ? '✅' : sfBal >= 10_000_000n ? '⚠️' : '🚨';
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const newRegStr = newRegs === null ? '—' : newRegs > 0 ? `+${newRegs} today` : 'no new today';

  const communityMsg = [
    `📊 <b>CryptoNova Daily Update — ${dateStr}</b>`,
    ``,
    statusLine,
    ``,
    `👥 <b>Members:</b> ${now.globalMembers.toLocaleString()} total (${newRegStr})`,
    `🔄 <b>Matrix Cycles:</b> ${now.systemCycles.toLocaleString()} completed`,
    `⚡ <b>T1 Progress:</b> ${t1Progress}`,
    ``,
    `${sfHealthIcon} <b>Stability Fund:</b> ${fmt6(sfBal)}`,
    `🪙 <b>CNOVA Floor:</b> $${floorPriceUSD.toFixed(4)} / token`,
    `💎 <b>Epoch:</b> ${['Genesis','Pioneer','Expansion','Momentum','Apex','Legacy','Endgame','Infinity'][Number(epoch)] || `#${epoch}`} — ${fmtE(epochReward)} CNOVA per entry`,
    ``,
    alerts.length > 0
      ? `⚠️ <b>Active alerts:</b> ${alerts.length} — check admin channel`
      : `✅ All systems running normally`,
    ``,
    `🔗 <a href="https://crypto-nova.app">crypto-nova.app</a>`,
  ].join('\n');

  await sendChannel(communityMsg);
}

async function mainWithRetry() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await main();
      return;
    } catch (e) {
      if (attempt < 2 && e?.info?.error?.code === -32016) {
        const wait = (attempt + 1) * 5000;
        console.log(`⏳ Rate limit hit, retrying in ${wait/1000}s... (attempt ${attempt+1}/3)`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

mainWithRetry().catch(console.error);
