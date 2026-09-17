## Preamble

```
SEP: XXXX
Title: Escrowed Withdrawals with Unilateral User Exit
Author: Alperen (alperen@patika.dev)
Status: Draft
Created: 2026-09-15
Updated: 2026-09-16
Version: 0.1.0
Discussion: (to be opened on stellar/stellar-protocol)
```

## Simple Summary

Today a SEP-6 / SEP-24 withdrawal is a plain Stellar payment to an anchor-controlled
account. Once that payment is applied, the user has no on-chain recourse: the
specifications define no deadline the anchor must meet, no user-initiated cancellation,
and no path by which a user can recover funds from an anchor that has stopped delivering.

This SEP replaces the plain payment with a **two-claimant claimable balance** whose
predicates give the anchor an exclusive claim window before an anchor-published deadline
`T`, and give the user an exclusive, unconditional claim after `T`. The construction uses
only classic Stellar operations, requires no contract deployment, and is enforced by
stellar-core rather than by either party.

## Motivation

SEP-24 and SEP-6 model two time-related concepts in a withdrawal, and both constrain the
**user**, not the anchor:

- `expired` — "funds were never received by the anchor and the transaction is considered
  abandoned by the user… anchors are responsible for determining when transactions are
  considered expired."
- `user_action_required_by` — a deadline set by the anchor for the user.

Neither specification defines a deadline by which the anchor must deliver, an endpoint
through which the user may cancel, or any status transition the user can trigger after
funds have left their account. `refunded` exists, but its only documented trigger is the
anchor's own decision (SEP-31: "If the Receiving Anchor decides to refund the funds…").
The word "dispute" does not appear in SEP-6, SEP-24, SEP-31 or SEP-38.

The consequence is observable on mainnet. As of 2026-09-15 the issuer behind
`anchorusd.com` still serves a `stellar.toml` with `status="live"`, a transfer server
whose `/info` reports deposits enabled, and a status page reading "All systems
operational" — while 1.93M USD remains outstanding across 38,350 trustlines and trades
at roughly $0.31 on negligible volume. No wind-down notice was published. Similar
patterns exist for other historical anchors. This document makes no claim about user
losses at any specific anchor; it observes that the protocol offers users **no
mechanism** should such a situation arise, and that anchors' own claims layer is not a
reliable signal of their operational state.

The claimable-balance construction described here is expressible on Stellar today
(CAP-0023, Protocol 14). SEP-24 and SEP-6 already reference claimable balances, but only
for the *deposit* case where the recipient lacks a trustline, and leave predicates
unspecified ("Anchors are free to set whichever predicates they feel are necessary").
No standard exists for the withdrawal direction. This SEP provides one.

## Abstract

An anchor that supports escrowed withdrawals advertises, per asset, a maximum delivery
time `max_delivery_seconds`. When a withdrawal reaches `pending_user_transfer_start`,
the wallet — instead of a `Payment` — submits a `CreateClaimableBalance` operation with
exactly two claimants:

| Claimant | Predicate | Can claim |
|---|---|---|
| Anchor account | `BEFORE_ABSOLUTE_TIME(T)` | only while `closeTime < T` |
| User account | `NOT(BEFORE_ABSOLUTE_TIME(T))` | only once `closeTime >= T` |

where `T = submission_time + max_delivery_seconds`. The two predicates are exact
complements: there is no window in which both, or neither, can claim. The anchor delivers
fiat and claims the balance before `T`. If the anchor does not claim before `T`, the user
claims after `T` with no cooperation from the anchor or any third party. Stellar provides
no operation that cancels or modifies a claimable balance; once `T` has passed the anchor
is permanently unable to claim.

The anchor reports the escrow's identity and outcome through additional fields on the
SEP-24/SEP-6 transaction record.

## Specification

### 1. Advertisement — `GET /info`

An anchor supporting this SEP MUST include an `escrow` object under each supported
withdrawal asset:

