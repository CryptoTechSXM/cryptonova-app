# V8.49 SCOPE — opened 2026-08-13, the evening V8.48 went live

Audience: a future session of Claude, plus the owner. Nobody else touches this code.
Read `V8_48_HANDOFF.md` first for the V8.48 deployed state; this file is what comes NEXT.

---

## ITEM 1 — SEPARATE THE EVICTION CLOCK FROM THE RESCUE CLOCK ⛔ TOP PRIORITY

**Owner policy, stated 2026-08-13 (deploy day), verbatim in substance:**
> "The SF always grows organically, eviction should not happen for 3 to 5 days.
> We do not seed SF, it grows organically. 24hrs of registrations before automated
> rescue kicks in on testnet and 48hrs on mainnet — that is by design, to have
> members rescue themselves before SF takes over."

**VERIFIED AGAINST THE CODE THE SAME DAY. Two of the three hold; one does not.**

| policy | code | verdict |
|---|---|---|
| SF grows organically, never seeded | no seeding anywhere in the deploy path; SF fills from `receiveLayer` fee splits | ✅ holds — and a deploy-day proposal to seed it was WRONG and was withdrawn |
| rescue waits 24h (testnet) / 48h (mainnet) | `parkedGracePeriod` = 86,400s, set by `deploy_v8.js`; mainnet is a config change to 172,800s, not code | ✅ holds |
| **eviction not for 3–5 days** | **`MatrixKeeperLib.sol:458-461` — the evict branch gates on `cfg.parkedGracePeriod`, THE SAME 24h CLOCK. There is no eviction-specific grace anywhere in the contracts.** | ❌ **NOT BUILT** |

The code at `MatrixKeeperLib.sol:455-461`:
```solidity
// EVICTION KEEPS THE FULL GRACE PERIOD. Eviction removes a member who has already
// taken out most of what they earned; there is no "costs the fund nothing"
// version of it, and nothing about it is urgent.
if (evict) {
    if (age < cfg.parkedGracePeriod) return (address(0), type(uint8).max);
    return (parkedMember, WORK_EVICT_PARKED);
}
```
"The FULL grace period" means the full **24 hours** — the comment is about not giving
eviction the *shortened* self-funded path from item 12. It was never 3–5 days.

### Why this is newly urgent in V8.48 specifically

