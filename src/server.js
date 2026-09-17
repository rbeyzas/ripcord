// Ripcord demo cüzdan sunucusu.
//
// Rolü: cüzdanın arka ucu. Anchor ile SEP-10/24 konuşur, imzasız XDR kurar ve imzadan
// önce doğrular; tarayıcı imzalar; sunucu ağa gönderir. Hiçbir gizli anahtar tutmaz.
// Anchor'dan AYRI bir süreçtir — sahnede anchor ölürken bu ayakta kalır, olması gereken bu.
//
// İkiz akış: aynı çekim iki yoldan.
//   legacy  → düz ödeme. Bugünkü SEP-24.
//   ripcord → emanet. Anchor'ın ilan ettiği süreyle claimable balance.

import http from "node:http";
import { readFile } from "node:fs/promises";
import dns from "node:dns";
import { Horizon, Networks, Transaction, TransactionBuilder, Operation, Memo, Account } from "@stellar/stellar-sdk";
import { buildEscrowTx, buildClaimTx, deadlineFor, verifyEscrowTx, parseAsset, assetKey } from "./escrow.js";
import { toMinor, fromMinor } from "./units.js";
import { verifyAttestation } from "./attest.js";
import { buildInvoke, submitInvoke, read as readContract, calls, normalizeObligation, normalizeBond } from "./bond.js";
import { Keypair } from "@stellar/stellar-sdk";
// Demo hakemi. Gerçek dünyada bağımsız bir taraf; burada .env'deki anahtar, açıkça etiketli.
const ARBITER_KP = process.env.ARBITER_SECRET ? Keypair.fromSecret(process.env.ARBITER_SECRET) : null;

dns.setDefaultResultOrder("ipv4first"); // localhost → 127.0.0.1

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1"; // konteynerde 0.0.0.0
// Musluk — canlı demoda bağlanan cüzdana test varlığı. Yalnızca kendi test varlığımızda
// (ISSUER_SECRET varsa); USDC modunda musluk yok, kullanıcı USDC'yi gerçek anchor'dan alır.
const ISSUER_KP = process.env.ISSUER_SECRET ? Keypair.fromSecret(process.env.ISSUER_SECRET) : null;
const FAUCET_AMOUNT = process.env.FAUCET_AMOUNT || "100";
const faucetLast = new Map(); // hesap → son fonlama zamanı; sahnede kötüye kullanım olmasın
const ANCHOR_URL = process.env.ANCHOR_URL || `http://localhost:${process.env.ANCHOR_PORT || 4200}`;
const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;
const horizon = new Horizon.Server(HORIZON);
const EXPLORER = "https://stellar.expert/explorer/testnet";

// Hesap → SEP-10 token. Bellekte; sunucu yeniden başlarsa yeniden kimlik doğrulanır.
const tokens = new Map();
// Bu oturumda başlatılan çekimler (id → {account, mode, balanceId, deadline, memo}).
const withdrawals = new Map();

