// Öldürülebilir demo anchor.
//
// Sahnede kapatabilmek için kendi anchor'ımız. SEP-1 / SEP-10 / SEP-24'ün çekim alt kümesini
// konuşur ve Ripcord uzantısını ilan eder. İki arıza modu:
//
//   ÖLÜ    — süreç kapanır (POST /admin/kill ya da Ctrl-C). HTTP yok.
//   ZOMBİ  — POST /admin/freeze. HTTP cevap verir, "pending" der, hiç teslim etmez.
//            AnchorUSD vakası tam olarak bu: durum sayfası "her şey yolunda", defter değil.
//
// İki çekim modu, aynı anchor:
//   legacy  — kullanıcı anchor hesabına düz ödeme yapar. Anchor donarsa para anchor'da kalır.
//   ripcord — kullanıcı claimable balance kurar. Anchor T'den önce talep eder; donarsa
//             T geçince kullanıcı geri alır. Anchor bu durumda kaydı dürüstçe günceller.
//
// Fiat ödeme SİMÜLEDİR (log satırı). Bu bir sandbox anchor'dır ve öyle olduğunu söyler.

import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  WebAuth,
  Transaction,
} from "@stellar/stellar-sdk";
import * as jwt from "./jwt.js";
import { buildClaimTx, describePredicate, parseAsset, assetKey } from "../escrow.js";
import { toMinor, fromMinor } from "../units.js";
import { buildAttestation, signAttestation, attestationHash } from "../attest.js";
import { buildInvoke, submitInvoke, read as readContract, calls, normalizeObligation, normalizeBond } from "../bond.js";

// --- Yapılandırma ------------------------------------------------------------
const PORT = Number(process.env.ANCHOR_PORT || 4200);
const HOST = "127.0.0.1";
const HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN || `localhost:${PORT}`;
const NET = Networks.TESTNET;
const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const DELIVERY = Number(process.env.ANCHOR_DELIVERY_SECONDS || 90);
const ASSET = parseAsset(
  process.env.ANCHOR_ASSET || "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
);
if (!process.env.ANCHOR_SECRET) {
  console.error("ANCHOR_SECRET yok. Önce: npm run anchor:setup");
  process.exit(1);
}
const anchorKp = Keypair.fromSecret(process.env.ANCHOR_SECRET);
// Katman 1 — isteğe bağlı. Yoksa yalnızca claimable_balance modu ilan edilir.
const BOND_CONTRACT = process.env.RIPCORD_BOND_CONTRACT || null;
const ARBITER = process.env.ARBITER_PUBLIC || null;
const BOND_AMOUNT_MINOR = BigInt(process.env.ANCHOR_BOND_MINOR || 100_0000000); // 100 birim
let bondConfig = null; // { challenge_secs, penalty_bps }
let nextObligationId = 1n; // taranan son yükümlülük id'si + 1
const ANCHOR = anchorKp.publicKey();
const JWT_SECRET = randomUUID() + randomUUID(); // her açılışta yeni; demo için doğru davranış
const horizon = new Horizon.Server(HORIZON);

