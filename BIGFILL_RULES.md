# BIGFILL RULES - read before every stress/fill run

**OWNER RULE (2026-07-25). Bigfill does FOUR things and nothing else:**

```
1. register
2. self rescue
3. manual upgrade
4. repeat
```

Anything else is noise that pollutes the test data and burns test funds.

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
