import { test } from "node:test";
import assert from "node:assert/strict";
import { Asset, Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import {
  deadlineFor,
  escrowClaimants,
  describePredicate,
  balanceIdFor,
  buildEscrowTx,
  buildClaimTx,
  verifyEscrowTx,
  MIN_DELIVERY_SECONDS,
} from "../src/escrow.js";

const NET = Networks.TESTNET;
const NOW = 1_800_000_000;
const user = Keypair.random().publicKey();
const anchor = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const USDC = new Asset("USDC", issuer);

const base = () => ({
  user,
  userSequence: "41",
  anchor,
  asset: USDC,
  amount: "20.5",
  deadline: deadlineFor(3600, NOW),
  networkPassphrase: NET,
  now: NOW,
});

// --- Yüklemler: protokolün kalbi -------------------------------------------

test("yüklem çifti tam tümleyendir: anchor before(T), kullanıcı not(before(T)), aynı T", () => {
  const T = deadlineFor(3600, NOW);
  const [a, u] = escrowClaimants({ anchor, user, deadline: T });
  const pa = describePredicate(a.predicate);
  const pu = describePredicate(u.predicate);
  assert.deepEqual(pa, { kind: "before", at: T });
  assert.deepEqual(pu, { kind: "not", of: { kind: "before", at: T } });
  assert.equal(a.destination, anchor);
  assert.equal(u.destination, user);
});

test("rel_before hiçbir zaman üretilmez", () => {
  const built = buildEscrowTx(base());
  const tx = new Transaction(built.xdr, NET);
  const json = JSON.stringify(
    tx.operations[0].claimants.map((c) => describePredicate(c.predicate)),
    (k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  assert.ok(!json.includes("relative"), json);
});

test("anchor ve kullanıcı aynı hesap olamaz", () => {
  assert.throws(() => escrowClaimants({ anchor: user, user, deadline: 1n }), /aynı hesap/);
});

// --- Süre ------------------------------------------------------------------

test("teslim süresi sınırlanır: çok kısa ve çok uzun reddedilir", () => {
  assert.throws(() => deadlineFor(MIN_DELIVERY_SECONDS - 1, NOW), /en az/);
  assert.throws(() => deadlineFor(400 * 24 * 3600, NOW), /en fazla/);
  assert.throws(() => deadlineFor(1.5, NOW), /tam saniye/);
  assert.equal(deadlineFor(60, NOW), BigInt(NOW + 60));
});

test("geçmişte ya da çok yakın bir son tarihle emanet kurulamaz", () => {
  assert.throws(() => buildEscrowTx({ ...base(), deadline: NOW - 10 }), /ileride/);
  assert.throws(() => buildEscrowTx({ ...base(), deadline: NOW + 30 }), /ileride/);
});

// --- balanceID -------------------------------------------------------------

test("balanceID deterministiktir ve Horizon biçimindedir (72 hex, tip 0 öneki)", () => {
  const a = balanceIdFor({ txSource: user, txSequence: 42n });
  const b = balanceIdFor({ txSource: user, txSequence: "42" });
  assert.equal(a, b);
  assert.match(a, /^00000000[0-9a-f]{64}$/);
  assert.notEqual(a, balanceIdFor({ txSource: user, txSequence: 43n }), "sıra numarası değişince id değişir");
  assert.notEqual(a, balanceIdFor({ txSource: anchor, txSequence: 42n }), "kaynak değişince id değişir");
  assert.notEqual(a, balanceIdFor({ txSource: user, txSequence: 42n, opIndex: 1 }), "op indeksi değişince id değişir");
});

test("kurucunun önceden hesapladığı balanceID, XDR'dan türetilenle aynıdır", () => {
  const built = buildEscrowTx(base());
  const v = verifyEscrowTx(built.xdr, { user, anchor }, { networkPassphrase: NET });
  assert.equal(v.balanceId, built.balanceId);
  assert.equal(built.txSequence, "42", "işlem sırası = hesap sırası + 1");
});

// --- Kurucu ----------------------------------------------------------------

test("emanet işlemi: tek op, iki alacaklı, 7 ondalık tutar, kısa geçerlilik, memo", () => {
  const built = buildEscrowTx({ ...base(), memo: "sep24:tx-123" });
  const tx = new Transaction(built.xdr, NET);
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0];
  assert.equal(op.type, "createClaimableBalance");
  assert.equal(op.amount, "20.5000000");
  assert.equal(op.claimants.length, 2);
  assert.equal(tx.source, user);
  assert.equal(Buffer.from(tx.memo.value).toString("utf8"), "sep24:tx-123");
  assert.equal(Number(tx.timeBounds.maxTime), NOW + 300, "bayat XDR gönderilemesin");
  assert.equal(built.amount, "20.5000000");
  assert.equal(built.asset, `USDC:${issuer}`);
});

test("sıfır, negatif ve 8 ondalıklı tutar reddedilir", () => {
  assert.throws(() => buildEscrowTx({ ...base(), amount: "0" }), /pozitif/);
  assert.throws(() => buildEscrowTx({ ...base(), amount: "-1" }), /Geçersiz/);
  assert.throws(() => buildEscrowTx({ ...base(), amount: "1.12345678" }), /ondalık/);
});

test("talep işlemi her iki taraf için aynı yapıdadır", () => {
  const built = buildEscrowTx(base());
  for (const who of [anchor, user]) {
    const c = buildClaimTx({ claimant: who, claimantSequence: "7", balanceId: built.balanceId, networkPassphrase: NET, now: NOW });
    const tx = new Transaction(c.xdr, NET);
    assert.equal(tx.operations[0].type, "claimClaimableBalance");
    assert.equal(tx.operations[0].balanceId, built.balanceId);
    assert.equal(tx.source, who);
  }
  assert.throws(() => buildClaimTx({ claimant: user, claimantSequence: "7", balanceId: "abc", networkPassphrase: NET }), /72 hex/);
});

// --- Doğrulayıcı: imzadan önceki savunma hattı ------------------------------

test("doğrulayıcı doğru işlemi kabul eder ve parametreleri geri verir", () => {
  const T = deadlineFor(3600, NOW);
  const built = buildEscrowTx({ ...base(), deadline: T });
  const v = verifyEscrowTx(built.xdr, { user, anchor, deadline: T, asset: USDC, amount: "20.50" }, { networkPassphrase: NET });
  assert.equal(v.ok, true);
  assert.equal(v.deadline, T);
  assert.equal(v.amount, "20.5000000");
});

test("doğrulayıcı sahte anchor'ı yakalar — saldırgan kendini T-öncesi alacaklı yapamaz", () => {
  const attacker = Keypair.random().publicKey();
  const built = buildEscrowTx({ ...base(), anchor: attacker });
  assert.throws(
    () => verifyEscrowTx(built.xdr, { user, anchor }, { networkPassphrase: NET }),
    (e) => e.problems.some((p) => /\[0\] anchor olmalı/.test(p)),
  );
});

test("doğrulayıcı yer değiştirmiş alacaklıları yakalar — kullanıcı T-öncesine konamaz", () => {
  // Elle çarpıtılmış işlem: alacaklı sırası ters.
  const T = deadlineFor(3600, NOW);
  const [a, u] = escrowClaimants({ anchor, user, deadline: T });
  const { Operation, TransactionBuilder, Account } = awaitSdk();
  const tx = new TransactionBuilder(new Account(user, "41"), { fee: "100", networkPassphrase: NET, timebounds: { minTime: 0, maxTime: NOW + 300 } })
    .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: "1.0000000", claimants: [u, a] }))
    .build();
  assert.throws(
    () => verifyEscrowTx(tx.toXDR(), { user, anchor }, { networkPassphrase: NET }),
    (e) => e.problems.length >= 2,
  );
});

