// Ripcord demo — ikiz akış. Cüzdan tarayıcıda imzalar; sunucu XDR kurar ve doğrular.
import { connect, sign, currentAddress } from "/vendor/wallets.js";

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (g) => (g ? `${g.slice(0, 5)}…${g.slice(-5)}` : "");
const now = () => Math.floor(Date.now() / 1000);

let state = { alive: false };
let account = null;
let authed = false;
// Her şeritte tek aktif çekim. { id, mode, amount, memo, balanceId, deadline, txHash, anchorRecord, reclaimTx, done }
const lanes = { legacy: null, ripcord: null, bonded: null };
const MODES = ["legacy", "ripcord", "bonded"];

async function api(path, body) {
  const r = await fetch(path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || j.unauthorized) { authed = false; showError("SEP-10 oturumu dolmuş. Üstten 'Cüzdan bağla'ya tekrar basın — sadece bir imza."); }
  if (!r.ok) throw Object.assign(Error(j.error || `${path} → ${r.status}`), { dead: j.dead, unauthorized: j.unauthorized });
  return j;
}
const showError = (e) => ($("#error").textContent = e?.message || String(e || ""));

// --- Durum ve bakiyeler ----------------------------------------------------------
async function refreshState() {
  try {
    state = await api(`/api/state${account ? `?account=${account}` : ""}`);
    authed = Boolean(state.authenticated);
  } catch (e) {
    state = { alive: false };
  }
  const pill = $("#anchor-pill");
  if (!state.alive) { pill.textContent = "anchor ÖLÜ — HTTP yok"; pill.className = "pill dead"; }
  const rev = $("[data-admin=revive]"); if (rev) rev.hidden = state.alive;
  else if (state.frozen) { pill.textContent = "anchor ZOMBİ — cevap veriyor, teslim etmiyor"; pill.className = "pill frozen"; }
  else { pill.textContent = `anchor CANLI · teslim ilanı ${state.deliverySeconds} sn`; pill.className = "pill alive"; }

  const b = state.balances;
  $("#balances").innerHTML = !b
    ? `<div class="bal"><span>bakiyeler</span><b>—</b><small class="muted small">anchor hiç görülmedi; varlık bilinmiyor</small></div>`
    : onboarding(b) + [
        ["cüzdanınız", b.user ?? "trustline yok", ""],
        ["emanette", b.inEscrow, "escrow"],
        ["anchor hesabı", b.anchor ?? "—", ""],
      ].map(([l, v, c]) => `<div class="bal ${c}"><span>${l}</span><b>${esc(v)}</b><small class="muted small">${esc(b.code)}</small></div>`).join("")
      + solvencyCard();
  // Katman 1 şeridi yalnızca anchor sözleşme ilan ediyorsa görünür.
  const bonded = Boolean(state.bond?.contract);
  $("#lane-bonded").hidden = !bonded;
  document.querySelector(".twins").classList.toggle("three", bonded);
  for (const btn of document.querySelectorAll("[data-withdraw]")) btn.disabled = !(account && authed && state.alive);
}

// Bağlanan cüzdan hazır değilse üç adım: XLM → trustline → test varlığı.
// Sahnede jüri üyesi kendi Freighter'ıyla 60 saniyede kullanıcı olur.
function onboarding(b) {
  if (!account) return "";
  if (b.funded === false)
    return `<div class="bal onboard"><span>1 / 3 · hesap ağda yok</span><b>XLM gerekli</b><button class="secondary" data-faucet="xlm">Friendbot ile fonla</button></div>`;
  if (b.user === null)
    return `<div class="bal onboard"><span>2 / 3 · ${esc(b.code)} trustline</span><b>açık değil</b><button class="secondary" data-faucet="trustline">Trustline aç (imza)</button></div>`;
  if (b.faucet && Number(b.user) < 10)
    return `<div class="bal onboard"><span>3 / 3 · demo bakiyesi</span><b>${esc(b.user)} ${esc(b.code)}</b><button class="secondary" data-faucet="fund">100 ${esc(b.code)} al</button></div>`;
  return "";
}

