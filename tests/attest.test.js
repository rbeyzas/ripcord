import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAttestation, signAttestation, verifyAttestation, attestationHash, canonical } from "../src/attest.js";

const anchor = Keypair.random();
const base = () => ({
  transactionId: "tx-1",
  escrowRef: "00000000" + "a".repeat(64),
  asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  amount: "10.0000000",
  fiat: { currency: "TRY", amount: "410.00", reference: "FAST-2026-0001" },
  at: "2026-09-16T00:00:00.000Z",
});

test("kanonik serileştirme anahtar sırasından bağımsızdır", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } }), '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
  const m1 = buildAttestation(base());
  const m2 = buildAttestation({ ...base(), fiat: { reference: "FAST-2026-0001", amount: "410.00", currency: "TRY" } });
  assert.equal(m1, m2);
});

test("anchor imzalar, cüzdan SIGNING_KEY ile doğrular", () => {
  const att = signAttestation(buildAttestation(base()), anchor);
  const v = verifyAttestation(att, anchor.publicKey());
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.claims.fiat.reference, "FAST-2026-0001");
  assert.equal(v.claims.type, "delivery");
});

test("başka anahtarla imzalanmış beyan reddedilir — sahte anchor beyan üretemez", () => {
  const impostor = Keypair.random();
  const att = signAttestation(buildAttestation(base()), impostor);
  const v = verifyAttestation(att, anchor.publicKey());
  assert.equal(v.ok, false);
  assert.match(v.reason, /imzacı/);
  // signer alanı silinse de imza tutmaz.
  delete att.signer;
  assert.equal(verifyAttestation(att, anchor.publicKey()).ok, false);
});

test("mesaj tek bayt değişse imza düşer", () => {
  const att = signAttestation(buildAttestation(base()), anchor);
  const tampered = { ...att, message: att.message.replace('"410.00"', '"4100.00"') };
  const v = verifyAttestation(tampered, anchor.publicKey());
  assert.equal(v.ok, false);
});

test("kanonik olmayan mesaj reddedilir — imza geçse bile", () => {
  const msg = buildAttestation(base());
  const loose = JSON.stringify(JSON.parse(msg), null, 2); // boşluklu
  const sig = anchor.signMessage(loose);
  const v = verifyAttestation({ message: loose, signature: Buffer.from(sig).toString("base64"), signer: anchor.publicKey() }, anchor.publicKey());
  assert.equal(v.ok, false);
  assert.match(v.reason, /kanonik/);
});

test("hash 32 bayt ve deterministik — Katman 1 claim'e gider", () => {
  const m = buildAttestation(base());
  const h = attestationHash(m);
  assert.equal(h.length, 32);
  assert.deepEqual(h, attestationHash(m));
});

test("eksik alan reddedilir", () => {
  assert.throws(() => buildAttestation({ ...base(), amount: "" }), /amount/);
  assert.throws(() => buildAttestation({ ...base(), fiat: { currency: "TRY" } }), /fiat/);
});

test("doğrulayıcı asla throw etmez", () => {
  assert.equal(verifyAttestation(null, anchor.publicKey()).ok, false);
  assert.equal(verifyAttestation({ message: "{", signature: "x" }, anchor.publicKey()).ok, false);
  assert.equal(verifyAttestation({ message: "{}", signature: "AAAA" }, "not-a-key").ok, false);
});
