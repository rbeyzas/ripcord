// Cüzdan sunucusunun API'sini tarayıcının çağıracağı sırayla koşar; imzayı demo
// kullanıcı yerelde atar (sahnede Freighter atar). Anchor + cüzdan sunucusu açık olmalı.
//
//   ripcord çekim → imzala → gönder → anchor teslim eder
//   dondur → ripcord çekim → T geç → /api/reclaim → imzala → gönder
//   legacy çekim (donmuş) → para anchor'da, /api/withdraw/:id pending_anchor
//   öldür → /api/state alive:false, /api/withdraw/:id anchorAlive:false

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";

const UI = process.env.UI_URL || `http://localhost:${process.env.PORT || 4173}`;
const user = Keypair.fromSecret(process.env.DEMO_USER_SECRET);
const account = user.publicKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const ok = (m) => console.log("  ✓", m);

async function api(path, body) {
  const r = await fetch(UI + path, body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: UI }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(j.error || `${path} → ${r.status}`), { dead: j.dead });
  return j;
}
const signLocal = (xdr) => { const t = new Transaction(xdr, Networks.TESTNET); t.sign(user); return t.toXDR(); };

async function withdraw(mode) {
  const w = await api("/api/withdraw", { account, amount: "10", mode });
  const sub = await api("/api/submit", { signedXdr: signLocal(w.xdr), id: w.id });
  return { ...w, hash: sub.hash };
}
async function waitFor(id, pred, ms) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { last = await api(`/api/withdraw/${id}`); if (pred(last)) return last; await sleep(2000); }
  throw Error(`bekleme doldu: ${JSON.stringify(last?.anchor?.status)} alive=${last?.anchorAlive}`);
}

console.log("\nRipcord · cüzdan sunucusu kontrolü\n");
let s = await api("/api/state");
if (!s.alive) throw Error("anchor kapalı");
if (s.frozen) await api("/api/admin/unfreeze", {});

// SEP-10 tarayıcı akışı
const ch = await api("/api/anchor/challenge", { account });
await api("/api/anchor/token", { account, signedXdr: signLocal(ch.xdr) });
s = await api(`/api/state?account=${account}`);
if (!s.authenticated) throw Error("token kaydedilmedi");
ok("SEP-10: sunucu doğruladı, biz imzaladık, token alındı");
ok(`bakiyeler: cüzdan ${s.balances.user} · emanette ${s.balances.inEscrow} · anchor ${s.balances.anchor}`);

// A
const A = await withdraw("ripcord");
if (!A.balanceId || !A.deadline) throw Error("ripcord alanları eksik");
const doneA = await waitFor(A.id, (r) => r.anchor?.escrow_outcome === "claimed_by_anchor", 60_000);
ok(`A ripcord: anchor teslim etti (${doneA.anchor.status})`);
if (!doneA.attestation?.ok) throw Error("A: SEP-53 beyanı doğrulanmadı: " + JSON.stringify(doneA.attestation));
ok(`A: SEP-53 teslim beyanı SIGNING_KEY ile doğrulandı · ref ${doneA.attestation.claims.fiat.reference}`);

// dondur → B
await api("/api/admin/freeze", {});
const B = await withdraw("ripcord");
ok(`B ripcord kuruldu, anchor zombi, T'ye ${B.deadline - now()} sn`);
s = await api(`/api/state?account=${account}`);
if (!s.balances.escrows.some((e) => e.id === B.balanceId)) throw Error("emanet /api/state'te görünmüyor");
ok("emanet /api/state bakiyelerinde görünüyor (anchor'dan bağımsız)");
await sleep((B.deadline - now() + 8) * 1000);
const rc = await api("/api/reclaim", { account, balanceId: B.balanceId });
const back = await api("/api/submit", { signedXdr: signLocal(rc.xdr) });
ok(`B: geri alındı ${back.hash.slice(0, 10)}…`);

// C legacy, donmuş
const C = await withdraw("legacy");
const stuck = await waitFor(C.id, (r) => r.anchor?.status === "pending_anchor", 30_000);
ok(`C legacy: ${stuck.anchor.status} — para anchor'da`);

// öldür
await api("/api/admin/kill", {});
await sleep(1500);
s = await api("/api/state");
if (s.alive) throw Error("anchor hâlâ canlı?");
ok("anchor öldürüldü: /api/state alive=false");
const dead = await api(`/api/withdraw/${C.id}`);
if (dead.anchorAlive !== false || dead.anchor !== null) throw Error("ölü anchor için kayıt uydurulmuş");
ok("ölü anchor için kayıt uydurulmadı: anchorAlive=false, anchor=null");

console.log("\nSONUÇ: PASS\n");
