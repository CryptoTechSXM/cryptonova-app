// fix_directs_v810.js — patches loadMyDirects + dash-directs to use memberReferrer scan
// Run: node fix_directs_v810.js
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'index.html');

// Read and normalize to LF so multiline matches work regardless of OS
let html = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
let changed = 0;

// ── 1. Add memberReferrer to TIER_ROUTER_ABI ────────────────────────────────
const OLD_ABI = `  'function globalJoined(address) external view returns (bool)',`;
const NEW_ABI = `  'function globalJoined(address) external view returns (bool)',
  'function memberReferrer(address) external view returns (address)',`;
if (html.includes(OLD_ABI) && !html.includes('memberReferrer(address)')) {
  html = html.replace(OLD_ABI, NEW_ABI);
  changed++;
  console.log('✓ Added memberReferrer to TIER_ROUTER_ABI');
} else {
  console.log('· memberReferrer already in ABI or anchor not found');
}

// ── 2. Replace the fire-and-forget dash-directs block ──────────────────────
const OLD_DASH = `    // Direct referrals count — fire-and-forget event scan
    (async () => {
      try {
        const trD = new ethers.Contract(ADDRS.tierRouter, TIER_ROUTER_ABI, rp);
        const logs = await trD.queryFilter(trD.filters.MemberRegistered(), 0).catch(async () =>
          trD.queryFilter(trD.filters.MemberRegistered(), -100000).catch(() => [])
        );
        const count = logs.filter(l => l.args?.referrer?.toLowerCase() === userAddr.toLowerCase()).length;
        setText('dash-directs', count.toString());
      } catch(_) { setText('dash-directs', '0'); }
    })();`;

const NEW_DASH = `    // Direct referrals count — scan memberReferrer mapping (event logs too stale on public RPC)
    (async () => {
      try {
        const trD = new ethers.Contract(ADDRS.tierRouter, TIER_ROUTER_ABI, rp);
        const mats = [ADDRS.T1.matA, ADDRS.T1.matB,
          ...(ADDRS.T2?.matA?[ADDRS.T2.matA,ADDRS.T2.matB]:[]),
          ...(ADDRS.T3?.matA?[ADDRS.T3.matA,ADDRS.T3.matB]:[]),
          ...(ADDRS.T4?.matA?[ADDRS.T4.matA,ADDRS.T4.matB]:[]),
          ...(ADDRS.T5?.matA?[ADDRS.T5.matA,ADDRS.T5.matB]:[]),
        ];
        const seen = new Set();
        for (const m of mats) {
          const mc = new ethers.Contract(m, MATRIX_ABI, rp);
          const occ = Number(await mc.occupancy().catch(()=>0n));
          if (!occ) continue;
          const addrs = await Promise.all(Array.from({length:occ},(_,i)=>mc.posToMember(i+1).catch(()=>ethers.ZeroAddress)));
          for (const a of addrs) { if (a && a !== ethers.ZeroAddress) seen.add(a.toLowerCase()); }
        }
        const uniq = [...seen];
        const refs = await Promise.all(uniq.map(a=>trD.memberReferrer(a).catch(()=>ethers.ZeroAddress)));
        const count = refs.filter(r=>r.toLowerCase()===userAddr.toLowerCase()).length;
        setText('dash-directs', count.toString());
      } catch(_) { setText('dash-directs', '0'); }
    })();`;

if (html.includes(OLD_DASH)) {
  html = html.replace(OLD_DASH, NEW_DASH);
  changed++;
  console.log('✓ Replaced dash-directs event scan with memberReferrer scan');
} else {
  console.log('✗ dash-directs anchor not found — check manually');
}

// ── 3. Replace the full loadMyDirects function body ────────────────────────
const OLD_FN = `async function loadMyDirects() {
  if (!userAddr) { toast('Connect wallet first','error'); return; }
  const rp = readProvider || new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  document.getElementById('my-directs-card').style.display='block';
  document.getElementById('my-directs-loading').style.display='block';
  document.getElementById('my-directs-empty').style.display='none';
  document.getElementById('my-directs-list').style.display='none';
  document.getElementById('matrix-pos-banner').style.display='none';
  const loadingEl = document.getElementById('matrix-loading');
  const treeEl    = document.getElementById('matrix-tree');
  if (loadingEl) loadingEl.style.display='none';
  if (treeEl) treeEl.style.display='none';
  try {
    const tr = new ethers.Contract(ADDRS.tierRouter, TIER_ROUTER_ABI, rp);
    let directs = [];
    // Query MemberRegistered — try from block 0 first, then progressive fallback
    let queryErr = null;
    const blkRanges = [0, 500000, 100000, 20000, 5000];
    for (const blkRange of blkRanges) {
      try {
        const from = blkRange === 0 ? 0 : -blkRange;
        const logs = await tr.queryFilter(tr.filters.MemberRegistered(), from);
        directs = logs
          .filter(l => l.args && l.args.referrer &&
            l.args.referrer.toLowerCase() === userAddr.toLowerCase())
          .map(l => l.args.member);
        queryErr = null;
        break;
      } catch(evtErr) {
        queryErr = evtErr.message;
        console.warn('MemberRegistered query range=' + blkRange + ' failed:', evtErr.message);
      }
    }
    if (queryErr) console.warn('MemberRegistered all ranges failed:', queryErr);
    document.getElementById('my-directs-loading').style.display='none';
    if (directs.length === 0) {
      document.getElementById('my-directs-empty').style.display='block';
      return;
    }
    const rowsEl = document.getElementById('my-directs-rows');
    rowsEl.innerHTML = directs.map(addr =>
      \`<div class="info-row">
        <span class="info-key" style="font-family:monospace;font-size:12px">\${addr.slice(0,6)}…\${addr.slice(-4)}</span>
        <span class="info-val"><a href="https://sepolia.basescan.org/address/\${addr}" target="_blank" style="color:var(--green);font-size:12px">View ↗</a></span>
      </div>\`
    ).join('');
    setText('matrix-my-node', directs.length.toString());
    document.getElementById('matrix-my-node-label').textContent = 'My Directs';
    document.getElementById('my-directs-list').style.display='block';
  } catch(e) {
    document.getElementById('my-directs-loading').textContent = 'Error loading directs: ' + e.message.slice(0,100);
  }
}`;

