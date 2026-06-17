// patch_card_details.js — adds drill-down detail panels to all 6 dashboard stat cards
// Run: node patch_card_details.js
const fs   = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'index.html');

let html = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
let changed = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 1. ADD CSS for detail panel + clickable cards
// ─────────────────────────────────────────────────────────────────────────────
const CSS_ANCHOR = `.stat-sub { font-size: 12px; color: var(--text3); margin-top: 4px; }`;
const CSS_NEW = `.stat-sub { font-size: 12px; color: var(--text3); margin-top: 4px; }
    .detail-hint { font-size: 10px; color: var(--text3); margin-top: 8px; letter-spacing: .3px; display: none; }
    .card-sm.clickable { cursor: pointer; transition: border-color .25s, box-shadow .25s, transform .15s; user-select: none; }
    .card-sm.clickable:hover { border-color: rgba(0,212,170,.45) !important; box-shadow: 0 4px 16px rgba(0,212,170,.08); transform: translateY(-2px); }
    .card-sm.clickable:hover .detail-hint { display: block; color: var(--green); }
    .card-sm.clickable.active-detail { border-color: rgba(0,212,170,.6) !important; box-shadow: 0 0 0 2px rgba(0,212,170,.15); }
    #dash-detail-panel {
      width: 100%; background: var(--bg2); border: 1px solid rgba(0,212,170,.3);
      border-radius: 12px; padding: 20px 22px; margin-bottom: 24px;
      display: none; animation: slideDown .2s ease;
    }
    #dash-detail-panel.show { display: block; }
    @keyframes slideDown { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform: translateY(0); } }
    .detail-panel-title { font-size: 14px; font-weight: 700; color: var(--green); margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; }
    .detail-close { cursor: pointer; color: var(--text3); font-size: 18px; line-height: 1; padding: 0 4px; }
    .detail-close:hover { color: var(--text1); }
    .detail-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .detail-row:last-child { border-bottom: none; }
    .detail-row.total { font-weight: 700; padding-top: 12px; font-size: 14px; }
    .detail-key { color: var(--text2); }
    .detail-val { color: var(--text1); font-weight: 600; }
    .detail-val.green { color: var(--green); }
    .detail-val.red   { color: var(--red); }
    .detail-val.purple { color: #a855f7; }
    .detail-val.yellow { color: var(--yellow); }
    .detail-note { font-size: 11px; color: var(--text3); margin-top: 12px; line-height: 1.6; padding: 10px 12px; background: var(--bg3); border-radius: 7px; }
    .detail-section { font-size: 11px; font-weight: 700; color: var(--text3); letter-spacing: .6px; text-transform: uppercase; margin: 14px 0 6px; }
    .detail-loading { color: var(--text3); font-size: 13px; }`;

if (html.includes(CSS_ANCHOR) && !html.includes('card-sm.clickable')) {
  html = html.replace(CSS_ANCHOR, CSS_NEW);
  changed++;
  console.log('✓ Added detail panel CSS');
} else {
  console.log('· CSS already patched or anchor missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. MAKE CARDS CLICKABLE — add class, onclick, and hint div to each
// ─────────────────────────────────────────────────────────────────────────────

// Card 1 — Withdrawable
const C1_OLD = `        <div class="card-sm" style="border-color:var(--green2)">
          <div class="stat-label">Withdrawable</div>
          <div class="stat-value green" id="dash-withdrawable">—</div>
          <div class="stat-sub">Ready to claim</div>
        </div>`;
const C1_NEW = `        <div class="card-sm clickable" style="border-color:var(--green2)" onclick="openDashDetail('withdrawable',this)" title="Click for breakdown">
          <div class="stat-label">Withdrawable</div>
          <div class="stat-value green" id="dash-withdrawable">—</div>
          <div class="stat-sub">Ready to claim</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C1_OLD)) { html = html.replace(C1_OLD, C1_NEW); changed++; console.log('✓ Card 1 (Withdrawable)'); }
else console.log('✗ Card 1 anchor not found');

// Card 2 — Total Earned
const C2_OLD = `        <div class="card-sm">
          <div class="stat-label">Total Earned</div>
          <div class="stat-value" id="dash-total-earned">—</div>
<div class="stat-sub" id="dash-total-earned-sub" title="Total USDC ever credited to your account. Includes current balance, amounts auto-deducted for tier upgrades, and past withdrawals.">All tiers lifetime</div>
        </div>`;
const C2_NEW = `        <div class="card-sm clickable" onclick="openDashDetail('earned',this)" title="Click for tier breakdown">
          <div class="stat-label">Total Earned</div>
          <div class="stat-value" id="dash-total-earned">—</div>
<div class="stat-sub" id="dash-total-earned-sub" title="Total USDC ever credited to your account. Includes current balance, amounts auto-deducted for tier upgrades, and past withdrawals.">All tiers lifetime</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C2_OLD)) { html = html.replace(C2_OLD, C2_NEW); changed++; console.log('✓ Card 2 (Total Earned)'); }
else console.log('✗ Card 2 anchor not found');

