#!/usr/bin/env node
// bug_manager.js — manage BUGS.md directly via GitHub API from the VPS
// Usage:
//   node bug_manager.js list              — show all open reports
//   node bug_manager.js close-all         — move all open → resolved (bulk)
//   node bug_manager.js close "<title>"   — close one report by title match
//   node bug_manager.js sync              — pull latest BUGS.md and print open count
//
// Requires in .env: GITHUB_TOKEN, GITHUB_REPO (default: CryptoTechSXM/cryptonova-testnet-app)

'use strict';
require('dotenv').config({ path: '/root/keeper/.env' });

const TOKEN  = process.env.GITHUB_TOKEN;
const REPO   = process.env.GITHUB_REPO || 'CryptoTechSXM/cryptonova-testnet-app';
const BRANCH = 'admin';
const PATH   = 'BUGS.md';
const API    = `https://api.github.com/repos/${REPO}/contents/${PATH}`;

const HEADERS = {
  Authorization:  `Bearer ${TOKEN}`,
  'User-Agent':   'cryptonova-keeper',
  Accept:         'application/vnd.github+json',
  'Content-Type': 'application/json',
};

// ── GitHub helpers ──────────────────────────────────────────────────────────

async function getFile() {
  const res = await fetch(`${API}?ref=${BRANCH}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    sha:     json.sha,
    content: Buffer.from(json.content, 'base64').toString('utf8'),
  };
}

async function putFile(content, sha, message) {
  const body = JSON.stringify({
    message,
    content: Buffer.from(content).toString('base64'),
    sha,
    branch: BRANCH,
  });
  const res = await fetch(API, { method: 'PUT', headers: HEADERS, body });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── BUGS.md parser ───────────────────────────────────────────────────────────

function parseOpenIssues(md) {
  const openStart  = md.indexOf('## Open Issues');
  const resolvedStart = md.indexOf('## Resolved Issues');
  if (openStart === -1) return [];

  const openBlock = resolvedStart !== -1
    ? md.slice(openStart, resolvedStart)
    : md.slice(openStart);

  const issues = [];
  const issueRegex = /###\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.+?)(?=\n###|\n##|$)/gs;
  let m;
  while ((m = issueRegex.exec(openBlock)) !== null) {
    issues.push({ date: m[1], title: m[2].trim(), raw: m[0] });
  }
  return issues;
}

function buildResolvedRow(issue, fix) {
  const date  = issue.date;
  const today = new Date().toISOString().slice(0, 10);
  // Extract reporter from raw block
  const reporterMatch = issue.raw.match(/\*\*Reporter:\*\*\s*(.+)/);
  const reporter = reporterMatch ? reporterMatch[1].trim() : 'unknown';
  const summary  = `${reporter} — ${issue.title.slice(0, 80)}`;
  return `| ${date} | ${today} | index.html | ${summary} | ${fix || 'Manual close'} |`;
}

function closeIssueInMd(md, issue, fix) {
  // Remove from Open section
  const updated = md.replace(issue.raw, '').replace(/\n{3,}/g, '\n\n');

  // Add to resolved table
  const row = buildResolvedRow(issue, fix);
  const tableHeader = '| Date Reported | Date Fixed | Page | Summary | Commit |';
  const tableIdx = updated.indexOf(tableHeader);
  if (tableIdx === -1) return updated; // can't find table, just remove

  // Insert after the separator line (the |---|...|)
  const separatorEnd = updated.indexOf('\n', updated.indexOf('|---|', tableIdx)) + 1;
  return updated.slice(0, separatorEnd) + row + '\n' + updated.slice(separatorEnd);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdList() {
  const { content } = await getFile();
  const issues = parseOpenIssues(content);
  if (issues.length === 0) {
    console.log('✅ No open bug reports.');
    return;
  }
  console.log(`📋 ${issues.length} open report(s):\n`);
  issues.forEach((iss, i) => console.log(`  ${i + 1}. [${iss.date}] ${iss.title}`));
}

async function cmdSync() {
  const { content } = await getFile();
  const issues = parseOpenIssues(content);
  console.log(`Synced. Open: ${issues.length}`);
  issues.forEach(iss => console.log(`  • [${iss.date}] ${iss.title.slice(0, 70)}`));
}

async function cmdCloseAll(fix) {
  const { sha, content } = await getFile();
  const issues = parseOpenIssues(content);
  if (issues.length === 0) { console.log('✅ Nothing to close.'); return; }

  let updated = content;
  for (const iss of issues) {
    updated = closeIssueInMd(updated, iss, fix);
  }

  // Clean up the open section
  updated = updated.replace(
    /## Open Issues[\s\S]*?(?=## Resolved Issues|$)/,
    `## Open Issues\n\n_No open issues — all resolved._\n\n`
  );

  await putFile(updated, sha, `bug-sync: close-all (${issues.length} reports) — ${fix || 'manual'}`);
  console.log(`✅ Closed ${issues.length} report(s) and pushed to ${BRANCH}.`);
}

async function cmdClose(titleMatch, fix) {
  const { sha, content } = await getFile();
  const issues = parseOpenIssues(content);
  const match  = issues.find(i => i.title.toLowerCase().includes(titleMatch.toLowerCase()));
  if (!match) { console.log(`No open report matching: "${titleMatch}"`); return; }

  let updated = closeIssueInMd(content, match, fix);

  // If no more open issues, replace the open section placeholder
  const remaining = parseOpenIssues(updated);
  if (remaining.length === 0) {
    updated = updated.replace(
      /## Open Issues[\s\S]*?(?=## Resolved Issues|$)/,
      `## Open Issues\n\n_No open issues._\n\n`
    );
  }

  await putFile(updated, sha, `bug-sync: close "${match.title.slice(0, 50)}" — ${fix || 'manual'}`);
  console.log(`✅ Closed: [${match.date}] ${match.title}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN) { console.error('FATAL: GITHUB_TOKEN not set in .env'); process.exit(1); }

  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'list':      return cmdList();
    case 'sync':      return cmdSync();
    case 'close-all': return cmdCloseAll(args[0]);
    case 'close':     return cmdClose(args[0], args[1]);
    default:
      console.log('Usage:');
      console.log('  node bug_manager.js list');
      console.log('  node bug_manager.js sync');
      console.log('  node bug_manager.js close-all [commit-ref]');
      console.log('  node bug_manager.js close "<title-match>" [commit-ref]');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
