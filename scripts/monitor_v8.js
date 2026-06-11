// ═══════════════════════════════════════════════════════════════════════
// CryptoNova V8.9 — Daily Chain Health Monitor
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
const RPC_URL = 'https://sepolia.base.org';

// ── Matrix size ──────────────────────────────────────────────────────
const MATRIX_SIZE = 127;

// ── Contract addresses (V8.9 — deployed_addresses_v8_9.json) ────────
const ADDRS = {
  usdc:           '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a',
  cnova:          '0xeAAA7d8CAA315d17321524790E52D55971b03777',
  treasury:       '0x5Be91D0C6493F923220C18cb4f6779F6e79f3ECE',
  stabilityFund:  '0x1f375CEcB492Ba544437683DFC2A6B1AC700150C',
  buybackReserve: '0x4BcB5A7E209269A145aC823e4539166B8E445c9f',
  tierRouter:     '0x44aD72D63d501F5d2893F1A15Df8DDfB174E56d7',
  matrixKeeper:   '0x95a69F7d1735174F314b32f97c32b7e8E515C002',
  communityWallet:'0xbF0C84Cc30D38Ced2F16aC729472Fc8808369D50',

  tiers: [
    { num:1,  fee:'$10',    pm:'0x31Fe8e59459CebAf967edbF86CFfd4598632b666', matA:'0x6f42Cf432D82cB0ce33B572b73F31b9e58ae978e', matB:'0xE7557506b2a766DbeF5BA3841baC865E36C0991E' },
    { num:2,  fee:'$25',    pm:'0xdA60fdB045c9E156ce71140b0BF51Ac8ff55aDd8', matA:'0x5B70F232D73bc4fE1e29E469DBDF168c3289B47d', matB:'0x0E984030b43d9FB71044f31142215101A60036c7' },
    { num:3,  fee:'$50',    pm:'0xb2c744dc4089D050a56A9D1c49Be37084da65E59', matA:'0xcb52F16926699cbd2287D518D4EfDfFC5f2E7cEd', matB:'0xCFb8C3EeE6d71a1F39b1Ae103892EC215FA47c60' },
    { num:4,  fee:'$100',   pm:'0xdE30066F79822ab8997fd46d21E72e20985AC4Dc', matA:'0xe2A119443bAe10286DFacB75248E0b9Dc998C380', matB:'0x98601fE894e9341Ed5d7488Fc852b349DcFc2353' },
    { num:5,  fee:'$250',   pm:'0x54d5A9c82F1Aa94f89712FC66B22b9c79abbB075', matA:'0xD0D79874F31962e8467E1a70183DB1Cb1079975c', matB:'0xE56Fe0794fC42ab2A1167aAFED39c0b87fA1EB2b' },
    { num:6,  fee:'$500',   pm:'0x5cEe72a04bfFFDC62841C5c39B81d619001066eF', matA:'0xBeaF7909256F6Ec17b4C48Df2FD2fAd6683B4957', matB:'0x65E0B1a07975013c4569393b375e26a60728fD83' },
    { num:7,  fee:'$1k',    pm:'0x1b46FbF4ebd4A22eA2713E41ad31fce8d3C1243B', matA:'0xB6F1844f86182857345B3EA701982E3715c2Af7e', matB:'0xe75FEeA8fC07F1818c8cd9f67C8712F65010b50e' },
    { num:8,  fee:'$2.5k',  pm:'0xEf80e42b5a6025382fB98d414Db3839A28a95F9c', matA:'0x7569AC9FDcf487dDFCBfAD5B5c2b97459D8733Da', matB:'0x84153189FB98503610Ca06F06e31B105aEE7D4c4' },
    { num:9,  fee:'$5k',    pm:'0xf057FFB28854e5a8eC55DC83627878ad9451f05b', matA:'0xC9432946183b545a0e9ca9eCCAE5f1A10181F217', matB:'0x5116a6806B640995887BB39829D4683E4F640C58' },
    { num:10, fee:'$10k',   pm:'0x0253951c84D8abE110016d034730695d5511986E', matA:'0xfDA591EFf27806Cf9f88aB24b02d5c7Dc1716169', matB:'0x40FF01246324F0d3337469f3e4462BE14F6477aA' },
  ],
};

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