// Card 3 — CNOVA Balance
const C3_OLD = `        <div class="card-sm">
          <div class="stat-label"><svg width="14" height="14" style="vertical-align:middle;border-radius:50%;margin-right:3px"><use href="#cnova-icon"/></svg>CNOVA Balance</div>
          <div class="stat-value green" id="dash-cnova">—</div>
          <div class="stat-sub">Mined tokens</div>
        </div>`;
const C3_NEW = `        <div class="card-sm clickable" onclick="openDashDetail('cnova',this)" title="Click for CNOVA breakdown">
          <div class="stat-label"><svg width="14" height="14" style="vertical-align:middle;border-radius:50%;margin-right:3px"><use href="#cnova-icon"/></svg>CNOVA Balance</div>
          <div class="stat-value green" id="dash-cnova">—</div>
          <div class="stat-sub">Mined tokens</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C3_OLD)) { html = html.replace(C3_OLD, C3_NEW); changed++; console.log('✓ Card 3 (CNOVA Balance)'); }
else console.log('✗ Card 3 anchor not found');

// Card 4 — CNOVA Value
const C4_OLD = `        <div class="card-sm">
          <div class="stat-label">CNOVA Value</div>
          <div class="stat-value" id="dash-cnova-val">—</div>
          <div class="stat-sub">At current floor</div>
        </div>`;
const C4_NEW = `        <div class="card-sm clickable" onclick="openDashDetail('cnova',this)" title="Click for CNOVA breakdown">
          <div class="stat-label">CNOVA Value</div>
          <div class="stat-value" id="dash-cnova-val">—</div>
          <div class="stat-sub">At current floor</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C4_OLD)) { html = html.replace(C4_OLD, C4_NEW); changed++; console.log('✓ Card 4 (CNOVA Value)'); }
else console.log('✗ Card 4 anchor not found');

// Card 5 — CNOVA Burned
const C5_OLD = `        <div class="card-sm" title="Total CNOVA you have burned via Redeem → USDC. Loaded from on-chain Transfer events.">
          <div class="stat-label">🔥 CNOVA Burned</div>
          <div class="stat-value" id="dash-cnova-burned" style="color:var(--red)">—</div>
          <div class="stat-sub">Redeemed lifetime</div>
        </div>`;