// Ödeme gücü — sözleşmeden okunur, anchor'ın beyanından değil.
function solvencyCard() {
  const bd = state.bond;
  if (!bd?.contract) return "";
  const st = bd.stats;
  const fmt = (m) => (Number(BigInt(m)) / 1e7).toFixed(2);
  if (!st) return `<div class="bal bond"><span>anchor teminatı</span><b>—</b><small class="muted small">${esc(bd.error || "yatırılmamış")}</small></div>`;
  return `<div class="bal bond"><span>anchor teminatı · zincirde</span><b>${fmt(st.total)}</b><small class="muted small">kilitli ${fmt(st.locked)} · açık yükümlülük ${st.open} · pencere ${bd.config?.challenge_secs ?? "?"} sn</small></div>`;
}

// --- Cüzdan + SEP-10 -------------------------------------------------------------
$("#wallet").onclick = async () => {
  try {
    showError("");
    account = await connect({ force: Boolean(account) && authed });
    $("#wallet").textContent = short(account);
    await refreshState();
    if (!state.alive) throw Error("Anchor ölü; kimlik doğrulanamaz. Anchor'ı başlatın: npm run anchor");
    if (!authed) {
      // Sunucu challenge'ı doğruladı (sıra 0, kaynak anchor); biz yalnızca imzalıyoruz.
      const ch = await api("/api/anchor/challenge", { account });
      const signedXdr = await sign(ch.xdr, ch.networkPassphrase, account);
      await api("/api/anchor/token", { account, signedXdr });
      authed = true;
    }
    await refreshState();
  } catch (e) { showError(e); }
};

// --- Çekim ------------------------------------------------------------------------
document.addEventListener("click", async (e) => {
  const w = e.target.closest("[data-withdraw]");
  const a = e.target.closest("[data-admin]");
  const r = e.target.closest("[data-reclaim]");
  const bd = e.target.closest("[data-bond]");
  const fc = e.target.closest("[data-faucet]");
  try {
    showError("");
    if (fc) { await faucet(fc.dataset.faucet); return; }
    if (w) await withdraw(w.dataset.withdraw);
    if (a) { await api(`/api/admin/${a.dataset.admin}`, {}); await refreshState(); render(); }
    if (r) await reclaim();
    if (bd) await bondAction(bd.dataset.bond);
  } catch (err) { showError(err); }
});

async function withdraw(mode) {
  const amount = $(`#amt-${mode}`).value.trim();
  const lane = { mode, amount, steps: [] };
  lanes[mode] = lane;
  step(lane, "wait", "SEP-24 çekim başlatılıyor", "anchor'a talimat soruluyor");
  render();
  let w;
  try {
    w = await api("/api/withdraw", { account, amount, mode });
  } catch (e) {
    lane.steps.pop();
    step(lane, "bad", "Çekim başlatılamadı", esc(e.message));
    render();
    throw e;
  }
  Object.assign(lane, w);
  lane.steps.pop();
  if (mode === "legacy") {
    step(lane, "ok", "Anchor talimat verdi", `hesap ${short(w.destination)} · memo <code>${esc(w.memo)}</code>`);
    step(lane, "wait", "Cüzdanda imzalanıyor", "düz ödeme — kesinleşince dayanağınız biter");
  } else if (mode === "bonded") {
    step(lane, "ok", "Anchor teslim süresini ilan etti", `<b class="countdown">${w.deliverySeconds} sn</b> · itiraz penceresi ${w.challengeSeconds ?? "?"} sn · sözleşme <code>${esc(w.contract.slice(0, 8))}…</code>`);
    step(lane, "wait", "Cüzdanda imzalanıyor", "open(): anchor'ın serbest teminatı tutar kadar kilitlenecek");
  } else {
    step(lane, "ok", "Anchor teslim süresini ilan etti", `<b class="countdown">${w.deliverySeconds} sn</b> · alacaklı ${short(w.claimant)}`);
    step(lane, "ok", "Emanet işlemi doğrulandı", `2 alacaklı · anchor before(T) · siz not(before(T)) · balanceId <code>${esc(w.balanceId.slice(0, 16))}…</code>`);
    step(lane, "wait", "Cüzdanda imzalanıyor", "emanet — anchor sadece işini yaparak alabilir");
  }
  render();
  const signedXdr = await sign(w.xdr, w.networkPassphrase, account);
  const sub = await api("/api/submit", { signedXdr, id: w.id, kind: w.kind });
  lane.txHash = sub.hash;
  if (mode === "bonded") lane.obligationId = sub.value != null ? String(sub.value) : null;
  lane.steps.pop();
  step(lane, mode === "legacy" ? "bad" : mode === "bonded" ? "bond" : "rip",
    mode === "legacy" ? "Para anchor'ın hesabında" : mode === "bonded" ? `Yükümlülük #${esc(lane.obligationId ?? "?")} açıldı — teminat kilitlendi` : "Para emanette",
    `<a href="${esc(sub.explorer)}" target="_blank" rel="noopener">explorer ↗</a>`);
  lane.sentAt = now();
  render();
  await refreshState();
}

