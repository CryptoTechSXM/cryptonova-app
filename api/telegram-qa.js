// ═══════════════════════════════════════════════════════════════════════════════
// CryptoNova Support Bot — Claude-powered Telegram Q&A
// Vercel serverless webhook handler
//
// ENV VARS (set in Vercel dashboard → Settings → Environment Variables):
//   TELEGRAM_QA_BOT_TOKEN  — dedicated support bot token from @BotFather
//   ANTHROPIC_API_KEY      — from console.anthropic.com → API Keys
//   FAUCET_PRIVATE_KEY     — private key of the pre-funded faucet wallet
//                            (NOT the deployer key — a separate wallet loaded
//                             with testnet USDC via deployer transfer)
//   BASE_SEPOLIA_RPC       — Alchemy Base Sepolia URL (optional, falls back to
//                            public RPC if not set)
//
// Register webhook once after every deploy:
//   .\setup-webhook.ps1
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

const BOT_USERNAME  = 'cnova_support_bot';
const USDC_ADDRESS  = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const TIER_ROUTER   = '0x9bdb62Ac866F222c7062398F891eC860c1F89034';
const BASESCAN      = 'https://sepolia.basescan.org';
const FAUCET_AMOUNT = 20_000_000n; // $20 USDC (6 decimals)

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
- Mined automatically each time you complete a matrix cycle (cycle out of any tier).
- Has a guaranteed floor price: <b>Treasury USDC ÷ total CNOVA supply</b>.
- 15% of every entry fee goes to the CNOVA Treasury, permanently backing the floor price.
- You can redeem CNOVA for USDC at the floor price at any time from the Dashboard.
- Floor price only goes up — it never decreases.

## CNOVA Epochs (verified from CNOVAToken.sol)
Epochs are <b>global and platform-wide</b> — not per-member. There are <b>9 epochs</b> total. The current epoch advances when the FIRST of these three triggers fires:
- 1,000,000 CNOVA minted in the current epoch
- 10,000 new member registrations in the current epoch
- 30 days elapsed since the epoch started

Base reward per cycle (T1) by epoch:
<code>
Epoch 1 — Nebula Genesis:    50 CNOVA
Epoch 2 — Mercury Rise:      40 CNOVA
Epoch 3 — Lunar Cluster:     20 CNOVA
Epoch 4 — Aurora Zenith:     10 CNOVA
Epoch 5 — Solaris Echo:       5 CNOVA
Epoch 6 — Cosmic Core:      2.5 CNOVA
Epoch 7 — Galaxy Grid:      2.5 CNOVA
Epoch 8 — Supernova Spark:  2.5 CNOVA
Epoch 9 — Final Frontier:  ≤2.5 CNOVA (formula-based)
</code>

<b>Tier multipliers</b> — higher tiers earn MORE CNOVA per cycle:
<code>
T1=1x  T2=2x  T3=4x   T4=8x   T5=20x
T6=40x T7=80x T8=160x T9=320x T10=640x
</code>
Example: cycling out of T5 in Epoch 1 = 50 × 20 = <b>1,000 CNOVA</b>.
Example: cycling out of T10 in Epoch 1 = 50 × 640 = <b>32,000 CNOVA</b>.

Mining stops when all 9 epochs are exhausted (21 million CNOVA hard cap). It is NOT per-member — do not tell members "after your 8th cycle you stop mining." The epoch is global and everyone in the same epoch gets the same base rate regardless of how many personal cycles they have completed.

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
4. You need <b>$10 USDC</b> on Base Sepolia testnet. Use the /faucet command or ask the bot for test USDC.
5. <b>Step 1:</b> Approve $10 USDC — this authorises the contract to take your entry fee.
6. <b>Step 2:</b> Register — this places you in the matrix.
7. If you have a referral link, use it — it auto-fills the referrer address.
8. After registration, your member ID and referral link appear on screen.

## Getting Test USDC
The support bot can send you <b>$20 testnet USDC</b> automatically. Two ways:
1. Use the /faucet command: <code>/faucet 0xYourWalletAddress</code>
2. Post your wallet address in this group and mention needing USDC

Limit: $20 per wallet address per 24 hours.

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

## How the Upgrade Fee Works (verified from contract code)
When you cycle out of a tier, the TierRouter automatically deducts the next tier's entry fee from your <b>withdrawable earnings balance</b> inside the contract. Key facts:

