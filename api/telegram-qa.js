// CryptoNova Support Bot - Claude-powered Telegram Q&A
// Vercel serverless webhook handler
//
// ENV VARS:
//   TELEGRAM_QA_BOT_TOKEN, ANTHROPIC_API_KEY,
//   FAUCET_PRIVATE_KEY, BASE_SEPOLIA_RPC

import { ethers } from 'ethers';

const BOT_USERNAME      = 'cnova_support_bot';
const USDC_ADDRESS      = '0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a';
const TIER_ROUTER       = '0xC729627996E968b5065399843FfFfCF5bfB5148b'; // V8.12
const CNOVA_TOKEN       = '0x9A07EBfeed853b24683B199fd33A27f8d8851191'; // V8.12

// Group moderation — set these in Vercel env vars after creating the groups
// SUPPORT_GROUP_ID: the numeric chat ID of the support group (e.g. -1001234567890)
// COMMUNITY_GROUP_LINK: invite link for the community group (e.g. https://t.me/+abc123)
const SUPPORT_GROUP_ID    = process.env.SUPPORT_GROUP_ID    || '';
const COMMUNITY_GROUP_URL = process.env.COMMUNITY_GROUP_LINK || 'https://t.me/CryptoNovaHQ';
const BASESCAN          = 'https://sepolia.basescan.org';
const FAUCET_AMOUNT     = 20_000_000n;
const FAUCET_ETH_AMOUNT = '0.002';