async function reclaim() {
  const lane = lanes.ripcord;
  if (!lane?.balanceId) return;
  step(lane, "wait", "Geri alma imzalanıyor", "anchor'a sorulmuyor — yüklem T'den sonra size ait");
  render();
  const c = await api("/api/reclaim", { account, balanceId: lane.balanceId });
  const signedXdr = await sign(c.xdr, c.networkPassphrase, account);
  const sub = await api("/api/submit", { signedXdr });
  lane.steps.pop();
  lane.reclaimTx = sub.hash;
  lane.done = "reclaimed";
  step(lane, "ok", "Paranız geri döndü", `kimse onaylamadı · <a href="${esc(sub.explorer)}" target="_blank" rel="noopener">explorer ↗</a>`);
  render();
  await refreshState();
}

async function faucet(step) {
  if (!account) throw Error("Önce cüzdan bağlayın");
  if (step === "xlm") { await api("/api/faucet/xlm", { account }); }
  if (step === "trustline") {
    const t = await api("/api/faucet/trustline", { account });
    const signedXdr = await sign(t.xdr, t.networkPassphrase, account);
    await api("/api/submit", { signedXdr });
  }
  if (step === "fund") { const r = await api("/api/faucet/fund", { account }); showError(""); }
  await refreshState();
}

async function bondAction(action) {
  const lane = lanes.bonded;
  if (!lane?.obligationId) return;
  const labels = { dispute: "İtiraz imzalanıyor", reclaim: "Geri alma imzalanıyor", resolve: "Demo hakemi karar veriyor" };
  step(lane, "wait", labels[action], action === "resolve" ? "üretimde bağımsız taraf; burada .env'deki demo anahtarı" : "anchor'a sorulmuyor — sözleşmeyle konuşuluyor");
  render();
  if (action === "resolve") {
    const r = await api("/api/admin/resolve", { id: lane.obligationId, contract: lane.contract, userWins: true });
    lane.steps.pop();
    step(lane, "ok", "Hakem: kullanıcı haklı", `tutar + ceza teminattan · <a href="${esc(r.explorer)}" target="_blank" rel="noopener">explorer ↗</a>`);
  } else {
    const c = await api(`/api/bond/${action}`, { account, id: lane.obligationId, contract: lane.contract });
    const signedXdr = await sign(c.xdr, c.networkPassphrase, account);
    const sub = await api("/api/submit", { signedXdr, kind: "soroban" });
    lane.steps.pop();
    step(lane, action === "reclaim" ? "ok" : "bond", action === "reclaim" ? "Paranız geri döndü" : "İtiraz kaydedildi — para ve teminat dilimi dondu", `<a href="${esc(sub.explorer)}" target="_blank" rel="noopener">explorer ↗</a>`);
    if (action === "reclaim") lane.done = "reclaimed";
  }
  render();
  await refreshState();
}

