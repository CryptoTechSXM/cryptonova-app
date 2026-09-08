// scripts/nonce_verdict.js — R17 (2026-09-08). Pure verdict used by deploy_v8.js before EVERY send.
// The deployer wallet must be quiet for the whole deploy: NonceManager numbers our transactions
// locally, so if another process (VPS rr_keeper / system_keeper, which sign with DEPLOYER_PRIVATE_KEY)
// sends from the wallet mid-run, the chain's pending count runs AHEAD of ours and our next send
// dies as "replacement transaction underpriced" — attempt 1 of the V8.53 private deploy, 488 s in.
//   chain ahead  -> "foreign": abort with the cause BEFORE the collision
//   chain behind -> "lag": a lagging node (rpc_resilience territory), warn and continue on the local nonce
//   equal        -> "ok"
// Proven: scripts/harness/nonce_verdict_test.js (3/3 branches + the boundary).
function nonceVerdict(expectedNext, chainPending) {
  expectedNext = Number(expectedNext); chainPending = Number(chainPending);
  if (!Number.isFinite(expectedNext) || !Number.isFinite(chainPending)) {
    return { action: "lag", msg: `nonce read unusable (ours ${expectedNext}, chain ${chainPending}) — continuing on the local nonce.` };
  }
  if (chainPending > expectedNext) {
    return { action: "foreign", msg:
      `R17 FOREIGN TRANSACTION: the chain shows ${chainPending} pending transactions from the deployer but this ` +
      `run has only reached nonce ${expectedNext}. Another process is signing with the deployer wallet — on the ` +
      `VPS that is rr_keeper / system_keeper (DEPLOYER_PRIVATE_KEY). STOP: touch /root/keeper/rr_keeper.OFF ` +
      `/root/keeper/system_keeper.OFF, wait 5 minutes, then re-run (addresses are written only at the end, ` +
      `so nothing from this run is recorded). GO_LIVE_RUNBOOK.md 0.2-PRIVATE.` };
  }
  if (chainPending < expectedNext) {
    return { action: "lag", msg:
      `node reports ${chainPending} pending vs our ${expectedNext} — a lagging node, not a foreign transaction; ` +
      `continuing on the local nonce.` };
  }
  return { action: "ok", msg: "" };
}
module.exports = { nonceVerdict };
