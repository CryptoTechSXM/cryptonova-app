# CryptoNova Snapshot — 3 Seed Proposals

Ready-to-paste into snapshot.org. Each proposal includes title, body, and choices.

---

## PROP-1: Establish Quorum Threshold for On-Chain Governance

**Title:**
`[PROP-1] Set On-Chain Governance Quorum to 2% of Circulating CNOVA`

**Body:**
```
## Summary

This proposal establishes the quorum threshold for CryptoNova's on-chain governance 
(V8Governance contract). Quorum is the minimum percentage of circulating CNOVA supply 
that must vote FOR a proposal for it to be eligible for execution.

## Current State

The V8Governance contract is deployed and active. The default quorum is 200 BPS (2%).
This proposal ratifies that default as the community's explicit preference.

## Proposed Value

- **Parameter**: Quorum BPS (Param #13)
- **Value**: 200 (= 2% of circulating CNOVA supply)
- **Contract**: V8Governance

## Rationale

2% quorum balances participation requirements against practical realities of early-stage 
token distribution. It ensures proposals cannot pass with trivial participation while 
remaining achievable as the community grows.

If this proposal passes, the deployer will submit a matching on-chain proposal via 
governance.html to formally set quorum = 200 BPS in the V8Governance contract.

## On-Chain Execution

- Param: Quorum BPS (#13)
- Target: V8Governance contract
- Value: 200
```

**Choices:** Yes, ratify 2% quorum | No, quorum should be higher | No, quorum should be lower

**Voting period:** 7 days
**Discussion:** Include link to Telegram / Discord when available

---

## PROP-2: Set Auto-Upgrade Cycle Threshold to 1 Cycle

**Title:**
`[PROP-2] Confirm Auto-Upgrade Trigger: 1 Completed T1 Cycle`

**Body:**
```
## Summary

This proposal ratifies the auto-upgrade cycle threshold — the number of completed 
Matrix cycles a T1 member must complete before becoming eligible for automatic 
upgrade to T2.

## Current State

The TierRouter contract currently triggers auto-upgrade eligibility after 1 completed 
cycle (fill MatA → cross to MatB → MatB fills → root exits). This proposal ratifies 
that threshold as the community's explicit preference.

## Proposed Value

- **Parameter**: Auto-Upgrade Cycle Threshold (Param #1)  
- **Value**: 1 (member becomes eligible after 1 completed cycle)
- **Contract**: TierRouter

## Rationale

A threshold of 1 cycle means members who complete one full T1 Figure-Eight cycle are 
immediately eligible for T2 upgrade. This keeps momentum high and prevents T1 
congestion from members who have already earned their upgrade. 

The alternative (threshold = 2+) would delay upgrades and slow T2 growth in the early 
protocol phase.

## On-Chain Execution

If this proposal passes:
- Param: Auto-Upgrade Cycle Threshold (#1)
- Target: TierRouter contract
- Value: 1
```

**Choices:** Yes, keep threshold at 1 cycle | No, raise threshold to 2 cycles | Abstain

**Voting period:** 7 days

---

## PROP-3: Set Stability Fund Minimum Reserve Floor at 60%

**Title:**
`[PROP-3] Enforce 60% Stability Fund Reserve Floor for Rescues`

**Body:**
```
## Summary

This proposal ratifies the Stability Fund (SF) minimum reserve floor — the percentage 
of the SF balance that must remain after any rescue operation. The MatrixKeeper 
contract currently enforces a 60% floor (i.e., rescue payouts cannot draw the SF below 
60% of its balance).

## Current State

The V8.18 MatrixKeeper enforces a 60% SF floor by default. This means:
- If SF balance = $1,000, max single rescue payout = $400 (40% of balance)
- The remaining $600 (60%) is always reserved for future rescues

This proposal ratifies 6000 BPS (60%) as the community's explicit floor preference.

## Proposed Value

- **Parameter**: SF Rescue Floor BPS (Param #6)
- **Value**: 6000 (= 60% of SF balance must remain post-rescue)
- **Contract**: MatrixKeeper

## Rationale

A 60% floor ensures the Stability Fund cannot be drained by a single burst of rescue 
activity. It provides sustainable, ongoing rescue capacity rather than one-time large 
payouts. 

As the protocol matures and SF grows, the community can vote to lower this floor 
(e.g., to 4000 BPS = 40%) to allow larger rescue tranches.

## On-Chain Execution

If this proposal passes:
- Param: SF Rescue Floor BPS (#6)
- Target: MatrixKeeper contract  
- Value: 6000
```

**Choices:** Yes, ratify 60% SF floor | No, lower to 40% (4000 BPS) | No, raise to 80% (8000 BPS)

**Voting period:** 7 days

---

## Posting Order & Timing

| Proposal | Post Date | Close Date | On-chain submission |
|---|---|---|---|
| PROP-1 (Quorum) | Launch day | +7 days | If passes: submit same day close |
| PROP-2 (Auto-upgrade) | Launch day + 1 | +8 days | If passes: submit same day close |
| PROP-3 (SF floor) | Launch day + 2 | +9 days | If passes: submit same day close |

Stagger by 1 day so the community isn't voting on 3 things simultaneously on day 1.

---

## Notes for On-Chain Submission (governance.html)

After each Snapshot vote closes with a passing result:
1. Navigate to governance.html
2. Click **Create Proposal**
3. Select the matching param from the dropdown
4. Enter the value that won
5. Paste the Snapshot proposal URL in the description field as a reference
6. Submit — 72h on-chain vote begins
7. After on-chain vote passes: Finalize → wait 48h → Execute
