// Ripcord — Katman 0. Emanetli çekim, sözleşmesiz.
//
// Bugün SEP-24/6 çekiminde kullanıcı anchor'a düz bir ödeme yapar ve o an itibarıyla
// hiçbir dayanağı kalmaz. Ripcord aynı tutarı iki alacaklılı bir claimable balance'a koyar:
//
//   anchor : BEFORE_ABSOLUTE_TIME(T)        → yalnızca T'den ÖNCE alabilir
//   user   : NOT(BEFORE_ABSOLUTE_TIME(T))   → yalnızca T'den SONRA alabilir
//
// İki yüklem tam tümleyendir (anchor: T > closeTime, user: closeTime >= T). Ne boşluk
// var ne örtüşme. Stellar'da claimable balance'ı silen TEK işlem ClaimClaimableBalanceOp;
// iptal operasyonu yoktur. T geçtiğinde anchor kalıcı olarak kilitlenir, kullanıcı tek
// başına alır. Bu bir sözleşme kuralı değil, protokol garantisi — stellar-core uygular.
//
// Neden Soroban değil: claimable balance klasik bir ledger kaydıdır, arşivlenmez, TTL'i
// yoktur, deploy gerektirmez. Herhangi bir anchor bir öğleden sonrada benimseyebilir.
//
// Üç kural:
//   1. Yalnızca abs_before. rel_before oluşturma anında mutlak zamana çevrilir ve hangi
//      ledger'a düştüğüne bağlıdır — emanet süresi için kabul edilemez.
//   2. Kullanıcı imzalamadan önce DOĞRULAR (verifyEscrowTx). Anchor'ın gönderdiği XDR'a
//      körü körüne imza atılmaz; SEP-10'daki disiplinin aynısı.
//   3. balanceID gönderilmeden önce hesaplanır. Böylece SEP işlem kaydına bağlanabilir.