// --- Durum -------------------------------------------------------------------
const txs = new Map(); // id → kayıt
let frozen = false;
const bootedAt = new Date().toISOString();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- Yardımcılar --------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const html = (res, body) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};
async function readBody(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 64 * 1024) throw Error("İstek çok büyük");
  }
  if (!raw) return {};
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}
function bearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(h);
  const p = m ? jwt.verify(m[1], JWT_SECRET) : null;
  if (!p) throw Object.assign(Error("Geçerli SEP-10 token gerekli"), { status: 401 });
  return p;
}
/** Kayıt görünümü — SEP-24 alanları + Ripcord uzantısı. İç alanlar dışarı çıkmaz. */
function view(t) {
  const base = {
    id: t.id,
    kind: "withdrawal",
    status: t.status,
    amount_in: t.amount,
    amount_in_asset: `stellar:${assetKey(ASSET)}`,
    amount_out: t.amount, // sandbox: 1:1
    amount_fee: "0",
    started_at: t.startedAt,
    completed_at: t.completedAt ?? null,
    message: t.message ?? null,
    withdraw_anchor_account: ANCHOR,
    withdraw_memo: t.memo,
    withdraw_memo_type: "text",
    stellar_transaction_id: t.stellarTx ?? null,
    more_info_url: `http://${HOME_DOMAIN}/interactive?id=${t.id}`,
    // Katman 2 — SEP-53 imzalı teslim beyanı. Legacy'de de var: tek başına benimsenebilir.
    escrow_attestation: t.attestation ?? null,
  };
  if (!t.escrow) return base;
  if (t.bonded)
    return {
      ...base,
      escrow_mode: "bonded_contract",
      escrow_contract: BOND_CONTRACT,
      escrow_claimant: ANCHOR,
      escrow_max_delivery_seconds: DELIVERY,
      escrow_obligation_id: t.obligationId ?? null,
      escrow_state: t.obligationState ?? null,
      escrow_deadline: t.escrowDeadline ?? null,
      escrow_outcome: t.escrowOutcome ?? "pending",
      escrow_challenge_seconds: bondConfig?.challenge_secs ?? null,
    };
  return {
    ...base,
    // --- Ripcord uzantısı (SEP taslağı §3–4) ---
    escrow_mode: "claimable_balance",
    escrow_claimant: ANCHOR,
    escrow_max_delivery_seconds: DELIVERY,
    escrow_balance_id: t.escrowBalanceId ?? null,
    escrow_deadline: t.escrowDeadline ?? null,
    escrow_outcome: t.escrowOutcome ?? "pending",
  };
}

// --- SEP-1 -------------------------------------------------------------------
const toml = () => `# Ripcord demo anchor — SANDBOX. Fiat ödeme simüledir.
VERSION="2.7.0"
NETWORK_PASSPHRASE="${NET}"
SIGNING_KEY="${ANCHOR}"
WEB_AUTH_ENDPOINT="http://${HOME_DOMAIN}/auth"
TRANSFER_SERVER_SEP0024="http://${HOME_DOMAIN}"
ACCOUNTS=["${ANCHOR}"]

[DOCUMENTATION]
ORG_NAME="Ripcord Demo Anchor"
ORG_DESCRIPTION="Sahnede öldürülmek için var. Gerçek para hareket etmez."

[[CURRENCIES]]
code="${ASSET.getCode()}"
issuer="${ASSET.getIssuer()}"
status="test"
is_asset_anchored=true
anchor_asset_type="fiat"
anchor_asset="TRY"
desc="Sandbox — çekimde TRY olarak 'ödenir' (simüle)."
`;

// --- SEP-24 /info + Ripcord ilanı ----------------------------------------------
const info = () => ({
  deposit: {},
  withdraw: {
    [ASSET.getCode()]: {
      enabled: true,
      min_amount: 1,
      max_amount: 10000,
      fee_fixed: 0,
      fee_percent: 0,
      // Ripcord: anchor teslim süresini İLAN eder. Kullanıcı imzadan önce görür.
      escrow: {
        supported: true,
        max_delivery_seconds: DELIVERY,
        modes: BOND_CONTRACT ? ["claimable_balance", "bonded_contract"] : ["claimable_balance"],
        ...(BOND_CONTRACT ? { contract: BOND_CONTRACT, challenge_seconds: bondConfig?.challenge_secs ?? null } : {}),
      },
    },
  },
  fee: { enabled: false },
  features: { account_creation: false, claimable_balances: true },
});

// "Fiat ödendi" — SİMÜLE. Gerçek anchor burada bankaya talimat verir ve referansı alır.
// Beyan, anchor'ın SIGNING_KEY'iyle imzalanır (anchorKp = SIGNING_KEY). Katman 2.
const TRY_RATE = 41; // sandbox kuru
function payFiatAndAttest(t, escrowRef) {
  const reference = `FAST-${Date.now().toString(36).toUpperCase()}`;
  const message = buildAttestation({
    transactionId: t.id,
    escrowRef,
    asset: assetKey(ASSET),
    amount: t.amount,
    fiat: { currency: "TRY", amount: (Number(t.amount) * TRY_RATE).toFixed(2), reference },
  });
  t.attestation = signAttestation(message, anchorKp);
  return reference;
}

