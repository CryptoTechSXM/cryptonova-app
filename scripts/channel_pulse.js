// ═══════════════════════════════════════════════════════════════════════
// CryptoNova — Community Channel Pulse
//
// Sends a short health snapshot to the announcement channel every 6 hours.
// Keeps the community informed without flooding — just the key numbers.
//
// Usage:
//   node scripts/channel_pulse.js
//
// ENV vars (.env):
//   TELEGRAM_BOT_TOKEN           — same bot used by monitor_v8.js
//   TELEGRAM_ANNOUNCE_CHANNEL_ID — your announcement channel ID (e.g. -1001234567890)
//   BASE_SEPOLIA_RPC_URL         — RPC endpoint
//   ADDRESSES_FILE               — e.g. deployed_addresses_v8_33.json
//
// Schedule (Windows Task Scheduler):
//   Every 6 hours — 08:00, 14:00, 20:00, 02:00 UTC
//   Skip the 08:00 run on days monitor_v8.js is scheduled (daily report covers it)
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { ethers } = require('ethers');
const https      = require('https');
const path       = require('path');
const fs         = require('fs');

const RPC_URL   = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const ADDR_FILE = path.join(__dirname, process.env.ADDRESSES_FILE || 'deployed_addresses_v8_34.json');

if (!fs.existsSync(ADDR_FILE)) {
  console.error(`❌  ${ADDR_FILE} not found.`);
  process.exit(1);
}
const _raw = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));
const TIER_FEES = ['$10','$25','$50','$100','$250','$500','$1,000','$2,500','$5,000','$10,000'];
const ADDRS = {
  usdc:          _raw.usdc,
  cnova:         _raw.cnova,
  treasury:      _raw.treasury,
  stabilityFund: _raw.stabilityFund,
  tierRouter:    _raw.tierRouter,
  tiers: Object.keys(_raw.tiers || {})
    .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')))
    .map(k => {
      const n = parseInt(k.replace(/\D/g,''));
      return { num: n, fee: TIER_FEES[n-1] || `$?`, ..._raw.tiers[k] };
    }),
};

const fmt6 = n => '$' + (Number(n) / 1e6).toFixed(2);

async function tgSend(msg) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const channel = process.env.TELEGRAM_ANNOUNCE_CHANNEL_ID;
  if (!token || !channel) {
    console.log('TELEGRAM_ANNOUNCE_CHANNEL_ID not set — console only:');
    console.log(msg.replace(/<[^>]+>/g, ''));
    return;
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: channel,
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
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const r = JSON.parse(data);
        if (!r.ok) console.error('Telegram error:', r.description);
        else console.log('✅ Pulse sent to channel');
        resolve(r);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC_URL);

  const MATRIX_ABI = [
    'function occupancy() external view returns (uint256)',
    'function totalJoined() external view returns (uint256)',
  ];
  const SF_ABI    = ['function totalBalance() external view returns (uint256)'];
  const USDC_ABI  = ['function balanceOf(address) external view returns (uint256)'];
  const CNOVA_ABI = [
    'function totalSupply() external view returns (uint256)',
    'function currentEpoch() external view returns (uint8)',
  ];
  const TR_ABI    = [
    'function systemPaused() external view returns (bool)',
    'function totalSystemCycles() external view returns (uint256)',
    'function globalJoinedCount() external view returns (uint256)',
  ];

  const sfC    = new ethers.Contract(ADDRS.stabilityFund, SF_ABI, rp);
  const usdcC  = new ethers.Contract(ADDRS.usdc, USDC_ABI, rp);
  const cnovaC = new ethers.Contract(ADDRS.cnova, CNOVA_ABI, rp);
  const trC    = new ethers.Contract(ADDRS.tierRouter, TR_ABI, rp);

  const [sfBal, tUSDC, supply, epoch, paused, cycles, globalCount] = await Promise.all([
    sfC.totalBalance(),
    usdcC.balanceOf(ADDRS.treasury),
    cnovaC.totalSupply(),
    cnovaC.currentEpoch(),
    trC.systemPaused(),
    trC.totalSystemCycles(),
    trC.globalJoinedCount(),  // unique wallets ever registered — matches website stat
  ]);

  const totalMembers = Number(globalCount);

  // Query all tiers sequentially to avoid rate limits
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tierRows = [];
  for (const t of ADDRS.tiers) {
    const matA = new ethers.Contract(t.matA, MATRIX_ABI, rp);
    const matB = new ethers.Contract(t.matB, MATRIX_ABI, rp);
    const [aOcc, bOcc] = await Promise.all([
      matA.occupancy(),
      matB.occupancy(),
    ]);
    // Only include tiers with at least 1 member
    if (Number(aOcc) > 0 || Number(bOcc) > 0) {
      tierRows.push({ num: t.num, fee: t.fee, aOcc: Number(aOcc), bOcc: Number(bOcc) });
    }
    await sleep(150);
  }

  const floorPrice = supply > 0n
    ? (Number(tUSDC) / 1e6) / (Number(supply) / 1e18)
    : 0;

  const sfHealthIcon = sfBal >= 50_000_000n ? '✅' : sfBal >= 10_000_000n ? '⚠️' : '🚨';
  const statusIcon   = paused ? '🔴' : '🟢';
  const statusText   = paused ? 'System paused' : 'Active';
  const timeStr      = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC';
  const epochName    = ['Genesis','Pioneer','Expansion','Momentum','Apex','Legacy','Endgame','Infinity'][Number(epoch)] || `#${epoch}`;

  const tierLines = tierRows.map(t =>
    `  T${t.num} ${t.fee.padEnd(7)} ${t.aOcc}/127 MatA · ${t.bOcc}/127 MatB`
  ).join('\n');

  const msg = [
    `⚡ <b>CryptoNova Pulse — ${timeStr}</b>`,
    ``,
    `${statusIcon} <b>Status:</b> ${statusText}`,
    `👥 <b>Members:</b> ${totalMembers.toLocaleString()}`,
    `🔄 <b>Cycles:</b> ${Number(cycles).toLocaleString()} completed`,
    ``,
    `<b>Matrix Progress:</b>`,
    `<pre>${tierLines}</pre>`,
    `${sfHealthIcon} <b>Stability Fund:</b> ${fmt6(sfBal)}`,
    `🪙 <b>CNOVA Floor:</b> $${floorPrice.toFixed(4)} · Epoch: ${epochName}`,
    ``,
    `🔗 <a href="https://crypto-nova.app">crypto-nova.app</a>`,
  ].join('\n');

  await tgSend(msg);
}

main().catch(e => { console.error('channel_pulse error:', e.message); process.exit(1); });