const SYSTEM_PROMPT = `You are the CryptoNova Support Bot. Answer questions from members about the CryptoNova Matrix platform.

## Tone and Format
- Friendly, concise, mobile-first.
- Use Telegram HTML only: <b>bold</b>, <i>italic</i>, <code>code</code>, <a href="URL">link</a>
- Under 250 words unless a walkthrough is needed.
- No Markdown (no asterisks, backticks, or dashes for bullets).
- Never make up numbers, addresses, or facts.

## What Is CryptoNova?
Decentralized matrix platform on Base blockchain. Members pay USDC to join a binary matrix and earn USDC as it fills. Also features CNOVA utility token mined automatically through cycles. Currently on <b>Base Sepolia testnet</b>. Mainnet launch planned.

## The Matrix System
1. Each tier has a two-phase cycle totalling <b>254 seats</b> (two 127-seat binary trees back-to-back).
2. Register at a tier, take a seat, USDC flows up as members fill seats below you.
3. Completing the first 127 seats is a mid-point crossing - <b>not</b> an upgrade.
4. When all 254 seats fill, the root member auto-upgrades to the next tier and earns CNOVA.
5. Cycle resets and begins again. Referral bonus pays when someone uses your referral link.

Key nuances:
- Upgrade only after the full 254-seat cycle. 127 is mid-point, not an upgrade.
- You may cycle through 254 seats <b>multiple times</b> before reaching root. Position determines when you upgrade.
- Do not promise upgrade after exactly one fill.

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

## CNOVA Token
- Mined automatically each cycle you complete.
- Guaranteed floor price: Treasury USDC divided by total CNOVA supply.
- 15% of every entry fee backs the Treasury permanently.
- Redeem CNOVA for USDC at floor price from the Dashboard anytime.
- Floor price only goes up.

## CNOVA Epochs (from CNOVAToken.sol)
<b>Global and platform-wide</b> - not per-member. <b>9 epochs total.</b>
Epoch advances when the FIRST fires: 1M CNOVA minted, 10k new members, or 30 days elapsed.

Base T1 rewards: Ep1=50, Ep2=40, Ep3=20, Ep4=10, Ep5=5, Ep6-8=2.5, Ep9=2.5 CNOVA.

<b>Tier multipliers:</b>
<code>T1=1x T2=2x T3=4x T4=8x T5=20x T6=40x T7=80x T8=160x T9=320x T10=640x</code>

T5 in Epoch 1 = 50x20 = <b>1,000 CNOVA</b>. T10 in Epoch 1 = 50x640 = <b>32,000 CNOVA</b>.

Mining stops after all 9 epochs (21M hard cap). Do NOT say "after your 8th cycle you stop mining" - epochs are global.

## Community Pool
1% of every entry fee. First 1,000 members eligible.
Genesis (#1-500) = 60%, Pioneer (#501-1000) = 40%.
50% distributes on the 25th of each month, 50% rolls over and compounds. Begins at mainnet.

## How to Register
1. Visit <a href="https://crypto-nova.app">crypto-nova.app</a>
2. Connect MetaMask or Rabby wallet
3. Switch to <b>Base Sepolia</b> (auto-prompted)
4. Need funds? Use <code>/faucet 0xYourAddress</code> - bot sends $20 USDC + 0.002 ETH instantly
5. Approve USDC, then Register
6. Member ID and referral link appear immediately

## Getting Test Funds
Bot sends <b>$20 testnet USDC + 0.002 ETH for gas</b> automatically.
Use: <code>/faucet 0xYourWalletAddress</code>
Or post your address and mention needing USDC/test funds.
Limit: one drop per address per 24 hours.

## Dashboard
Withdrawable, Total Earned, CNOVA Balance, CNOVA Value, CNOVA Burned, Community Pool share.

## Withdrawals
1.5% fee deducted. Instant to Base Sepolia wallet. Can also redeem CNOVA for USDC.

## Upgrade Fee (verified from contract)
TierRouter deducts next tier fee from your <b>withdrawable balance</b> inside the contract.
- NOT from your external wallet.
- NOT free - comes from earnings.
- Example: T1 cycles out, $25 T2 fee deducted from withdrawable, registered at T2 automatically.
- If withdrawable < next fee: <b>parked</b> for up to 10 days. Keeper then applies the ratio check:
  - If you withdrew ≤70% of total earned: StabilityFund covers 25% of fee, your withdrawable covers 75% → rescued automatically.
  - If you withdrew >70% of total earned: evicted. Slot cleared, must re-enter fresh. Withdrawable balance preserved.
- Both 70% threshold and 25% SF contribution are DAO-governed.
- Do NOT say upgrade is free. Do NOT say rescue is guaranteed.

## Network Setup (Base Sepolia)
Chain ID: <code>84532</code> | RPC: <code>https://sepolia.base.org</code> | Explorer: <code>https://sepolia.basescan.org</code>

## Common Issues
<b>Transaction failed:</b> Approve USDC first (Step 1 before Step 2). Check you have ETH for gas.
<b>Already registered:</b> Open Dashboard to see your account.
<b>Wrong network:</b> Use site prompt or add Base Sepolia manually.
<b>No USDC/ETH (testnet):</b> Use /faucet command with your address.
<b>No USDC/ETH (mainnet):</b> Swap any crypto to USDC on Base using <a href="https://changenow.app.link/referral?link_id=c66940e36c06c9">ChangeNow</a> — works with most coins, no account required.
<b>Wallet won't connect:</b> Refresh or switch to MetaMask/Rabby.
<b>Dashboard shows 0:</b> Connect with same wallet you registered with.

## Referral System
The referral system is fully live in the smart contracts.
- When you register using someone's referral link, their <b>wallet address</b> is recorded on-chain permanently and they earn the L1 direct fee (20% of your entry fee) instantly.
- The referrer field always shows a <b>wallet address</b> (e.g. 0x1a2b...3c4d). There are no usernames or Member IDs — it is wallet-address based.
- <b>"Direct"</b> means the member registered without a referral link (no referrer address passed). This happens on testnet AND mainnet — it is not a testnet limitation.
- On testnet, most members show "Direct" because they were added via automated stress-testing with no referrer, not because referrals aren't working.
- On mainnet, members who use a referral link will show the referrer's wallet address. Members who register directly will always show "Direct" — permanently.
- Do NOT say referrer will show "Member ID" or "username" — those are not built. Do NOT say "Direct" is only a testnet thing.

## Contracts (Base Sepolia)
TierRouter: <code>0xC729627996E968b5065399843FfFfCF5bfB5148b</code>
USDC: <code>0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a</code>

## Links
<a href="https://crypto-nova.app">crypto-nova.app</a> | <a href="https://crypto-nova.app/faq">FAQ</a>
<a href="https://changenow.app.link/referral?link_id=c66940e36c06c9">ChangeNow</a> — swap any crypto to USDC on Base (no account needed)

## Escalate to @admin when
- Missing payment or stuck transaction
- Bug or unexpected site behaviour
- Anything needing admin access

## Never
- Share private keys or seed phrases
- Promise earnings or give financial advice
- Answer off-topic questions (crypto markets, other projects) - stay on CryptoNova support`;