// --- Gözcü: Horizon'u izler ------------------------------------------------------
// GÖRMEK ile TESLİM ETMEK ayrı. Donmuş (zombi) anchor zinciri görür, kaydeder; sadece
// ödemez. Bu, AnchorUSD'nin gerçek davranışı: /info hâlâ cevap veriyor, para geliyor,
// hiçbir şey olmuyor.
let watching = false;
async function watch() {
  if (watching) return; // turlar örtüşmesin — yarış yok
  watching = true;
  try {
    const open = [...txs.values()].filter((t) => ["pending_user_transfer_start", "pending_anchor", "pending_external", "on_hold"].includes(t.status));
    if (!open.length) return;
    await watchRipcord(open.filter((t) => t.escrow && !t.bonded));
    await watchBonded(open.filter((t) => t.bonded));
    await watchLegacy(open.filter((t) => !t.escrow));
  } catch (e) {
    log("gözcü hatası:", e.message);
  } finally {
    watching = false;
  }
}

async function watchRipcord(list) {
  if (!list.length) return;
  const page = await horizon.claimableBalances().claimant(ANCHOR).limit(100).order("desc").call();
  const now = Math.floor(Date.now() / 1000);
  for (const t of list) {
    if (t.claiming) continue; // talep yolda; sonucu o karar verir
    const cb = page.records.find((r) => {
      if (t.escrowBalanceId) return r.id === t.escrowBalanceId;
      return r.sponsor === t.account && r.asset === `${ASSET.getCode()}:${ASSET.getIssuer()}` && toMinor(r.amount) === toMinor(t.amount);
    });

    if (!cb) {
      if (!t.escrowBalanceId) continue; // henüz kurulmadı
      const T = Math.floor(new Date(t.escrowDeadline).getTime() / 1000);
      // Protokol kuralı: kullanıcı yalnızca T'den SONRA alabilir. Emanet T'den sonra
      // yoksa ve biz almadıysak → kullanıcı geri aldı. T'den önce yoksa → bizim talebimiz
      // henüz yansımadı; bekle.
      if (now >= T) {
        t.status = "refunded";
        t.escrowOutcome = "reclaimed_by_user";
        t.message = "Teslim süresi doldu; kullanıcı emaneti tek taraflı geri aldı. Anchor teslim etmedi.";
        t.completedAt = new Date().toISOString();
        log(`↩ ${t.id.slice(0, 8)} kullanıcı geri aldı — biz teslim etmedik`);
      }
      continue;
    }

    // GÖRMEK — donmuş olsak da kaydederiz.
    if (!t.escrowBalanceId) {
      const mine = cb.claimants.find((c) => c.destination === ANCHOR);
      const T = predicateDeadline(mine?.predicate);
      if (!T) { log(`⚠ ${t.id.slice(0, 8)} emanet yüklemi beklenen biçimde değil, yok sayıldı`); continue; }
      t.escrowBalanceId = cb.id;
      t.escrowDeadline = new Date(Number(T) * 1000).toISOString();
      t.status = "pending_anchor"; // fon emanette, sıra bizde
      log(`◈ ${t.id.slice(0, 8)} emanet görüldü ${cb.id.slice(0, 12)}… T=${t.escrowDeadline}${frozen ? " (DONMUŞ — teslim yok)" : ""}`);
    }
    if (frozen) continue; // TESLİM ETMEK — zombi burada durur.

    const T = Math.floor(new Date(t.escrowDeadline).getTime() / 1000);
    if (now >= T - 5) { log(`… ${t.id.slice(0, 8)} T'ye çok yakın, talep denenmiyor`); continue; }

    // "Fiat ödendi" — SİMÜLE. Sonra emaneti T'den önce al.
    const ref = payFiatAndAttest(t, cb.id);
    log(`$ ${t.id.slice(0, 8)} fiat ödendi (simüle) ${ref} → beyan imzalandı → emanet talep ediliyor`);
    t.claiming = true;
    try {
      const acc = await horizon.loadAccount(ANCHOR);
      const claim = buildClaimTx({ claimant: ANCHOR, claimantSequence: acc.sequenceNumber(), balanceId: cb.id, networkPassphrase: NET });
      const tx = new Transaction(claim.xdr, NET);
      tx.sign(anchorKp);
      const r = await horizon.submitTransaction(tx);
      t.stellarTx = r.hash;
      t.status = "completed";
      t.escrowOutcome = "claimed_by_anchor";
      t.completedAt = new Date().toISOString();
      t.message = "Fiat ödendi (sandbox); emanet T'den önce talep edildi.";
      log(`✓ ${t.id.slice(0, 8)} tamamlandı ${r.hash.slice(0, 10)}…`);
    } catch (e) {
      log(`✗ ${t.id.slice(0, 8)} talep düştü:`, JSON.stringify(e?.response?.data?.extras?.result_codes || e.message));
    } finally {
      t.claiming = false;
    }
  }
}