- You do <b>not</b> pay from your external wallet — the fee is taken from earnings already inside the contract.
- The upgrade is <b>not free</b> — the cost comes out of your accumulated withdrawable balance.
- Example: cycling out of T1 → the $25 T2 entry fee is deducted from your withdrawable, then you are registered into T2 automatically.
- If your withdrawable balance is below the next tier's entry fee when you cycle out, you are <b>parked</b> — your upgrade is paused. The system's automated keeper will complete your upgrade once enough earnings accumulate.
- This means: if you withdraw most of your earnings and your balance drops below the next tier's fee, you may get parked temporarily. This is not a bug — the keeper resolves it automatically.
- Do NOT tell members the upgrade is "free." It is automatic and comes from earnings, but the cost is real.

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
<b>No USDC / insufficient balance:</b> Use /faucet command with your wallet address — the bot will send $20 testnet USDC automatically.
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
/faucet 0xYourAddress — get $20 testnet USDC instantly
/stats — live testnet stats
/help — show this message

🌐 <a href="https://crypto-nova.app">crypto-nova.app</a> | 📋 <a href="https://crypto-nova.app/faq">FAQ</a>`;

const REGISTER_TEXT = `📝 <b>How to Register on CryptoNova</b>

1. Visit <a href="https://early.crypto-nova.app">early.crypto-nova.app</a>
2. Connect MetaMask or Rabby wallet
3. Switch to <b>Base Sepolia</b> network (auto-prompted)
4. Need testnet USDC? Use: <code>/faucet 0xYourWalletAddress</code>
5. Click <b>Approve USDC</b> and confirm the transaction
6. Click <b>Register</b> and confirm the second transaction
7. Your <b>Member ID</b> and <b>referral link</b> appear instantly

Have a referral link? Use it — it pre-fills your referrer's address.