const HELP_TEXT = `<b>CryptoNova Support Bot</b>

I can answer questions about:
1. How the matrix works
2. Registration and entry fees
3. CNOVA token and mining
4. Tiers, upgrades and earnings
5. Withdrawals and 1.5% fee
6. Community Pool eligibility
7. Dashboard breakdown
8. Troubleshooting

<b>Commands:</b>
/faucet 0xYourAddress — get $20 USDC + 0.002 ETH instantly
/register — how to get started
/price — live CNOVA floor price
/tier — entry fees and earnings per tier
/stats — live testnet stats
/help — this message

<a href="https://crypto-nova.app">crypto-nova.app</a> | <a href="https://crypto-nova.app/faq">FAQ</a>`;

const REGISTER_TEXT = `<b>How to Register on CryptoNova</b>

1. Visit <a href="https://crypto-nova.app">crypto-nova.app</a>
2. Connect MetaMask or Rabby wallet
3. Switch to <b>Base Sepolia</b> (auto-prompted)
4. Need testnet funds? Use: <code>/faucet 0xYourWalletAddress</code>
   Bot sends $20 USDC + 0.002 ETH for gas instantly.
5. Approve USDC and confirm
6. Register and confirm
7. Member ID and referral link appear instantly

Have a referral link? Use it to pre-fill your referrer.
Questions? Mention @cnova_support_bot`;

const OFFTOPIC_REDIRECT = `👋 This is the <b>CryptoNova Support Channel</b> — for technical help, bug reports, and platform questions.

💬 For general chat, join the community here:
<a href="${COMMUNITY_GROUP_URL}">CryptoNova Community →</a>

Have a support question? Just ask it here and I'll answer right away! 🛠️`;

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

const faucetCooldowns = new Map();
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

async function sendFaucetFunds(toAddress) {
  const FAUCET_KEY = process.env.FAUCET_PRIVATE_KEY;
  if (!FAUCET_KEY) return { ok: false, reason: 'Faucet not configured - tag @admin for test funds.' };

  const rpcUrl = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet   = new ethers.Wallet(FAUCET_KEY, provider);

    const usdc = new ethers.Contract(USDC_ADDRESS, [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address account) view returns (uint256)',
    ], wallet);

    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < FAUCET_AMOUNT) return { ok: false, reason: 'Faucet is low on USDC - tag @admin to refill.' };

    const ethBal  = await provider.getBalance(wallet.address);
    const ethSend = ethers.parseEther(FAUCET_ETH_AMOUNT);
    if (ethBal < ethSend) return { ok: false, reason: 'Faucet is low on ETH - tag @admin to refill.' };

    const ethTx      = await wallet.sendTransaction({ to: toAddress, value: ethSend });
    const ethReceipt = await ethTx.wait(1);
    console.log(`[faucet] ETH sent to ${toAddress} - ${ethReceipt.hash}`);

    const usdcTx      = await usdc.transfer(toAddress, FAUCET_AMOUNT);
    const usdcReceipt = await usdcTx.wait(1);
    console.log(`[faucet] USDC sent to ${toAddress} - ${usdcReceipt.hash}`);

    return { ok: true, ethHash: ethReceipt.hash, usdcHash: usdcReceipt.hash };
  } catch (e) {
    console.error('[faucet] Error:', e.message);
    return { ok: false, reason: 'Transaction failed - tag @admin for help.' };
  }
}

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