// Katman 1 gözcüsü. Yükümlülük id'leri sıralı: yenileri get(nextId) ile tararız.
async function anchorInvoke(call) {
  const built = await buildInvoke({ source: ANCHOR, contractId: BOND_CONTRACT, ...call });
  const tx = new Transaction(built.xdr, NET);
  tx.sign(anchorKp);
  return submitInvoke(tx.toXDR());
}
async function watchBonded(list) {
  if (!list.length || !BOND_CONTRACT) return;
  const now = Math.floor(Date.now() / 1000);
  // 1) Yeni yükümlülükleri tara ve eşle.
  const unassigned = list.filter((t) => !t.obligationId);
  if (unassigned.length) {
    for (let guard = 0; guard < 20; guard++) {
      let o;
      try { o = normalizeObligation(await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.get(nextObligationId) })); }
      catch (e) { if (e.contractError === "NotFound") break; throw e; }
      const id = nextObligationId; nextObligationId += 1n;
      if (o.anchor !== ANCHOR) continue;
      const t = unassigned.find((x) => !x.obligationId && x.account === o.user && toMinor(x.amount) === Number(BigInt(o.amount)));
      if (!t) continue;
      t.obligationId = id.toString();
      t.obligationState = o.state;
      t.escrowDeadline = new Date(o.deadline * 1000).toISOString();
      t.status = "pending_anchor";
      log(`◈ ${t.id.slice(0, 8)} teminatlı yükümlülük #${id} görüldü · T=${t.escrowDeadline}${frozen ? " (DONMUŞ — teslim yok)" : ""}`);
    }
  }
  // 2) Atanmışların durumunu ilerlet.
  for (const t of list.filter((x) => x.obligationId)) {
    if (t.claiming) continue;
    let o;
    try { o = normalizeObligation(await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.get(BigInt(t.obligationId)) })); }
    catch (e) { log(`⚠ #${t.obligationId} okunamadı: ${e.message}`); continue; }
    t.obligationState = o.state;
    const T = o.deadline;
    switch (o.state) {
      case "Open": {
        if (frozen) break;
        if (now >= T - 5) { log(`… ${t.id.slice(0, 8)} T'ye çok yakın, claim denenmiyor`); break; }
        const ref = payFiatAndAttest(t, `bond:${t.obligationId}`);
        log(`$ ${t.id.slice(0, 8)} fiat ödendi (simüle) ${ref} → claim #${t.obligationId} (beyan hash'iyle)`);
        t.claiming = true;
        try {
          const r = await anchorInvoke(calls.claim(BigInt(t.obligationId), attestationHash(t.attestation.message)));
          t.status = "pending_external"; // itiraz penceresi
          t.escrowOutcome = "claimed_by_anchor";
          t.message = `Fiat ödendi (sandbox); claim edildi, itiraz penceresi ${bondConfig?.challenge_secs ?? "?"} sn.`;
          t.claimTx = r.hash;
          log(`✓ ${t.id.slice(0, 8)} claim #${t.obligationId} ${r.hash.slice(0, 10)}… — pencere açık`);
        } catch (e) { log(`✗ ${t.id.slice(0, 8)} claim düştü: ${e.message}`); }
        finally { t.claiming = false; }
        break;
      }
      case "Claimed": {
        if (frozen) break;
        const windowEnd = o.claimed_at + Number(bondConfig?.challenge_secs ?? 0);
        if (now < windowEnd) break;
        t.claiming = true;
        try {
          const r = await anchorInvoke(calls.finalize(BigInt(t.obligationId)));
          t.status = "completed"; t.stellarTx = r.hash; t.completedAt = new Date().toISOString();
          t.message = "İtiraz penceresi itirazsız kapandı; emanet anchor'a geçti.";
          log(`✓ ${t.id.slice(0, 8)} finalize #${t.obligationId} — tamamlandı`);
        } catch (e) { log(`✗ finalize düştü: ${e.message}`); }
        finally { t.claiming = false; }
        break;
      }
      case "Disputed":
        if (t.status !== "on_hold") { t.status = "on_hold"; t.escrowOutcome = "disputed"; t.message = "Kullanıcı itiraz etti; hakem bekleniyor."; log(`⚖ ${t.id.slice(0, 8)} #${t.obligationId} İTİRAZ`); }
        break;
      case "Reclaimed":
        t.status = "refunded"; t.escrowOutcome = "reclaimed_by_user"; t.completedAt = new Date().toISOString();
        t.message = "Teslim süresi doldu; kullanıcı tek taraflı geri aldı. Anchor teslim etmedi.";
        log(`↩ ${t.id.slice(0, 8)} #${t.obligationId} kullanıcı geri aldı`);
        break;
      case "Resolved":
        t.completedAt = new Date().toISOString();
        if (o.user_won) { t.status = "refunded"; t.escrowOutcome = "resolved_for_user"; t.message = "Hakem kullanıcıyı haklı buldu; tutar + ceza kullanıcıya, teminattan."; }
        else { t.status = "completed"; t.escrowOutcome = "resolved_for_anchor"; t.message = "Hakem anchor'ı haklı buldu; tutar anchor'a."; }
        log(`⚖ ${t.id.slice(0, 8)} #${t.obligationId} karar: ${o.user_won ? "kullanıcı" : "anchor"}`);
        break;
      case "Settled":
        t.status = "completed"; t.completedAt = t.completedAt ?? new Date().toISOString();
        break;
    }
  }
}

