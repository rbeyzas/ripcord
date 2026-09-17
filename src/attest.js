// Katman 2 — imzalı teslim beyanı (SEP-53).
//
// Katman 0 ve 1 zincir dışı gerçeği doğrulayamaz: fiat bankaya ulaştı mı, bilinemez.
// Katman 2 bunu çözmez; "dedi/demedi"yi ortadan kaldırır. Anchor "şu çekim için şu
// referansla şu tutarı ödedim" cümlesini stellar.toml'daki SIGNING_KEY ile imzalar.
// Sonuç:
//   · Cüzdan, imzayı anchor'ın keşif anahtarıyla doğrular — sahte beyan üretilemez.
//   · Beyanın hash'i Katman 1'de `claim(id, attestation)` ile zincire bağlanır.
//   · Gerçek dünyadaki ihtilafta anchor'ın inkâr edemeyeceği bir belge doğar.
//
// SEP-53 "Sign and Verify Messages", Haziran 2026'da Final oldu; SDK 17'de
// Keypair.signMessage / verifyMessage olarak var. Mesaj "Stellar Signed Message:\n"
// önekiyle sha256'lanır ve ed25519 ile imzalanır.

import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export const ATTESTATION_VERSION = "ripcord/1";

/**
 * Kanonik beyan gövdesi. Anahtarlar sıralı, boşluksuz JSON — iki taraf da aynı
 * bayt dizisini üretir, yoksa imza tutmaz.
 */
export function buildAttestation({
  transactionId,
  escrowRef, // Katman 0: balanceId (72 hex) · Katman 1: yükümlülük id'si (string)
  asset, // "CODE:ISSUER"
  amount, // 7 ondalık dizge
  fiat, // { currency, amount, reference }
  at = new Date().toISOString(),
}) {
  for (const [k, v] of Object.entries({ transactionId, escrowRef, asset, amount }))
    if (typeof v !== "string" || !v) throw Error(`beyan alanı eksik: ${k}`);
  if (!fiat?.currency || !fiat?.amount || !fiat?.reference) throw Error("fiat {currency, amount, reference} gerekli");
  const body = {
    amount,
    asset,
    at,
    escrow: escrowRef,
    fiat: { amount: String(fiat.amount), currency: String(fiat.currency), reference: String(fiat.reference) },
    transaction: transactionId,
    type: "delivery",
    v: ATTESTATION_VERSION,
  };
  return canonical(body);
}

/** Anahtarları özyinelemeli sıralayıp boşluksuz serileştirir. */
export function canonical(obj) {
  const sort = (v) =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(obj));
}

/** Anchor tarafı: SIGNING_KEY'in gizli anahtarıyla imzala. */
export function signAttestation(message, keypair) {
  if (!keypair?.canSign?.()) throw Error("İmzalayacak gizli anahtar yok");
  const sig = keypair.signMessage(message);
  return { message, signature: Buffer.from(sig).toString("base64"), signer: keypair.publicKey() };
}

/**
 * Cüzdan tarafı: imza, TOML'dan okunan SIGNING_KEY'e ait mi?
 * Asla throw etmez; { ok, reason } döner. İmza doğrulaması sessizce geçilmez.
 */
export function verifyAttestation(att, expectedSigner) {
  try {
    if (!att || typeof att.message !== "string" || typeof att.signature !== "string") return { ok: false, reason: "beyan biçimi bozuk" };
    if (!StrKey.isValidEd25519PublicKey(expectedSigner || "")) return { ok: false, reason: "beklenen imzacı geçersiz" };
    if (att.signer && att.signer !== expectedSigner) return { ok: false, reason: `imzacı ${short(att.signer)} ≠ SIGNING_KEY ${short(expectedSigner)}` };
    const parsed = JSON.parse(att.message);
    if (parsed.v !== ATTESTATION_VERSION || parsed.type !== "delivery") return { ok: false, reason: "beyan sürümü/türü tanınmıyor" };
    if (canonical(parsed) !== att.message) return { ok: false, reason: "mesaj kanonik değil" };
    const ok = Keypair.fromPublicKey(expectedSigner).verifyMessage(att.message, Buffer.from(att.signature, "base64"));
    return ok ? { ok: true, claims: parsed } : { ok: false, reason: "imza doğrulanamadı" };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Zincire giden 32 baytlık özet — Katman 1 `claim(id, attestation)`. */
export function attestationHash(message) {
  return createHash("sha256").update(message, "utf8").digest();
}

const short = (g) => (g ? `${g.slice(0, 4)}…${g.slice(-4)}` : "∅");
