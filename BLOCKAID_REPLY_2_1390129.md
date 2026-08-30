# CryptoNova — reply to the reassessment checklist (ticket 1390129)

Prepared 2026-08-30, in reply to Peter's message of 2026-08-29.

We have read your note as it was written: these are changes to **implement and reflect
on the site**, not questions to answer by email. The site changes are done and live as
of today, and this document records them alongside the answers to each heading. Where
something is missing or weak we say so rather than work around it — that was our
approach in our 2026-08-28 submission and we are keeping it.

---

## 1. Legal entity

**There is no registered company behind CryptoNova, and no business licence.**

CryptoNova is built and run by a small, community-driven team of four. It is not
incorporated anywhere. Obtaining a business licence is something the team intends to
pursue, and we will state it publicly when it exists rather than imply it now.

There is no investor group and no outside staff. Enquiries from regulators, security
vendors and wallet providers are answered directly and in full — this document included.

Named contact: **Clive A. Caesar**, project lead, who goes by **CryptoTech** with the
community and on community calls — `cryptocounsels@gmail.com`.

This is now stated in the same terms on the public site, in section 1 of the privacy
policy (see §7 below), so the answer we give you and the answer a member reads are the
same answer.

## 2. Regulatory status

**We hold no registration of any kind** — no investment, brokerage, exchange, custody or
advisory licence, in any jurisdiction.

Our position, stated as a position and not as legal advice: at the present stage the
system runs on Base Sepolia testnet, the settlement token is a valueless mock, we take
custody of nothing, and nothing is offered for sale for real money. Mainnet is the point
at which that question has to be answered properly, and we would rather answer it before
deploying than be asked afterwards.

We are not lawyers and we are not presenting this as a legal opinion.

## 3. Clear explanation of the product

CryptoNova is a **matrix/referral community platform**. We describe it plainly rather
than in softer language:

- A member pays a **$10 test-USDC entry fee** and is placed in a position in a matrix
  structure (a paired "figure eight": matrix A and matrix B, 127 seats each, ten tiers).
- That fee is split on chain by fixed, published proportions: a crossing reserve held
  for the member's own progression, an instant credit to their balance, a referral
  bonus to their sponsor, chain pay to five upline positions, and a share into an
  equalization pool distributed to seated members on each rotation.
- A member earns from that structure as later members join and as their own position
  cycles. **Income therefore depends on continued participation by other people.** We
  state that on the site rather than around it.
- The exact split, tier prices and fee schedule are public at
  `https://crypto-nova.app/compensation.html`.

The full mechanism, contract by contract, is in our 2026-08-28 document
(`BLOCKAID_APPEAL_1390129.md`, §1 and §3), which also lists exactly which token approval
the site can ask for, when, and for what amount.

## 4. Proof of funds, custody model, and withdrawal

**Custody model: non-custodial.** The project does not hold member funds in any account
it controls on their behalf. There are no user accounts, no passwords, and no deposits
to us. A member's balance lives in the matrix contract they are seated in, and only
their own wallet can move it.

**Withdrawal, step by step, as a member actually does it:**

1. The member connects their own wallet to the dashboard. Nothing is custodial about
   this — it is a read plus the ability to sign.
2. The dashboard shows a **Withdrawable** figure, computed from the contract, and states
   the amount **after** the withdrawal fee rather than before it.
3. The member calls **`withdraw()`** (or **`withdrawPartial(uint256 amount)`**) on the
   matrix contract. The Withdraw Earnings panel does this; it can equally be called
   directly on BaseScan against the verified contract, without our site.
4. The fee is read live from the chain via **`withdrawalFeeBps()`** on the same contract
   — it is not a number our page invents. The net amount is transferred to the member's
   own wallet **in the same transaction**.
5. There is no approval step, no waiting period, no manual release by us, and no way for
   us to stop or reverse it.

Because every one of these functions is on a source-verified contract, this is
independently checkable without taking our word for it.