```json
{
  "withdraw": {
    "USDC": {
      "enabled": true,
      "escrow": {
        "supported": true,
        "max_delivery_seconds": 172800,
        "modes": ["claimable_balance"]
      }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `supported` | boolean | Whether escrowed withdrawals are accepted for this asset. |
| `max_delivery_seconds` | integer | The anchor's committed delivery time. MUST be ≥ 60. Wallets SHOULD display this to the user before signing. |
| `modes` | string[] | Escrow mechanisms accepted. This version defines only `"claimable_balance"`. |

`max_delivery_seconds` is a **product commitment**, not a protocol constant. It is
expected to differ by asset, rail and jurisdiction, and to be a dimension on which
anchors compete.

### 2. Withdrawal request

The wallet indicates intent to use escrow by including `escrow_mode` in the
`POST /transactions/withdraw/interactive` (SEP-24) or `GET /withdraw` (SEP-6) request:

| Field | Type | Description |
|---|---|---|
| `escrow_mode` | string | `"claimable_balance"`. If omitted, the legacy payment flow applies. |

An anchor that receives an `escrow_mode` it does not support MUST respond with HTTP 400
and an error, rather than silently falling back to the legacy flow. A user who asked for
escrow must not end up making an unescrowed payment.

### 3. Transaction record — additional fields

When `escrow_mode` was requested and accepted, the anchor MUST include the following
fields on the transaction record from status `pending_user_transfer_start` onward:

| Field | Type | Description |
|---|---|---|
| `escrow_mode` | string | `"claimable_balance"` |
| `escrow_claimant` | G-address | The anchor account that will claim before `T`. MUST be listed in the anchor's `stellar.toml` `ACCOUNTS`. |
| `escrow_max_delivery_seconds` | integer | The value advertised in `/info` at the time of the request. Fixed for the life of the transaction. |
| `escrow_balance_id` | string \| null | Hex `ClaimableBalanceID` once the anchor has observed the balance on ledger; `null` before. |
| `escrow_deadline` | ISO 8601 \| null | `T`, read from the on-ledger predicate once observed. |
| `escrow_outcome` | string | `pending` \| `claimed_by_anchor` \| `reclaimed_by_user` |

The existing `withdraw_anchor_account`, `withdraw_memo` and `withdraw_memo_type` fields
retain their meaning; the memo MUST be attached to the transaction that creates the
claimable balance.

### 4. Escrow transaction — normative structure

The wallet MUST construct a transaction with:

- **Source account:** the user's account.
- **Exactly one operation:** `CreateClaimableBalance`.
- **Asset and amount:** as specified by the transaction record (`amount_in`).
- **Exactly two claimants, in this order:**
  1. `escrow_claimant` with predicate `BEFORE_ABSOLUTE_TIME(T)`
  2. the user's account with predicate `NOT(BEFORE_ABSOLUTE_TIME(T))`
- **`T`** = the wallet's current time (seconds) + `escrow_max_delivery_seconds`.
- **Memo:** `withdraw_memo`, of type `withdraw_memo_type`.
- **Time bounds:** a short validity window (RECOMMENDED ≤ 5 minutes), so a stale
  transaction cannot be applied long after `T` was computed.

`BEFORE_RELATIVE_TIME` MUST NOT be used. stellar-core rewrites relative predicates to
absolute ones at creation using the close time of whichever ledger the transaction lands
in, which makes the effective deadline depend on transaction propagation.

The wallet MUST verify the above structure before presenting the transaction for
signature, regardless of who constructed the XDR. A reference verifier is provided in
the accompanying implementation (`verifyEscrowTx`).

### 5. Balance identification

`ClaimableBalanceID` is deterministic:

```
sha256( ENVELOPE_TYPE_OP_ID ‖ tx.sourceAccount ‖ tx.seqNum ‖ opIndex )
```

using the **transaction's** source account and sequence number (for a fee-bump, the inner
transaction's). Both wallet and anchor can therefore compute the identifier before
submission. Anchors MUST match an escrow to a transaction record by all of:

- the claimable balance's `sponsor` equals the record's user account,
- `asset` and `amount` equal the record's,
- the anchor's own account is claimant `[0]` with a `BEFORE_ABSOLUTE_TIME` predicate,
- the memo on the creating transaction equals `withdraw_memo` (RECOMMENDED where the
  anchor indexes transactions).

Anchors SHOULD tolerate `T` differing from their own expectation by clock skew and
submission latency, and MUST accept any `T` **later** than expected — a longer window
only benefits the anchor.

### 6. Anchor behaviour

On observing a matching escrow the anchor:

1. MUST set `escrow_balance_id` and `escrow_deadline` from the ledger entry, and MOVE
   the record to `pending_anchor`.
2. SHOULD perform the fiat delivery.
3. MUST NOT claim the balance before delivery has been initiated. (This is not
   enforceable on-chain; see Security Concerns.)
4. MUST claim the balance before `T`. On success, set `escrow_outcome =
   claimed_by_anchor`, `stellar_transaction_id` to the claim transaction, and status
   `completed`.
5. If the anchor observes that the balance no longer exists, it did not claim it, and
   the current ledger close time is ≥ `T`, it MUST set `escrow_outcome =
   reclaimed_by_user` and status `refunded`.

An anchor MUST NOT attempt to claim once it can no longer deliver within `T`; a claim
after `T` fails with `CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM` in any case.

### 7. User behaviour

After `T`, the user MAY submit `ClaimClaimableBalance` for `escrow_balance_id` from the
user account. No interaction with the anchor is required or expected. Wallets SHOULD
surface this action prominently once `T` has passed and the balance still exists, and
SHOULD confirm the user's trustline exists before submitting.

### 8. Status semantics

No new status values are introduced. `refunded` with `escrow_outcome =
reclaimed_by_user` denotes a user-executed reclaim. Implementers are invited to comment
on whether a dedicated status (e.g. `reclaimed`) is warranted; this draft avoids it to
minimise the change surface for existing wallets.

## Design Rationale

**Why claimable balances and not a Soroban contract.** A claimable balance is a classic
ledger entry: it is not subject to state archival, has no TTL, requires no deployment,
no upgrade path, and no governance. Any anchor can adopt this SEP with a change to how it
watches incoming funds. Contract-based escrow with bonds, challenge windows and dispute
resolution is a natural extension and is discussed below, but a standard that requires
every anchor to depend on a deployed contract would have a far higher adoption bar.

**Why the user sponsors the reserve.** The creator of a claimable balance sponsors its
reserve (2 × base reserve for two claimants, 1 XLM at current parameters) and the
reserve is returned to the sponsor on claim — regardless of who claims. Placing this on
the user means the anchor bears **no** on-chain cost for supporting this SEP, and the
user's cost is a temporary lock returned within `max_delivery_seconds`.

**Why the deadline is anchor-published rather than fixed.** A protocol-fixed deadline
cannot be right for both a same-day instant-payment rail and a T+2 cross-border wire.
Publishing it turns delivery time from an invisible risk into a comparable, enforced
commitment, and lets wallets and users choose anchors accordingly.

**Why exact complements.** `BEFORE_ABSOLUTE_TIME(T)` is true iff `closeTime < T`;
`NOT(BEFORE_ABSOLUTE_TIME(T))` is true iff `closeTime >= T`. There is no ledger in which
both claimants are eligible and none in which neither is. Any other construction
introduces a race or a dead zone.

## Security Concerns

**The anchor may claim without delivering.** Nothing on-chain can verify that fiat
reached a bank account; no such oracle exists. This SEP does not make the fiat leg
trustless. It bounds the user's exposure to the case *"anchor claimed and did not
deliver"* and eliminates the case *"anchor did nothing and the funds are gone"*. A
contract-based extension (bond, challenge window, pre-agreed arbiter) can make the former
costly for the anchor and is out of scope for this version.

**Issuer powers are unaffected.** The guarantee is "without the *anchor's* cooperation",
not "without anyone's". If the user's trustline had clawback enabled when the balance was
created, the balance carries the clawback flag and the issuer can destroy it. If the
issuer has `auth_revocable` set, it can revoke the user's authorization and the user's
claim will fail with `CLAIM_CLAIMABLE_BALANCE_NOT_AUTHORIZED`. As of 2026-09-15 the USDC
issuer on mainnet has `auth_clawback_enabled: false` and `auth_revocable: true`. Wallets
SHOULD show the issuer's flags to the user.

**Trustline required at claim time.** The user's claim fails with
`CLAIM_CLAIMABLE_BALANCE_NO_TRUST` if the trustline has been removed in the meantime.
Wallets SHOULD check before submitting.

**Reserve and account merge.** While any escrow it sponsors is outstanding, the user's
account has `numSponsoring > 0` and cannot be merged. This resolves when the balance is
claimed by either party.

**Deadline economics.** A `max_delivery_seconds` shorter than the anchor's real
settlement path penalises honest anchors (they lose the claim window through no fault);
one that is too long delays the user's recourse. Anchors are expected to publish values
that reflect their rails, including weekends and holidays. Wallets MUST display the value
before the user signs.

**Front-running at the boundary.** An anchor observing `closeTime` approaching `T` may
attempt a last-moment claim. Because the predicates are exact complements evaluated at
the claim transaction's ledger close time, either exactly one party succeeds or, if both
transactions land in the same ledger, ordering within the ledger decides. This does not
create a state where funds are unrecoverable; it only affects which party receives them.

**Malformed escrows.** An anchor MUST NOT treat a claimable balance as satisfying this
SEP unless it matches §4 exactly. A wallet MUST NOT sign a transaction that does not
match §4 exactly. Reference implementations of both checks are provided.

## Changelog

- `v0.1.0` — Initial draft. Claimable-balance mode only.