import {
  Asset,
  Claimant,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  Transaction,
  Memo,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { toMinor, fromMinor, assertMinor } from "./units.js";

/** Emanet süresi için alt sınır. Bundan kısa bir T, anchor'a hiç şans vermez. */
export const MIN_DELIVERY_SECONDS = 60;
/** Üst sınır: bir yıl. Daha uzunu "emanet" değil "kilit"tir. */
export const MAX_DELIVERY_SECONDS = 365 * 24 * 3600;
/** İmzasız işlemin geçerlilik penceresi. Bayat XDR gönderilmesin. */
export const TX_VALIDITY_SECONDS = 300;

// ---------------------------------------------------------------------------
// Zaman

/**
 * Teslim süresinden mutlak son tarihi üretir (unix saniye, bigint).
 * `now` enjekte edilebilir — testlerde saat oynatmak için.
 */
export function deadlineFor(deliverySeconds, now = Math.floor(Date.now() / 1000)) {
  const d = Number(deliverySeconds);
  if (!Number.isInteger(d)) throw Error(`Teslim süresi tam saniye olmalı: ${deliverySeconds}`);
  if (d < MIN_DELIVERY_SECONDS)
    throw Error(`Teslim süresi en az ${MIN_DELIVERY_SECONDS} sn olmalı: ${d}`);
  if (d > MAX_DELIVERY_SECONDS)
    throw Error(`Teslim süresi en fazla ${MAX_DELIVERY_SECONDS} sn olmalı: ${d}`);
  return BigInt(now) + BigInt(d);
}

// ---------------------------------------------------------------------------
// Yüklemler

/**
 * Protokolün normatif yüklem çifti.
 * Sıra sabittir: [0] anchor, [1] kullanıcı. verifyEscrowTx bu sırayı bekler.
 */
export function escrowClaimants({ anchor, user, deadline }) {
  assertAccount(anchor, "anchor");
  assertAccount(user, "user");
  if (anchor === user) throw Error("Anchor ve kullanıcı aynı hesap olamaz");
  const T = toDeadline(deadline);
  const before = Claimant.predicateBeforeAbsoluteTime(T.toString());
  return [
    new Claimant(anchor, before),
    new Claimant(user, Claimant.predicateNot(before)),
  ];
}

/** Bir yüklemi sade nesneye indirger; hem test hem UI için. */
export function describePredicate(p) {
  switch (p.type) {
    case "claimPredicateUnconditional":
      return { kind: "unconditional" };
    case "claimPredicateBeforeAbsoluteTime":
      return { kind: "before", at: BigInt(p.absBefore) };
    case "claimPredicateBeforeRelativeTime":
      return { kind: "before-relative", seconds: BigInt(p.relBefore) };
    case "claimPredicateNot":
      return { kind: "not", of: p.notPredicate ? describePredicate(p.notPredicate) : null };
    case "claimPredicateAnd":
      return { kind: "and", of: p.andPredicates.map(describePredicate) };
    case "claimPredicateOr":
      return { kind: "or", of: p.orPredicates.map(describePredicate) };
    default:
      return { kind: "unknown", type: p.type };
  }
}

// ---------------------------------------------------------------------------
// balanceID — gönderilmeden önce hesaplanır

/**
 * ClaimableBalanceID = sha256(ENVELOPE_TYPE_OP_ID ‖ txSource ‖ txSeq ‖ opIndex)
 * Horizon'un gösterdiği biçim: 4 bayt tip (0) + 32 bayt hash, hex, 72 karakter.
 *
 * DİKKAT: kaynak ve sıra numarası İŞLEMİN kaynağı ve sıra numarasıdır, operasyonun
 * değil. Fee-bump'ta iç işlem esas alınır. Muxed hesapta altta yatan ed25519 hesap.
 */
export function balanceIdFor({ txSource, txSequence, opIndex = 0 }) {
  assertAccount(txSource, "txSource");
  const seq = BigInt(txSequence);
  if (seq <= 0n) throw Error("İşlem sıra numarası pozitif olmalı");
  const preimage = xdr.HashIdPreimage.envelopeTypeOpId(
    new xdr.HashIdPreimageOperationId({
      sourceAccount: Keypair.fromPublicKey(txSource).xdrAccountId(),
      seqNum: seq,
      opNum: opIndex,
    }),
  );
  const h = hash(preimage.toXDR());
  return xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(h).toXDR("hex");
}

// ---------------------------------------------------------------------------
// İşlem kurucular

/**
 * Emanet işlemi. Kullanıcı imzalar; anchor ya da cüzdan sunucusu kurabilir.
 *
 * @param {object} p
 * @param {string} p.user            kullanıcının G adresi — işlem kaynağı ve T-sonrası alacaklı
 * @param {string|number|bigint} p.userSequence  kullanıcı hesabının MEVCUT sıra numarası (Horizon'dan)
 * @param {string} p.anchor          anchor'ın G adresi — T-öncesi alacaklı
 * @param {Asset}  p.asset
 * @param {string} p.amount          "100.50" biçiminde, en fazla 7 ondalık
 * @param {bigint|number|string} p.deadline   mutlak unix saniye (deadlineFor ile üretin)
 * @param {string} p.networkPassphrase
 * @param {string} [p.memo]          SEP işlem id'si için (memo text/id/hash)
 * @param {string} [p.baseFee]
 * @param {number} [p.now]
 */
export function buildEscrowTx({
  user,
  userSequence,
  anchor,
  asset,
  amount,
  deadline,
  networkPassphrase,
  memo,
  baseFee = "100",
  now = Math.floor(Date.now() / 1000),
}) {
  if (!networkPassphrase) throw Error("networkPassphrase gerekli");
  if (!(asset instanceof Asset)) throw Error("asset bir Asset olmalı");
  const T = toDeadline(deadline);
  if (T <= BigInt(now) + BigInt(MIN_DELIVERY_SECONDS))
    throw Error(`Son tarih en az ${MIN_DELIVERY_SECONDS} sn ileride olmalı`);

  // Tutar: 7 ondalık doğrulaması units.js'te. Sıfır ve negatif reddedilir.
  const minor = toMinor(amount);
  assertMinor(minor);
  const amountStr = fromMinor(minor);

  const claimants = escrowClaimants({ anchor, user, deadline: T });

  // İşlemin sıra numarası = hesabın mevcut sıra numarası + 1. balanceID buna bağlı.
  const txSequence = BigInt(userSequence) + 1n;
  const balanceId = balanceIdFor({ txSource: user, txSequence, opIndex: 0 });

  // Account nesnesi yerine minimal arayüz: TransactionBuilder yalnızca accountId,
  // sequenceNumber ve incrementSequenceNumber çağırır. Horizon'a gitmeden kurulur.
  const account = new FakeAccount(user, userSequence);

  const builder = new TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase,
    timebounds: { minTime: 0, maxTime: now + TX_VALIDITY_SECONDS },
  }).addOperation(Operation.createClaimableBalance({ asset, amount: amountStr, claimants }));
  if (memo) builder.addMemo(typeof memo === "string" ? Memo.text(memo) : memo);
  const tx = builder.build();

  return {
    xdr: tx.toXDR(),
    balanceId,
    deadline: T,
    amount: amountStr,
    asset: assetKey(asset),
    anchor,
    user,
    txSequence: txSequence.toString(),
    validUntil: now + TX_VALIDITY_SECONDS,
  };
}

