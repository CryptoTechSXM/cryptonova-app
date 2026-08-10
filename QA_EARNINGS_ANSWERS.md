# QA reference — "do I get paid when I self-rescue?"

**Written 2026-08-10. Every claim below is verified against contract source; the
file:line is given so QA can re-check rather than trust this document.**
If the contract changes, this file is wrong until someone re-verifies it.

---

## The short answer

**Self-rescue is not a payment to the member. It is a payment the member makes.**

Members get paid at **rotation**, and continuously from **referrals** and **chain
pay**. Crossing — whether it happens on its own, via self-rescue, or via the keeper —
is not itself an earning event.

---

## What actually happens on a crossing

When the crossing completes the member enters the next matrix, and their entry fee is
split three ways (`MatrixLogicLib._distributePayments`):

| share | goes to | constant |
|---|---|---|
| **50%** | the member's own `crossingReserve` — locked, pre-funds their NEXT crossing | `CROSSING_RESERVE_BPS = 5000` |
| **2.5%** | the member's `withdrawable`, immediately | `DIRECT_EARN_BPS = 250` (halved from 5% in V8.32) |
| **47.5%** | referrer L1, chain pay (6 levels), pool, treasury, StabilityFund, buyback, liquidity, dev, ops, community | `SplitConfig` BPS, sum 4750 |

On a $10 T1 crossing: **$5 reserved, $0.25 liquid, $4.75 distributed.**

So a member DOES see a small credit at crossing — but 52.5% of it is their own fee
being repositioned, not income from anyone else. **Do not describe this as earnings.**

---

## Where earnings actually come from

**1. Rotation — the main engine.**
`MatrixLogicLib._cycleOutRoot`. Pool value accrues into the matrix's accumulators at
each rotation and is credited to the members still seated.

**The member who cycles OUT gets nothing from the rotation that moves them.** They are
settled up to the PREVIOUS rotation (`_settlePool` is called on the root first, then
this rotation's pool is folded in for everyone else). The source comment states it
directly: *"the root receives nothing from this rotation — identical to the V8.43
loop, which paid seats 2..N only."*

**2. Referrals (L1).** Paid directly when someone the member referred enters.

**3. Chain pay.** Up to 6 levels above an entrant are paid — `ChainPayDistributed`.

All three land in `withdrawable` as they happen, so they are already reflected before
the member ever reaches a crossing.

---

## Self-rescue vs keeper rescue — the answer members care about

- **Self-rescue** — the member pays their own shortfall. **No debt.** Future pool
  shares stay whole.
- **Keeper co-pay rescue** — the StabilityFund covers it as a **loan**. It is repaid
  out of the member's FUTURE pool shares at a clawback rate until cleared
  (`_settlePool` deducts `clawbackBpsFor(member)` before crediting).

Self-rescue costs more today and leaves every future rotation intact. That is a real
trade-off and members should be told it plainly.

---

## KNOWN GAPS — what the dashboard CANNOT show yet (be honest about these)

**This is the part QA most needs.** If a member asks "where did this money come
from?", the site cannot fully answer today.

`_credit()` increments `withdrawable` and `totalEarned` and **emits no event**. So:

| earning path | attributable in the UI? | why |
|---|---|---|
| Chain pay | **yes** | emits `ChainPayDistributed` |
| Pool share | **yes** | emits `PoolShareCredited` |
| **L1 referral** | **NO** | `_credit` is silent |
| **Direct earn (2.5%)** | **NO** | `_credit` is silent |

An **orphaned** L1 (member has no referrer) DOES emit `OrphanFeeRouted`. So the
failure case is observable and the success case is not.

The dashboard breakdown is therefore **per-tier, not per-source**. A member sees the
balance rise and cannot learn why.

**Being fixed under scope item 37** — `EarningsCredited(member, payer, source, amount)`
emitted from `_credit`, shipping with a frontend change that groups the breakdown by
source. **Until that ships, do not promise members a source breakdown.**

---

## Sources

- `contracts/MatrixLogicLib.sol` — `_distributePayments`, `_cycleOutRoot`,
  `_settlePool`, `_credit`
- Constants: `CROSSING_RESERVE_BPS` 5000, `DIRECT_EARN_BPS` 250
- Scope: `V8_48_SCOPE.md` items 37 (source transparency), 38 (parity audit)
