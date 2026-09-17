// Uçtan uca: cüzdan rolünde demo kullanıcı, yerel anchor'a karşı tam SEP akışı.
//
//   1. SEP-1 keşif → SEP-10 kimlik → SEP-24 /info (Ripcord ilanı okunur)
//   2. Çekim A (ripcord): emanet kur → anchor teslim eder → completed / claimed_by_anchor
//   3. Anchor DONDURULUR (zombi)
//   4. Çekim B (ripcord): emanet kur → anchor sessiz → T geçer → kullanıcı geri alır
//      → anchor kaydı: refunded / reclaimed_by_user
//   5. Çekim C (legacy, dondurulmuş anchor): düz ödeme → para anchor'da, sonsuza kadar pending
//
// Gerekli: .env'de DEMO_USER_SECRET (anchor:setup --own-asset) ve anchor'ın çalışıyor olması.

import { mkdirSync, writeFileSync } from "node:fs";
import dns from "node:dns";
// "localhost" IPv6'ya (::1) çözülebilir; anchor 127.0.0.1'de dinliyor. BillRail'de aynı tuzağa düştük.
dns.setDefaultResultOrder("ipv4first");
import {
  Asset, Horizon, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildEscrowTx, buildClaimTx, deadlineFor, verifyEscrowTx, parseAsset } from "../src/escrow.js";

const ANCHOR_URL = process.env.ANCHOR_URL || `http://localhost:${process.env.ANCHOR_PORT || 4200}`;
const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;
const horizon = new Horizon.Server(HORIZON);
if (!process.env.DEMO_USER_SECRET) {
  console.error("DEMO_USER_SECRET yok. Önce: npm run anchor:setup -- --own-asset");
  process.exit(1);
}
const user = Keypair.fromSecret(process.env.DEMO_USER_SECRET);
const USER = user.publicKey();

const report = { at: new Date().toISOString(), anchor: ANCHOR_URL, steps: [] };
const log = (msg, extra = {}) => { console.log(`  ${msg}`); report.steps.push({ msg, ...extra, t: new Date().toISOString() }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function api(path, { method = "GET", body, token } = {}) {
  const r = await fetch(ANCHOR_URL + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(`${method} ${path} → ${r.status} ${j.error || ""}`);
  return j;
}
async function submit(kp, xdr) {
  const tx = new Transaction(xdr, NET);
  tx.sign(kp);
  try { const r = await horizon.submitTransaction(tx); return { ok: true, hash: r.hash }; }
  catch (e) { return { ok: false, codes: e?.response?.data?.extras?.result_codes }; }
}
async function balance(pub, asset) {
  const a = await horizon.loadAccount(pub);
  const b = a.balances.find((x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer());
  return b ? b.balance : "0";
}
async function waitStatus(id, token, want, timeoutMs) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = (await api(`/transaction?id=${id}`, { token })).transaction;
    if (want.includes(last.status)) return last;
    await sleep(2000);
  }
  throw Error(`${id.slice(0, 8)} ${want} beklendi, ${last?.status} kaldı`);
}

// --- SEP-1 + SEP-10 ------------------------------------------------------------
async function discoverAndAuth() {
  const toml = await (await fetch(`${ANCHOR_URL}/.well-known/stellar.toml`)).text();
  const signing = /SIGNING_KEY="(G[A-Z2-7]{55})"/.exec(toml)?.[1];
  const authUrl = /WEB_AUTH_ENDPOINT="([^"]+)"/.exec(toml)?.[1];
  if (!signing || !authUrl) throw Error("TOML eksik");
  log("SEP-1 keşif", { signing: signing.slice(0, 8) + "…", authUrl });

  const ch = await (await fetch(`${authUrl}?account=${USER}`)).json();
  const tx = new Transaction(ch.transaction, NET);
  // Cüzdan disiplini: challenge'ı imzalamadan önce doğrula — sıra 0, kaynak anchor.
  if (tx.sequence !== "0") throw Error("SEP-10 challenge sırası 0 değil!");
  if (tx.source !== signing) throw Error("SEP-10 challenge kaynağı SIGNING_KEY değil!");
  tx.sign(user);
  const { token } = await (await fetch(authUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction: tx.toXDR() }) })).json();
  if (!token) throw Error("token gelmedi");
  log("SEP-10 kimlik doğrulandı");
  return token;
}

// --- Bir çekim döngüsü -----------------------------------------------------------
async function withdraw({ token, asset, amount, escrow, label }) {
  const start = await api("/transactions/withdraw/interactive", { method: "POST", token, body: { asset_code: asset.getCode(), amount, account: USER, ...(escrow ? { escrow_mode: "claimable_balance" } : {}) } });
  await fetch(start.url); // etkileşimli adım — sandbox otomatik tamamlar
  const t = await waitStatus(start.id, token, ["pending_user_transfer_start"], 10_000);
  log(`${label}: anchor ödeme bekliyor`, { id: t.id, memo: t.withdraw_memo, escrow: Boolean(t.escrow_mode), delivery: t.escrow_max_delivery_seconds ?? null });
  const acc = await horizon.loadAccount(USER);

  if (!escrow) {
    // BUGÜNKÜ AKIŞ: düz ödeme. Bundan sonra kullanıcının hiçbir dayanağı yok.
    const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).setTimeout(120)
      .addOperation(Operation.payment({ destination: t.withdraw_anchor_account, asset, amount }))
      .addMemo(Memo.text(t.withdraw_memo)).build();
    const r = await submit(user, tx.toXDR());
    if (!r.ok) throw Error("legacy ödeme düştü " + JSON.stringify(r.codes));
    return { id: t.id, tx: r.hash };
  }

  // RIPCORD: anchor'ın ilan ettiği süreyle emanet kur, imzadan önce doğrula.
  const T = deadlineFor(t.escrow_max_delivery_seconds, now());
  const built = buildEscrowTx({ user: USER, userSequence: acc.sequenceNumber(), anchor: t.escrow_claimant, asset, amount, deadline: T, networkPassphrase: NET, memo: t.withdraw_memo });
  verifyEscrowTx(built.xdr, { user: USER, anchor: t.escrow_claimant, deadline: T, asset, amount }, { networkPassphrase: NET });
  const r = await submit(user, built.xdr);
  if (!r.ok) throw Error("emanet düştü " + JSON.stringify(r.codes));
  return { id: t.id, tx: r.hash, balanceId: built.balanceId, deadline: Number(T) };
}