async function watchLegacy(list) {
  if (!list.length) return;
  const page = await horizon.payments().forAccount(ANCHOR).join("transactions").limit(100).order("desc").call();
  for (const t of list) {
    if (!t.stellarTx) {
      const p = page.records.find((r) => r.type === "payment" && r.to === ANCHOR && r.from === t.account && r.transaction_attr?.memo === t.memo && toMinor(r.amount) === toMinor(t.amount));
      if (!p) continue;
      // Para artık anchor hesabında. Custody bizde. Kullanıcının dayanağı yok.
      t.stellarTx = p.transaction_hash;
      t.status = "pending_anchor";
      log(`◈ ${t.id.slice(0, 8)} legacy ödeme ALINDI ${p.transaction_hash.slice(0, 10)}…${frozen ? " (DONMUŞ — para bizde, teslim yok)" : ""}`);
    }
    if (frozen) continue; // zombi: parayı aldı, pending_anchor'da sonsuza kadar
    payFiatAndAttest(t, t.stellarTx);
    t.status = "completed";
    t.completedAt = new Date().toISOString();
    t.message = "Ödeme alındı; fiat ödendi (sandbox).";
    log(`✓ ${t.id.slice(0, 8)} legacy tamamlandı`);
  }
}

function predicateDeadline(p) {
  if (!p) return null;
  // Horizon JSON: { abs_before: "2026-…", abs_before_epoch: "1789…" }
  if (p.abs_before_epoch) return BigInt(p.abs_before_epoch);
  if (p.abs_before) return BigInt(Math.floor(new Date(p.abs_before).getTime() / 1000));
  return null;
}