**Proof of funds.** On a testnet the meaningful form of this is that the balances are
public and readable at named addresses rather than asserted by us: the StabilityFund
(`0xCc6E704814B04bD492AA99e86fCa24e3cA938136`) and the CNOVA Treasury
(`0xc1ED39a0FaAd9A6B291A2f3b6CBF165D2027a8D4`) hold their balances on chain, in the mock
token, visible to anyone.

Example member withdrawal transactions:

- `0x5707e4e9c2c8c405eeb6063e312f03541ccf1e876ca130e6d153d1a8e594b698`
- `0x0596417c78c2cfe3d924f9de9f1feca63712faeb481d30fffbcef622d0c14d13`
- `0xa91fd0316babb76eb05c7e932fdf2b4d680bd43aa734d5aef46b3725214aa346`

## 5. Contract and wallet documentation, admin control, and the RPC activity

### 5a. Contracts

All **46** contracts of the current deployment have public verified source on BaseScan.
The complete address table is in our 2026-08-28 document, §2. Verification was completed
**2026-08-27**, and we told you in that document that the preceding unverified window is
what we believe triggered the flag — a fresh domain asking for token approvals to an
unverified contract is the drainer shape, and we recognised it because the same thing
happened to us on 2026-07-30.

### 5b. Admin control — stated plainly, including what is weak

- **Contract owner:** a single externally-owned wallet, `0xCd0Af6a4116f2062c1594aDf34c1821D45175506`.
- **Keeper caller:** a **separate** externally-owned wallet, `0xd419681B…`, authorised only
  to call the upkeep entry point. Deploy custody and automation custody are deliberately
  not the same key.
- **There is no multisig today.** Admin functions are held by one EOA. We are not going
  to describe that as anything other than what it is; it is on our list to change, and
  we would treat a recommendation from you on it as useful rather than unwelcome.
- **On-chain governance exists and is deployed:** `V8Governance`
  (`0x78DC530Ab3D63FC300e14381e27B6eACeD090951`, verified). Any CNOVA holder can open a
  proposal and vote, with weight equal to their CNOVA balance. Parameter setters are
  `onlyOwnerOrGovernance`, and the stated direction of the project is that parameter
  control moves to holders. To be exact rather than flattering: the governance page is
  still behind a "Coming Soon" gate on the public domains while the testnet phase runs,
  so that surface is deployed and verified but not yet open to members.

### 5c. The Base Sepolia RPC activity

This is ours, it is scheduled, and none of it touches a member's wallet. It comes from
three places.

**(i) Scheduled automation on a single VPS.** A set of cron jobs keeps the matrices
moving and the accounting honest. They sign from the keeper wallet above and nothing
else. The job classes, with their live cadences:

| job | cadence | what it does |
|---|---|---|
| work-queue keeper | every 10 min | calls the contract's own upkeep entry point to process queued matrix work |
| parked-member rescue (co-pay) | every 10 min | re-enters members whose position stalled, funding the gap from the Stability Fund |
| parked-member rescue (self-funded) | every 10 min | the same, for members who can fund it themselves |
| duplicate-seat watch | every 20 min | read-only integrity check |
| growth snapshot | every 30 min | read-only census, one CSV row per matrix |
| system health | every 30 min | read-only |
| integrity check | hourly | read-only, alerts on mismatch |
| Stability Fund invariant check | hourly | read-only, alerts on mismatch |
| on-ramp reward distribution | twice hourly | distributes accrued rewards |
| monitoring / channel reporting | daily / 6-hourly | read-only |

⚠ For completeness: **the two rescue jobs are paused as of 2026-08-29** while we
investigate a seating defect our own testing found. We would rather tell you the fleet
is not in its steady state than show you a table that does not match what you observe.

**(ii) A load-generation harness.** This is the part most likely to look wrong from
outside, so we are explicit about it rather than let you infer it.

This deployment has **real community members** — **196 organic member wallets at our last
count on 2026-08-29, and over 200 now.** They are people who registered, use the site, and
file bug reports we pay bounties on.