async function deleteMessage(token, chatId, messageId) {
  return tgPost('deleteMessage', token, { chat_id: chatId, message_id: messageId }).catch(() => {});
}

async function isGroupAdmin(token, chatId, userId) {
  try {
    const r = await tgPost('getChatMember', token, { chat_id: chatId, user_id: userId });
    return ['administrator', 'creator'].includes(r?.result?.status);
  } catch { return false; }
}

// Classifies a group message as 'support', 'offtopic', or 'spam'.
// Defaults to 'support' on any error so the bot never silently drops a real question.
async function classifyMessage(apiKey, text) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        system: `Classify this Telegram message into exactly one word — no punctuation, no explanation:
"support" = help request, technical question about CryptoNova, faucet request, bug report, wallet issue, registration question
"offtopic" = casual greetings (GM/GN/hi), general crypto chat, price talk, unrelated conversation, sharing wins
"spam" = marketing links, promotional content, scam attempts, unrelated project shilling, gibberish
Reply with only one word.`,
        messages: [{ role: 'user', content: text }],
      }),
    });
    const data = await r.json();
    const result = data.content?.[0]?.text?.trim().toLowerCase().split(/\s/)[0];
    return ['support', 'offtopic', 'spam'].includes(result) ? result : 'support';
  } catch { return 'support'; }  // fail-safe: never drop a real question
}

async function fetchLiveStats() {
  const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
  async function call(to, selector) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: selector }, 'latest'] }),
    });
    const json = await r.json();
    if (json.error || !json.result || json.result === '0x') return null;
    return parseInt(json.result, 16);
  }
  const count = await call(TIER_ROUTER, '0x2b47da6f') || await call(TIER_ROUTER, '0x753b5e99') || await call(TIER_ROUTER, '0x2d4d5ec3');
  const memberDisplay = count && count > 0 ? `<b>${count.toLocaleString()}</b> members registered` : 'member count unavailable';
  return `<b>CryptoNova Testnet - Live Stats</b>\n\nMembers: ${memberDisplay}\nNetwork: Base Sepolia\nContract: <code>${TIER_ROUTER}</code>\n\n<a href="https://crypto-nova.app">Open Dashboard for full stats</a>`;
}

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

async function askClaude(apiKey, question) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: question }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return mdToTg(data.content?.[0]?.text?.trim() || '');
}

function extractAddress(text) {
  const m = text.match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0] : null;
}

function faucetKeywordsPresent(text) {
  return /\bfaucet\b|need\s+usdc|send\s+usdc|test\s+usdc|test\s+funds|need\s+test|want\s+usdc|get\s+usdc/i.test(text);
}

function shortAddr(addr) { return `${addr.slice(0, 8)}...${addr.slice(-6)}`; }

async function handleFaucetRequest(token, chatId, msgId, rawAddress) {
  if (!rawAddress || !/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
    await sendReply(token, chatId, `Please include a valid wallet address.\n\nExample:\n<code>/faucet 0xYourWalletAddress</code>`, msgId);
    return;
  }
  let toAddress;
  try { toAddress = ethers.getAddress(rawAddress); }
  catch { await sendReply(token, chatId, `That doesn't look like a valid Ethereum address. Double-check and try again.`, msgId); return; }

  const cd = checkFaucetCooldown(toAddress);
  if (!cd.allowed) {
    await sendReply(token, chatId, `Address <code>${shortAddr(toAddress)}</code> already received test funds. Try again in <b>${cd.hoursLeft}h</b>.`, msgId);
    return;
  }

  await sendTyping(token, chatId);
  const result = await sendFaucetFunds(toAddress);

  if (result.ok) {
    markFaucetUsed(toAddress);
    await sendReply(token, chatId,
      `Funds sent to\n<code>${toAddress}</code>\n\n` +
      `<b>$20 testnet USDC</b> - <a href="${BASESCAN}/tx/${result.usdcHash}">View tx</a>\n` +
      `<b>0.002 ETH</b> for gas - <a href="${BASESCAN}/tx/${result.ethHash}">View tx</a>\n\n` +
      `You're ready to register!\n<a href="https://crypto-nova.app">crypto-nova.app</a>`,
      msgId);
  } else {
    await sendReply(token, chatId, result.reason, msgId);
  }
}

