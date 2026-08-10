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

---

## VERIFIED BY LIVE WITHDRAWAL 2026-08-10 — read before answering "can I withdraw?"

A real withdrawal was performed on `0x1C56C6` (testnet) to settle these by MEASUREMENT
rather than by reading code.

**1. Withdrawals work. They do not revert.** $5.00 then $119.99 went through cleanly. An
earlier prediction that the automation reserve would block it was WRONG: that reserve
applies ONLY in the member's highest-tier matrix, so every other matrix withdraws freely.

**2. The withdrawal fee is 1.5%.** $5.00 withdrawn = $0.0750 fee, $4.9250 received.

**3. Withdrawing SETTLES pending pool first.** Lifetime earned read $74.52 before and
**$174.48** after; pool share went $16.05 -> $116.01. Nothing was created — ~$100 of pool
was already owed and simply not yet credited.

   **Consequence: "Total Earned" UNDERSTATES for any member who has not withdrawn
   recently.** If a member says "I've earned more than that", they are probably right.

**4. The Stability Fund clawback does exactly what the loan panel says.** $15.25 borrowed,
$15.25 repaid, **$0.00 owed** after withdrawing. The panel's "it repays itself
automatically" is accurate.

**5. KNOWN CONTRACT BUG — `freeWithdrawable()` under-reports (scope item 1).**

| account | view says | actually claimable |
|---|---|---|
| `0x09D160` | $33.15 | $340.23 |
| `0xa2f6FB` | $18.41 | $313.01 |
| `0x7a245E` | $85.55 | $268.28 |

   **The DASHBOARD is correct** — it computes the headline itself rather than trusting that
   view. Believe a number a member quotes from the site. Anyone reading `freeWithdrawable`
   directly off a block explorer or third-party tool gets a number that is far too low,
   sometimes $0.00 on a live balance. **That is a broken contract view, not missing money.**


## COMMUNITY WALLET — "when do I get paid?" (answer changed 2026-08-10)

**Answer members now: the 25th of every month.** As of V8.48 that is what the contract
does, not just what the site says.

Be careful with this one, because the honest history matters if anyone quotes an older
answer back at you:

- Until 2026-08-07 the WEBSITE had a "day of month >= 25" gate. The CONTRACT never did.
- The contract ran on a rolling 30-day timer measured from whenever the previous
  distribution actually fired. That drifts: 4 Sep, ~4 Oct, ~3 Nov — about five days a
  year. So "the 25th" was a real belief with nothing behind it.
- V8.48 makes it real. `distributionDayOfMonth = 25`, at most one distribution per
  calendar month, and the day is capped at 28 so February always has the date.

Three things members ask next:

**"How do I know the date is right?"** The dashboard reads `nextDistributionTime()`
straight off the contract. It is not a countdown the website computes — if the site and
the chain ever disagreed, the site would be the one that is wrong, and this is exactly
why we removed the second copy of the rule.

**"What if I do not claim?"** Each distribution EXPIRES on the next monthly date.
Unclaimed USDC is swept back into the pool and shared with everyone on the following
run. `claim()` itself has no time gate, but the share it would pay does. Say "claim
within the month", not "claim whenever".

**"What is my split?"** Genesis (#1–500) 60%, Pioneer (#501–1,000) 40%, of the 50% that
distributes each month; the other 50% rolls over and compounds. If you see 65/35
anywhere, that was a stale line in the site fixed on 2026-08-10 — 60/40 is what the
contract pays.

## Sources

- `contracts/MatrixLogicLib.sol` — `_distributePayments`, `_cycleOutRoot`,
  `_settlePool`, `_credit`
- Constants: `CROSSING_RESERVE_BPS` 5000, `DIRECT_EARN_BPS` 250
- Scope: `V8_48_SCOPE.md` items 37 (source transparency), 38 (parity audit)
