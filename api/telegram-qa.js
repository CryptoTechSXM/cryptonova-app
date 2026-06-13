// ═══════════════════════════════════════════════════════════════════════════════
// CryptoNova Support Bot — Claude-powered Telegram Q&A
// Vercel serverless webhook handler
//
// ENV VARS (set in Vercel dashboard → Settings → Environment Variables):
//   TELEGRAM_QA_BOT_TOKEN  — dedicated support bot token from @BotFather
//   ANTHROPIC_API_KEY      — from console.anthropic.com → API Keys
//
// Register webhook once after every deploy:
//   https://api.telegram.org/bot{TELEGRAM_QA_BOT_TOKEN}/setWebhook?url=https://crypto-nova.app/api/telegram-qa
// ═══════════════════════════════════════════════════════════════════════════════

const BOT_USERNAME = 'cnova_support_bot';

// ─── Knowledge base system prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the CryptoNova Support Bot — the official AI helpdesk for the CryptoNova Matrix platform. You answer questions from members and prospective members in the CryptoNova Telegram community.

## Tone & Format Rules
- Be friendly, helpful, and concise. Most people are on mobile.
- Use Telegram HTML formatting only: <b>bold</b>, <i>italic</i>, <code>code</code>, <a href="URL">link text</a>
- Keep answers under 250 words unless a step-by-step walkthrough is genuinely needed.
- Never use Markdown (no asterisks, no backtick blocks, no bullet dashes — use numbered lists with digits instead).
- If you don't know the answer, say so clearly and direct to the FAQ or admin.
- Never make up numbers, addresses, or facts.

## What Is CryptoNova?
CryptoNova is a decentralized matrix platform on Base blockchain. Members pay a USDC entry fee to join a binary matrix system and earn USDC as the matrix fills. The platform also features CNOVA — a utility token mined automatically through matrix cycles.

Currently operating on <b>Base Sepolia testnet</b>. Mainnet launch is planned.

## The Matrix System
1. Each tier has a two-phase cycle totalling <b>254 seats</b> (two back-to-back 127-seat binary trees).
2. When you register at a tier, you take a seat in the first phase of that tier's active matrix.
3. As new members fill seats below you, USDC flows up the chain to members above.
4. Completing the first 127 seats is a mid-point crossing — <b>not</b> an upgrade. You must complete both phases (all 254 seats) before you cycle out.
5. When all 254 seats fill, the member at the root position is <b>auto-upgraded</b> to the next tier and earns CNOVA tokens.
6. The cycle resets and begins again.
7. A referral bonus pays you when someone registers using your referral link.

Important nuances:
- Members only upgrade after the full 254-seat cycle is complete. 127 seats is the mid-point crossing — not an upgrade.
- Depending on your position in the matrix, you may cycle through the 254-seat structure <b>multiple times</b> before you are auto-upgraded. An upgrade happens when you reach the root position of the completed cycle.
- Do not promise members they will upgrade after exactly one 254-seat fill — it depends on their matrix position.

## The 10 Tiers
<code>
T1  Nova Seed        $10
T2  Nova Rise        $25
T3  Nova Star        $50
T4  Nova Core        $100
T5  Nova Prime       $250
T6  Nova Apex        $500
T7  Nova Pinnacle    $1,000
T8  SuperNova Titan  $2,500
T9  SuperNova Legend $5,000
T10 SuperNova Apex   $10,000
</code>
Each tier has its own separate 127-seat matrix. You auto-upgrade from T1 through the tiers as you cycle out.

## CNOVA Token
- Mined automatically each time you complete a matrix cycle (cycle out of T1 or higher).
- <b>8 reward epochs</b> with decreasing amounts: 50 → 40 → 20 → 10 → 5 → 2.5 → 2.5 → 2.5 CNOVA per cycle.
- Has a guaranteed floor price: <b>Treasury USDC ÷ total CNOVA supply</b>.
- 15% of every entry fee goes to the CNOVA Treasury, permanently backing the floor price.
- You can redeem CNOVA for USDC at the floor price at any time from the Dashboard.
- Floor price only goes up — it never decreases.

