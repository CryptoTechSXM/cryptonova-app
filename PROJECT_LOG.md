# CryptoNova — Project Log

Update the "Current State" section and add a session entry after every working session.

---

## Current State (updated 2026-07-03)

### Live version: V8.31
- **Network:** Base Sepolia (testnet)
- **Deployed:** 2026-07-03
- **Deployer:** 0x5EaEfA3086F025099f224cBe64fc9b3787533BB4
- **Addresses file:** `scripts/deployed_addresses_v8_31.json`
- **W1 status:** Seeded at T1 MatA position-1 (root), 1/127 occupancy

### Key V8.31 contract addresses
| Contract | Address |
|----------|---------|
| cnova | 0x8e81Ea3fE21DfFe30804cB46bE8543bD32CeC626 |
| treasury | 0x3980ed891B29d8745E6e116B8e010ac74701Da6f |
| stabilityFund | 0xE7f9046d6CbD2589e8651A12D32C57fA0dEbdA1C |
| buybackReserve | 0x97972bE52D3CDB6597C468D0F572c06f8805742b |
| tierRouter | 0x3A569619f0FB2A0ef48d7eDB1BFeA34AeF35512c |
| matrixFactory | 0xA7833Ba609335306D8D9e7ecb0535f4E53e80c1a |
| matrixKeeper | 0xA56F7dFa7665fA413993AcF3902903D2A9BfabF2 |
| v8Governance | 0x12c884DF4321098fc0Cddf09e946fb2d9e60d881 |
| communityWallet | 0xB414d754AEaB17f37F4F95652Cf483dc7ba23E71 |
| directSale | 0x247a748D07784352b3Fb384Fe0D624DbaF599616 |
| couponRegistry | 0x20b66F6fb4554d0CD283590d747c5474d2923971 |
| usdc (unchanged) | 0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a |
| liquidityReserve (unchanged) | 0x961fDE5C78200891f36858B2940a2B6d4F1Af854 |

### Keeper tasks (Windows Task Scheduler)
| Task name | Status | Script |
|-----------|--------|--------|
| `\CryptoNova-Rescue` | ACTIVE | manual_rescue.js |
| `\CryptoNova Rescue Keeper` | ACTIVE | (check — one still pops up window) |
| `\CryptoNova-V8-Monitor` | ACTIVE | monitor_silent.ps1 (popup fixed) |
| `\CryptoNova CRE Keeper Staging` | DISABLED | Needs receiver update to V8.31 matrixKeeper |
| Others (4) | DISABLED | Re-enable only after verification |

### Frontend repos
| Repo | Branch | URL | Status |
|------|--------|-----|--------|
| CryptoNova-Testnet-App | admin | admin.crypto-nova.app | ACTIVE — V8.31 addresses live |
| CryptoNova-Testnet-App | preview | early.crypto-nova.app | Not yet pushed |
| CryptoNova-Testnet-App | main | crypto-nova.app / v8.crypto-nova.app | Not yet pushed |
| CryptoNova-Mainnet-App | — | cryptonova.ai | PARKED until July 19 2026 |

### Stability Fund status
- Balance: ~$0.27 (CRITICAL — needs top-up before bigfill)
- Run `sf_topup_t1.js` or transfer USDC directly to the SF contract address

---

## Pending work (next session priority order)

- [ ] **Identify + fix remaining popup keeper task** (one of the 3 re-enabled tasks still shows a window)
- [ ] **Fund Stability Fund** — needs USDC before bigfill. Run `sf_topup_t1.js`.
- [ ] **Update CRE keeper receiver** — change Chainlink receiver to V8.31 matrixKeeper (`0xA56F7dFa7665fA413993AcF3902903D2A9BfabF2`)
- [ ] **Run bigfill** — after SF funded + admin site green
- [ ] **Verify admin site post-V8.31** — do full visual sweep, check all pages load correctly
- [ ] **Task #52** — crossing reserve UI display (show 50/5/45 split info on frontend)
- [ ] **Task #59** — free re-entry for wrongfully reclaimed members
- [ ] **Task #60** — fix ghost-parked state left in lower tier after auto-upgrade
- [ ] **Task #36** — votable rescue loan interest rate (governance, deferrable)
- [ ] **QuickNode subscription** — before July 19, set as primary RPC, Alchemy as fallback
- [ ] **Push admin → preview → main** — after admin verified clean + leader sign-off

---

## Mainnet target: July 19 2026

- **Soft launch:** July 19 2026 (open registration, leader referral links, coupons live day 1)
- **Domain:** cryptonova.ai (gated until July 19 12pm EST)
- **Early access:** ea.cryptonova.ai (coupon-only, 9am EST)
- **Admin:** admin.cryptonova.ai (always open)
- Option A: V8.30 launches July 19. Option B: V8.31 launches July 19 (preferred — has selfRescue, coupon fixes, crossing reserve).

---

## Session log

### 2026-07-03 — V8.31 deploy + frontend update

**What was done:**
- V8.31 deployed to Base Sepolia
  - 50/5/45 crossing reserve model (Option B BPS: L1=700, L2-L6=600, Pool=4000, SF=600, Treasury=1000)
  - registerWithCoupon globalJoined flag fix
  - sfBal fallback fix (stalls when bucket has pennies, not just exact zero)
  - selfRescue() added, coupon system live
- W1 seeded at T1 MatA position-1 (root) via seed_w1.js
  - USDC mint issue: MockUSDC owned by 0xCd0Af6, workaround = transfer from funded wallet
- 3 keeper tasks re-enabled (Rescue, Rescue Keeper, Monitor)
- monitor_silent.ps1 popup fixed: removed `cmd /c` subprocess, inlined bat logic directly in PS1
- system_keeper.js: V8.30 → V8.31 version banner; SF target hardcoded $200 clamp removed (now always shows real on-chain sfTarget())
- deploy_v8.js: version strings V8.18/V8.26 → V8.31
- All 5 frontend HTML files updated with V8.31 addresses (82 replacements)
  - Script: update_addrs.py (in Cowork outputs folder)
  - Committed 1f6d59a to admin branch
- index.html truncation bug fixed: Python wrote truncated version from stale mount cache; rebuilt from git commit 9bf49ce, re-applied replacements, stripped null bytes
  - Committed (pending — git add done, commit not yet run as of this entry)
- Created CLAUDE.md (testnet-app repo), CLAUDE.md (contracts repo), PROJECT_LOG.md (this file)

**Commits this session:**
- CryptoNite-Smart-Contracts: f581e4f (script fixes: version banners, SF target display)
- CryptoNite-Smart-Contracts: d48a979 (deployed_addresses_v8_31.json)
- CryptoNova-Testnet-App: 1f6d59a (V8.31 address update, 82 replacements)
- CryptoNova-Testnet-App: TBD (index.html truncation fix + CLAUDE.md)

**Known issues carried forward:**
- One keeper task still shows a popup window (not yet identified which one)
- SF at $0.27 — critical, needs manual top-up before bigfill
- CRE keeper receiver still points to V8.30 matrixKeeper — do not re-enable until updated
- sfTarget() returns $300 instead of $200 on fresh deploy (highestOpenTier() returns 0 when T1 is deployed but not organically active — fallback to $300 manual default). Non-blocking since Telegram and terminal now both show the real on-chain value consistently.
