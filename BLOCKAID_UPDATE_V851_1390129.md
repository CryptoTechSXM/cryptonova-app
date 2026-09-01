# CryptoNova — V8.51 redeployment address table (ticket 1390129)

Prepared 2026-09-01 by the CryptoNova project. Sent unprompted, as an update to our
2026-08-28 submission and our 2026-08-30 reply. **No reply or action is requested — this is
notice of a change on our side, so your records are not stale.**

## What changed

- We redeployed the whole system on **2026-09-01** to fix a seat-allocation fault. **Every contract
  address below is new.** The addresses in our 2026-08-28 table are the previous deployment and
  members are being moved off them today.
- **Nothing else changed.** Same network (**Base Sepolia testnet, chain id 84532**), same domains,
  same operators, same contact, same model, same answers to every question in your checklist.
- **The settlement token is unchanged and deliberately reused:** `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a`
  is the same MockUSDC already in your record. It is a test token, not Circle USDC, with no market
  value. No mainnet asset is reachable from any contract listed here.
- Deployed 2026-09-01T04:00:12.611Z by `0xCd0Af6a4116f2062c1594aDf34c1821D45175506`.
- Domains in scope, unchanged and all serving the same build: `www.crypto-nova.app`,
  `crypto-nova.app`, `v8.crypto-nova.app`, `early.crypto-nova.app`, `admin.crypto-nova.app`.

## Verification was completed BEFORE any member was pointed at these contracts

This is the one thing we changed in our process because of this ticket. Our 2026-08-28 submission
noted that verification finished **after** the flag was raised, and that we believed the unverified
window was the likely trigger. So this time the order was deliberate:

1. Contracts deployed and wired — **2026-09-01, 02:35–04:00 UTC.**
2. **All 46 contracts source-verified on BaseScan — completed before any traffic.** Verified in two
   independent passes: a submission pass, then a separate pass that re-queried BaseScan for each
   address rather than trusting the submitter's own report. Result: **46 verified, 0 unverified, 0 unknown.**
3. Only then was the frontend repointed and members told.

At no point was a member directed at an unverified contract in this deployment.

Re-checked again on 2026-09-01 immediately before sending this document, by querying BaseScan
for each address: **46 verified, 0 unverified, 0 unknown, 1 EOA.**

## Every contract, source-verified on BaseScan