/**
 * Talep işlemi. Hem anchor (T'den önce) hem kullanıcı (T'den sonra) aynı yapıyı kullanır;
 * kimin başarılı olacağına ağ karar verir.
 */
export function buildClaimTx({
  claimant,
  claimantSequence,
  balanceId,
  networkPassphrase,
  baseFee = "100",
  now = Math.floor(Date.now() / 1000),
}) {
  assertAccount(claimant, "claimant");
  if (!/^[0-9a-f]{72}$/i.test(balanceId || "")) throw Error("balanceId 72 hex karakter olmalı");
  const account = new FakeAccount(claimant, claimantSequence);
  const tx = new TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase,
    timebounds: { minTime: 0, maxTime: now + TX_VALIDITY_SECONDS },
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .build();
  return { xdr: tx.toXDR(), balanceId, claimant };
}

// ---------------------------------------------------------------------------
// Doğrulama — kullanıcı imzalamadan ÖNCE

/**
 * Bir emanet XDR'ının protokole uyduğunu ve beklenen parametrelerle eşleştiğini doğrular.
 * Cüzdan bunu imza ekranından önce çağırır. Uyumsuzluk = imzalama, hata fırlat.
 *
 * Kontroller:
 *   · tam olarak 1 operasyon, türü createClaimableBalance
 *   · tam olarak 2 alacaklı, sıra [anchor, user]
 *   · anchor yüklemi: before(T) ; user yüklemi: not(before(T)) ; aynı T
 *   · T beklenen son tarihe eşit
 *   · varlık ve tutar beklenenle aynı
 *   · işlem kaynağı kullanıcı
 *   · rel_before hiçbir yerde yok
 */