// --- Anket: anchor kaydı + zincir ----------------------------------------------------
async function poll() {
  for (const mode of ["legacy", "ripcord"]) {
    const lane = lanes[mode];
    // Bitmiş şeritte beyan henüz gelmediyse bir tur daha bak.
    if (!lane?.id || (lane.done && (lane.attestation || lane.done === "reclaimed"))) continue;
    try {
      const r = await api(`/api/withdraw/${lane.id}`);
      lane.anchorAlive = r.anchorAlive;
      lane.anchorRecord = r.anchor;
      lane.attestation = r.attestation;
    } catch (e) { console.warn(`[poll ${mode}]`, e.message); if (!e.unauthorized) lane.anchorAlive = false; }
    if (mode === "bonded" && !lane.obligation) console.warn("[poll bonded] yükümlülük okunamadı", { id: lane.id, obligationId: lane.obligationId, contract: lane.contract });
    // Ripcord: emanetin zincirdeki hâli anchor'dan bağımsız — bakiyelerden okunur.
    if (mode === "ripcord" && lane.balanceId && state.balances) {
      lane.onChain = state.balances.escrows.some((e) => e.id === lane.balanceId);
      if (!lane.onChain && lane.txHash && !lane.reclaimTx && now() < lane.deadline) lane.done = "delivered";
    }
    if (mode === "legacy" && lane.anchorRecord?.status === "completed") lane.done = "delivered";
    if (mode === "ripcord" && lane.anchorRecord?.escrow_outcome === "claimed_by_anchor") lane.done = "delivered";
  }
  render();
}

// --- Görünüm ------------------------------------------------------------------------
function step(lane, kind, title, body) { lane.steps.push({ kind, title, body }); }

function render() {
  for (const mode of MODES) {
    const el = $(`#tl-${mode}`);
    const lane = lanes[mode];
    if (!lane) { el.innerHTML = `<p class="muted">Henüz çekim yok.</p>`; continue; }
    let html = lane.steps.map((s) => `<div class="step ${s.kind}"><span class="dot"></span><div><b>${s.title}</b><p>${s.body}</p></div></div>`).join("");
    const rec = lane.anchorRecord;
    const status = lane.anchorAlive === false ? "— anchor cevap vermiyor —" : rec?.status ?? "…";
    if (lane.txHash) html += `<div class="step ${lane.done === "delivered" ? "ok" : "wait"}"><span class="dot"></span><div><b>Anchor'a göre durum: <code>${esc(status)}</code></b><p>${esc(rec?.message ?? (lane.anchorAlive === false ? "HTTP yok. Kayıt okunamıyor." : ""))}</p></div></div>`;

    if (mode === "legacy" && lane.txHash && lane.done !== "delivered") {
      const zombie = state.frozen || lane.anchorAlive === false;
      if (zombie) html += `<div class="stuck"><b>Paranız anchor'ın hesabında.</b> Spec'te sizin başlatabileceğiniz hiçbir eylem yok. İptal ucu yok, süre yok, itiraz yok. Bekliyorsunuz.</div>`;
    }
    if (lane.attestation) {
      const a = lane.attestation;
      html += a.ok
        ? `<div class="step ok"><span class="dot"></span><div><b>İmzalı teslim beyanı · SEP-53 · doğrulandı ✓</b><p>${esc(a.claims.fiat.amount)} ${esc(a.claims.fiat.currency)} · ref <code>${esc(a.claims.fiat.reference)}</code> · imzacı: anchor'ın stellar.toml SIGNING_KEY'i. İnkâr edilemez.</p></div></div>`
        : `<div class="step bad"><span class="dot"></span><div><b>Teslim beyanı DOĞRULANAMADI</b><p>${esc(a.reason)}</p></div></div>`;
    }
    if (mode === "legacy" && lane.done === "delivered") html += `<div class="saved">Anchor teslim etti. Bu sefer.</div>`;

    if (mode === "ripcord" && lane.txHash) {
      if (lane.done === "delivered") html += `<div class="saved">Anchor T'den önce talep etti ve teslim etti. Emanet kapandı.</div>`;
      else if (lane.done === "reclaimed") html += `<div class="saved"><b>Geri aldınız.</b> Anchor'ın durumu ne olursa olsun.</div>`;
      else {
        const left = lane.deadline - now();
        if (left > 0) html += `<div class="step rip"><span class="dot"></span><div><b>T'ye <span class="countdown">${left}</span> sn</b><p>Anchor bu süre içinde talep etmezse yüklem size döner. Anchor'ın rızası gerekmez.</p></div></div>`;
        else html += `<div class="step rip"><span class="dot"></span><div><b>T geçti. Anchor teslim etmedi.</b><p>Yüklem artık sizin. Anchor bu andan itibaren kalıcı olarak kilitli — talep etse de ağ reddeder.</p></div></div><button class="reclaim" data-reclaim>Paramı geri al →</button>`;
      }
    }
    if (mode === "bonded" && lane.txHash) html += bondedView(lane);
    el.innerHTML = html;
  }
}

