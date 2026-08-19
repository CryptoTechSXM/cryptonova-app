# BIGFILL RULES - read before every stress/fill run

**OWNER RULE (2026-07-25, EXTENDED 2026-08-19). Bigfill does FIVE things and nothing else:**

```
1. register  — ONE new member per run (was 127; changed 2026-08-19)
2. self rescue
3. manual upgrade
4. eviction re-entry — an evicted member gets back in, pays their fees, upgrades if eligible
5. repeat
```

Anything else is noise that pollutes the test data and burns test funds.

## Why ONE registration per run (measured, 2026-08-19)

The fund is fed by the SWEEPS, not by bulk registration. `scripts/diag_sf_usdc_ledger.js`
read every USDC transfer in and out of the StabilityFund over V8.48's life and reconciled
exactly (in $1,401.79 / out $1,364.86 / balance $36.94 = balanceOf = totalBalance):

| regime | daily net | self-rescues/day | keeper rescues/day | SF lending/day |
|---|---|---|---|---|
| bigfill running | **+$111** | 73.5 | 11.5 | $76.72 |
| bigfill stopped | **-$136** | 16.0 | 44.3 | $345.68 |

Four bigfill days all positive, three quiet days all negative, no overlap. Stopping bigfill
QUADRUPLED the rescues the fund pays for. Bulk registration inflates the member count
without adding any of that — the sweeps run over ALL historical wallets regardless of
`-Count`, so one registration per run keeps the economy moving without the inflation.

⚠ NEITHER REGIME IS THE REAL WORLD: bigfill wallets self-rescue and upgrade every time
(~100%), stopped they do neither (0%). Real members sit between. Read +$111 and -$136 as a
BRACKET, never as the answer.

## ⚠ ABOUT ACTION 4 — IT SIMULATES SOMETHING PRODUCTION CANNOT DO (yet)

Verified in the contracts 2026-08-19: eviction does NOT clear `globalJoined`, `register()`
reverts for anyone who has ever joined, and auto-reentry/double-entry are read inside the
CYCLE-OUT handler so they need a seat an evicted member no longer holds. **An evicted member
has no way back on their own.** The phase works by owner `setGlobalJoined(member,false)`
followed by a normal fee-paying registration.

Owner decision 2026-08-19 was BOTH: run it here now so the fund stays measurable, AND scope
a real member-callable re-entry into V8.50. **Until V8.50 ships, do not read "evicted members
returned" in bigfill data as something the live community can do.**

What is clean: `_recordJoin` is idempotent, so a returning member does not double-count
`uniqueMembers` and keeps their original join clock. Sponsor is preserved from
`memberReferrer` where the chain still knows it, so referral history is not rewritten.

Turn it off with `-NoEvictReentry`; cap it with `-EvictReentryMax <n>` (default 25).

---

## ALWAYS run it through the wrapper

```powershell
powershell -ExecutionPolicy Bypass -File C:\CryptoNite-Smart-Contracts\CryptoNova\run_bigfill_rr.ps1
```
Options: `-Count 127 -Offset 0 -SelfRescueRate 1.0 -UpgradeRate 0.75`

**Do NOT call `npx hardhat run scripts/bigfill_v8.js` directly** - the raw script's
DEFAULTS turn on things the owner rule forbids (see table).

## What the wrapper switches OFF (and what the raw defaults would do)

| Env var | Wrapper sets | Raw default | What the default would do |
|---|---|---|---|
| `CNOVA_BUY_RATE` | `0` | `0.25` | 25% of wallets buy CNOVA each cycle |
| `CNOVA_SELL_RATE` | `0` | `0.15` | 15% of wallets sell/earlyUnlock CNOVA |
| `BURN_SIMULATE` | `false` | ON | `earlyUnlockAll()` burn sweep at the end |

## What stays ON (the owner-approved actions)

| Env var | Wrapper default | Meaning |
|---|---|---|
| `SELF_RESCUE_RATE` | `1.0` | every parked wallet self-rescues (pays own shortfall, no debt) |
| `UPGRADE_RATE` | `0.75` | 75% of eligible wallets do a manual upgrade |
| `ROUND_ROBIN` | 39 leader addresses | rotates sponsors so L1 spreads across leaders |

## Round-robin notes

- Set SESSION-ONLY by the wrapper, so the VPS `stress_keeper.js` (own 7-address
  list in `/root/keeper/.env`) is unaffected.
- V8.44 change: unregistered addresses are **skipped**, not fatal. Before, one
  unregistered address aborted the entire run.
- Rotation is `wallet[i] -> leader[i % activeCount]`, fixed at run start. Leaders
  who register mid-run join on the NEXT run.
- Trim the roster by editing the `$leaders` list in `run_bigfill_rr.ps1`.

## Sequencing

- `-Offset` is the BIP-44 wallet index to start from. To continue after a
  127-wallet run, use `-Offset 127` next, then `-Offset 254`, etc. Re-using an
  offset means re-using wallets that are already `globalJoined` (they'll be
  skipped as "already joined").
- On a FRESH deploy start at `-Offset 0` - the new TierRouter has no join history.

## V8.44 watch-list while running

- Every pair's MatB `rotationCount` must CLIMB (it froze at 0 on V8.43).
- Parked count should drain, not pile up.
- No wallet should hold `crossingReserve > 0` while neither seated nor parked
  (that is the stranded-funds bug class - report immediately).
- Full-cascade registration gas should sit well under the ~17.8M public-RPC cap.