const C5_NEW = `        <div class="card-sm clickable" onclick="openDashDetail('burned',this)" title="Click for redemption history">
          <div class="stat-label">🔥 CNOVA Burned</div>
          <div class="stat-value" id="dash-cnova-burned" style="color:var(--red)">—</div>
          <div class="stat-sub">Redeemed lifetime</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C5_OLD)) { html = html.replace(C5_OLD, C5_NEW); changed++; console.log('✓ Card 5 (CNOVA Burned)'); }
else console.log('✗ Card 5 anchor not found');

// Card 6 — Community Pool
const C6_OLD = `        <div class="card-sm" style="border-color:rgba(168,85,247,.4)" title="Total USDC held in the Community Wallet — funded by orphan fees from empty upline positions.">
          <div class="stat-label">🏛️ Community Pool</div>
          <div class="stat-value" id="dash-cw-pool" style="color:#a855f7">—</div>
          <div class="stat-sub">Orphan fees collected</div>
        </div>`;
const C6_NEW = `        <div class="card-sm clickable" style="border-color:rgba(168,85,247,.4)" onclick="openDashDetail('community',this)" title="Click for eligibility details">
          <div class="stat-label">🏛️ Community Pool</div>
          <div class="stat-value" id="dash-cw-pool" style="color:#a855f7">—</div>
          <div class="stat-sub">Orphan fees collected</div>
          <div class="detail-hint">Details ↗</div>
        </div>`;
if (html.includes(C6_OLD)) { html = html.replace(C6_OLD, C6_NEW); changed++; console.log('✓ Card 6 (Community Pool)'); }
else console.log('✗ Card 6 anchor not found');

// ─────────────────────────────────────────────────────────────────────────────
// 3. ADD DETAIL PANEL HTML — insert after the 6-card grid closing div
// ─────────────────────────────────────────────────────────────────────────────
const PANEL_ANCHOR = `      <!-- Withdraw + member info -->`;
const PANEL_HTML = `      <!-- ── Card detail panel ── -->
      <div id="dash-detail-panel">
        <div class="detail-panel-title">
          <span id="detail-panel-title-text">Details</span>
          <span class="detail-close" onclick="closeDashDetail()">✕</span>
        </div>
        <div id="detail-panel-body"><span class="detail-loading">Loading…</span></div>
      </div>

      <!-- Withdraw + member info -->`;
if (html.includes(PANEL_ANCHOR) && !html.includes('dash-detail-panel')) {
  html = html.replace(PANEL_ANCHOR, PANEL_HTML);
  changed++;
  console.log('✓ Detail panel HTML inserted');
} else {
  console.log('· Detail panel HTML already present or anchor missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADD JS FUNCTION — insert after loadUserBurnHistory
// ─────────────────────────────────────────────────────────────────────────────
const JS_ANCHOR = `async function doWithdraw() {`;
const JS_NEW = `// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD CARD DETAIL PANELS
// ═══════════════════════════════════════════════════════════════════════
let _activeDetailCard = null;

function closeDashDetail() {
  const panel = document.getElementById('dash-detail-panel');
  if (panel) panel.classList.remove('show');
  if (_activeDetailCard) { _activeDetailCard.classList.remove('active-detail'); _activeDetailCard = null; }
}

async function openDashDetail(type, cardEl) {
  const panel    = document.getElementById('dash-detail-panel');
  const titleEl  = document.getElementById('detail-panel-title-text');
  const bodyEl   = document.getElementById('detail-panel-body');
  if (!panel || !bodyEl) return;

  // Toggle off if same card clicked again
  if (_activeDetailCard === cardEl && panel.classList.contains('show')) {
    closeDashDetail(); return;
  }
  if (_activeDetailCard) _activeDetailCard.classList.remove('active-detail');
  _activeDetailCard = cardEl;
  if (cardEl) cardEl.classList.add('active-detail');

  // Scroll panel into view
  panel.classList.add('show');
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

  bodyEl.innerHTML = '<span class="detail-loading"><span class="spinner"></span> Loading…</span>';

  const rp = readProvider || new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });

  try {
    if (type === 'withdrawable') {
      titleEl.textContent = '💰 Withdrawable — Balance Breakdown';
      await renderWithdrawableDetail(bodyEl, rp);
    } else if (type === 'earned') {
      titleEl.textContent = '📈 Total Earned — Tier Breakdown';
      await renderEarnedDetail(bodyEl, rp);
    } else if (type === 'cnova') {
      titleEl.textContent = '◈ CNOVA — Balance & Epoch Breakdown';
      await renderCnovaDetail(bodyEl, rp);
    } else if (type === 'burned') {
      titleEl.textContent = '🔥 CNOVA Burned — Redemption History';
      await renderBurnedDetail(bodyEl, rp);
    } else if (type === 'community') {
      titleEl.textContent = '🏛️ Community Pool — Your Eligibility';
      await renderCommunityDetail(bodyEl, rp);
    }
  } catch(e) {
    bodyEl.innerHTML = \`<div class="detail-note">⚠️ Failed to load detail: \${e.message.slice(0,100)}</div>\`;
  }
}

// ── Withdrawable breakdown ────────────────────────────────────────────
async function renderWithdrawableDetail(el, rp) {
  // Collect totals across all matrices
  const matrices = [
    ADDRS.T1.matA, ADDRS.T1.matB, ADDRS.T2.matA, ADDRS.T2.matB,
    ADDRS.T3.matA, ADDRS.T3.matB,
    ...(ADDRS.T4?.matA ? [ADDRS.T4.matA, ADDRS.T4.matB] : []),
    ...(ADDRS.T5?.matA ? [ADDRS.T5.matA, ADDRS.T5.matB] : []),
    ...(ADDRS.T6?.matA ? [ADDRS.T6.matA, ADDRS.T6.matB] : []),
    ...(ADDRS.T7?.matA ? [ADDRS.T7.matA, ADDRS.T7.matB] : []),
    ...(ADDRS.T8?.matA ? [ADDRS.T8.matA, ADDRS.T8.matB] : []),
    ...(ADDRS.T9?.matA ? [ADDRS.T9.matA, ADDRS.T9.matB] : []),
    ...(ADDRS.T10?.matA ? [ADDRS.T10.matA, ADDRS.T10.matB] : []),
  ];
  let totalEarned = 0n, totalWithdrawn = 0n, totalWithdrawable = 0n, joinedAt = 0n;
  for (const addr of matrices) {
    const mc = new ethers.Contract(addr, MATRIX_ABI, rp);
    const m = await mc.getMember(userAddr).catch(() => null);
    if (m && m.hasEverJoined) {
      totalEarned      += BigInt(m.totalEarned);
      totalWithdrawn   += BigInt(m.totalWithdrawn);
      totalWithdrawable += BigInt(m.withdrawable);
      if (!joinedAt && m.joinedAt) joinedAt = BigInt(m.joinedAt);
    }
  }
  const autoDeducted = totalEarned > (totalWithdrawn + totalWithdrawable)
    ? totalEarned - totalWithdrawn - totalWithdrawable : 0n;

  // Withdrawal fee
  const matFee = new ethers.Contract(ADDRS.T1.matA, MATRIX_ABI, rp);
  const feeBps = await matFee.withdrawalFeeBps().catch(() => 150n);
  const feeAmt = totalWithdrawable * feeBps / 10000n;
  const netAmt = totalWithdrawable - feeAmt;
  const feePct = (Number(feeBps) / 100).toFixed(1);

  const joinDate = joinedAt > 0n
    ? new Date(Number(joinedAt) * 1000).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
    : '—';
  const daysSince = joinedAt > 0n ? Math.floor((Date.now()/1000 - Number(joinedAt)) / 86400) : 0;

  el.innerHTML = \`
    <div class="detail-row"><span class="detail-key">Total Ever Earned</span><span class="detail-val green">\${fmt6(totalEarned)}</span></div>
    <div class="detail-row"><span class="detail-key">Previously Withdrawn</span><span class="detail-val">\${fmt6(totalWithdrawn)}</span></div>
    <div class="detail-row"><span class="detail-key">Auto-Deducted (upgrades)</span><span class="detail-val">\${fmt6(autoDeducted)}</span></div>
    <div class="detail-row total"><span class="detail-key">= Available to Claim</span><span class="detail-val green">\${fmt6(totalWithdrawable)}</span></div>
    \${totalWithdrawable > 0n ? \`
    <div class="detail-section">After Withdrawal Fee</div>
    <div class="detail-row"><span class="detail-key">Withdrawal Fee (\${feePct}%)</span><span class="detail-val red">−\${fmt6(feeAmt)}</span></div>
    <div class="detail-row total"><span class="detail-key">You Receive</span><span class="detail-val green">\${fmt6(netAmt)}</span></div>
    \` : ''}
    <div class="detail-note">📅 Member since \${joinDate}\${daysSince > 0 ? \` · \${daysSince} days ago\` : ''}</div>
  \`;
}

// ── Total Earned breakdown (tier-by-tier) ────────────────────────────
async function renderEarnedDetail(el, rp) {
  const tr = new ethers.Contract(ADDRS.tierRouter, TIER_ROUTER_ABI, rp);
  const onChainTier = Number(await tr.memberHighestTier(userAddr).catch(() => 0));
  const numTiers = Math.max(onChainTier, 1);

  const [cycArr, feeArr] = await Promise.all([
    Promise.all(Array.from({length: numTiers}, (_, i) => tr.tierCycles(userAddr, i).catch(() => 0n))),
    Promise.all(Array.from({length: numTiers}, (_, i) => tr.tierEntryFees(i).catch(() => 0n))),
  ]);

  const TIER_NAMES = ['Nova Seed','Nova Rise','Nova Star','Nova Core','Nova Prime','Nova Apex','Nova Pinnacle','SuperNova Titan','SuperNova Legend','SuperNova Apex'];
  let totalCycles = 0n;

  const rows = cycArr.map((c, i) => {
    totalCycles += c;
    const label = TIER_NAMES[i] || \`T\${i+1}\`;
    const fee   = feeArr[i] || 0n;
    const estEarnings = c * fee;
    return c > 0n
      ? \`<div class="detail-row"><span class="detail-key">T\${i+1} · \${label}</span><span class="detail-val">\${c} cycle\${c===1n?'':'s'} &nbsp;<span style="color:var(--text3);font-weight:400;font-size:12px">entry fee \${fmt6(fee)}</span></span></div>\`
      : '';
  }).join('');

  // Sum earned across all matrices
  const matrices = [
    ADDRS.T1.matA, ADDRS.T1.matB, ADDRS.T2.matA, ADDRS.T2.matB,
    ADDRS.T3.matA, ADDRS.T3.matB,
    ...(ADDRS.T4?.matA ? [ADDRS.T4.matA, ADDRS.T4.matB] : []),
    ...(ADDRS.T5?.matA ? [ADDRS.T5.matA, ADDRS.T5.matB] : []),
  ];
  let totalEarned = 0n;
  for (const addr of matrices) {
    const mc = new ethers.Contract(addr, MATRIX_ABI, rp);
    const m = await mc.getMember(userAddr).catch(() => null);
    if (m && m.hasEverJoined) totalEarned += BigInt(m.totalEarned);
  }

  const avgPerCycle = totalCycles > 0n
    ? fmt6(totalEarned / totalCycles) : '—';

  el.innerHTML = \`
    <div class="detail-section">Cycles by Tier</div>
    \${rows || '<div class="detail-row"><span class="detail-key" style="color:var(--text3)">No cycles recorded yet</span></div>'}
    <div class="detail-row total"><span class="detail-key">Total Cycles</span><span class="detail-val green">\${totalCycles.toString()}</span></div>
    <div class="detail-section">Summary</div>
    <div class="detail-row"><span class="detail-key">Total Earned (all tiers)</span><span class="detail-val green">\${fmt6(totalEarned)}</span></div>
    <div class="detail-row"><span class="detail-key">Average per Cycle</span><span class="detail-val">\${avgPerCycle}</span></div>
    <div class="detail-note">💡 Each cycle completes when your matrix fills 127 seats. Earnings per cycle vary based on how many chain-pay levels you've unlocked.</div>
  \`;
}

// ── CNOVA balance breakdown ───────────────────────────────────────────
async function renderCnovaDetail(el, rp) {
  const cnova   = new ethers.Contract(ADDRS.cnova,    CNOVA_ABI, rp);
  const usdcC   = new ethers.Contract(ADDRS.usdc,     USDC_ABI,  rp);

  const [cnovabal, supply, treasuryUsdc, epochNum] = await Promise.all([
    cnova.balanceOf(userAddr).catch(() => 0n),
    cnova.totalSupply().catch(() => 0n),
    usdcC.balanceOf(ADDRS.treasury).catch(() => 0n),
    cnova.currentEpochNumber().catch(() => 1n),
  ]);

  const floorRaw   = supply > 0n ? (treasuryUsdc * BigInt(1e18)) / supply : 0n;
  const cnovaValRaw = (cnovabal * treasuryUsdc) / (supply > 0n ? supply : 1n);
  const balFmt = Number(ethers.formatEther(cnovabal)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const floorFmt = supply > 0n
    ? '$' + (Number(treasuryUsdc) / Number(supply) * 1e12).toFixed(6)
    : '$0.000000';

  // Epoch reward schedule
  const epochNums = [0,1,2,3,4,5,6,7];
  const epochRewards = await Promise.all(epochNums.map(i => cnova.epochRewards(i).catch(() => null)));
  const epochRows = epochRewards.map((r, i) => {
    if (r === null) return '';
    const amt = Number(ethers.formatEther(r)).toFixed(1);
    const isCurrent = (i === Number(epochNum) - 1);
    return \`<div class="detail-row">
      <span class="detail-key">Epoch \${i+1}\${isCurrent ? ' <span style=\\"color:var(--green);font-size:10px\\">● Active</span>' : ''}</span>
      <span class="detail-val \${isCurrent ? 'green' : ''}">\${amt} CNOVA / cycle</span>
    </div>\`;
  }).join('');

  el.innerHTML = \`
    <div class="detail-section">Your Balance</div>
    <div class="detail-row"><span class="detail-key">CNOVA Held</span><span class="detail-val green">\${balFmt} CNOVA</span></div>
    <div class="detail-row"><span class="detail-key">Floor Price</span><span class="detail-val">\${floorFmt} per CNOVA</span></div>
    <div class="detail-row total"><span class="detail-key">USD Value at Floor</span><span class="detail-val green">\${fmt6(cnovaValRaw)}</span></div>
    <div class="detail-section">Mining Schedule (CNOVA per cycle)</div>
    \${epochRows}
    <div class="detail-note">◈ CNOVA is minted each time you complete a matrix cycle. The reward decreases each epoch as total supply grows. Floor price = CNOVA Treasury USDC ÷ total supply.</div>
  \`;
}

// ── CNOVA Burned breakdown ────────────────────────────────────────────
async function renderBurnedDetail(el, rp) {
  el.innerHTML = '<span class="detail-loading"><span class="spinner"></span> Scanning burn history…</span>';
  const cnova = new ethers.Contract(ADDRS.cnova, CNOVA_ABI, rp);
  try {
    const filter = cnova.filters.Transfer(userAddr, ethers.ZeroAddress);
    const events = await cnova.queryFilter(filter, 0, 'latest');
    const total  = events.reduce((a, e) => a + BigInt(e.args.value), 0n);
    const totalFmt = Number(ethers.formatEther(total)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

    if (events.length === 0) {
      el.innerHTML = \`
        <div class="detail-row"><span class="detail-key">Total Burned</span><span class="detail-val">0.00 CNOVA</span></div>
        <div class="detail-note">No redemptions found. Use the Redeem CNOVA → USDC panel in the Dashboard to convert your CNOVA to USDC at the current floor price.</div>
      \`;
      return;
    }

    // Fetch block timestamps for recent events (last 5)
    const recent = events.slice(-5).reverse();
    const rows = await Promise.all(recent.map(async e => {
      let dateStr = '';
      try {
        const blk = await rp.getBlock(e.blockNumber);
        dateStr = blk ? new Date(blk.timestamp * 1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
      } catch(_) {}
      const amt = Number(ethers.formatEther(e.args.value)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
      return \`<div class="detail-row">
        <span class="detail-key">\${dateStr || 'Block #'+e.blockNumber}</span>
        <span class="detail-val red">\${amt} CNOVA burned</span>
      </div>\`;
    }));

    el.innerHTML = \`
      <div class="detail-row total"><span class="detail-key">Total Burned Lifetime</span><span class="detail-val red">\${totalFmt} CNOVA</span></div>
      <div class="detail-row"><span class="detail-key">Redemption Count</span><span class="detail-val">\${events.length}</span></div>
      \${events.length > 5 ? \`<div class="detail-section">Last 5 Redemptions</div>\` : \`<div class="detail-section">All Redemptions</div>\`}
      \${rows.join('')}
    \`;
  } catch(e) {
    el.innerHTML = \`<div class="detail-note">⚠️ Could not load burn history from this RPC (block range limit). Your total burned is shown on the card. Full history available on mainnet with a paid RPC.</div>\`;
  }
}

// ── Community Pool breakdown ──────────────────────────────────────────
async function renderCommunityDetail(el, rp) {
  const usdc = new ethers.Contract(ADDRS.usdc, USDC_ABI, rp);
  const cwBal = await usdc.balanceOf(ADDRS.communityWallet).catch(() => 0n);

  // Get member ID from T1 MatA
  const matA = new ethers.Contract(ADDRS.T1.matA, MATRIX_ABI, rp);
  const matB = new ethers.Contract(ADDRS.T1.matB, MATRIX_ABI, rp);
  let memberId = 0;
  const mA = await matA.getMember(userAddr).catch(() => null);
  if (mA && mA.hasEverJoined) { memberId = Number(mA.id); }
  else {
    const mB = await matB.getMember(userAddr).catch(() => null);
    if (mB && mB.hasEverJoined) memberId = Number(mB.id);
  }

  // Determine eligibility
  const isGenesis  = memberId >= 1 && memberId <= 500;
  const isPioneer  = memberId > 500 && memberId <= 1000;
  const isEligible = isGenesis || isPioneer;

  const groupLabel     = isGenesis ? 'Genesis (members #1–500)' : isPioneer ? 'Pioneer (members #501–1000)' : 'Not eligible (member #1001+)';
  const groupShare     = isGenesis ? 0.65 : isPioneer ? 0.35 : 0;
  const groupMax       = isGenesis ? 500 : 500; // max members in each group
  const distributable  = cwBal / 2n;            // 50% distributes each month
  const groupPool      = BigInt(Math.floor(Number(distributable) * groupShare));
  const estShare       = groupMax > 0 ? groupPool / BigInt(groupMax) : 0n;

  const eligibilityIcon = isGenesis ? '🟢' : isPioneer ? '🟡' : '🔴';

  el.innerHTML = \`
    <div class="detail-section">Pool Balance</div>
    <div class="detail-row"><span class="detail-key">Total Pool</span><span class="detail-val purple">\${fmt6(cwBal)}</span></div>
    <div class="detail-row"><span class="detail-key">Monthly Distributable (50%)</span><span class="detail-val">\${fmt6(distributable)}</span></div>
    <div class="detail-row"><span class="detail-key">Rolls Over (50%)</span><span class="detail-val">\${fmt6(cwBal - distributable)}</span></div>

    <div class="detail-section">Your Eligibility</div>
    <div class="detail-row"><span class="detail-key">Your Member ID</span><span class="detail-val">#\${memberId || '—'}</span></div>
    <div class="detail-row"><span class="detail-key">Category</span><span class="detail-val">\${eligibilityIcon} \${memberId ? groupLabel : '—'}</span></div>
    \${isEligible ? \`
    <div class="detail-row"><span class="detail-key">Your Group Share</span><span class="detail-val">\${(groupShare*100).toFixed(0)}% of distributable</span></div>
    <div class="detail-row"><span class="detail-key">Group Pool</span><span class="detail-val purple">\${fmt6(groupPool)}</span></div>
    <div class="detail-row total"><span class="detail-key">Est. Your Share / Month</span><span class="detail-val green">\${fmt6(estShare)} <span style="color:var(--text3);font-size:11px;font-weight:400">(÷ \${groupMax} members)</span></span></div>
    \` : \`
    <div class="detail-row"><span class="detail-key">Eligible</span><span class="detail-val red">No — pool is for first 1,000 members only</span></div>
    \`}
    <div class="detail-note">🏛️ The Community Pool collects 1% of every entry fee (orphan fees from members with no upline). First 1,000 members split it monthly: Genesis (#1–500) receive 65%, Pioneer (#501–1,000) receive 35%. Distributions begin at mainnet launch.</div>
  \`;
}

async function doWithdraw() {`;

if (html.includes(JS_ANCHOR) && !html.includes('openDashDetail')) {
  html = html.replace(JS_ANCHOR, JS_NEW);
  changed++;
  console.log('✓ Added openDashDetail() JS functions');
} else {
  console.log('· JS already patched or anchor missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────────────────────
if (changed > 0) {
  fs.writeFileSync(FILE, html.replace(/\n/g, '\r\n'));
  console.log(`\nDone — ${changed}/9 changes applied.`);
  console.log('Run: git add index.html && git commit -m "feat: dashboard card detail panels" && git push');
} else {
  console.log('\nNo changes applied.');
}