**In addition**, 24 to 48 hours after the community launch we enabled a stress harness that
registers synthetic wallets and exercises rescues and tier upgrades on a schedule
(registrations every 20 minutes, rescues and upgrades every 5). It exists because a
127-seat matrix behaves very differently full than empty, and testnet is where we would
rather discover that. So a meaningful portion of the registered wallets are ours, not
people — we would rather state that plainly than have it look like inorganic activity we
were hiding. **We have not measured the exact organic-to-synthetic ratio and we are not
going to estimate one here; if that number is useful to you, ask and we will produce it
properly.**

All of it moves only the valueless mock token. **No real asset changes hands anywhere in
this system.**

**(iii) Member page loads.** The dashboard reads contract state directly over RPC to
render a member's position, so an open browser tab is itself a steady source of read
traffic.

We use **ten dedicated endpoints from a commercial RPC provider**, plus the public Base
Sepolia endpoint as a fallback, split between the frontend read pool and the automation.
We are not listing the URLs here because with that provider the API key is part of the
URL; we can confirm any specific endpoint or transaction you have observed if you tell
us which one.

## 6. Marketing and return claims — changed, and live

This was the substantive item and it is done.

**Removed from the live site:** the "~31% ROI", "~41% ROI" and "~56% ROI" figures that
appeared under "Tier 1 Earnings Potential", and the line "refer 5 people and earn $2.50
extra on top of passive". These were present in the page and in all ten language files;
both are corrected, and the language files matter because they override the page.

**What replaced them:** the same figures presented as a worked example of the published
fee split — for instance "$0.50 referral bonus × 5 directs, added to the passive figure",
which is arithmetic from the fee schedule rather than a rate of return — with a
disclaimer placed **adjacent to the figures**, not buried:

> *"Illustration only, not a forecast. These figures assume the matrix fills completely
> and every seat pays — that does not always happen, and there is no guaranteed or
> promised return. What you actually earn depends on how many people join below you."*

The only remaining occurrence of the term "ROI" anywhere on the site is the FAQ
glossary's definition of the term, which itself ends "ROI is not guaranteed."

We have also adopted this as a standing rule rather than a one-off edit: **no figure
ships as a rate of return, and no earnings statement ships without the
not-guaranteed disclosure beside it.**

## 7. Publicly accessible policy documents

- **Privacy policy — new, published today: `https://crypto-nova.app/privacy.html`.**
  You were right that there was none. It states what the chain records permanently and
  that we cannot erase it; what the site itself receives; that bug reports and the
  Pay It Forward waitlist are **published publicly** and should not carry private
  information; that there are no advertising or analytics trackers; the third parties
  involved; retention; and what we can and cannot delete on request. It is linked from
  the home page, terms, FAQ, compensation plan and from both forms that publish member
  data, and it is **deliberately not behind the maintenance gate** that covers the rest
  of the site, so it is reachable without a wallet or an access code.
- **Terms of use and risk disclaimer — `https://crypto-nova.app/terms.html`**, already
  live, containing risk disclosure, an explicit no-financial-advice section, eligibility
  and restricted jurisdictions, and a no-refunds section.
- **Fee schedule — `https://crypto-nova.app/compensation.html`**, the full split and
  tier pricing.

## What we have still not done

Keeping the same standard as our last submission:

- **No third-party security audit.** We have not had one and we are not implying one.
  The review documents we sent are our own internal notes, described as such.
- **No multisig** on admin functions, as stated in §5b.
- **No legal entity or licence**, as stated in §1 and §2.

## A redeploy is coming, and we will tell you when it lands

In fairness to your process: we expect to **deploy a new set of contracts within roughly
the next week**, once we have worked through the defects our community testing has
surfaced. These contracts carry no proxy machinery, so a fix means a fresh deployment at
new addresses rather than an upgrade in place.

When that happens we will **verify every contract on BaseScan before pointing members at
it**, and we will send you the updated address table unprompted. We are stating this now
because the unverified window after a deploy is, by our own reading, what triggered this
flag in the first place — twice. We do not intend to repeat it a third time.

## What we are asking

That the domains be reassessed now that the return-claim copy is removed from the live
site, a privacy policy is published, and every contract is verified with its admin
custody documented above.

We are happy to walk through a registration, a withdrawal, or any transaction you have
observed, and to answer follow-up questions on any contract in the table.
