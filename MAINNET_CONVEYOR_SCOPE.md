# CryptoNova Mainnet — Conveyor Belt Matrix: Technical Scope

**Version:** 0.2  
**Date:** 2026-05-28  
**Status:** Locked — ready for implementation  

---

## 1. Why This Change

The testnet contract uses a **full-reset cycle model**: when all 254 slots fill, everyone
re-enters a fresh tree. Early movers who accumulated a large re-entry pool tend to
re-take top spots, leaving late joiners structurally disadvantaged across cycles.

The mainnet contract replaces this with a **conveyor belt model**:

- 254 active earning positions at any time (after initial fill)
- When a new member joins, **position 1 person rotates to the back of the queue** (free, automatic re-entry)
- **Positions 2–254 each advance one spot** (2 → 1, 3 → 2, etc.)
- The new member fills the last position
- **Everyone eventually reaches position 1** — no permanent top class
- **Members never leave the system** — pay once, cycle forever

This is a one-time-payment system. Members pay $10 USDC once and remain in the
matrix permanently, re-entering the back of the queue each time they reach position 1.

---

## 2. Core Mechanic — Dynamic FIFO Queue

### Why a dynamic queue instead of a fixed ring buffer

A fixed ring buffer (address[254]) can only hold 254 addresses. When re-entry is
added (rotated-out member goes to back of queue AND new member also joins), we need
to accommodate 255+ entries. A dynamic queue solves this in O(1) per join.

### Data layout

```solidity
address[] private queue;              // grows as members join; never shrinks
uint256   public  head;               // index of position-1 member (0-based)
uint256   public  occupancy;          // how many slots filled (0 → 254, then stays 254)
uint256   public  totalJoined;        // unique lifetime members (never decrements)
uint256   public  rotationCount;      // how many full rotations have occurred

mapping(address => uint256) private memberQueueIndex;  // current active index in queue[]
```

### How positions map to queue indices

```
// 1-based position from queue index
position(idx) = idx − head + 1

// queue index from 1-based position
queueIndex(p) = head + p − 1

// who is at position p right now?
memberAtPosition(p) = queue[head + p − 1]
```

### The active earning window

Positions **1 through 254** are the "active" slots — these are the ancestors used for
chain pay calculations. Any member at position > 254 is in the queue and earns
chain pay as an ancestor when they advance into the top 254.

At launch (occupancy < 254): all joined members are active (positions 1 to occupancy).
After full (occupancy = 254): active window is always positions 1–254.

### Reading tree ancestors from position

The 7-level binary tree is **implicit** — no parent/child pointers stored.
For a member at position `p`, their chain-pay ancestors are:

| Level | Ancestor position |
|-------|-------------------|
| 1     | floor(p / 2)      |
| 2     | floor(p / 4)      |
| 3     | floor(p / 8)      |
| 4     | floor(p / 16)     |
| 5     | floor(p / 32)     |
| 6     | floor(p / 64)     |
| 7     | floor(p / 128)    |

To find the **address** of any ancestor, compute their queue index:
`queue[head + ancestorPosition − 1]`. Each lookup is two arithmetic ops — no
storage traversal needed.

> **Key insight:** For any position p ≥ 1, all 7 ancestors have positions < p. So
> even when a new member joins at position > 254 (waiting zone), all their chain-pay
> ancestors are already in positions 1–254 (the active earning window). This means
> chain pay always flows to active, advancing members.

---

## 3. Re-entry Mechanics (V3 core feature)

### What re-entry means in V3

- Member pays $10 USDC **once**, at initial registration
- They enter the queue and advance toward position 1 as new members join
- When they reach position 1 and a new member joins, they **automatically re-enter**
  at the back of the queue — **no additional payment required**
- `originalReferrer` stays locked for life (set at first registration, never changes)
- Re-entry generates **no payment event** — only new $10 registrations distribute funds
- Members cycle through the 254 active positions indefinitely

### Why this works for earnings

Each time a member is in the active 254 positions, every new joiner whose ancestor
chain includes them will pay them chain pay. The closer to position 1, the more
ancestor relationships and the more frequent the earnings. After rotating out of
position 1 (free re-entry), they advance back toward position 1 — earning continuously
as they move up.

### Re-entry vs V2 re-entry pool