export default async function handler(req, res) {
  const ok = () => res.status(200).json({ ok: true });
  if (req.method !== 'POST') return ok();

  const BOT_TOKEN = process.env.TELEGRAM_QA_BOT_TOKEN;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  if (!BOT_TOKEN || !ANTHROPIC) { console.error('[telegram-qa] Missing env vars'); return ok(); }

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

  // ── New member welcome ─────────────────────────────────────────────────────
  // Fires when someone joins the support group (new_chat_members service message).
  // No rawText on these, so we must check BEFORE the rawText guard below.
  if (msg.new_chat_members && Array.isArray(msg.new_chat_members)) {
    const isSupportGroupJoin = SUPPORT_GROUP_ID && String(chatId) === String(SUPPORT_GROUP_ID);
    if (isSupportGroupJoin) {
      const newcomers = msg.new_chat_members.filter(u => !u.is_bot);
      if (newcomers.length > 0) {
        const names = newcomers.map(u =>
          u.username ? `@${u.username}` : `<b>${u.first_name}</b>`
        ).join(', ');

        await tgPost('sendMessage', BOT_TOKEN, {
          chat_id: chatId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          text:
            `👋 Welcome to the CryptoNova Support Group, ${names}!\n\n` +
            `<b>How this group works:</b>\n` +
            `• Type your question here and I'll answer it automatically\n` +
            `• I'll repost your question cleanly and reply below it\n` +
            `• For private questions, DM me directly: @${BOT_USERNAME}\n\n` +
            `<b>Not for general chat</b> — join our community group for that:\n` +
            `<a href="${COMMUNITY_GROUP_URL}">CryptoNova Community →</a>\n\n` +
            `<b>Quick commands:</b>\n` +
            `<code>/faucet 0x…</code> — get testnet USDC + ETH\n` +
            `<code>/price</code> — current CNOVA floor price\n` +
            `<code>/tier</code> — tier entry fees and earnings\n\n` +
            `🚀 <b>Mainnet launches June 19</b> — <a href="https://crypto-nova.app">crypto-nova.app</a>`,
        });
      }
    }
    return ok();
  }

  if (fromBot || !chatId || !rawText) return ok();

  const mentionPattern = new RegExp(`@${BOT_USERNAME}`, 'i');
  const isMentioned    = mentionPattern.test(rawText);
  const isPrivate      = chatType === 'private';
  const isCommand      = rawText.startsWith('/');
  const isSupportGroup = SUPPORT_GROUP_ID && String(chatId) === String(SUPPORT_GROUP_ID);

  // ── Support group moderation ────────────────────────────────────────────────
  // Any plain message in the support group (not a command, not an @mention):
  //   spam    → delete silently
  //   offtopic → delete + "please DM the bot" notice
  //   support  → delete original, repost with @username attribution, answer below
  //
  // ⚠️  Bot must be a group ADMIN with "Delete messages" permission for this to work.
  if (isSupportGroup && !isCommand && !isMentioned && !fromBot) {
    const senderName = msg.from?.username
      ? `@${msg.from.username}`
      : `<b>${msg.from?.first_name || 'Member'}</b>`;

    const verdict = await classifyMessage(ANTHROPIC, rawText);

    if (verdict === 'spam') {
      // Silently delete — no notification to avoid drawing attention
      await deleteMessage(BOT_TOKEN, chatId, msgId);
      return ok();
    }

    if (verdict === 'offtopic') {
      // Delete + polite redirect
      await deleteMessage(BOT_TOKEN, chatId, msgId);
      await tgPost('sendMessage', BOT_TOKEN, {
        chat_id: chatId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          `👋 Hey ${senderName} — this group is for <b>support questions only</b>.\n\n` +
          `For general chat and community discussion:\n` +
          `<a href="${COMMUNITY_GROUP_URL}">CryptoNova Community →</a>\n\n` +
          `To ask a support question, DM me directly: @${BOT_USERNAME}\n` +
          `Or just ask it in this group and tag me: <code>@${BOT_USERNAME} your question</code>`,
      });
      return ok();
    }

    // verdict === 'support': delete original, repost with attribution, then answer
    await deleteMessage(BOT_TOKEN, chatId, msgId);

    const repostResult = await tgPost('sendMessage', BOT_TOKEN, {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `💬 ${senderName} asked:\n\n${rawText}`,
    });

    const repostMsgId = repostResult?.result?.message_id;
    await sendTyping(BOT_TOKEN, chatId);
    try {
      const answer = await askClaude(ANTHROPIC, rawText);
      if (answer) await sendReply(BOT_TOKEN, chatId, answer, repostMsgId);
      else throw new Error('empty');
    } catch (e) {
      console.error('[group-qa] Claude error:', e.message);
      await sendReply(BOT_TOKEN, chatId,
        `Having trouble right now — try DM-ing me directly: @${BOT_USERNAME}`, repostMsgId);
    }
    return ok();
  }

  if (!isPrivate && !isMentioned && !isCommand) return ok();

  const question = rawText.replace(mentionPattern, '').trim();
  if (!question) { await sendReply(BOT_TOKEN, chatId, HELP_TEXT); return ok(); }

  if (isCommand) {
    const parts  = question.split(/\s+/);
    const cmd    = parts[0].toLowerCase().replace(`@${BOT_USERNAME}`, '');
    const cmdArg = parts[1] || '';

    if (cmd === '/start' || cmd === '/help') { await sendReply(BOT_TOKEN, chatId, HELP_TEXT); return ok(); }
    if (cmd === '/register') { await sendReply(BOT_TOKEN, chatId, REGISTER_TEXT); return ok(); }
    if (cmd === '/stats') {
      await sendTyping(BOT_TOKEN, chatId);
      try { await sendReply(BOT_TOKEN, chatId, await fetchLiveStats(), msgId); }
      catch (e) { await sendReply(BOT_TOKEN, chatId, 'Unable to fetch live stats. Check the <a href="https://crypto-nova.app">Dashboard</a>.', msgId); }
      return ok();
    }
    if (cmd === '/price') {
      await sendTyping(BOT_TOKEN, chatId);
      try {
        const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
        const eth = async (to, sel) => {
          const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_call', params:[{to, data:sel},'latest'] }) });
          const j = await r.json();
          return (j.error || !j.result || j.result==='0x') ? null : BigInt(j.result);
        };
        // floorPrice() — single uint256 in 6-decimal USDC
        const raw = await eth(CNOVA_TOKEN, '0xd555254e');
        if (raw !== null) {
          const price = (Number(raw) / 1e6).toFixed(6);
          await sendReply(BOT_TOKEN, chatId,
            `💰 <b>CNOVA Floor Price</b>\n\n` +
            `<b>$${price} USDC</b> per CNOVA\n\n` +
            `<i>Floor price is backed by the Treasury and can only go up.</i>\n` +
            `Redeem on the <a href="https://crypto-nova.app">Dashboard</a> → Withdraw Earnings → Redeem CNOVA.`,
            msgId);
        } else {
          await sendReply(BOT_TOKEN, chatId, 'Unable to fetch CNOVA price right now — check the <a href="https://crypto-nova.app">Dashboard</a>.', msgId);
        }
      } catch(e) {
        await sendReply(BOT_TOKEN, chatId, 'Price fetch error. Try the <a href="https://crypto-nova.app">Dashboard</a> instead.', msgId);
      }
      return ok();
    }
    if (cmd === '/tier') {
      await sendReply(BOT_TOKEN, chatId,
        `📊 <b>CryptoNova — 10 Tiers</b>\n\n` +
        `<code>` +
        `T1  Nova Seed         $10\n` +
        `T2  Nova Rise         $25\n` +
        `T3  Nova Star         $50\n` +
        `T4  Nova Core        $100\n` +
        `T5  Nova Prime       $250\n` +
        `T6  Nova Apex        $500\n` +
        `T7  Nova Pinnacle   $1,000\n` +
        `T8  SuperNova Titan $2,500\n` +
        `T9  SuperNova Legend$5,000\n` +
        `T10 SuperNova Apex $10,000` +
        `</code>\n\n` +
        `<b>How earnings work:</b>\n` +
        `• 127-seat binary tree fills → you advance\n` +
        `• Full 254-seat cycle → auto-upgrade + CNOVA mined\n` +
        `• Chain pay: 10%→4%→3%→1.5%→0.75%→0.75% up 6 levels\n\n` +
        `Register at T1 and get your referral link: <a href="https://crypto-nova.app">crypto-nova.app</a>`,
        msgId);
      return ok();
    }
    if (cmd === '/faucet') {
      if (!cmdArg) {
        await sendReply(BOT_TOKEN, chatId,
          `<b>Testnet Faucet</b>\n\nSends <b>$20 testnet USDC + 0.002 ETH</b> for gas instantly.\n\nUsage:\n<code>/faucet 0xYourWalletAddress</code>\n\nLimit: one drop per address per 24 hours.`,
          msgId);
        return ok();
      }
      await handleFaucetRequest(BOT_TOKEN, chatId, msgId, cmdArg);
      return ok();
    }
    if (cmd === '/del') {
      // Admin-only: delete the replied-to message (+ the /del command itself)
      const targetMsgId = msg.reply_to_message?.message_id;
      if (!targetMsgId) {
        await sendReply(BOT_TOKEN, chatId, `Reply to a message with /del to remove it.`, msgId);
        return ok();
      }
      const adminOk = await isGroupAdmin(BOT_TOKEN, chatId, userId);
      if (!adminOk) {
        await sendReply(BOT_TOKEN, chatId, `Only group admins can delete messages.`, msgId);
        return ok();
      }
      await deleteMessage(BOT_TOKEN, chatId, targetMsgId);
      await deleteMessage(BOT_TOKEN, chatId, msgId);  // also remove the /del command itself
      return ok();
    }
  }

  const detectedAddr = extractAddress(question);
  if (detectedAddr && faucetKeywordsPresent(question)) {
    if (!checkRateLimit(userId)) { await sendReply(BOT_TOKEN, chatId, `Too many messages. Please wait a moment.`, msgId); return ok(); }
    await handleFaucetRequest(BOT_TOKEN, chatId, msgId, detectedAddr);
    return ok();
  }

  if (!checkRateLimit(userId)) {
    await sendReply(BOT_TOKEN, chatId, `Too many messages. Please wait a moment before asking again.`, msgId);
    return ok();
  }

  await sendTyping(BOT_TOKEN, chatId);
  try {
    const answer = await askClaude(ANTHROPIC, question);
    if (answer) await sendReply(BOT_TOKEN, chatId, answer, msgId);
    else throw new Error('Empty response');
  } catch (e) {
    console.error('[telegram-qa] Claude error:', e.message);
    await sendReply(BOT_TOKEN, chatId, `Having trouble right now. Try again in a moment.\n<a href="https://crypto-nova.app/faq">FAQ</a> | Tag @admin for urgent help.`, msgId);
  }

  return ok();
}