const NEW_FN = `async function loadMyDirects() {
  if (!userAddr) { toast('Connect wallet first','error'); return; }
  const rp = readProvider || new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });
  document.getElementById('my-directs-card').style.display='block';
  document.getElementById('my-directs-loading').style.display='block';
  document.getElementById('my-directs-empty').style.display='none';
  document.getElementById('my-directs-list').style.display='none';
  document.getElementById('matrix-pos-banner').style.display='none';
  const loadingEl = document.getElementById('matrix-loading');
  const treeEl    = document.getElementById('matrix-tree');
  if (loadingEl) loadingEl.style.display='none';
  if (treeEl) treeEl.style.display='none';
  try {
    const tr = new ethers.Contract(ADDRS.tierRouter, TIER_ROUTER_ABI, rp);
    // Scan memberReferrer mapping — event-log approach fails on public RPCs (block range too old)
    const allMats = [
      ADDRS.T1.matA, ADDRS.T1.matB,
      ...(ADDRS.T2?.matA?[ADDRS.T2.matA,ADDRS.T2.matB]:[]),
      ...(ADDRS.T3?.matA?[ADDRS.T3.matA,ADDRS.T3.matB]:[]),
      ...(ADDRS.T4?.matA?[ADDRS.T4.matA,ADDRS.T4.matB]:[]),
      ...(ADDRS.T5?.matA?[ADDRS.T5.matA,ADDRS.T5.matB]:[]),
      ...(ADDRS.T6?.matA?[ADDRS.T6.matA,ADDRS.T6.matB]:[]),
      ...(ADDRS.T7?.matA?[ADDRS.T7.matA,ADDRS.T7.matB]:[]),
      ...(ADDRS.T8?.matA?[ADDRS.T8.matA,ADDRS.T8.matB]:[]),
      ...(ADDRS.T9?.matA?[ADDRS.T9.matA,ADDRS.T9.matB]:[]),
      ...(ADDRS.T10?.matA?[ADDRS.T10.matA,ADDRS.T10.matB]:[]),
    ];
    const seen = new Set();
    for (const matAddr of allMats) {
      const mc  = new ethers.Contract(matAddr, MATRIX_ABI, rp);
      const occ = Number(await mc.occupancy().catch(()=>0n));
      if (!occ) continue;
      const addrs = await Promise.all(
        Array.from({length:occ}, (_,i) => mc.posToMember(i+1).catch(()=>ethers.ZeroAddress))
      );
      for (const a of addrs) {
        if (a && a !== ethers.ZeroAddress) seen.add(a);
      }
    }
    const uniq = [...seen];
    const refs = await Promise.all(uniq.map(a => tr.memberReferrer(a).catch(()=>ethers.ZeroAddress)));
    const directAddrs = uniq.filter((_,i) => refs[i].toLowerCase() === userAddr.toLowerCase());
    document.getElementById('my-directs-loading').style.display='none';
    if (directAddrs.length === 0) {
      document.getElementById('my-directs-empty').style.display='block';
      return;
    }
    const rowsEl = document.getElementById('my-directs-rows');
    rowsEl.innerHTML = directAddrs.map(addr =>
      \`<div class="info-row">
        <span class="info-key" style="font-family:monospace;font-size:12px">\${addr.slice(0,6)}…\${addr.slice(-4)}</span>
        <span class="info-val"><a href="https://sepolia.basescan.org/address/\${addr}" target="_blank" style="color:var(--green);font-size:12px">View ↗</a></span>
      </div>\`
    ).join('');
    setText('matrix-my-node', directAddrs.length.toString());
    document.getElementById('matrix-my-node-label').textContent = 'My Directs';
    document.getElementById('my-directs-list').style.display='block';
  } catch(e) {
    document.getElementById('my-directs-loading').textContent = 'Error loading directs: ' + e.message.slice(0,100);
  }
}`;

if (html.includes(OLD_FN)) {
  html = html.replace(OLD_FN, NEW_FN);
  changed++;
  console.log('✓ Replaced loadMyDirects with memberReferrer scan');
} else {
  console.log('✗ loadMyDirects anchor not found — check manually');
}

// ── Write back ──────────────────────────────────────────────────────────────
if (changed > 0) {
  // Restore CRLF for Windows git working tree
  fs.writeFileSync(FILE, html.replace(/\n/g, '\r\n'));
  console.log(`\nDone — ${changed}/3 changes applied. Run: git add index.html && git commit -m "fix: directs — memberReferrer scan replaces stale event log query" && git push origin v8`);
} else {
  console.log('\nNo changes applied.');
}
