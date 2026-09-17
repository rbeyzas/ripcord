// Katman 1 cüzdan-sunucusu akışı, headless. Anchor + cüzdan sunucusu açık olmalı.
//   D. bonded çekim → anchor claim (beyan hash'iyle) → kullanıcı itiraz → demo hakemi → user_won
//   E. dondur → bonded çekim → T geç → kullanıcı reclaim
import dns from "node:dns"; dns.setDefaultResultOrder("ipv4first");
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
const UI = process.env.UI_URL || `http://localhost:${process.env.PORT || 4173}`;
const user = Keypair.fromSecret(process.env.DEMO_USER_SECRET); const account = user.publicKey();
const PHASE = process.env.PHASE || "D";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const now = () => Math.floor(Date.now() / 1000);
const ok = (m) => console.log("  ✓", m);
async function api(path, body) { const r = await fetch(UI + path, body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: UI }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error || `${path} → ${r.status}`); return j; }
const signLocal = (xdr) => { const t = new Transaction(xdr, Networks.TESTNET); t.sign(user); return t.toXDR(); };
async function waitFor(id, pred, ms) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { last = await api(`/api/withdraw/${id}`); if (pred(last)) return last; await sleep(2500); } throw Error(`bekleme doldu: ${JSON.stringify(last?.obligation?.state)} / ${last?.anchor?.status}`); }

let s = await api("/api/state");
if (!s.alive) throw Error("anchor kapalı");
if (!s.bond?.contract) throw Error("anchor bonded_contract ilan etmiyor");
if (s.frozen) await api("/api/admin/unfreeze", {});
if (!s.authenticated) { const ch = await api("/api/anchor/challenge", { account }); await api("/api/anchor/token", { account, signedXdr: signLocal(ch.xdr) }); }
ok(`teminat zincirde: total ${Number(BigInt(s.bond.stats?.total ?? 0)) / 1e7} · kilitli ${Number(BigInt(s.bond.stats?.locked ?? 0)) / 1e7} · açık ${s.bond.stats?.open}`);

async function withdrawBonded() {
  const w = await api("/api/withdraw", { account, amount: "10", mode: "bonded" });
  if (w.kind !== "soroban") throw Error("soroban XDR beklenirdi");
  const sub = await api("/api/submit", { signedXdr: signLocal(w.xdr), id: w.id, kind: "soroban" });
  return { ...w, hash: sub.hash, obligationId: String(sub.value) };
}

if (PHASE === "D") {
  const D = await withdrawBonded();
  ok(`D: yükümlülük #${D.obligationId} açıldı`);
  s = await api(`/api/state?account=${account}`);
  if (Number(BigInt(s.bond.stats.locked)) !== 10_0000000) throw Error("teminat kilitlenmedi: " + s.bond.stats.locked);
  ok("D: anchor teminatından 10 kilitlendi (stats.locked)");
  const claimed = await waitFor(D.id, (r) => r.obligation?.state === "Claimed", 60_000);
  if (!claimed.attestation?.ok) throw Error("beyan doğrulanmadı");
  ok(`D: anchor claim etti, beyan doğrulandı (${claimed.anchor.status}) — pencere açık`);
  const d = await api("/api/bond/dispute", { account, id: D.obligationId, contract: D.contract });
  await api("/api/submit", { signedXdr: signLocal(d.xdr), kind: "soroban" });
  const disputed = await waitFor(D.id, (r) => r.obligation?.state === "Disputed", 30_000);
  ok(`D: itiraz edildi (anchor kaydı: ${disputed.anchor.status} / ${disputed.anchor.escrow_outcome})`);
  await api("/api/admin/resolve", { id: D.obligationId, contract: D.contract, userWins: true });
  const res = await waitFor(D.id, (r) => r.obligation?.state === "Resolved", 30_000);
  if (!res.obligation.user_won) throw Error("user_won bekleniyordu");
  s = await api(`/api/state?account=${account}`);
  ok(`D: hakem kullanıcıyı haklı buldu · anchor kaydı ${res.anchor.status}/${res.anchor.escrow_outcome} · teminat ${Number(BigInt(s.bond.stats.total)) / 1e7} (ceza düştü)`);
} else {
  await api("/api/admin/freeze", {});
  const E = await withdrawBonded();
  ok(`E: yükümlülük #${E.obligationId} açıldı, anchor zombi, T'ye ${E.deadline - now()} sn`);
  await sleep(Math.max(0, E.deadline - now() + 8) * 1000);
  const rc = await api("/api/bond/reclaim", { account, id: E.obligationId, contract: E.contract });
  await api("/api/submit", { signedXdr: signLocal(rc.xdr), kind: "soroban" });
  await api("/api/admin/unfreeze", {});
  const back = await waitFor(E.id, (r) => r.obligation?.state === "Reclaimed", 30_000);
  ok(`E: kullanıcı geri aldı · anchor kaydı ${back.anchor.status}/${back.anchor.escrow_outcome}`);
}
console.log("\nSONUÇ: PASS\n");