const files = {
  "/": ["public/index.html", "text/html"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/style.css": ["public/style.css", "text/css"],
  "/vendor/wallets.js": ["public/vendor/wallets.js", "text/javascript"],
};

// --- Anchor istemcisi ------------------------------------------------------------
async function anchor(path, { method = "GET", body, token } = {}) {
  let r;
  try {
    r = await fetch(ANCHOR_URL + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    // Anchor ÖLÜ. Bu bir hata değil, demonun bir hâli — çağıran karar verir.
    throw Object.assign(Error("ANCHOR_DEAD"), { dead: true, cause: e });
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(Error("SEP-10 oturumu geçersiz/dolmuş — cüzdanı yeniden bağlayın"), { unauthorized: true });
  if (!r.ok) throw Error(j.error || `${method} ${path} → ${r.status}`);
  return j;
}

// Anchor ölünce bile varlık ve adres bilinsin: bakiyeler ve emanetler Horizon'dan okunur,
// anchor'dan değil. Sahnede "Öldür" sonrası para nerede sorusu cevapsız kalmaz.
let lastKnown = null;
async function anchorState() {
  try {
    const s = await anchor("/admin/state");
    lastKnown = { anchor: s.anchor, asset: s.asset, deliverySeconds: s.deliverySeconds };
    return { alive: true, frozen: s.frozen, anchor: s.anchor, asset: s.asset, deliverySeconds: s.deliverySeconds, bond: s.bond ?? null };
  } catch (e) {
    if (e.dead) return { alive: false, frozen: false, ...(lastKnown || {}), fromCache: Boolean(lastKnown) };
    throw e;
  }
}

async function discover() {
  const toml = await (await fetch(`${ANCHOR_URL}/.well-known/stellar.toml`, { signal: AbortSignal.timeout(6000) })).text();
  const signing = /SIGNING_KEY="(G[A-Z2-7]{55})"/.exec(toml)?.[1];
  const authUrl = /WEB_AUTH_ENDPOINT="([^"]+)"/.exec(toml)?.[1];
  if (!signing || !authUrl) throw Error("Anchor TOML'unda SIGNING_KEY / WEB_AUTH_ENDPOINT yok");
  return { signing, authUrl };
}

// --- Bakiyeler ------------------------------------------------------------------
async function balances(account, state) {
  const asset = parseAsset(state.asset);
  let funded = null; // kullanıcı hesabı ağda var mı (friendbot gerekir mi)
  const bal = async (pub, isUser = false) => {
    try {
      const a = await horizon.loadAccount(pub);
      if (isUser) funded = true;
      const b = a.balances.find((x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer());
      return b ? b.balance : null; // null = trustline yok
    } catch {
      if (isUser) funded = false;
      return null;
    }
  };
  const [user, anchorBal] = await Promise.all([account ? bal(account, true) : null, state.anchor ? bal(state.anchor) : null]);
  // Bu kullanıcının anchor'a açtığı, hâlâ duran emanetler.
  let escrows = [];
  if (account) {
    try {
      const page = await horizon.claimableBalances().sponsor(account).limit(50).order("desc").call();
      escrows = page.records
        .filter((r) => r.asset === `${asset.getCode()}:${asset.getIssuer()}` && r.claimants.some((c) => c.destination === state.anchor))
        .map((r) => {
          const mine = r.claimants.find((c) => c.destination === state.anchor);
          return { id: r.id, amount: r.amount, deadline: mine?.predicate?.abs_before_epoch ? Number(mine.predicate.abs_before_epoch) : null };
        });
    } catch {}
  }
  const inEscrow = escrows.reduce((s, e) => s + toMinor(e.amount), 0);
  return { asset: assetKey(asset), code: asset.getCode(), user, funded, anchor: anchorBal, escrows, inEscrow: fromMinor(inEscrow), faucet: Boolean(ISSUER_KP) };
}

// --- HTTP -------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && files[url.pathname]) {
      const [path, type] = files[url.pathname];
      // Statikler asla önbelleklenmesin: sahnede eski app.js çalışması kabul edilemez.
      res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(path));
    }
    let body = {};
    if (req.method === "POST") {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw Error("Cross-origin istek reddedildi");
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 65536) throw Error("İstek çok büyük"); }
      body = JSON.parse(raw || "{}");
    }
    const p = url.pathname;

    if (p === "/api/state") {
      const state = await anchorState();
      const account = url.searchParams.get("account");
      let info = null;
      if (state.alive) { try { info = await anchor("/info"); } catch {} }
      const b = state.asset ? await balances(account, state) : null; // ölüyken son bilinen varlıkla
      return send(200, { network: "testnet", networkPassphrase: NET, anchorUrl: ANCHOR_URL, explorer: EXPLORER, ...state, info, balances: b, authenticated: account ? tokens.has(account) : false });
    }

    // SEP-10: sunucu challenge'ı alır ve DOĞRULAR; tarayıcı imzalar.
    if (p === "/api/anchor/challenge" && req.method === "POST") {
      if (!body.account) throw Error("account gerekli");
      const { signing, authUrl } = await discover();
      const ch = await (await fetch(`${authUrl}?account=${body.account}`)).json();
      const tx = new Transaction(ch.transaction, NET);
      if (tx.sequence !== "0") throw Error("SEP-10 challenge sırası 0 değil — imzalanmaz");
      if (tx.source !== signing) throw Error("SEP-10 challenge kaynağı anchor'ın SIGNING_KEY'i değil — imzalanmaz");
      if (ch.network_passphrase && ch.network_passphrase !== NET) throw Error("Challenge testnet değil — imzalanmaz");
      return send(200, { xdr: ch.transaction, networkPassphrase: NET, authUrl });
    }
    if (p === "/api/anchor/token" && req.method === "POST") {
      if (!body.account || !body.signedXdr) throw Error("account ve signedXdr gerekli");
      const { authUrl } = await discover();
      const r = await (await fetch(authUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction: body.signedXdr }) })).json();
      if (!r.token) throw Error(r.error || "Anchor token vermedi");
      tokens.set(body.account, r.token);
      return send(200, { ok: true });
    }

    // Çekim başlat → imzasız XDR. mode: legacy | ripcord
    if (p === "/api/withdraw" && req.method === "POST") {
      const { account, amount = "10", mode } = body;
      if (!account) throw Error("account gerekli");
      if (!["legacy", "ripcord", "bonded"].includes(mode)) throw Error("mode legacy|ripcord|bonded olmalı");
      const token = tokens.get(account);
      if (!token) throw Error("Önce SEP-10 ile kimlik doğrulayın");
      const state = await anchorState();
      if (!state.alive) throw Error("ANCHOR_DEAD");
      const asset = parseAsset(state.asset);
      const amt = fromMinor(toMinor(amount));

      const start = await anchor("/transactions/withdraw/interactive", { method: "POST", token, body: { asset_code: asset.getCode(), amount: amt, account, ...(mode === "ripcord" ? { escrow_mode: "claimable_balance" } : mode === "bonded" ? { escrow_mode: "bonded_contract" } : {}) } });
      await fetch(start.url, { signal: AbortSignal.timeout(6000) }); // etkileşimli adım — sandbox otomatik
      let t;
      for (let i = 0; i < 10; i++) {
        t = (await anchor(`/transaction?id=${start.id}`, { token })).transaction;
        if (t.status === "pending_user_transfer_start") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (t.status !== "pending_user_transfer_start") throw Error(`Anchor ödeme talimatı vermedi: ${t.status}`);

      const acc = await horizon.loadAccount(account);
      let out;
      if (mode === "legacy") {
        // BUGÜNKÜ DÜNYA: düz ödeme. Kesinleştiği an kullanıcının dayanağı biter.
        const tx = new TransactionBuilder(new Account(account, acc.sequenceNumber()), { fee: "100", networkPassphrase: NET }).setTimeout(300)
          .addOperation(Operation.payment({ destination: t.withdraw_anchor_account, asset, amount: amt }))
          .addMemo(Memo.text(t.withdraw_memo)).build();
        out = { xdr: tx.toXDR(), destination: t.withdraw_anchor_account };
      } else if (mode === "bonded") {
        // KATMAN 1: sözleşmede yükümlülük aç. Kaynak kullanıcı; simülasyon auth'u doldurur.
        if (!t.escrow_contract) throw Error("Anchor bonded_contract ilan etmiyor");
        const T = Number(deadlineFor(t.escrow_max_delivery_seconds)) + 15; // uygulama anı payı (BadDeadline yarışı)
        const built = await buildInvoke({ source: account, contractId: t.escrow_contract, ...calls.open(account, t.escrow_claimant, toMinor(amt), T) });
        out = { xdr: built.xdr, kind: "soroban", contract: t.escrow_contract, deadline: T, claimant: t.escrow_claimant, deliverySeconds: t.escrow_max_delivery_seconds, challengeSeconds: t.escrow_challenge_seconds };
      } else {
        if (!t.escrow_max_delivery_seconds || !t.escrow_claimant) throw Error("Anchor Ripcord ilan etmiyor");
        const T = deadlineFor(t.escrow_max_delivery_seconds);
        const built = buildEscrowTx({ user: account, userSequence: acc.sequenceNumber(), anchor: t.escrow_claimant, asset, amount: amt, deadline: T, networkPassphrase: NET, memo: t.withdraw_memo });
        // İmzadan önce doğrula. Anchor'ın söylediği süre ve alacaklıyla birebir.
        verifyEscrowTx(built.xdr, { user: account, anchor: t.escrow_claimant, deadline: T, asset, amount: amt }, { networkPassphrase: NET });
        out = { xdr: built.xdr, balanceId: built.balanceId, deadline: Number(T), claimant: t.escrow_claimant, deliverySeconds: t.escrow_max_delivery_seconds };
      }
      withdrawals.set(start.id, { id: start.id, account, mode, memo: t.withdraw_memo, amount: amt, ...out, xdr: undefined });
      return send(200, { id: start.id, mode, amount: amt, memo: t.withdraw_memo, networkPassphrase: NET, ...out });
    }

    if (p === "/api/submit" && req.method === "POST") {
      if (!body.signedXdr) throw Error("signedXdr gerekli");
      if (body.kind === "soroban") {
        const r = await submitInvoke(body.signedXdr);
        if (body.id && withdrawals.has(body.id)) { const w = withdrawals.get(body.id); w.txHash = r.hash; if (r.value != null && !w.obligationId) w.obligationId = String(r.value); }
        return send(200, { hash: r.hash, value: r.value, explorer: `${EXPLORER}/tx/${r.hash}` });
      }
      const tx = new Transaction(body.signedXdr, NET);
      try {
        const r = await horizon.submitTransaction(tx);
        if (body.id && withdrawals.has(body.id)) withdrawals.get(body.id).txHash = r.hash;
        return send(200, { hash: r.hash, ledger: r.ledger, explorer: `${EXPLORER}/tx/${r.hash}` });
      } catch (e) {
        const codes = e?.response?.data?.extras?.result_codes;
        throw Error(codes ? `Ağ reddetti: ${JSON.stringify(codes)}` : e.message);
      }
    }

    // Anchor'ın gözünden işlem kaydı — anchor ölüyse bunu söyler, uydurmaz.
    if (p.startsWith("/api/withdraw/") && req.method === "GET") {
      const id = p.split("/")[3];
      const w = withdrawals.get(id);
      if (!w) throw Error("Bu oturumda böyle bir çekim yok");
      const token = tokens.get(w.account);
      if (!token) throw Object.assign(Error("SEP-10 oturumu yok — cüzdanı yeniden bağlayın"), { unauthorized: true });
      // Katman 1: yükümlülüğün zincirdeki hâli anchor'dan bağımsız okunur.
      let obligation = null;
      if (w.mode === "bonded" && w.obligationId && w.contract) {
        try { obligation = normalizeObligation(await readContract({ contractId: w.contract, source: w.account, ...calls.get(BigInt(w.obligationId)) })); } catch {}
      }
      try {
        const t = (await anchor(`/transaction?id=${id}`, { token })).transaction;
        // Katman 2: beyan varsa TOML'daki SIGNING_KEY ile doğrula. Anchor'ın "imzaladım"
        // demesi yetmez; anahtar keşiften gelir, kayıttan değil.
        let attestation = null;
        if (t.escrow_attestation) {
          const { signing } = await discover();
          attestation = verifyAttestation(t.escrow_attestation, signing);
        }
        return send(200, { local: w, anchor: t, anchorAlive: true, attestation, obligation });
      } catch (e) {
        if (e.dead) return send(200, { local: w, anchor: null, anchorAlive: false, obligation });
        throw e;
      }
    }

    // Geri alma — kullanıcı tek başına. Anchor'a HİÇ sorulmaz.
    if (p === "/api/reclaim" && req.method === "POST") {
      const { account, balanceId } = body;
      if (!account || !balanceId) throw Error("account ve balanceId gerekli");
      const acc = await horizon.loadAccount(account);
      const c = buildClaimTx({ claimant: account, claimantSequence: acc.sequenceNumber(), balanceId, networkPassphrase: NET });
      return send(200, { xdr: c.xdr, networkPassphrase: NET });
    }

    // Katman 1 — kullanıcı eylemleri. Anchor'a HİÇ sorulmaz; sözleşmeyle konuşulur.
    if ((p === "/api/bond/dispute" || p === "/api/bond/reclaim") && req.method === "POST") {
      const { account, id, contract } = body;
      if (!account || !id || !contract) throw Error("account, id, contract gerekli");
      const call = p.endsWith("dispute") ? calls.dispute(BigInt(id)) : calls.reclaim(BigInt(id));
      const built = await buildInvoke({ source: account, contractId: contract, ...call });
      return send(200, { xdr: built.xdr, networkPassphrase: NET, kind: "soroban" });
    }
    // DEMO HAKEMİ — üretimde bağımsız taraf. Burada .env'deki anahtar, sahne için.
    if (p === "/api/admin/resolve" && req.method === "POST") {
      if (!ARBITER_KP) throw Error("ARBITER_SECRET yok — demo hakemi tanımlı değil");
      const { id, contract, userWins } = body;
      const built = await buildInvoke({ source: ARBITER_KP.publicKey(), contractId: contract, ...calls.resolve(BigInt(id), Boolean(userWins)) });
      const tx = new Transaction(built.xdr, NET); tx.sign(ARBITER_KP);
      const r = await submitInvoke(tx.toXDR());
      return send(200, { hash: r.hash, explorer: `${EXPLORER}/tx/${r.hash}` });
    }

    // --- Musluk: canlı demoda bağlanan cüzdanı üç adımda hazırlar ------------------------
    // 1) XLM (friendbot)  2) trustline (kullanıcı imzalar)  3) test varlığı (ihraççı öder)
    if (p === "/api/faucet/xlm" && req.method === "POST") {
      if (!body.account) throw Error("account gerekli");
      const r = await fetch(`https://friendbot.stellar.org?addr=${body.account}`);
      if (!r.ok && r.status !== 400) throw Error(`friendbot ${r.status}`);
      return send(200, { ok: true });
    }
    if (p === "/api/faucet/trustline" && req.method === "POST") {
      if (!body.account) throw Error("account gerekli");
      const state = await anchorState();
      if (!state.asset) throw Error("varlık bilinmiyor; anchor hiç görülmedi");
      const asset = parseAsset(state.asset);
      const acc = await horizon.loadAccount(body.account);
      const tx = new TransactionBuilder(new Account(body.account, acc.sequenceNumber()), { fee: "100", networkPassphrase: NET }).setTimeout(300)
        .addOperation(Operation.changeTrust({ asset })).build();
      return send(200, { xdr: tx.toXDR(), networkPassphrase: NET, asset: state.asset });
    }
    if (p === "/api/faucet/fund" && req.method === "POST") {
      if (!ISSUER_KP) throw Error("Bu kurulumda musluk yok (USDC modu) — varlığı gerçek anchor'dan alın");
      if (!body.account) throw Error("account gerekli");
      const last = faucetLast.get(body.account) || 0;
      if (Date.now() - last < 10 * 60_000) throw Error("Bu hesap az önce fonlandı; 10 dk bekleyin");
      const state = await anchorState();
      const asset = parseAsset(state.asset);
      if (asset.getIssuer() !== ISSUER_KP.publicKey()) throw Error("Musluk yalnızca kendi test varlığımız için");
      const target = await horizon.loadAccount(body.account);
      if (!target.balances.some((x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer())) throw Error("Önce trustline açın");
      const acc = await horizon.loadAccount(ISSUER_KP.publicKey());
      const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).setTimeout(120)
        .addOperation(Operation.payment({ destination: body.account, asset, amount: FAUCET_AMOUNT })).build();
      tx.sign(ISSUER_KP);
      try { const r = await horizon.submitTransaction(tx); faucetLast.set(body.account, Date.now()); return send(200, { hash: r.hash, amount: FAUCET_AMOUNT, explorer: `${EXPLORER}/tx/${r.hash}` }); }
      catch (e) { throw Error("Musluk ödemesi düştü: " + JSON.stringify(e?.response?.data?.extras?.result_codes || e.message)); }
    }

    // Diriltme — yalnızca supervisor altında (canlı deploy). Yerelde: terminalden npm run anchor.
    if (p === "/api/admin/revive" && req.method === "POST") {
      if (!process.send) throw Error("Yerel modda diriltme yok: terminalden `npm run anchor`");
      process.send({ type: "revive" });
      return send(200, { ok: true });
    }

    // Sunucu kumandası — sahne. Anchor'ın admin ucuna vekâlet.
    if (/^\/api\/admin\/(freeze|unfreeze|kill)$/.test(p) && req.method === "POST") {
      const action = p.split("/")[3];
      try {
        const r = await anchor(`/admin/${action}`, { method: "POST" });
        return send(200, r);
      } catch (e) {
        if (e.dead) return send(200, { alive: false });
        throw e;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    if (e.unauthorized) for (const [k, v] of tokens) if (req.url.includes(k) || (body && body.account === k)) tokens.delete(k);
    console.error(new Date().toISOString().slice(11, 19), req.method, url.pathname, "→", e.message);
    send(e.dead ? 503 : e.unauthorized ? 401 : 400, { error: e.message, dead: Boolean(e.dead), unauthorized: Boolean(e.unauthorized) });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} kullanımda. Eski süreç ESKİ kodu servis ediyor; kapatın:\n\n      kill $(lsof -ti tcp:${PORT})\n`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, HOST, () => {
  console.log(`Ripcord cüzdan: http://${HOST === "0.0.0.0" ? "0.0.0.0" : "localhost"}:${PORT}  (anchor: ${ANCHOR_URL})${ISSUER_KP ? " · musluk açık" : ""}`);
});