function bondedView(lane) {
  const o = lane.obligation;
  if (!o) return `<div class="step wait"><span class="dot"></span><div><b>Yükümlülük okunuyor…</b></div></div>`;
  const left = o.deadline - now();
  const cs = Number(state.bond?.config?.challenge_secs ?? 0);
  switch (o.state) {
    case "Open":
      return left > 0
        ? `<div class="step bond"><span class="dot"></span><div><b>Açık · T'ye <span class="countdown">${left}</span> sn</b><p>Anchor claim etmezse T'den sonra tek başına geri alırsınız. Teminatı kilitli.</p></div></div>`
        : `<div class="step bond"><span class="dot"></span><div><b>T geçti. Anchor claim etmedi.</b><p>Sözleşme artık anchor'ın claim'ini <code>TooLate</code> ile reddeder.</p></div></div><div class="btnrow"><button class="reclaim" data-bond="reclaim">Paramı geri al →</button></div>`;
    case "Claimed": {
      const wl = o.claimed_at + cs - now();
      return `<div class="step bond"><span class="dot"></span><div><b>Anchor "ödedim" dedi · itiraz penceresi <span class="countdown">${Math.max(0, wl)}</span> sn</b><p>Para hâlâ sözleşmede. Beyanı doğrulayın; ödeme gelmediyse itiraz edin — teminattan ceza alırsınız.</p></div></div>${wl > 0 ? `<div class="btnrow"><button class="secondary" data-bond="dispute">Ödeme gelmedi — itiraz et</button></div>` : `<p class="muted small">Pencere kapandı; anchor finalize edebilir.</p>`}`;
    }
    case "Disputed":
      return `<div class="step bad"><span class="dot"></span><div><b>İtirazlı · hakem bekleniyor</b><p>Para ve teminat dilimi dondu. Ne anchor ne siz — hakem (${short(state.bond?.arbiter)}) karar verir.</p></div></div><div class="btnrow"><button class="ghost" data-bond="resolve">Demo hakemi: kullanıcı haklı →</button></div>`;
    case "Settled": return `<div class="saved">Pencere itirazsız kapandı; anchor aldı. Teminat serbest.</div>`;
    case "Reclaimed": return `<div class="saved"><b>Geri aldınız.</b> Anchor teslim etmedi; teminatı serbest kaldı ama itibarı zincirde.</div>`;
    case "Resolved": return o.user_won
      ? `<div class="saved"><b>Hakem sizi haklı buldu.</b> Tutar + %${(Number(state.bond?.config?.penalty_bps ?? 0) / 100).toFixed(0)} ceza, anchor'ın teminatından.</div>`
      : `<div class="stuck">Hakem anchor'ı haklı buldu; tutar anchor'a geçti.</div>`;
    default: return "";
  }
}

// --- Başlat ---------------------------------------------------------------------------
render();
refreshState();
setInterval(async () => { await refreshState(); await poll(); }, 3000);
setInterval(render, 1000); // geri sayım
(async () => { try { const a = await currentAddress?.(); if (a) { account = a; $("#wallet").textContent = short(a); await refreshState(); } } catch {} })();
