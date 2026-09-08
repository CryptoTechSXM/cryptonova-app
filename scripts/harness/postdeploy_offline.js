// scripts/harness/postdeploy_offline.js — OFFLINE harness for scripts/postdeploy_check.js (session 66, R15).
// The device shell has no RPC, so the pauser row was proven with canned JSON-RPC answers instead.
// Every other row is fed values that PASS, so a run isolates the pauser branch under test.
//
// Run from the contracts repo root (C:\CryptoNite-Smart-Contracts\CryptoNova):
//   PD_MODE=absent|zero|set  [PAUSER_WALLET=0x..]  [PD_CHAIN=0x14a34|0x2105]
//   SKIP_VERIFY_GATE=1 BASE_SEPOLIA_RPC_URL=http://127.0.0.1:1 ADDRESSES_FILE=deployed_addresses_v8_52.json
//   node -r ./scripts/harness/postdeploy_offline.js scripts/postdeploy_check.js
// For the mainnet branches use a scratch copy of a book with "chainId": 8453 and PD_CHAIN=0x2105.
// Proven 2026-09-08: 8/8 branches (absent/zero/set/set+match/set+mismatch on 84532; absent/set-no-env/match on 8453).
const { ethers } = require("ethers");
const MODE = process.env.PD_MODE, CHAIN = process.env.PD_CHAIN || "0x14a34";
const sel = (sig) => ethers.id(sig).slice(0, 10);
const u = (n) => ethers.toBeHex(n, 32), a = (x) => ethers.zeroPadValue(x, 32);
const fee = 10n * 10n ** 6n;
const table = {
  [sel("upkeepCaller(address)")]: u(1),
  [sel("stabilityFloor()")]: u(fee * 3n),
  [sel("tierEntryFees(uint256)")]: u(fee),
  [sel("sfTargetMultiplier(uint256)")]: u(3),
  [sel("totalBalance()")]: u(fee * 10n),
  [sel("graduationEnabled()")]: u(1),
};
function answer(m, args) {
  if (m === "eth_chainId") return CHAIN;
  if (m === "eth_blockNumber") return "0x1";
  if (m === "eth_call") {
    const s = args[0].data.slice(0, 10);
    if (s === sel("pauser()")) {
      if (MODE === "absent") return "0x";
      if (MODE === "zero") return u(0);
      return a("0x00000000000000000000000000000000000000AA");
    }
    if (table[s]) return table[s];
  }
  throw new Error("unsupported " + m);
}
ethers.JsonRpcProvider.prototype._send = async function (payload) {
  const arr = Array.isArray(payload) ? payload : [payload];
  return arr.map((r) => ({ id: r.id, jsonrpc: "2.0", result: answer(r.method, r.params) }));
};