| V2 re-entry pool                          | V3 automatic re-entry              |
|-------------------------------------------|------------------------------------|
| Required payment per cycle                | Free — pay once forever            |
| Manual or pool-funded                     | Fully automatic on rotation        |
| Complex pool balance accounting           | No pool, no balance tracking       |
| Members could run out of re-entry funds   | Members can never be removed       |

---

## 4. Registration Flow

```
register(address referrer)
  ├── Verify not already registered
  ├── Collect $10 USDC from caller
  ├── If occupancy < 254:
  │     ── INITIAL FILL ──
  │     queue.push(msg.sender)
  │     memberQueueIndex[msg.sender] = queue.length − 1
  │     occupancy++
  │     totalJoined++
  └── If occupancy == 254:
        ── ROTATION ──
        rotatedOutAddr = queue[head]           // person leaving position 1
        head++                                  // advance pointer (O(1))
        queue.push(rotatedOutAddr)             // re-enter at back of queue (free)
        memberQueueIndex[rotatedOutAddr] = queue.length − 1
        queue.push(msg.sender)                 // new joiner behind re-entrant
        memberQueueIndex[msg.sender] = queue.length − 1
        totalJoined++
        rotationCount++
        emit MatrixRotation(rotationCount, rotatedOutAddr, msg.sender)
        ── end rotation ──
  ├── newPosition = positionOf(msg.sender)
  ├── Distribute chain pay (7 levels up implicit tree, from new joiner's position)
  ├── Pay $3.00 referral bonus to originalReferrer
  ├── Send treasury + dev/ops cuts
  ├── Mint CNOVA reward
  └── emit MemberRegistered(...)
```

> **Note:** After rotation, `msg.sender` is at `queue.length − 1` and their position
> is `queue.length − 1 − head + 1`. During initial fill this will be ≤254. After the
> first rotation, new joiners will land at position 255 (one step outside active window)
> and advance into the active window on the very next join.

---

## 5. Payment Split (new members only — re-entry is free)

| Destination      | Amount     | Notes                                    |
|------------------|------------|------------------------------------------|
| Referral bonus   | $3.00      | To originalReferrer (locked for life)    |
| Chain pay        | $4.00      | Distributed across up to 7 ancestors     |
| Treasury reserve | $2.50      | Up from $1.50 (absorbs freed re-entry $) |
| Dev + Ops        | $0.50      | Split between dev wallet and ops wallet  |
| **Total**        | **$10.00** |                                          |

> Re-entry events generate **zero payment**. Only new $10 registrations distribute funds.

### Chain pay breakdown (same 7 levels as V2)

| Level | Amount | 80% direct earn | 20% → treasury |
|-------|--------|-----------------|----------------|
| 1     | $1.33  | $1.06           | $0.27          |
| 2     | $0.80  | $0.64           | $0.16          |
| 3     | $0.67  | $0.54           | $0.13          |
| 4     | $0.53  | $0.42           | $0.11          |
| 5     | $0.35  | $0.28           | $0.07          |
| 6     | $0.21  | $0.17           | $0.04          |
| 7     | $0.11  | $0.09           | $0.02          |
| **Total** | **$4.00** | **$3.20**   | **$0.80**      |

If an ancestor slot is empty (initial fill period), that level's 80% earn goes to treasury.
The 20% pool always goes to treasury.

---

## 6. Member Struct

```solidity
struct Member {
    uint256  id;                  // sequential join number (unique members only)
    address  referrer;            // wallet that referred them at registration
    address  originalReferrer;    // locked at registration, never changes
    uint256  joinedAt;            // block timestamp of initial registration
    uint256  withdrawable;        // claimable USDC earnings
    uint256  totalEarned;         // lifetime earnings (for stats)
    uint256  reentryCount;        // how many times they've cycled back (starts 0)
    bool     isRegistered;
}

mapping(address => Member) public members;
mapping(uint256 => address) public memberById;  // join-order lookup (by unique ID)
```

Key difference from V2: **no `ringIndex`** — `memberQueueIndex` is a separate mapping
that updates each time a member re-enters. The Member struct stores immutable
registration data; the queue mapping tracks mutable position data.

---

## 7. View Functions