export function verifyEscrowTx(txXdr, expect, { networkPassphrase } = {}) {
  if (!networkPassphrase) throw Error("networkPassphrase gerekli");
  const tx = new Transaction(txXdr, networkPassphrase);
  const problems = [];
  const fail = (m) => problems.push(m);

  if (tx.operations.length !== 1) fail(`1 operasyon bekleniyor, ${tx.operations.length} var`);
  const op = tx.operations[0];
  if (!op || op.type !== "createClaimableBalance") fail(`createClaimableBalance bekleniyor, ${op?.type} var`);
  if (tx.source !== expect.user) fail(`işlem kaynağı kullanıcı olmalı (${short(expect.user)}), ${short(tx.source)} var`);

  if (op?.type === "createClaimableBalance") {
    if (op.claimants.length !== 2) fail(`2 alacaklı bekleniyor, ${op.claimants.length} var`);
    const [a, u] = op.claimants;
    if (a?.destination !== expect.anchor) fail(`[0] anchor olmalı (${short(expect.anchor)}), ${short(a?.destination)} var`);
    if (u?.destination !== expect.user) fail(`[1] kullanıcı olmalı (${short(expect.user)}), ${short(u?.destination)} var`);

    const pa = a ? describePredicate(a.predicate) : null;
    const pu = u ? describePredicate(u.predicate) : null;
    if (pa?.kind !== "before") fail(`anchor yüklemi before(T) olmalı, ${pa?.kind} var`);
    if (pu?.kind !== "not" || pu.of?.kind !== "before") fail(`kullanıcı yüklemi not(before(T)) olmalı, ${pu?.kind}(${pu?.of?.kind}) var`);
    if (pa?.kind === "before" && pu?.of?.kind === "before" && pa.at !== pu.of.at)
      fail(`iki yüklemin T'si farklı: ${pa.at} ≠ ${pu.of.at}`);
    if (expect.deadline !== undefined && pa?.kind === "before" && pa.at !== toDeadline(expect.deadline))
      fail(`son tarih ${toDeadline(expect.deadline)} bekleniyor, ${pa.at} var`);
    if (containsRelative(pa) || containsRelative(pu)) fail("rel_before yasak");

    const gotAsset = assetKey(op.asset);
    if (expect.asset && gotAsset !== assetKey(expect.asset)) fail(`varlık ${assetKey(expect.asset)} bekleniyor, ${gotAsset} var`);
    if (expect.amount !== undefined) {
      const want = fromMinor(toMinor(expect.amount));
      if (op.amount !== want) fail(`tutar ${want} bekleniyor, ${op.amount} var`);
    }
  }

  if (problems.length) {
    const e = Error("Emanet işlemi doğrulanamadı:\n  · " + problems.join("\n  · "));
    e.problems = problems;
    throw e;
  }
  const seq = BigInt(tx.sequence);
  return {
    ok: true,
    balanceId: balanceIdFor({ txSource: tx.source, txSequence: seq, opIndex: 0 }),
    deadline: describePredicate(op.claimants[0].predicate).at,
    amount: op.amount,
    asset: assetKey(op.asset),
  };
}

// ---------------------------------------------------------------------------
// Yardımcılar

export function assetKey(a) {
  if (!a) return null;
  if (a.isNative?.()) return "native";
  return `${a.getCode()}:${a.getIssuer()}`;
}

export function parseAsset(key) {
  if (key === "native" || key === "XLM") return Asset.native();
  const [code, issuer] = String(key).split(":");
  if (!code || !issuer) throw Error(`Varlık "CODE:ISSUER" biçiminde olmalı: ${key}`);
  return new Asset(code, issuer);
}

function toDeadline(d) {
  let T;
  try {
    T = typeof d === "bigint" ? d : BigInt(d);
  } catch {
    throw Error(`Son tarih tam sayı unix saniye olmalı: ${d}`);
  }
  if (T <= 0n) throw Error("Son tarih pozitif olmalı");
  return T;
}

function containsRelative(p) {
  if (!p) return false;
  if (p.kind === "before-relative") return true;
  if (p.of) return Array.isArray(p.of) ? p.of.some(containsRelative) : containsRelative(p.of);
  return false;
}

function assertAccount(g, name) {
  if (!StrKey.isValidEd25519PublicKey(g || ""))
    throw Error(`${name} geçerli bir G adresi olmalı: ${g}`);
}

const short = (g) => (g ? `${g.slice(0, 4)}…${g.slice(-4)}` : "∅");

/** TransactionBuilder'ın ihtiyaç duyduğu asgari hesap arayüzü — Horizon'a gitmeden kurulum. */
class FakeAccount {
  constructor(id, seq) {
    this._id = id;
    this._seq = BigInt(seq);
  }
  accountId() {
    return this._id;
  }
  sequenceNumber() {
    return this._seq.toString();
  }
  incrementSequenceNumber() {
    this._seq += 1n;
  }
}
