Handover — session 13

Start by pasting in `NEXT_SESSION_BRIEF.md` from `C:\CryptoNite-Smart-Contracts\CryptoNova`.
It's current as of this commit.
State: contracts `v8.1` at `9fb7d43`; frontend `admin` = `preview` = `main` at `74a1588`,
untouched since session 10. Nothing deployed, no chain written to. Suite 611/7/0, not re-run —
sessions 11 and 12 added three test files and wired none of them into the suite. Clean apart
from three known `.bak` files (session 9 leftovers, house pattern is `archive/`, not delete).

Session 12 was measurement only, no contract code touched. What it proved:
* ⛔ "ZERO GRADUATIONS" WAS A DEAD COUNTER. `MemberCrossedToPartner` cannot fire on a MatB
  cycle-out — it routes through TierRouter, which emits `MemberReentered`. Success was
  silent, only failure was loud. Every "0 graduations" number in handoff 11.4 and 11.5 is
  withdrawn. Before believing any zero, prove the event CAN fire on that path.
* ✅ Fixture, size 127, zero referrals: 508 hops → 485 parked, 23 RE-ENTERED, 22 members
  round twice. But every success came during the fill phase and the last 237 consecutive
  hops produced zero. The fixture is the FLOOR, not the forecast.
* ✅ LIVE V8.48, first time ever counted: 945 hops → 764 parked, 175 RE-ENTERED, 18.52%.
  91 distinct members have cleared the forward hop, 40 more than once, one five times.
* ✅ 175 of 175 clearances had NO SF loan in their own transaction — paid from earnings.
  (Tests the clearing tx only; 53 of the 91 borrowed earlier. SF sits upstream at A→B.)
* ⛔ LOAN BOOK: $1,511.34 borrowed / $1,447.51 repaid = 95.78%, 836 repayments on 459 loans.
  This REFUTES 11.4's case against option B, which reasoned only about the cycle that took
  the loan. B is back on the table and must be re-priced, not dismissed.
* ✅ Orphaned L1 does NOT all go to accountOne — 20% does, ~40% to the community wallet and
  ~40% to the dev wallet. Lever C costs those two, which changes what C is.
* ✅ UNAFFECTED: every shortfall number. `V8_50_MemberLedger.test.js` reconciles a parked
  member's withdrawable against every credit they ever received — three readings, two sizes,
  largest disagreement $0.0000. Lazy settlement and an earnings cap stay refuted.

First thing to chase: SEPARATE THE BIGFILL WALLETS FROM ORGANIC MEMBERS and re-run
`scripts/diag_forward_hop.js`. The live entry flow is bigfill funded with my USDC, so 95.78%
may be me repaying, not the protocol. The collection mechanism is proven either way — organic
viability is not. Bigfill wallets: round-robin leader sponsors, lifetime withdrawn $0.00,
reserve exactly $5.00. DO NOT let me take the A/B/C decision until that row exists.
Then: open one of the 5 unexplained cycle-outs (tx hashes in the script output), fix
`V8_50_ReferralBreakeven.test.js` v4 to count `MemberReentered` (it counts the dead event, so
its rates 0-4 measured nothing), then the session 10 backlog — stale-nonce retry backoff,
@bevmawire's Dashboard retry, `maxItemsPerUpkeep` against 15, member-callable re-entry.

One thing to carry: session 12 shipped two bad measurements in a row — merged park buckets
that made outcomes exceed attempts, and an SF proxy that read 100% because it could not come
back negative. Both were caught only because the numbers disagreed with themselves, not
because they looked wrong. Build the instrument so it can contradict you, and when a number
is flattering, check what it cannot see before reporting it.
