// check_addrs.js — sanity-check the addresses file: does code exist at each address?
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ADDRS_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_42.json";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRS_FILE), "utf8"));
  console.log(`File: ${ADDRS_FILE}\n`);
  const flat = { tierRouter: addrs.tierRouter, matrixKeeper: addrs.matrixKeeper, usdc: addrs.usdc, cnova: addrs.cnovaToken || addrs.cnova, sf: addrs.stabilityFund };
  for (const [k, v] of Object.entries(flat)) {
    if (!v) { console.log(`${k}: (missing)`); continue; }
    const code = await provider.getCode(v).catch(() => "0x");
    console.log(`${k}: ${v} — ${code.length > 2 ? "✅ contract" : "❌ NO CODE"}`);
  }
  for (const tk of Object.keys(addrs.tiers || {})) {
    const pm = addrs.tiers[tk]?.pm;
    if (!pm) continue;
    const code = await provider.getCode(pm).catch(() => "0x");
    console.log(`${tk}.pm: ${pm} — ${code.length > 2 ? "✅" : "❌ NO CODE"}`);
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