| Contract | Address | Source |
|---|---|---|
| MockUSDC | `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a` | [BaseScan](https://sepolia.basescan.org/address/0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a#code) |
| CNOVAToken | `0x486580A65A4952Ad79cCC14C1593BE6dB1A62d4B` | [BaseScan](https://sepolia.basescan.org/address/0x486580A65A4952Ad79cCC14C1593BE6dB1A62d4B#code) |
| CNOVATreasury | `0x31eD4325F0a75FFA061F3ca8de613f8e0df2c6af` | [BaseScan](https://sepolia.basescan.org/address/0x31eD4325F0a75FFA061F3ca8de613f8e0df2c6af#code) |
| StabilityFund | `0xb7962158FA9DDCB15697d0a0358473c1F34C13FF` | [BaseScan](https://sepolia.basescan.org/address/0xb7962158FA9DDCB15697d0a0358473c1F34C13FF#code) |
| CNOVABuybackReserve | `0x5cDb6b329a10068c2715db87345F40c069FD1fa0` | [BaseScan](https://sepolia.basescan.org/address/0x5cDb6b329a10068c2715db87345F40c069FD1fa0#code) |
| TierRouter | `0x73772F4f4ACF7DcE64a69060878A92fD272c7CD8` | [BaseScan](https://sepolia.basescan.org/address/0x73772F4f4ACF7DcE64a69060878A92fD272c7CD8#code) |
| MatrixFactory | `0x3dBa9195e0EcE759B727C26EDd7CFA1B1DFdf4c5` | [BaseScan](https://sepolia.basescan.org/address/0x3dBa9195e0EcE759B727C26EDd7CFA1B1DFdf4c5#code) |
| MatrixPairFactory | `0x97E10ADfED7c7E367dd3572b3eF6be6B2CE05c5B` | [BaseScan](https://sepolia.basescan.org/address/0x97E10ADfED7c7E367dd3572b3eF6be6B2CE05c5B#code) |
| MatrixKeeper | `0x693519F442cE01633954D9E700B6faC3F96d25FA` | [BaseScan](https://sepolia.basescan.org/address/0x693519F442cE01633954D9E700B6faC3F96d25FA#code) |
| V8Governance | `0x56Ba053e649e1e2E99a131301B39B9F9510A4575` | [BaseScan](https://sepolia.basescan.org/address/0x56Ba053e649e1e2E99a131301B39B9F9510A4575#code) |
| CommunityWallet | `0x64ec12541e783b89402fA4983238C0FF4e367C02` | [BaseScan](https://sepolia.basescan.org/address/0x64ec12541e783b89402fA4983238C0FF4e367C02#code) |
| CNOVADirectSale | `0x7AFCed3bc59cf1860ed78382fC4dcc4edA35aC61` | [BaseScan](https://sepolia.basescan.org/address/0x7AFCed3bc59cf1860ed78382fC4dcc4edA35aC61#code) |
| CouponRegistry | `0xA0B430Ca510D89d6cD5A629279624879084EFf75` | [BaseScan](https://sepolia.basescan.org/address/0xA0B430Ca510D89d6cD5A629279624879084EFf75#code) |
| MatrixLogicLib (library) | `0x3E3928BE92185034BBB6E66f6c163e1FDeaD5690` | [BaseScan](https://sepolia.basescan.org/address/0x3E3928BE92185034BBB6E66f6c163e1FDeaD5690#code) |
| TierRouterLib (library) | `0x08F1dD4F620b8857626F771050cB2bDdd6A0596C` | [BaseScan](https://sepolia.basescan.org/address/0x08F1dD4F620b8857626F771050cB2bDdd6A0596C#code) |
| MatrixKeeperLib (library) | `0x3E7f783a77CBEf3D0B7171889EF9F930A34eE38b` | [BaseScan](https://sepolia.basescan.org/address/0x3E7f783a77CBEf3D0B7171889EF9F930A34eE38b#code) |
| PairManagerV8 — tier T1 | `0xBEaA7DA4586d4FF1370A0595b54f003ADecD85f7` | [BaseScan](https://sepolia.basescan.org/address/0xBEaA7DA4586d4FF1370A0595b54f003ADecD85f7#code) |
| FigureEightMatrixV8 — T1 matrix A | `0x2f37A4eAa541fc6015D3453d41A5E1817B093049` | [BaseScan](https://sepolia.basescan.org/address/0x2f37A4eAa541fc6015D3453d41A5E1817B093049#code) |
| FigureEightMatrixV8 — T1 matrix B | `0x395ee7eD68422586eC7ff122f85238C79314aa63` | [BaseScan](https://sepolia.basescan.org/address/0x395ee7eD68422586eC7ff122f85238C79314aa63#code) |
| PairManagerV8 — tier T2 | `0x973EED6CA2178A45770C52A61c926aCc8b310B57` | [BaseScan](https://sepolia.basescan.org/address/0x973EED6CA2178A45770C52A61c926aCc8b310B57#code) |
| FigureEightMatrixV8 — T2 matrix A | `0x1A4C3054D5Abeab3Db5a7F01A946904B4BE8B4Ad` | [BaseScan](https://sepolia.basescan.org/address/0x1A4C3054D5Abeab3Db5a7F01A946904B4BE8B4Ad#code) |
| FigureEightMatrixV8 — T2 matrix B | `0x7Cb499eeeC5f402d5d73B47014f4227bdCa1EE35` | [BaseScan](https://sepolia.basescan.org/address/0x7Cb499eeeC5f402d5d73B47014f4227bdCa1EE35#code) |
| PairManagerV8 — tier T3 | `0xd0980B3f3A967e76deC4E197766B693dE6292dcB` | [BaseScan](https://sepolia.basescan.org/address/0xd0980B3f3A967e76deC4E197766B693dE6292dcB#code) |
| FigureEightMatrixV8 — T3 matrix A | `0xc1c7C70bb76f94D9fA45102b48eF6c6403782d81` | [BaseScan](https://sepolia.basescan.org/address/0xc1c7C70bb76f94D9fA45102b48eF6c6403782d81#code) |
| FigureEightMatrixV8 — T3 matrix B | `0x7bd2d80b3945a4Be888C0f4EEB2D3B8E6A06e49a` | [BaseScan](https://sepolia.basescan.org/address/0x7bd2d80b3945a4Be888C0f4EEB2D3B8E6A06e49a#code) |
| PairManagerV8 — tier T4 | `0x60340d2fef8d737EADe69CFBdCe99732511f2eb1` | [BaseScan](https://sepolia.basescan.org/address/0x60340d2fef8d737EADe69CFBdCe99732511f2eb1#code) |
| FigureEightMatrixV8 — T4 matrix A | `0xe0C3EAAEFCBEBb53014545dc174994266F1210Cb` | [BaseScan](https://sepolia.basescan.org/address/0xe0C3EAAEFCBEBb53014545dc174994266F1210Cb#code) |
| FigureEightMatrixV8 — T4 matrix B | `0xC4371d1E0580A72Ffe7fba02b98af5D8510d8A25` | [BaseScan](https://sepolia.basescan.org/address/0xC4371d1E0580A72Ffe7fba02b98af5D8510d8A25#code) |
| PairManagerV8 — tier T5 | `0x001D50a749951A8fA3893141114cE59A9D926Fd1` | [BaseScan](https://sepolia.basescan.org/address/0x001D50a749951A8fA3893141114cE59A9D926Fd1#code) |
| FigureEightMatrixV8 — T5 matrix A | `0xA4Ca9886D1Ef751c909551F0FF6076d363828fe3` | [BaseScan](https://sepolia.basescan.org/address/0xA4Ca9886D1Ef751c909551F0FF6076d363828fe3#code) |
| FigureEightMatrixV8 — T5 matrix B | `0x1D5Eec4F0a12E784D34410E8f577d94f26E15CF2` | [BaseScan](https://sepolia.basescan.org/address/0x1D5Eec4F0a12E784D34410E8f577d94f26E15CF2#code) |
| PairManagerV8 — tier T6 | `0xDabe1da7DC4D151F02B26aC1d449B9Bb07491B9e` | [BaseScan](https://sepolia.basescan.org/address/0xDabe1da7DC4D151F02B26aC1d449B9Bb07491B9e#code) |
| FigureEightMatrixV8 — T6 matrix A | `0x691174A57347990318DbA202B9faBbcC2E2E964c` | [BaseScan](https://sepolia.basescan.org/address/0x691174A57347990318DbA202B9faBbcC2E2E964c#code) |
| FigureEightMatrixV8 — T6 matrix B | `0xFFb1141D5FB1cc19D9292fC9974849B13999580B` | [BaseScan](https://sepolia.basescan.org/address/0xFFb1141D5FB1cc19D9292fC9974849B13999580B#code) |
| PairManagerV8 — tier T7 | `0xa110eB4E57f9D91D4c92806EE216C8a26CD04C31` | [BaseScan](https://sepolia.basescan.org/address/0xa110eB4E57f9D91D4c92806EE216C8a26CD04C31#code) |
| FigureEightMatrixV8 — T7 matrix A | `0xa1088Cb9BaA915a155ce131AFF2807Be8cc5956c` | [BaseScan](https://sepolia.basescan.org/address/0xa1088Cb9BaA915a155ce131AFF2807Be8cc5956c#code) |
| FigureEightMatrixV8 — T7 matrix B | `0xdbE3114d03E59a41270DBf2C72c93126F20b5F58` | [BaseScan](https://sepolia.basescan.org/address/0xdbE3114d03E59a41270DBf2C72c93126F20b5F58#code) |
| PairManagerV8 — tier T8 | `0xebB18fa4d0eB57902e9081f355d007F0F9aeB534` | [BaseScan](https://sepolia.basescan.org/address/0xebB18fa4d0eB57902e9081f355d007F0F9aeB534#code) |
| FigureEightMatrixV8 — T8 matrix A | `0x2d503d0393580efEDAeb8b9aED66D939BFd64A06` | [BaseScan](https://sepolia.basescan.org/address/0x2d503d0393580efEDAeb8b9aED66D939BFd64A06#code) |
| FigureEightMatrixV8 — T8 matrix B | `0x8A63DEA29324Bfc77Aa3140d7ad5195d766c6DCa` | [BaseScan](https://sepolia.basescan.org/address/0x8A63DEA29324Bfc77Aa3140d7ad5195d766c6DCa#code) |
| PairManagerV8 — tier T9 | `0xfB8c7722D26622f72D4Dd37BC4F5ACB07dBb071D` | [BaseScan](https://sepolia.basescan.org/address/0xfB8c7722D26622f72D4Dd37BC4F5ACB07dBb071D#code) |
| FigureEightMatrixV8 — T9 matrix A | `0x324A2650871f5228De8cca084c6e5074860ab188` | [BaseScan](https://sepolia.basescan.org/address/0x324A2650871f5228De8cca084c6e5074860ab188#code) |
| FigureEightMatrixV8 — T9 matrix B | `0x67DbF81DeF9453Bd492E1c028878582660BE4Ce4` | [BaseScan](https://sepolia.basescan.org/address/0x67DbF81DeF9453Bd492E1c028878582660BE4Ce4#code) |
| PairManagerV8 — tier T10 | `0xaaE9f54823D9458aa96D5E78CA371760d6A4b7d2` | [BaseScan](https://sepolia.basescan.org/address/0xaaE9f54823D9458aa96D5E78CA371760d6A4b7d2#code) |
| FigureEightMatrixV8 — T10 matrix A | `0x6Fa6a4fD5B1222e000bE53758C4d9a3496218768` | [BaseScan](https://sepolia.basescan.org/address/0x6Fa6a4fD5B1222e000bE53758C4d9a3496218768#code) |
| FigureEightMatrixV8 — T10 matrix B | `0xb824F701a06CcBf74C5A28E2eEf649D2F27f19A9` | [BaseScan](https://sepolia.basescan.org/address/0xb824F701a06CcBf74C5A28E2eEf649D2F27f19A9#code) |

**46 contracts, all with public verified source.**

One address in our deployment file, `liquidityReserve` `0x961fDE5C78200891f36858B2940a2B6d4F1Af854`, is an
externally-owned account with no bytecode. We list it here for completeness rather than omit it;
there is nothing to verify on an EOA.

## Contact

**Clive A. Caesar**, project lead, known as **CryptoTech** to the community — `cryptocounsels@gmail.com`.
We answer enquiries from regulators, security vendors and wallet providers directly and in full.