// --- Ana akış -------------------------------------------------------------------
async function main() {
  console.log("\nRipcord · anchor uçtan uca kontrolü\n");
  const state = await api("/admin/state");
  if (state.frozen) await api("/admin/unfreeze", { method: "POST" });
  const asset = parseAsset(state.asset);
  const token = await discoverAndAuth();
  const info = await api("/info");
  const w = info.withdraw[asset.getCode()];
  if (!w?.escrow?.supported) throw Error("/info Ripcord ilan etmiyor");
  log("SEP-24 /info: Ripcord ilanı okundu", { max_delivery_seconds: w.escrow.max_delivery_seconds, modes: w.escrow.modes });

  const before = await balance(USER, asset);

  // A — anchor sağlıklı, ripcord
  console.log("\n── A · Ripcord, anchor sağlıklı ──");
  const A = await withdraw({ token, asset, amount: "10", escrow: true, label: "A" });
  const doneA = await waitStatus(A.id, token, ["completed"], 60_000);
  if (doneA.escrow_outcome !== "claimed_by_anchor") throw Error("A: escrow_outcome " + doneA.escrow_outcome);
  if (doneA.escrow_balance_id !== A.balanceId) throw Error("A: anchor'ın gördüğü balanceId bizimkinden farklı");
  log("✓ A tamamlandı: anchor T'den önce talep etti", { outcome: doneA.escrow_outcome, tx: doneA.stellar_transaction_id });

  // Anchor'ı dondur — zombi.
  console.log("\n── Anchor DONDURULUYOR (HTTP açık, teslim yok) ──");
  await api("/admin/freeze", { method: "POST" });
  log("❄ anchor donduruldu");

  // B — ripcord, anchor zombi
  console.log("\n── B · Ripcord, anchor zombi ──");
  const B = await withdraw({ token, asset, amount: "10", escrow: true, label: "B" });
  const afterEscrow = await balance(USER, asset);
  log("emanet kuruldu, anchor sessiz", { balanceId: B.balanceId, userBalance: afterEscrow });
  const wait = B.deadline - now() + 8;
  log(`T'ye ${wait} sn bekleniyor…`);
  await sleep(wait * 1000);
  const acc = await horizon.loadAccount(USER);
  const back = buildClaimTx({ claimant: USER, claimantSequence: acc.sequenceNumber(), balanceId: B.balanceId, networkPassphrase: NET });
  const r = await submit(user, back.xdr);
  if (!r.ok) throw Error("geri alma düştü " + JSON.stringify(r.codes));
  log("✓ B: kullanıcı parasını geri aldı — anchor zombi, kimse onaylamadı", { tx: r.hash, userBalance: await balance(USER, asset) });

  // Anchor çözülünce kaydı dürüstçe güncellemeli.
  await api("/admin/unfreeze", { method: "POST" });
  const doneB = await waitStatus(B.id, token, ["refunded"], 20_000);
  if (doneB.escrow_outcome !== "reclaimed_by_user") throw Error("B: escrow_outcome " + doneB.escrow_outcome);
  log("✓ B: anchor kaydı reclaimed_by_user oldu", { status: doneB.status, outcome: doneB.escrow_outcome });
  await api("/admin/freeze", { method: "POST" });

  // C — legacy, anchor zombi: bugünkü dünya
  console.log("\n── C · Bugünkü akış, anchor zombi ──");
  const C = await withdraw({ token, asset, amount: "10", escrow: false, label: "C" });
  await sleep(8000);
  const stuck = (await api(`/transaction?id=${C.id}`, { token })).transaction;
  const anchorBal = await balance(state.anchor, asset);
  log("✗ C: para anchor hesabında, durum değişmiyor, kullanıcının yapabileceği hiçbir şey yok", { status: stuck.status, anchorBalance: anchorBal, userBalance: await balance(USER, asset) });
  await api("/admin/unfreeze", { method: "POST" });

  report.summary = { before, after: await balance(USER, asset), A: doneA.escrow_outcome, B: doneB.escrow_outcome, C: stuck.status };
  report.result = "PASS";
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/anchor-e2e.json", JSON.stringify(report, null, 2));
  console.log("\nSONUÇ: PASS · reports/anchor-e2e.json\n");
}

main().catch(async (e) => {
  report.result = "FAIL"; report.error = e.message;
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/anchor-e2e.json", JSON.stringify(report, null, 2));
  console.error("\nSONUÇ: FAIL —", e.message, "\n");
  try { await api("/admin/unfreeze", { method: "POST" }); } catch {}
  process.exit(1);
});
