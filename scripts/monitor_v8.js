// ═══════════════════════════════════════════════════════════════════════
// CryptoNova V8 — Daily Chain Health Monitor
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

// ── Contract addresses ───────────────────────────────────────────────
const ADDRS = {
  usdc:          '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a',
  cnova:         '0x2ECB1b19f9B9c41F0F4A83844A176729Abc41a43',
  treasury:      '0xc4ae7Bdd9730b5D2636fEb488DbdE2Cf963fEf73',
  stabilityFund: '0x0a75cB6EDaB85aa911cCe8Fcb76E0Fb812F6f3bB',
  tierRouter:    '0x394FB648840E2d07324458Af64EA9480D54598a8',
  T1: {
    pm:   '0x7e6693b747F5d66e6c7859B8c452C91aA0B7D459',
    matA: '0x99dDB434232C56673fD3C81e95caBec330fc8573',
    matB: '0xEeCfA538710EC5c04cf54e39e5e68bd6308EfAe9',
  },
  T2: {
    pm:   '0x09707B188B602ea36Ed870F5C53508A212a532c4',
    matA: '0x7C18b1F374B67b3a6E97346b98D63B48580e51DB',
    matB: '0x08F081C226A6081C8B570fFe4DB2517cCDE63132',
  },
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
  if (d === 0) return ' (no change)';
  return d > 0 ? ` (+${prefix}${d})` : ` (${prefix}${d})`;
};
const delta6 = (now, prev) => {
  if (prev === undefined) return '';
  const d = (Number(now) - Number(prev)) / 1e6;
  if (d === 0) return ' (no change)';
  return d > 0 ? ` (+$${d.toFixed(2)})` : ` (-$${Math.abs(d).toFixed(2)})`;
};

