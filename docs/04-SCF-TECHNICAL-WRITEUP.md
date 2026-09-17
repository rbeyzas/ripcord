# Ripcord — SCF submission-format technical write-up

*Prepared for the Rise In × Stellar Pro Hackathon 2026, Scale Track, and as the seed
of an SCF #46 submission (deadline 8 November 2026). Every factual claim below is either
reproducible with a command in this repository or cited to a primary source.*

## Project summary

Ripcord is a protocol extension for SEP-6/SEP-24 withdrawals that answers one question:
**what happens to the user's money if the anchor stops delivering?** Today the answer is
"nothing" — the specifications define no anchor-side deadline and no user-initiated
recourse. Ripcord replaces the plain withdrawal payment with a two-claimant claimable
balance whose predicates give the anchor an exclusive window before a published deadline
and give the user an exclusive, unconditional claim after it. It is enforced by
stellar-core, requires no contract deployment, and can be adopted by any anchor in an
afternoon. Two optional layers add a bonded Soroban escrow with dispute resolution and a
SEP-53-signed delivery attestation.

## Problem

SEP-24 and SEP-6 model two time concepts in a withdrawal and both bind the user:
`expired` ("funds were never received by the anchor and the transaction is considered
abandoned by the user") and `user_action_required_by`. Neither spec defines a deadline
the anchor must meet, a cancellation endpoint, or any status the user can trigger once
funds have left their account. `refunded` exists but only the anchor can cause it. The
word "dispute" does not appear in SEP-6, 24, 31 or 38.

This is observable on mainnet today. The issuer behind `anchorusd.com` serves a
`stellar.toml` with `status="live"`, a transfer server whose `/info` reports deposits
enabled, and a status page reading "All systems operational" — while 1.93M USD remains
outstanding across 38,350 trustlines and trades near $0.31 on ~8 USD of weekly volume.
Similar patterns hold for other historical anchors. We make **no claim about user losses**
at any specific anchor; the point is that the protocol offers no mechanism should such a
situation arise, and that an anchor's own claims layer is not a reliable signal.

## Solution

Three layers, each independently adoptable:

**Layer 0 — native (shipped).** `CreateClaimableBalance` with claimants
`[anchor: BEFORE_ABSOLUTE_TIME(T), user: NOT(BEFORE_ABSOLUTE_TIME(T))]`. The predicates
are exact complements; Stellar has no operation that cancels a claimable balance, so once
`T` passes the anchor is permanently locked out and the user claims alone. Verified on
testnet: the anchor's late claim is rejected by the network with `op_cannot_claim`.

**Layer 1 — bonded (shipped, contract `CCKGTC4IIHONXWXIZI33T5SYXAGPWUCEKCJBNY5YZRDTPGBSGYZUPVLV`).**
A Soroban contract in which the anchor posts collateral and declares an arbiter. Opening
an obligation locks free collateral, so an anchor cannot take on more than it can cover
and its open obligations are countable on-chain. `claim` starts a challenge window rather
than releasing funds; the user may `dispute`; the pre-declared arbiter resolves, and a
user who prevails receives the amount plus a penalty from the bond.

**Layer 2 — attested (shipped).** The anchor signs a canonical delivery statement with its
`stellar.toml` `SIGNING_KEY` per SEP-53 (Final, June 2026). The wallet verifies against the
discovery key, not the record; the hash is what Layer 1's `claim` carries.

Delivery time becomes a **published, enforced, competitive commitment**:
`GET /info` → `withdraw[asset].escrow.max_delivery_seconds`, shown to the user before
signing.

## Why Stellar

The construction exists only because of Stellar primitives: claimable balances with
absolute-time predicates (CAP-0023), sponsored reserves returned to the creator
(CAP-0033), classic ledger entries immune to state archival, and SEP-53 message signing.
On chains without native time-predicated balances this would require a contract from
day one, which is exactly the adoption bar we avoid. The problem is also Stellar-specific:
anchors are Stellar's on/off-ramp model, and SDF's 2026 priorities name cross-border
usage and asset adoption first.

## Why a protocol and not a product

Every wallet and every anchor rebuilding this independently would produce incompatible
escrows. A wallet can only offer "your money comes back if the anchor fails" if anchors
publish the deadline and watch for claimable balances in a standard way. The deliverable
is therefore a SEP draft (`docs/SEP-XXXX-escrowed-withdrawals.md`) with a reference
anchor, a reference wallet, and conformance scripts.

## Ecosystem integration

- **Stellar Wallets Kit v2** (Eligible Integration Partner): every user signature — SEP-10
  challenge, escrow creation, reclaim — goes through the kit. Load-bearing.
- **SEP-1 / SEP-10 / SEP-24**: implemented on both sides; the SEP-10 challenge is verified
  (sequence 0, source = `SIGNING_KEY`, network) before it is ever presented for signature.
- **SEP-53**: delivery attestations.
- **Soroban SDK 23**: Layer 1 contract, persistent/instance storage with TTL extension.
- **JS SDK 17**: `Claimant` predicates, `WebAuth`, `signMessage`, deploy via
  `rpc.assembleTransaction` — no CLI dependency.

## Technical design

### Layer 0 — `src/escrow.js`
`deadlineFor`, `escrowClaimants`, `balanceIdFor` (deterministic `ClaimableBalanceID`
computed before submission so it binds to the SEP transaction record), `buildEscrowTx`,
`buildClaimTx`, and `verifyEscrowTx` — the wallet's pre-signature defense: exactly one
operation, exactly two claimants in order, complementary predicates with the same `T`,
expected `T`/asset/amount, source = user, no `BEFORE_RELATIVE_TIME`. 15 unit tests
including forged anchor, swapped claimants, and a hidden extra payment operation.

### Layer 1 — `contracts/ripcord-bond`
`bond / unbond / open / claim / dispute / finalize / reclaim / resolve / stats`. Persistent
storage for obligations and bonds, instance for configuration, TTL extended on every write;
the deadline lives in the entry value because TTL is never a security boundary
(CAP-46-12). No admin, no upgrade path. 9 Rust tests; 30 KB Wasm.

### Layer 2 — `src/attest.js`
Canonical JSON (sorted keys, no whitespace) → `Keypair.signMessage` → verified with
`Keypair.fromPublicKey(SIGNING_KEY).verifyMessage`. Non-canonical or re-keyed messages are
rejected even with valid signatures. 8 tests.

### Reference anchor — `src/anchor/server.js`
SEP-1/10/24 subset plus the Ripcord extension. Two failure modes for demonstration:
**dead** (process exits) and **zombie** (HTTP up, observes the chain, never delivers —
the AnchorUSD pattern). Observation and delivery are separate so a frozen anchor still
records `pending_anchor`, which is the more damning state.

### Trust boundary — stated
No contract can verify that fiat reached a bank. Layer 0 eliminates "anchor did nothing
and the funds are gone"; Layer 1 makes "anchor claimed and did not deliver" costly; Layer 2
makes it non-repudiable. Issuer powers (clawback, `auth_revocable` — USDC has the latter)
sit outside the protocol. The reserve (1 XLM per escrow) is sponsored by the user and
returned on claim; the anchor bears no on-chain cost.

## What is real, what is simulated

| Real (testnet) | Simulated |
|---|---|
| SEP-1 discovery, SEP-10 auth, SEP-24 withdrawal flow | Fiat payout (a log line and a signed attestation) |
| Claimable balance creation, anchor claim, user reclaim, `op_cannot_claim` | The anchor itself (ours, killable by design) |
| Soroban bond contract: all transitions, penalties, `stats` | Arbiter (a keypair; in production a named party) |
| SEP-53 signatures and verification | — |

Six reproducible checks, all passing: `npm test` (33), `contract:test` (9),
`escrow:check`, `anchor:check`, `ui:check`, `bond:check`. Raw outputs in `reports/`.

## Post-hackathon roadmap

1. **SEP PR** — open `docs/SEP-XXXX-escrowed-withdrawals.md` on `stellar/stellar-protocol`
   and take the discussion; add a `bonded_contract` mode once Layer 1 stabilises.
2. **First integrators** — one wallet (target: an open-source wallet already on Wallets
   Kit) and one anchor willing to publish `max_delivery_seconds`. The deposit-side data
   we still need is what a real anchor considers a defensible delivery commitment.
3. **Deposit direction** — out of scope now; a bond against declared outstanding deposits
   is the honest lever and will be specified separately.
4. **Solvency view** — Layer 1's `stats()` across anchors, published as a read-only
   public page. Every open obligation is already on-chain; this only reads it.
5. **SCF #46 Integration track** — Build Award milestones map to 1–4 above; final tranche
   gated on a live wallet + anchor pair, per SCF v7's UX-readiness requirement.

## Skill files used

- `CheesecakeLabs/stellar-anchor-skill/blob/main/SKILL.md` — SEP-1/10/24 flow shapes,
  carried over from our earlier BillRail work. No other skill files were used; the SEP
  texts and stellar-core source were read directly.

## Links

- Repository: (GitHub, public — to be added)
- Layer 1 contract (testnet): `CCKGTC4IIHONXWXIZI33T5SYXAGPWUCEKCJBNY5YZRDTPGBSGYZUPVLV`
- SEP draft: `docs/SEP-XXXX-escrowed-withdrawals.md`
- Architecture: `docs/03-MIMARI.md`