// --- HTTP --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOME_DOMAIN}`);
  const path = url.pathname;
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    if (path === "/.well-known/stellar.toml") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(toml());
    }

    // SEP-10
    if (path === "/auth" && req.method === "GET") {
      const account = url.searchParams.get("account");
      if (!account) return json(res, 400, { error: "account gerekli" });
      const tx = WebAuth.buildChallengeTx(anchorKp, account, HOME_DOMAIN.split(":")[0], 300, NET, HOME_DOMAIN.split(":")[0]);
      return json(res, 200, { transaction: tx, network_passphrase: NET });
    }
    if (path === "/auth" && req.method === "POST") {
      const body = await readBody(req);
      const { clientAccountID } = WebAuth.readChallengeTx(body.transaction, ANCHOR, NET, HOME_DOMAIN.split(":")[0], HOME_DOMAIN.split(":")[0]);
      WebAuth.verifyChallengeTxSigners(body.transaction, ANCHOR, NET, [clientAccountID], HOME_DOMAIN.split(":")[0], HOME_DOMAIN.split(":")[0]);
      // Demo: 12 saat. Sahne öncesi kurulum 15 dk'yı aşarsa token düşmesin.
      return json(res, 200, { token: jwt.sign({ iss: `http://${HOME_DOMAIN}/auth`, sub: clientAccountID }, JWT_SECRET, { ttlSeconds: 12 * 3600 }) });
    }

    // SEP-24
    if (path === "/info") return json(res, 200, info());

    if (path === "/transactions/withdraw/interactive" && req.method === "POST") {
      const auth = bearer(req);
      const body = await readBody(req);
      if ((body.asset_code || ASSET.getCode()) !== ASSET.getCode()) return json(res, 400, { error: "desteklenmeyen varlık" });
      const account = body.account || auth.sub;
      if (account !== auth.sub) return json(res, 403, { error: "token başka hesaba ait" });
      const amount = fromMinor(toMinor(body.amount || "10"));
      const id = randomUUID();
      // SEP §2: escrow_mode. Bilinmeyen mod → 400. Sessizce düz ödemeye düşmek YASAK.
      const mode = body.escrow_mode ?? null;
      const supported = [null, "claimable_balance", ...(BOND_CONTRACT ? ["bonded_contract"] : [])];
      if (!supported.includes(mode))
        return json(res, 400, { error: `desteklenmeyen escrow_mode: ${mode}` });
      const escrow = mode !== null;
      const bonded = mode === "bonded_contract";
      txs.set(id, {
        id, account, amount, escrow, bonded,
        memo: `rc:${id.slice(0, 12)}`,
        status: "incomplete",
        startedAt: new Date().toISOString(),
      });
      log(`+ ${id.slice(0, 8)} çekim ${amount} ${ASSET.getCode()} · ${bonded ? "RIPCORD·TEMİNATLI" : escrow ? "RIPCORD" : "legacy"} · ${account.slice(0, 6)}…`);
      return json(res, 200, { type: "interactive_customer_info_needed", url: `http://${HOME_DOMAIN}/interactive?id=${id}`, id });
    }

    // Etkileşimli adım — sandbox: banka bilgisi "alındı", işlem ödeme bekliyor.
    if (path === "/interactive") {
      const t = txs.get(url.searchParams.get("id") || "");
      if (!t) return json(res, 404, { error: "işlem yok" });
      if (t.status === "incomplete") {
        t.status = "pending_user_transfer_start";
        log(`→ ${t.id.slice(0, 8)} banka bilgisi alındı (sandbox), ödeme bekleniyor`);
      }
      return html(res, `<!doctype html><meta charset=utf-8><title>Ripcord demo anchor</title>
<body style="font:15px ui-sans-serif;padding:32px;max-width:460px;margin:auto;color:#222">
<p style="letter-spacing:.14em;font-size:.72rem;color:#777">RIPCORD DEMO ANCHOR · SANDBOX</p>
<h2 style="margin:.2em 0">Banka bilgileri alındı</h2>
<p>IBAN: TR** **** **** **** (simüle)<br>Tutar: <b>${t.amount} ${ASSET.getCode()}</b> → TRY</p>
<p style="color:#555">Bu pencereyi kapatıp cüzdana dönebilirsiniz. ${t.escrow ? `Teslim süresi ilanı: <b>${DELIVERY} sn</b>.` : ""}</p>
<script>try{window.opener&&window.opener.postMessage({transaction:${JSON.stringify(view(t))}},"*")}catch(e){}</script>`);
    }

    if (path === "/transaction") {
      const auth = bearer(req);
      const t = txs.get(url.searchParams.get("id") || "");
      if (!t || t.account !== auth.sub) return json(res, 404, { error: "işlem yok" });
      return json(res, 200, { transaction: view(t) });
    }
    if (path === "/transactions") {
      const auth = bearer(req);
      const list = [...txs.values()].filter((t) => t.account === auth.sub).map(view);
      return json(res, 200, { transactions: list });
    }

    // Yönetim — yalnızca 127.0.0.1'de dinliyoruz; sahne kumandası.
    if (path === "/admin/state") {
      let bond = null;
      if (BOND_CONTRACT) {
        try { bond = { contract: BOND_CONTRACT, arbiter: ARBITER, config: bondConfig, stats: normalizeBond(await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.stats(ANCHOR) })) }; }
        catch (e) { bond = { contract: BOND_CONTRACT, error: e.message }; }
      }
      return json(res, 200, { alive: true, frozen, bootedAt, anchor: ANCHOR, asset: assetKey(ASSET), deliverySeconds: DELIVERY, transactions: txs.size, bond });
    }
    if (path === "/admin/freeze" && req.method === "POST") { frozen = true; log("❄ DONDURULDU — cevap veriyoruz, teslim etmiyoruz"); return json(res, 200, { frozen }); }
    if (path === "/admin/unfreeze" && req.method === "POST") { frozen = false; log("☀ çözüldü"); return json(res, 200, { frozen }); }
    if (path === "/admin/kill" && req.method === "POST") {
      log("☠ ÖLDÜRÜLDÜ");
      json(res, 200, { alive: false });
      setTimeout(() => process.exit(0), 150);
      return;
    }

    return json(res, 404, { error: "yok" });
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nRipcord demo anchor · http://${HOME_DOMAIN}`);
  console.log(`  hesap   ${ANCHOR}`);
  console.log(`  varlık  ${assetKey(ASSET)}`);
  console.log(`  teslim  ${DELIVERY} sn ilan ediliyor`);
  console.log(`  kumanda POST /admin/freeze · /admin/unfreeze · /admin/kill\n`);
  setInterval(watch, 3000);
  bootBond().catch((e) => log("Katman 1 açılış hatası:", e.message));
});