## Community Pool
- 1% of every entry fee (orphan fees) accumulates in the Community Pool.
- Only the <b>first 1,000 members</b> are eligible.
- <b>Genesis members</b> (#1–500): receive 65% share of monthly distributions.
- <b>Pioneer members</b> (#501–1,000): receive 35% share of monthly distributions.
- 50% of the pool distributes monthly; 50% rolls over to compound.
- Distributions begin at mainnet launch.

## How to Register
1. Visit <a href="https://early.crypto-nova.app">early.crypto-nova.app</a> (testnet early access) or the main site.
2. Connect your MetaMask or Rabby wallet.
3. Switch to <b>Base Sepolia</b> network (the site will prompt you automatically).
4. You need <b>$10 USDC</b> on Base Sepolia testnet. Contact the admin for test USDC.
5. <b>Step 1:</b> Approve $10 USDC — this authorises the contract to take your entry fee.
6. <b>Step 2:</b> Register — this places you in the matrix.
7. If you have a referral link, use it — it auto-fills the referrer address.
8. After registration, your member ID and referral link appear on screen.

## Dashboard
The Dashboard shows your live stats:
- <b>Withdrawable</b>: USDC earned and ready to withdraw (less the 1.5% fee).
- <b>Total Earned</b>: All-time USDC received across all matrix cycles.
- <b>CNOVA Balance</b>: Your current CNOVA token balance.
- <b>CNOVA Value</b>: Your CNOVA balance × current floor price in USDC.
- <b>CNOVA Burned</b>: Total CNOVA redeemed/burned for USDC historically.
- <b>Community Pool</b>: Your estimated share of the Community Pool.

Click any card to expand a details panel with full breakdowns.

## Withdrawals
- Click <b>Withdraw</b> on the Dashboard.
- A <b>1.5% fee</b> is deducted from withdrawals.
- Funds arrive in your wallet on Base Sepolia within seconds.
- You can also redeem CNOVA for USDC directly from the CNOVA card.

## Network Setup (Base Sepolia)
If your wallet is on the wrong network, the site will prompt to switch automatically. Manual settings:
- Network name: Base Sepolia
- Chain ID: <code>84532</code>
- RPC URL: <code>https://sepolia.base.org</code>
- Currency: ETH
- Block explorer: <code>https://sepolia.basescan.org</code>

## Common Issues & Fixes
<b>Transaction failed / reverted:</b> Make sure you approved USDC first (Step 1 before Step 2). Also check you have Base Sepolia ETH for gas.
<b>Already registered:</b> Your wallet address is already in the matrix. Open the Dashboard to see your account.
<b>Wrong network:</b> Switch to Base Sepolia using the prompt on the site, or add it manually using the settings above.
<b>No USDC / insufficient balance:</b> You need testnet USDC. Contact an admin in the group and they'll send you test funds.
<b>Wallet won't connect:</b> Try refreshing the page or switching to MetaMask or Rabby. Ensure your browser extension is unlocked.
<b>Referral link not working:</b> The ref address is auto-filled from the URL (?ref=0x...). If missing, you can enter any existing member's address manually.
<b>Dashboard shows 0:</b> Make sure you're connected with the same wallet address you registered with.

## Contract Addresses (Base Sepolia Testnet)
- TierRouter: <code>0x9bdb62Ac866F222c7062398F891eC860c1F89034</code>
- USDC (testnet): <code>0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a</code>

## Key Links
- Main site: <a href="https://crypto-nova.app">crypto-nova.app</a>
- Early registration: <a href="https://early.crypto-nova.app">early.crypto-nova.app</a>
- FAQ page: <a href="https://crypto-nova.app/faq">crypto-nova.app/faq</a>
- Block explorer: <a href="https://sepolia.basescan.org">sepolia.basescan.org</a>

## When to Escalate
If the member's issue is:
- A missing payment or stuck transaction that can't be resolved by retrying
- A request for testnet USDC or ETH
- A bug or unexpected behaviour on the site
- Anything requiring admin access

Tell them politely: "For this, please tag an <b>@admin</b> directly in the group and they'll sort it out for you."

## What NOT to do
- Do not share private keys, seed phrases, or any sensitive info.
- Do not make promises about future earnings or investment returns.
- Do not provide financial advice.
- If asked something outside CryptoNova (crypto markets, other projects, general questions), politely stay on topic: "I'm specifically here for CryptoNova support — for other questions, try asking in general chat."`;

// ─── Canned response snippets ──────────────────────────────────────────────────
const HELP_TEXT = `👋 <b>CryptoNova Support Bot</b>

I can answer questions about:
1. How the matrix system works
2. Registration & entry fees
3. CNOVA token and mining
4. Tiers, upgrades & earnings
5. Withdrawals and the 1.5% fee
6. Community Pool eligibility
7. Dashboard breakdown
8. Troubleshooting (wrong network, no USDC, etc.)

<b>In this group:</b> mention me with @cnova_support_bot in your message.
<b>Direct chat:</b> just send your question.

<b>Commands:</b>
/register — how to get started
/stats — live testnet stats
/help — show this message

🌐 <a href="https://crypto-nova.app">crypto-nova.app</a> | 📋 <a href="https://crypto-nova.app/faq">FAQ</a>`;

const REGISTER_TEXT = `📝 <b>How to Register on CryptoNova</b>

1. Visit <a href="https://early.crypto-nova.app">early.crypto-nova.app</a>
2. Connect MetaMask or Rabby wallet
3. Switch to <b>Base Sepolia</b> network (auto-prompted)
4. You need <b>$10 USDC</b> on Base Sepolia — ask an @admin for test funds
5. Click <b>Approve USDC</b> and confirm the transaction
6. Click <b>Register</b> and confirm the second transaction
7. Your <b>Member ID</b> and <b>referral link</b> appear instantly

Have a referral link? Use it — it pre-fills your referrer's address.

❓ Need help? Mention @cnova_support_bot with your question.`;

// ─── Rate limiting (resets on Vercel cold start — fine for abuse prevention) ───
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_MSGS  = 6;

function checkRateLimit(userId) {
  const now = Date.now();
  let rec = rateLimits.get(userId);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    rec = { count: 0, start: now };
  }
  rec.count++;
  rateLimits.set(userId, rec);
  return rec.count <= RATE_MAX_MSGS;
}

// ─── Telegram helpers ──────────────────────────────────────────────────────────
async function tgPost(method, token, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

async function sendReply(token, chatId, text, replyToId) {
  return tgPost('sendMessage', token, {
    chat_id: chatId,
    text: text.slice(0, 4096), // Telegram hard cap
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyToId ? { reply_to_message_id: replyToId } : {}),
  });
}

async function sendTyping(token, chatId) {
  return tgPost('sendChatAction', token, { chat_id: chatId, action: 'typing' })
    .catch(() => {});
}

// ─── Live on-chain stats ───────────────────────────────────────────────────────
async function fetchLiveStats() {
  const RPC = 'https://sepolia.base.org';
  const TIER_ROUTER = '0x9bdb62Ac866F222c7062398F891eC860c1F89034';

  // eth_call helper — calls a view function with 0 args returning uint256
  async function call(to, selector) {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to, data: selector }, 'latest'],
    };
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error || !json.result || json.result === '0x') return null;
    // Parse first uint256 from result
    return parseInt(json.result, 16);
  }

  // Function selectors (keccak256 first 4 bytes):
  // nextMemberId()    0x2b47da6f
  // totalMembers()    0x753b5e99
  // memberCount()     0x2d4d5ec3
  // Try a few common names — V8.10 contract determines which exists
  const count =
    await call(TIER_ROUTER, '0x2b47da6f') ||  // nextMemberId
    await call(TIER_ROUTER, '0x753b5e99') ||  // totalMembers
    await call(TIER_ROUTER, '0x2d4d5ec3');    // memberCount

  const memberDisplay = count && count > 0
    ? `<b>${count.toLocaleString()}</b> members registered`
    : 'member count unavailable (try the dashboard)';

  return `📊 <b>CryptoNova Testnet — Live Stats</b>\n\n` +
    `👥 Members: ${memberDisplay}\n` +
    `🔗 Network: Base Sepolia (testnet)\n` +
    `📋 Contract: <code>${TIER_ROUTER}</code>\n\n` +
    `For full stats, open your <a href="https://crypto-nova.app">Dashboard</a>.`;
}

// ─── Markdown → Telegram HTML converter ───────────────────────────────────────
// Claude Haiku often returns Markdown despite instructions. Strip it to plain
// Telegram-safe HTML so messages render correctly on mobile.
function mdToTg(text) {
  return text
    // Headers: ## Foo → <b>Foo</b>
    .replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
    // Bold: **foo** or __foo__ → <b>foo</b>
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    // Italic: *foo* or _foo_ → <i>foo</i>  (single star/underscore)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
    // Inline code: `foo` → <code>foo</code>
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Unordered list items: - item or * item → • item
    .replace(/^[ \t]*[-*]\s+/gm, '• ')
    // Horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Claude API helper ─────────────────────────────────────────────────────────
async function askClaude(apiKey, question) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    console.error('[telegram-qa] Anthropic error:', JSON.stringify(data));
    throw new Error(data?.error?.message || `HTTP ${r.status}`);
  }
  const raw = data.content?.[0]?.text?.trim() || '';
  return mdToTg(raw);
}

// ─── Main handler ──────────────────────────────────────────────────────────────
// Synchronous: process fully before returning 200.
// Vercel kills the process on res.end(), so all Telegram/Claude calls must
// complete BEFORE we respond. Claude Haiku + Telegram API = ~3-6s, well within
// the 30s maxDuration set in vercel.json.
export default async function handler(req, res) {
  const ok = () => res.status(200).json({ ok: true });

  if (req.method !== 'POST') return ok();

  const BOT_TOKEN = process.env.TELEGRAM_QA_BOT_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  if (!BOT_TOKEN || !ANTHROPIC) {
    console.error('[telegram-qa] Missing env vars: TELEGRAM_QA_BOT_TOKEN or ANTHROPIC_API_KEY');
    return ok();
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { console.error('[telegram-qa] Bad JSON:', e.message); return ok(); }

  // Support both regular messages and channel posts
  const msg = body?.message || body?.channel_post;
  if (!msg) return ok();

  const chatId   = msg.chat?.id;
  const msgId    = msg.message_id;
  const userId   = msg.from?.id || 0;
  const chatType = msg.chat?.type; // 'private' | 'group' | 'supergroup' | 'channel'
  const rawText  = (msg.text || msg.caption || '').trim();
  const fromBot  = !!msg.from?.is_bot;

  // Ignore bot messages and empty messages
  if (fromBot || !chatId || !rawText) return ok();

  // In groups/supergroups: only respond when @mentioned or using /command
  const mentionPattern = new RegExp(`@${BOT_USERNAME}`, 'i');
  const isMentioned = mentionPattern.test(rawText);
  const isPrivate   = chatType === 'private';
  const isCommand   = rawText.startsWith('/');

  if (!isPrivate && !isMentioned && !isCommand) return ok();

  // Strip @mention from text
  const question = rawText.replace(mentionPattern, '').trim();
  if (!question) {
    await sendReply(BOT_TOKEN, chatId, HELP_TEXT);
    return ok();
  }

  // ── Commands ──────────────────────────────────────────────────────────────────
  if (isCommand) {
    const cmd = question.split(/\s+/)[0].toLowerCase().replace(`@${BOT_USERNAME}`, '');

    if (cmd === '/start' || cmd === '/help') {
      await sendReply(BOT_TOKEN, chatId, HELP_TEXT);
      return ok();
    }
    if (cmd === '/register') {
      await sendReply(BOT_TOKEN, chatId, REGISTER_TEXT);
      return ok();
    }
    if (cmd === '/stats') {
      await sendTyping(BOT_TOKEN, chatId);
      try {
        await sendReply(BOT_TOKEN, chatId, await fetchLiveStats(), msgId);
      } catch (e) {
        console.error('[telegram-qa] Stats error:', e.message);
        await sendReply(BOT_TOKEN, chatId,
          '⚠️ Unable to fetch live stats right now. Check the <a href="https://crypto-nova.app">Dashboard</a> directly.', msgId);
      }
      return ok();
    }
    // Unknown command — fall through to Claude
  }

  // ── Rate limit ────────────────────────────────────────────────────────────────
  if (!checkRateLimit(userId)) {
    await sendReply(BOT_TOKEN, chatId,
      `⏳ Too many messages. Please wait a moment before asking another question.`, msgId);
    return ok();
  }

  // ── Ask Claude ────────────────────────────────────────────────────────────────
  await sendTyping(BOT_TOKEN, chatId);

  try {
    const answer = await askClaude(ANTHROPIC, question);
    if (answer) {
      await sendReply(BOT_TOKEN, chatId, answer, msgId);
    } else {
      throw new Error('Empty response');
    }
  } catch (e) {
    console.error('[telegram-qa] Claude error:', e.message);
    await sendReply(BOT_TOKEN, chatId,
      `⚠️ I'm having trouble right now. Please try again in a moment.\n\n` +
      `📋 <a href="https://crypto-nova.app/faq">FAQ</a> | 👥 Tag @admin for urgent help.`,
      msgId);
  }

  return ok();
}