test("doğrulayıcı farklı son tarihi, tutarı ve varlığı yakalar", () => {
  const T = deadlineFor(3600, NOW);
  const built = buildEscrowTx({ ...base(), deadline: T });
  const other = new Asset("EURC", issuer);
  assert.throws(
    () => verifyEscrowTx(built.xdr, { user, anchor, deadline: T + 1n, amount: "99", asset: other }, { networkPassphrase: NET }),
    (e) =>
      e.problems.some((p) => /son tarih/.test(p)) &&
      e.problems.some((p) => /tutar/.test(p)) &&
      e.problems.some((p) => /varlık/.test(p)),
  );
});

test("doğrulayıcı fazladan operasyonu reddeder — emanetin yanına gizli ödeme eklenemez", () => {
  const { Operation, TransactionBuilder, Account } = awaitSdk();
  const T = deadlineFor(3600, NOW);
  const claimants = escrowClaimants({ anchor, user, deadline: T });
  const tx = new TransactionBuilder(new Account(user, "41"), { fee: "200", networkPassphrase: NET, timebounds: { minTime: 0, maxTime: NOW + 300 } })
    .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: "1.0000000", claimants }))
    .addOperation(Operation.payment({ destination: anchor, asset: USDC, amount: "500.0000000" }))
    .build();
  assert.throws(
    () => verifyEscrowTx(tx.toXDR(), { user, anchor, deadline: T }, { networkPassphrase: NET }),
    /1 operasyon bekleniyor, 2 var/,
  );
});

// Test dosyası ESM; SDK'yı testin içinde senkron kullanmak için üstte import edildi.
import * as SDK from "@stellar/stellar-sdk";
function awaitSdk() {
  return SDK;
}