**Evictions have NEVER FIRED, in any version.** `evict_parked.js`'s cron guard
(`pgrep -f evict_loop.sh`) always matched its own parent shell, so the script never
ran once. V8.48 moved eviction ON CHAIN (item 47's two-branch valve) AND the keeper
EOA is now authorized (see the V8.48 deploy-day trap). **V8.48 will therefore produce
the first real evictions in the system's history — on a 24-hour clock the owner does
not intend.**

### Who is actually exposed (from `_triageParked`, MatrixKeeperLib.sol:358-403)

`evict = true` in four cases:
1. **GHOST** — already seated in either half of the pair. The valve DEQUEUES ONLY;
   nobody loses a seat. Harmless, and item 45 is meant to drive this to zero.
2. `withdrawRatio > rescueRatioBps` — has taken out most of what they earned.
3. `sfBps == type(uint256).max` — off the bottom of the rescue ladder, too thin.
4. **Item 46 insolvency floor** — `!loanEligible(member, tier)`, i.e. debt already
   >= 34% of the tier fee. Self-funded members (`sfShare == 0`) are never floored.

Cases 2–4 evict a REAL member. None of them can trigger on a chain that is hours old —
debt and withdrawal history take days to accumulate — which is why this is a V8.49
item and not a hotfix. **The exposure grows every day the network runs.**

### The fix

Add a governed `evictionGracePeriod` (suggest default **4 days = 345,600s**, DAO param,
enumerated and capped like `selfFundedGracePeriod`), thread it through `ScanCfg`, and
use it in the evict branch:
```solidity
if (evict) {
    if (age < cfg.evictionGracePeriod) return (address(0), type(uint8).max);
    return (parkedMember, WORK_EVICT_PARKED);
}
```
Points to settle when building it:
- **Should GHOST dequeue wait at all?** A ghost holds a queue slot it can never use and
  a dequeue costs the member nothing. Argument for keeping ghosts on the SHORT clock
  (or no clock) and giving only cases 2–4 the long one. **Owner decision.**
- Mainnet parity: `parkedGracePeriod` 48h and `evictionGracePeriod` 3–5 days must be
  set at mainnet deploy, not left at testnet defaults. Add both to `predeploy_check.js`
  as declared-default assertions so they cannot silently ship wrong.
- Do NOT try to solve this by raising `parkedGracePeriod` via governance: one knob
  drives both clocks, so it would push SF rescue out to 3–5 days and break the 24h
  design. That is exactly why a second param is needed.

### Until V8.49 ships — the interim position (owner chose: fix properly, watch daily)

Watch for the first eviction ever recorded: `MemberEvicted` / `GhostDequeued` events,
`diag_ghost_parked.js`, and the keeper log. If evictions start hitting real members
before V8.49 is ready, the emergency lever is **PARAM 59 → `insolvencyFloorBps = 0`**,
which disables case 4 only (cases 2 and 3 remain, and are pre-V8.48 behaviour).

---

## ITEM 2 — THE WALLET RPC (carried from the V8.48 handoff, likely the biggest member win)

`index.html:2834` and `:2903` call `wallet_addEthereumChain` with
`rpcUrls: ['https://sepolia.base.org']` — the PUBLIC endpoint. The site's own READS go
through a healthy 5-endpoint QuickNode pool, but every member whose wallet our site
configured SENDS TRANSACTIONS through the public one. A Cloudflare 502 from it during
registration is what dumped raw HTML into an `alert()` on deploy day.

**Prime suspect for the "❌ Transaction failed on-chain — hard-refresh" report class,
the single most common member complaint in BUGS.md.** Not changed on deploy day because
it governs how every NEW member adds the network, and verifying it needs a wallet that
has never had Base Sepolia configured.

**Owner decision required with it:** a QuickNode URL placed in a member's wallet is used
for ALL their Base Sepolia activity, not just our site, burning quota the owner pays for.
Consider a dedicated endpoint kept OUT of the site's read pool, so one member cannot
degrade the dashboard for everyone.

---

## ITEM 3 — THE UN-PROPAGATED-FIX SWEEP

Three times now a defect has been fixed in one place and left live in a sibling:
items 30 and 39, the epoch `.catch(() => 1)` (fixed at :3451, still live at :6410 until
a later session caught it), and on deploy day the **post-action dashboard refresh** —
`_staggeredDashRefresh()` was written 2026-08-06 for Kira's upgrade/rescue report and
wired into 8 sites, while all three WITHDRAW paths kept the single 3.5s read the same
commit's own comment calls unreliable. Members saw a stale balance and clicked Withdraw
again. Fixed on deploy day (now 12 call sites).

**This is a pattern, not three coincidences.** Worth a dedicated session: for every
"fixed" entry in BUGS.md and the audit notes, grep for OTHER call sites of the same
defective shape and check whether the fix reached them. Deliverable: a list, then fixes.

---

## ITEM 4 — SMALLER CARRIED ITEMS

- **Raw RPC error dumped into `alert()`** — the 502 rendered a wall of raw HTML/JS in a
  browser popup during registration. Needs the honest-error treatment `doWithdraw()` got.
- **`uBal` display fabrication** — `usdc2.balanceOf(...).catch(() => 0n)` at
  `index.html:5581` shows **$0.00 USDC** if the read drops. Display-only (approve enables
  unconditionally, the contract judges), so D2 class. Deploy-day sweep result: **130
  value-returning catches remain in index.html; none found gating an action.**
- **Stale banner text in `deploy_v8.js`** — prints "V8.41 Deploy" and
  "ADDRESSES_FILE=…v8_47.json must be set". Cosmetic; reads as a live warning mid-deploy.
- **Epoch-transparency panel** — the ONLY part of the old NEXT UP #2 still open; the
  `.catch(() => 1)` half is already fixed. All four epoch getters exist on chain.
- **Item 46's dashboard surface** — "no loan — insolvency floor; self-rescue or eviction
  follows". Ships with, and is the member-facing half of, item 1 above.
- **`deploy_v8.js` does not authorize the keeper EOA** — now step 1.3c in the runbook,
  but the real fix is to do it IN the deploy script so no future deploy can miss it.

## ITEM 5 — THE EARLY-EXIT PENALTY IS NOW LIVE FOR THE FIRST TIME (member comms)

`earlyExitPenaltyBps` returned 0 on every previous deployment because
`setMemberTracker` was never called. V8.48 wired it (item 13), so the V4 ladder
(0–30d **45%**, 31–60d 30%, 61–90d 15%, 91–120d 5%, 121d+ 0%) is enforced for real —
and the redeploy resets every long-standing member to day 0, i.e. 45%. Nothing in the
deploy announcement mentions it. **Not a bug; a communications decision the owner should
make deliberately rather than let a member discover it by trying to redeem.**