```solidity
// Current 1-based position of a member in the queue
function positionOf(address member) public view returns (uint256)

// Address at a given 1-based position right now
function memberAtPosition(uint256 position) public view returns (address)

// How many new joins until this member reaches position 1
function movesUntilRoot(address member) public view returns (uint256)

// Snapshot of active positions 1–254 (or 1–occupancy during fill)
function getActiveQueue() public view returns (address[] memory)

// Full queue length (total slots including waiting zone)
function queueLength() public view returns (uint256)

// Number of complete rotations that have occurred
// (same as public rotationCount state var, exposed for ABI clarity)
function getRotationCount() public view returns (uint256)

// True if member is currently in the active 254 earning window
function isActive(address member) public view returns (bool)
```

---

## 8. Events

```solidity
// Fired on every successful new registration
event MemberRegistered(
    address indexed member,
    address indexed referrer,
    uint256 memberId,
    uint256 position,        // their starting queue position
    uint256 cnovaRewarded
);

// Fired when a rotation occurs (matrix was full, new joiner caused rotation)
event MatrixRotation(
    uint256 indexed rotationNumber,
    address indexed rotatedToBack,   // person who left position 1 → re-entered at back
    address indexed newJoiner        // person who triggered the rotation
);

// Fired when a member's automatic re-entry completes
event MemberReentered(
    address indexed member,
    uint256 reentryCount,            // how many times they've re-entered total
    uint256 newPosition              // their position after re-entry (back of queue)
);

// Fired when a member withdraws earnings
event EarningsWithdrawn(address indexed member, uint256 amount);

// Fired for each chain-pay recipient
event ChainPayment(
    address indexed recipient,
    uint256 level,
    uint256 amount,
    uint256 fromPosition,
    uint256 toPosition
);
```

---

## 9. Removed Features (vs V2 testnet)

| Feature              | Reason removed                                         |
|----------------------|--------------------------------------------------------|
| Re-entry pool        | Re-entry is free and automatic — no pool needed        |
| `topUpReentryPool()` | Function no longer meaningful                          |
| Re-entry payment     | Members pay once only                                  |
| Cycle ID tracking    | Replaced by `rotationCount` (continuous counter)       |
| BFS node struct      | Tree is implicit from position — no storage needed     |
| `getNode(nodeId)`    | Replaced by `memberAtPosition(position)`               |
| `bfsHead` per cycle  | Replaced by queue `head` pointer                       |
| `CYCLE_TRIGGER`      | No hard reset — rotation is per-join, not per-fill     |
| Fixed ring[254]      | Replaced by dynamic queue (supports re-entry + growth) |

---

## 10. What Stays the Same

- $10 USDC entry fee (paid once only)
- `originalReferrer` locked for life
- $3.00 referral bonus
- 7-level chain pay structure and amounts
- CNOVA token minting on registration
- CNOVATreasury contract (separate, unchanged)
- Dev wallet + ops wallet split
- `withdraw()` for claimable USDC
- Community wallet / default referrer (set at deploy time)
- Founder pool for first 1,000 members (monthly claimable from community wallet)
- Base chain deployment

---

## 11. Scalability — 1M+ Members

Each `register()` call is O(1) regardless of total queue size:
- 2 `array.push()` calls (re-entrant + new joiner) — O(1) amortised
- 2 mapping writes (`memberQueueIndex` updates) — O(1)
- `head++` — O(1)
- 7 ancestor lookups (queue index reads) — O(1) each

**Storage growth:** queue array grows by 2 per new join after initial fill
(1 re-entrant address appended + 1 new joiner address appended). At 1M members:
queue length ≈ 254 + 2 × (1M − 254) ≈ 2M entries × 20 bytes = ~40 MB over the
lifetime of the contract. On Base (EVM L2), this is feasible — storage slots are
cheap relative to Ethereum mainnet.

**Base chain capacity:** ~2M transactions/day. At 1,000 joins/day the contract
uses 0.05% of daily capacity. At 10,000 joins/day, 0.5%. No bottleneck.

**Rotation speed:** With 1M members, a new join moves position-1 person to position
~2M (very back). They'll advance 1 spot per new join. To cycle back to position 1
requires ~2M new joins. At 10,000 joins/day that's ~200 days per cycle — still
rewarding. Members earn chain pay on every new join while they're in positions 1–254
during each cycle.

---

## 12. Edge Cases