// ── Thresholds for alerts ────────────────────────────────────────────
const ALERTS = {
  stabilityFundMin:  10_000_000n,   // alert if StabilityFund < $10
  poolStallHours:    12,            // alert if MatB occ unchanged for >12h
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

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const prev  = loadState();
  const now   = {};
  const alerts = [];
  const today = new Date().toUTCString();

  const rp = new ethers.JsonRpcProvider(RPC_URL);

  console.log('CryptoNova V8 — Daily Monitor');
  console.log('Time:', today);
  console.log('RPC: ', RPC_URL);

  // ── Read contracts ─────────────────────────────────────────────────
  const t1A  = new ethers.Contract(ADDRS.T1.matA, MATRIX_ABI, rp);
  const t1B  = new ethers.Contract(ADDRS.T1.matB, MATRIX_ABI, rp);
  const t2A  = new ethers.Contract(ADDRS.T2.matA, MATRIX_ABI, rp);
  const t2B  = new ethers.Contract(ADDRS.T2.matB, MATRIX_ABI, rp);
  const cnova = new ethers.Contract(ADDRS.cnova, CNOVA_ABI, rp);
  const sf    = new ethers.Contract(ADDRS.stabilityFund, SF_ABI, rp);
  const usdc  = new ethers.Contract(ADDRS.usdc, USDC_ABI, rp);
  const tr    = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);

  const [
    t1AOcc, t1ACycles, t1APool, t1ATotal,
    t1BOcc, t1BCycles, t1BPool,
    t2AOcc, t2ACycles, t2APool, t2ATotal,
    t2BOcc, t2BCycles,
    totalSupply, epoch, epochReward,
    sfBal, tUSDC, paused, systemCycles,
  ] = await Promise.all([
    t1A.occupancy(), t1A.rotationCount(), t1A.poolAccumulator(), t1A.totalJoined(),
    t1B.occupancy(), t1B.rotationCount(), t1B.poolAccumulator(),
    t2A.occupancy(), t2A.rotationCount(), t2A.poolAccumulator(), t2A.totalJoined(),
    t2B.occupancy(), t2B.rotationCount().catch(() => 0n),
    cnova.totalSupply(), cnova.currentEpoch(),
    cnova.epochRewards(0).catch(() => ethers.parseEther('50')),
    sf.totalBalance(),
    usdc.balanceOf(ADDRS.treasury),
    tr.systemPaused(),
    tr.totalSystemCycles(),
  ]);

  // ── Save current state ─────────────────────────────────────────────
  now.t1AOcc     = Number(t1AOcc);
  now.t1ACycles  = Number(t1ACycles);
  now.t1BOcc     = Number(t1BOcc);
  now.t1BCycles  = Number(t1BCycles);
  now.t2AOcc     = Number(t2AOcc);
  now.t2ACycles  = Number(t2ACycles);
  now.t2BOcc     = Number(t2BOcc);
  now.t1ATotal   = Number(t1ATotal);
  now.t2ATotal   = Number(t2ATotal);
  now.sfBal      = sfBal.toString();
  now.tUSDC      = tUSDC.toString();
  now.supply     = totalSupply.toString();
  now.systemCycles = Number(systemCycles);
  now.timestamp  = Date.now();
  now.paused     = paused;

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

  if (prev.t1BOcc !== undefined && now.t1BOcc === prev.t1BOcc && now.t1BOcc < 64 && hoursSinceLast >= ALERTS.poolStallHours) {
    alerts.push(`⚠️  T1 MatB STALLED at ${now.t1BOcc}/64 for ~${Math.round(hoursSinceLast)}h — consider running forceCross`);
  }

  if (prev.t1ATotal !== undefined) {
    const newRegs = now.t1ATotal + now.t2ATotal - (prev.t1ATotal + prev.t2ATotal);
    if (hoursSinceLast >= 20 && newRegs === 0) {
      alerts.push(`⚠️  No new registrations in ~${Math.round(hoursSinceLast)}h — check if frontend is reachable`);
    }
  }

  if (now.systemCycles > (prev.systemCycles || 0)) {
    const newCycles = now.systemCycles - (prev.systemCycles || 0);
    alerts.push(`🎉 ${newCycles} new matrix cycle${newCycles > 1 ? 's' : ''} completed since last check!`);
  }

  // ── Build report ──────────────────────────────────────────────────
  const newRegs = (prev.t1ATotal !== undefined)
    ? now.t1ATotal + now.t2ATotal - (prev.t1ATotal + (prev.t2ATotal || 0))
    : '?';

  const statusLine = paused
    ? '🔴 <b>SYSTEM PAUSED</b>'
    : alerts.length > 0
      ? '🟡 Healthy with warnings'
      : '🟢 All systems healthy';

  const report = [
    `📊 <b>CryptoNova V8 — Daily Report</b>`,
    `📅 ${today}`,
    ``,
    statusLine,
    ``,
    `<b>── REGISTRATIONS ──────────────────</b>`,
    `  Total (T1):      ${now.t1ATotal}${delta(now.t1ATotal, prev.t1ATotal, '')}`,
    `  Total (T2):      ${now.t2ATotal}${delta(now.t2ATotal, prev.t2ATotal ?? 0, '')}`,
    `  New (24h est):   ${newRegs === '?' ? 'first run' : newRegs}`,
    ``,
    `<b>── T1 MATRIX ───────────────────────</b>`,
    `  MatA:  ${now.t1AOcc}/64  cycles: ${now.t1ACycles}${delta(now.t1ACycles, prev.t1ACycles)}`,
    `  MatB:  ${now.t1BOcc}/64  cycles: ${now.t1BCycles}${delta(now.t1BCycles, prev.t1BCycles)}`,
    `  MatA pool: ${fmt6(t1APool)}  |  MatB pool: ${fmt6(t1BPool)}`,
    ``,
    `<b>── T2 MATRIX ───────────────────────</b>`,
    `  MatA:  ${now.t2AOcc}/64  cycles: ${now.t2ACycles}${delta(now.t2ACycles, prev.t2ACycles ?? 0)}`,
    `  MatB:  ${now.t2BOcc}/64  cycles: ${now.t2BCycles ?? 0}${delta(now.t2BCycles ?? 0, prev.t2BCycles ?? 0)}`,
    `  MatA pool: ${fmt6(t2APool)}`,
    ``,
    `<b>── TREASURY & RESERVES ─────────────</b>`,
    `  Treasury USDC:   ${fmt6(tUSDC)}${delta6(tUSDC, prev.tUSDC)}`,
    `  StabilityFund:   ${fmt6(sfBal)}${delta6(sfBal, prev.sfBal)}`,
    ``,
    `<b>── CNOVA TOKEN ─────────────────────</b>`,
    `  Total supply:    ${fmtE(totalSupply)} CNOVA${delta(Math.round(Number(totalSupply)/1e18), prev.supply ? Math.round(Number(prev.supply)/1e18) : undefined)}`,
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
  report.push(`<i>Run: node scripts/monitor_v8.js</i>`);

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