// Açılışta: sözleşme yapılandırmasını oku; teminat yoksa yatır. Anchor'ın "sigortalı çekim"
// ilan edebilmesi için teminatı zincirde olmalı — bu, ilanın kendisi.
async function bootBond() {
  if (!BOND_CONTRACT) return;
  if (!ARBITER) { log("Katman 1: ARBITER_PUBLIC yok, teminat yatırılmıyor"); return; }
  bondConfig = await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.config() });
  bondConfig = { challenge_secs: Number(bondConfig.challenge_secs), penalty_bps: Number(bondConfig.penalty_bps) };
  let stats = null;
  try { stats = normalizeBond(await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.stats(ANCHOR) })); } catch {}
  // Var olan yükümlülükleri atlamak için sayaç: en yüksek id'yi bul.
  for (let id = 1n; id < 10_000n; id++) {
    try { await readContract({ contractId: BOND_CONTRACT, source: ANCHOR, ...calls.get(id) }); nextObligationId = id + 1n; }
    catch (e) { if (e.contractError === "NotFound") break; throw e; }
  }
  if (stats && BigInt(stats.total) > 0n) { log(`Katman 1: teminat ${fromMinor(Number(BigInt(stats.total)))} · kilitli ${fromMinor(Number(BigInt(stats.locked)))} · açık ${stats.open}`); return; }
  try {
    const r = await anchorInvoke(calls.bond(ANCHOR, BOND_AMOUNT_MINOR, ARBITER));
    log(`Katman 1: teminat yatırıldı ${fromMinor(Number(BOND_AMOUNT_MINOR))} ${ASSET.getCode()} · hakem ${ARBITER.slice(0, 6)}… · ${r.hash.slice(0, 10)}…`);
  } catch (e) {
    log("Katman 1: teminat yatırılamadı —", e.message, "(anchor'ın varlık bakiyesi var mı?)");
  }
}