// ── ABIs (minimal) ───────────────────────────────────────────────────
const MATRIX_ABI = [
  'function occupancy() external view returns (uint256)',
  'function rotationCount() external view returns (uint256)',
  'function poolAccumulator() external view returns (uint256)',
  'function totalJoined() external view returns (uint256)',
];
const CNOVA_ABI = [
  'function totalSupply() external view returns (uint256)',
  'function currentEpoch() external view returns (uint8)',
  'function epochRewards(uint8) external view returns (uint256)',
];
const SF_ABI   = ['function totalBalance() external view returns (uint256)'];
const USDC_ABI = ['function balanceOf(address) external view returns (uint256)'];
const TR_ABI   = [
  'function systemPaused() external view returns (bool)',
  'function totalSystemCycles() external view returns (uint256)',
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
  const prev   = loadState();
  const now    = {};
  const alerts = [];
  const today  = new Date().toUTCString();

  const rp = new ethers.JsonRpcProvider(RPC_URL);

  console.log('CryptoNova V8.8 — Daily Monitor');
  console.log('Time:', today);
  console.log('RPC: ', RPC_URL);

  // ── Build tier contracts ──────────────────────────────────────────
  const tierContracts = ADDRS.tiers.map(t => ({
    num:  t.num,
    fee:  t.fee,
    matA: new ethers.Contract(t.matA, MATRIX_ABI, rp),
    matB: new ethers.Contract(t.matB, MATRIX_ABI, rp),
  }));

  // ── Read all tier data in parallel ───────────────────────────────
  const tierData = await Promise.all(tierContracts.map(async (t) => {
    const [aOcc, aCycles, aPool, aTotal, bOcc, bCycles, bPool] = await Promise.all([
      t.matA.occupancy(),
      t.matA.rotationCount(),
      t.matA.poolAccumulator(),
      t.matA.totalJoined(),
      t.matB.occupancy(),
      t.matB.rotationCount().catch(() => 0n),
      t.matB.poolAccumulator().catch(() => 0n),
    ]);
    return { num: t.num, fee: t.fee, aOcc, aCycles, aPool, aTotal, bOcc, bCycles, bPool };
  }));

  // ── Read shared infrastructure ────────────────────────────────────
  const cnovaC = new ethers.Contract(ADDRS.cnova, CNOVA_ABI, rp);
  const sfC    = new ethers.Contract(ADDRS.stabilityFund, SF_ABI, rp);
  const usdcC  = new ethers.Contract(ADDRS.usdc, USDC_ABI, rp);
  const trC    = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);
  const cwC    = new ethers.Contract(ADDRS.communityWallet, CW_ABI, rp);

  const [
    totalSupply, epoch, epochReward,
    sfBal,
    tUSDC, bbUSDC, cwUSDC,
    paused, systemCycles,
    cwEnrolled, cwGenesis, cwPioneer, cwPool, cwDistReady, cwLifetime,
  ] = await Promise.all([
    cnovaC.totalSupply(),
    cnovaC.currentEpoch(),
    cnovaC.epochRewards(0).catch(() => ethers.parseEther('50')),
    sfC.totalBalance(),
    usdcC.balanceOf(ADDRS.treasury),
    usdcC.balanceOf(ADDRS.buybackReserve),
    usdcC.balanceOf(ADDRS.communityWallet),
    trC.systemPaused(),
    trC.totalSystemCycles(),
    cwC.totalEnrolled().catch(() => 0n),
    cwC.genesisCount().catch(() => 0n),
    cwC.pioneerCount().catch(() => 0n),
    cwC.availablePool().catch(() => 0n),
    cwC.distributeReady().catch(() => false),
    cwC.totalLifetimeClaimed().catch(() => 0n),
  ]);

  // ── Save current state ─────────────────────────────────────────────
  now.sfBal        = sfBal.toString();
  now.tUSDC        = tUSDC.toString();
  now.supply       = totalSupply.toString();
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

  const newRegs = prev.totalJoined !== undefined
    ? totalJoinedNow - prev.totalJoined
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
    return `  T${td.num.toString().padEnd(2)} ${td.fee.padEnd(6)} A:${String(Number(td.aOcc)).padStart(3)}/${MATRIX_SIZE}(${td.aCycles}${aCy}) B:${String(Number(td.bOcc)).padStart(3)}/${MATRIX_SIZE}(${td.bCycles}${bCy})`;
  });

  // ── Status line ───────────────────────────────────────────────────
  const statusLine = paused
    ? '🔴 <b>SYSTEM PAUSED</b>'
    : alerts.length > 0
      ? '🟡 Healthy with warnings'
      : '🟢 All systems healthy';

  // ── Build report ──────────────────────────────────────────────────
  const report = [
    `📊 <b>CryptoNova V8.8 — Daily Report</b>`,
    `📅 ${today}`,
    ``,
    statusLine,
    ``,
    `<b>── REGISTRATIONS ──────────────────</b>`,
    `  Total all tiers: ${totalJoinedNow}${newRegs !== null ? delta(totalJoinedNow, prev.totalJoined) : ' (first run)'}`,
    `  New (24h est):   ${newRegs === null ? 'first run' : newRegs}`,
    `  Members enrolled (CW): ${Number(cwEnrolled)}/1000  (G:${Number(cwGenesis)} / P:${Number(cwPioneer)})`,
    ``,
    `<b>── TIER MATRIX SNAPSHOT ────────────</b>`,
    `  (Tier Fee  MatA:occ/127(cycles) MatB:occ/127(cycles))`,
    ...tierRows,
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
    `  Current epoch:   ${epoch}`,
    `  Reward/entry:    ${fmtE(epochReward)} CNOVA`,
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
    report.push('');
    report.push('✅ No alerts — everything looks normal');
  }

  report.push('');
  report.push(`<i>CryptoNova V8.8 · Base Sepolia · node scripts/monitor_v8.js</i>`);

  const message = report.join('\n');

  // ── Output ────────────────────────────────────────────────────────
  console.log('\n' + message.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&'));
  await sendTelegram(message);

  saveState(now);
  console.log('\n✓ State saved to', STATE_FILE);
}

main().catch(e => {
  console.error('Monitor failed:', e);
  process.exit(1);
});
