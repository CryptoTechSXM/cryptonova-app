// ═══════════════════════════════════════════════════════════════════════
// CryptoNova V8 — Error Reporter
// Vercel serverless function: receives frontend errors, aggregates by day,
// forwards to Telegram admin channel.
//
// ENV VARS required in Vercel dashboard:
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   TELEGRAM_CHAT_ID     — your private admin group/channel chat ID
// ═══════════════════════════════════════════════════════════════════════

// In-process counter (resets on cold start — approx per deployment)
// For persistent counts we rely on the Telegram message history
const sessionCounts = {};

export default async function handler(req, res) {
  // CORS — allow requests from our own domains only
  const origin = req.headers.origin || '';
  const allowed = [
    'https://crypto-nova.app',
    'https://v8.crypto-nova.app',
    'https://v6.crypto-nova.app',
    // Vercel preview URLs
    'vercel.app',
  ];
  const isAllowed = allowed.some(o => origin.includes(o)) || origin === '';
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : 'https://crypto-nova.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    // Silently accept but don't crash — lets frontend work even if env not set yet
    console.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return res.status(200).json({ ok: true, note: 'env not configured' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const {
    type    = 'UNKNOWN',      // e.g. WALLET_UNSUPPORTED, TX_FAILED, WRONG_NETWORK
    wallet  = 'unknown',      // MetaMask / Rabby / Coinbase Wallet / etc.
    error   = '',             // the error message
    action  = '',             // what the user was trying to do
    device  = 'unknown',      // mobile / desktop
    network = '',             // chainId the user was on
    url     = '',             // page URL (pathname only)
    addr    = '',             // wallet address (short — privacy)
  } = body;

  // Build a session key for counting
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const countKey = `${today}:${type}:${wallet}`;
  sessionCounts[countKey] = (sessionCounts[countKey] || 0) + 1;
  const count = sessionCounts[countKey];

  // Emoji by severity
  const icon = type.includes('CRITICAL') ? '🚨'
    : type.includes('TX_FAILED')         ? '❌'
    : type.includes('WRONG_NETWORK')     ? '🔴'
    : type.includes('WALLET_UNSUPPORTED')? '🟡'
    : type.includes('WALLET_ERROR')      ? '🟠'
    : 'ℹ️';

  // Only ping Telegram on first occurrence per session, then every 5
  // This prevents spam while still tracking
  const shouldAlert = count === 1 || count % 5 === 0;

  const msg = [
    `${icon} <b>CryptoNova V8 — ${type}</b>`,
    `📅 ${new Date().toUTCString()}`,
    ``,
    `👛 Wallet:   ${wallet}`,
    `📱 Device:   ${device}`,
    action  ? `🎯 Action:   ${action}`  : null,
    error   ? `⚠️ Error:    <code>${escHtml(error.slice(0, 200))}</code>` : null,
    network ? `🔗 Network:  chainId ${network}` : null,
    addr    ? `🆔 Address:  ${addr}` : null,
    url     ? `🌐 Page:     ${url}` : null,
    ``,
    `📊 Session count for this error: <b>${count}</b>`,
    count >= 10 ? `\n⚡ <b>HIGH FREQUENCY — review and fix on next push</b>` : null,
  ].filter(Boolean).join('\n');

  if (shouldAlert) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (e) {
      console.error('Telegram send failed:', e.message);
    }
  }

  return res.status(200).json({ ok: true, count });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