### 12a. Initial fill period (occupancy < 254)
Queue grows from 0 to 254. No rotations. Chain pay flows to filled ancestor positions;
empty ancestors → that level's earnings go to treasury.

### 12b. Re-entrant AND new joiner order at position 254
After rotation: re-entrant is appended first (index N), new joiner second (index N+1).
Re-entrant lands at position N − head + 1, new joiner at N+1 − head + 1.
New joiner is always one position behind the re-entrant. Both are in the "waiting zone"
(positions > 254) and advance into the active window on the next join.

### 12c. Referrer not in matrix
Same as V2 — fall back to community wallet address as default referrer.

### 12d. Duplicate registration guard
`require(!members[msg.sender].isRegistered)` — no re-registration allowed.
Re-entry is automatic; members cannot call register() again.

### 12e. Chain pay when ancestor slot is in waiting zone
During initial fill, some ancestor positions may be unfilled (address(0) → treasury).
After full, all 7 ancestors of any position ≤ 254 are in positions 1–127, which are
always within the active window. This resolves itself as the matrix fills.

### 12f. Gas estimate per register()
- 2 SSTORE for queue pushes
- 2 SSTORE for memberQueueIndex updates
- 1 SSTORE for head++
- 7 SLOAD for ancestor addresses
- 7 USDC transfers (or accumulate to withdrawable + 1 SSTORE each)
- 1 CNOVA mint
- **Estimated: ~180,000–230,000 gas** (comparable to V2)

---

## 13. Contract Architecture (unchanged)

```
CryptoNovaMatrix (new V3)
    └── calls → CNOVAToken.mint()
    └── reads → CNOVATreasury.floorPrice()
    └── pays  → CNOVATreasury (treasury cut)

CNOVAToken       (unchanged from testnet V2)
CNOVATreasury    (unchanged from testnet V2)
```

---

## 14. Frontend Changes Required

| Area                   | Change needed                                                    |
|------------------------|------------------------------------------------------------------|
| Matrix tree view       | Show queue positions instead of BFS node IDs                     |
| My Position banner     | Show current position + `movesUntilRoot()` countdown            |
| Stats bar              | Replace "Cycle Fill" with "Rotation Count" + "Queue Length"     |
| Re-entry pool UI       | Remove entirely (dashboard, register page)                       |
| Re-entry count         | Add "Re-entered X times" to member profile                       |
| My Directs             | Unchanged — still scans by `originalReferrer`                   |
| Active/waiting badge   | Show "Active" if position ≤254, "Waiting" if position >254      |
| New stat: Moves to #1  | "You are X joins away from position 1"                          |

---

## 15. Locked Decisions Summary

| Decision                  | Value                                                  |
|---------------------------|--------------------------------------------------------|
| Re-entry                  | Free, automatic — triggers on each rotation from pos 1 |
| Payment                   | $10 once at registration only                          |
| Treasury                  | $2.50 per registration                                 |
| Dev + Ops                 | $0.50 per registration                                 |
| Referral bonus            | $3.00 to originalReferrer (locked for life)            |
| Chain pay                 | $4.00 across 7 implicit tree levels                    |
| Active window             | 254 positions                                          |
| Data structure            | Dynamic array queue + head pointer                     |
| Founder pool              | First 1,000 unique members, monthly claim from community wallet |
| Claim window              | 30 days, unclaimed sweeps back to community wallet     |
| Chain                     | Base (mainnet) / Base Sepolia (testnet)                |

---

## 16. Implementation Plan

| Step | Task                                                        | Effort  |
|------|-------------------------------------------------------------|---------|
| 1    | Write `CryptoNovaMatrixV3.sol` with dynamic queue + re-entry | 2–3 hrs |
| 2    | Update Hardhat deploy script for V3                         | 30 min  |
| 3    | Write unit tests (30+ covering rotation, re-entry, edge cases) | 3–4 hrs |
| 4    | Deploy to Base Sepolia, test with 10+ wallets + rotations   | 1 hr    |
| 5    | Update frontend for V3 ABI + new view functions             | 2 hrs   |
| 6    | Security review (queue index consistency, re-entry math)    | 1 hr    |
| 7    | Deploy to Base Mainnet                                      | 30 min  |

**Total estimated effort:** ~10–12 hours

---

*End of scope document v0.2. All open questions from v0.1 §13 are now resolved.*