❓ Need help? Mention @cnova_support_bot with your question.`;

// ─── Rate limiting — per userId (resets on cold start) ─────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_MSGS  = 6;

function checkRateLimit(userId) {
  const now = Date.now();
  let rec = rateLimits.get(userId);
  if (!rec || now - rec.start > RATE_WINDOW_MS) rec = { count: 0, start: now };
  rec.count++;
  rateLimits.set(userId, rec);
  return rec.count <= RATE_MAX_MSGS;
}

// ─── Faucet rate limiting — per wallet address, 24h cooldown ──────────────────
const faucetCooldowns = new Map(); // walletAddress.toLowerCase() → timestamp
const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function checkFaucetCooldown(addr) {
  const key = addr.toLowerCase();
  const last = faucetCooldowns.get(key);
  if (!last) return { allowed: true };
  const remaining = FAUCET_COOLDOWN_MS - (Date.now() - last);
  if (remaining <= 0) return { allowed: true };
  return { allowed: false, hoursLeft: Math.ceil(remaining / 3_600_000) };
}

function markFaucetUsed(addr) {
  faucetCooldowns.set(addr.toLowerCase(), Date.now());
}

// ─── USDC faucet transfer ──────────────────────────────────────────────────────
async function sendFaucetUSDC(toAddress) {
  const FAUCET_KEY = process.env.FAUCET_PRIVATE_KEY;
  if (!FAUCET_KEY) {
    console.warn('[faucet] FAUCET_PRIVATE_KEY not set');
    return { ok: false, reason: 'Faucet is not configured yet — tag @admin for test USDC.' };
  }

  // Resolve RPC: prefer Alchemy (faster), fall back to public endpoint
  const rpcUrl = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(FAUCET_KEY, provider);

    const usdc = new ethers.Contract(USDC_ADDRESS, [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address account) view returns (uint256)',
    ], wallet);

    // Sanity-check faucet balance before sending
    const balance = await usdc.balanceOf(wallet.address);
    if (balance < FAUCET_AMOUNT) {
      console.warn(`[faucet] Low balance: ${balance}`);
      return { ok: false, reason: 'Faucet is low on USDC — tag @admin to refill.' };
    }

    const tx      = await usdc.transfer(toAddress, FAUCET_AMOUNT);
    const receipt = await tx.wait(1);
    console.log(`[faucet] Sent $20 USDC to ${toAddress} — tx ${receipt.hash}`);
    return { ok: true, txHash: receipt.hash };
  } catch (e) {
    console.error('[faucet] Error:', e.message);
    return { ok: false, reason: 'Transaction failed — tag @admin for help.' };
  }
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
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyToId ? { reply_to_message_id: replyToId } : {}),
  });
}

async function sendTyping(token, chatId) {
  return tgPost('sendChatAction', token, { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// ─── Live on-chain stats ───────────────────────────────────────────────────────
async function fetchLiveStats() {
  const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

  async function call(to, selector) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to, data: selector }, 'latest'],
      }),
    });
    const json = await r.json();
    if (json.error || !json.result || json.result === '0x') return null;
    return parseInt(json.result, 16);
  }

  const count =
    await call(TIER_ROUTER, '0x2b47da6f') ||
    await call(TIER_ROUTER, '0x753b5e99') ||
    await call(TIER_ROUTER, '0x2d4d5ec3');

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
function mdToTg(text) {
  return text
    .replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[ \t]*[-*]\s+/gm, '• ')
    .replace(/^[-*_]{3,}$/gm, '')
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
      max_tokens: 1024,
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

// ─── Address extractor ─────────────────────────────────────────────────────────
function extractAddress(text) {
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0] : null;
}

function faucetKeywordsPresent(text) {
  return /\bfaucet\b|need\s+usdc|send\s+usdc|test\s+usdc|test\s+funds|need\s+test|want\s+usdc|get\s+usdc/i.test(text);
}

function shortAddr(addr) {
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

// ─── Faucet handler (shared between /faucet command and natural-language) ──────
async function handleFaucetRequest(token, chatId, msgId, rawAddress) {
  // Validate it looks like a real address
  if (!rawAddress || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
    await sendReply(token, chatId,
      `⚠️ Please include a valid wallet address.\n\nExample:\n<code>/faucet 0xYourWalletAddress</code>`,
      msgId);
    return;
  }

  // Checksum the address so ethers doesn't throw
  let toAddress;
  try {
    toAddress = ethers.getAddress(rawAddress);
  } catch {
    await sendReply(token, chatId,
      `⚠️ That doesn't look like a valid Ethereum address. Double-check it and try again.`, msgId);
    return;
  }

  // Per-address rate limit
  const cd = checkFaucetCooldown(toAddress);
  if (!cd.allowed) {
    await sendReply(token, chatId,
      `⏳ Address <code>${shortAddr(toAddress)}</code> already received test USDC.\n` +
      `Try again in <b>${cd.hoursLeft}h</b>.`,
      msgId);
    return;
  }

  await sendTyping(token, chatId);

  const result = await sendFaucetUSDC(toAddress);

  if (result.ok) {
    markFaucetUsed(toAddress);
    await sendReply(token, chatId,
      `💰 Sent <b>$20 testnet USDC</b> to\n<code>${toAddress}</code>\n\n` +
      `📋 <a href="${BASESCAN}/tx/${result.txHash}">View on Basescan</a>\n\n` +
      `You now have enough to register! 🚀\n` +
      `👉 <a href="https://early.crypto-nova.app">early.crypto-nova.app</a>`,
      msgId);
  } else {
    await sendReply(token, chatId,
      `⚠️ ${result.reason}`, msgId);
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────────
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

  const msg = body?.message || body?.channel_post;
  if (!msg) return ok();

  const chatId   = msg.chat?.id;
  const msgId    = msg.message_id;
  const userId   = msg.from?.id || 0;
  const chatType = msg.chat?.type;
  const rawText  = (msg.text || msg.caption || '').trim();
  const fromBot  = !!msg.from?.is_bot;

  if (fromBot || !chatId || !rawText) return ok();

  const mentionPattern = new RegExp(`@${BOT_USERNAME}`, 'i');
  const isMentioned = mentionPattern.test(rawText);
  const isPrivate   = chatType === 'private';
  const isCommand   = rawText.startsWith('/');

  if (!isPrivate && !isMentioned && !isCommand) return ok();

  const question = rawText.replace(mentionPattern, '').trim();
  if (!question) {
    await sendReply(BOT_TOKEN, chatId, HELP_TEXT);
    return ok();
  }

  // ── Commands ──────────────────────────────────────────────────────────────────
  if (isCommand) {
    const parts  = question.split(/\s+/);
    const cmd    = parts[0].toLowerCase().replace(`@${BOT_USERNAME}`, '');
    const cmdArg = parts[1] || '';

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
    if (cmd === '/faucet') {
      if (!cmdArg) {
        await sendReply(BOT_TOKEN, chatId,
          `💧 <b>Testnet USDC Faucet</b>\n\n` +
          `Sends <b>$20 testnet USDC</b> to your wallet instantly.\n\n` +
          `Usage:\n<code>/faucet 0xYourWalletAddress</code>\n\n` +
          `Limit: $20 per address per 24 hours.`,
          msgId);
        return ok();
      }
      await handleFaucetRequest(BOT_TOKEN, chatId, msgId, cmdArg);
      return ok();
    }
    // Unknown command — fall through to Claude
  }

  // ── Natural-language faucet detection ─────────────────────────────────────────
  // Trigger when the message contains a wallet address AND a "need USDC" keyword.
  // This catches messages like "hey I need USDC, my address is 0x1234..."
  const detectedAddr = extractAddress(question);
  if (detectedAddr && faucetKeywordsPresent(question)) {
    if (!checkRateLimit(userId)) {
      await sendReply(BOT_TOKEN, chatId,
        `⏳ Too many messages. Please wait a moment before trying again.`, msgId);
      return ok();
    }
    await handleFaucetRequest(BOT_TOKEN, chatId, msgId, detectedAddr);
    return ok();
  }

  // ── Rate limit (Claude queries) ───────────────────────────────────────────────
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
