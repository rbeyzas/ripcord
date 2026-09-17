// Ripcord Katman 0 — gerçek testnet kanıtı.
//
// İki senaryo, aynı protokol:
//   A. Anchor işini yapar: T'den önce talep eder → alır.
//   B. Anchor ölür: T geçer; anchor'ın talebi REDDEDİLİR, kullanıcı tek başına geri alır.
// Ayrıca: kullanıcı T'den önce alamaz; önceden hesaplanan balanceID ağdakiyle aynıdır;
// 1 XLM rezerv oluşturana döner.
//
// Dış anchor'a bağımlı değil: kendi test varlığımızı ihraç ediyoruz. Çıktı reports/'a yazılır.

import { mkdirSync, writeFileSync } from "node:fs";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
} from "@stellar/stellar-sdk";
import { buildEscrowTx, buildClaimTx, deadlineFor, verifyEscrowTx } from "../src/escrow.js";

const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;
const server = new Horizon.Server(HORIZON);
const DELIVERY = Number(process.env.DELIVERY_SECONDS || 75); // min 60; demoda kısa

const report = { network: "testnet", horizon: HORIZON, at: new Date().toISOString(), steps: [] };
const log = (msg, extra = {}) => {
  console.log(`  ${msg}`);
  report.steps.push({ msg, ...extra, t: new Date().toISOString() });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function friendbot(pub) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && r.status !== 400) throw Error(`friendbot ${r.status}`);
}

async function submit(kp, xdr, label) {
  const tx = new Transaction(xdr, NET);
  tx.sign(kp);
  try {
    const res = await server.submitTransaction(tx);
    return { ok: true, hash: res.hash, ledger: res.ledger };
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    return { ok: false, codes, status: e?.response?.status, message: e.message };
  }
}

async function classic(kp, ops, label) {
  const acc = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).setTimeout(120);
  for (const op of ops) b.addOperation(op);
  const r = await submit(kp, b.build().toXDR(), label);
  if (!r.ok) throw Error(`${label} düştü: ${JSON.stringify(r.codes || r.message)}`);
  return r;
}

// Rezerv bakiyeden DÜŞÜLMEZ; sponsorluk sayacı olarak minimum bakiyeyi yükseltir.
// Doğru ölçüm num_sponsoring'dir, balance değil.
async function sponsoring(pub) {
  const a = await server.loadAccount(pub);
  return a.num_sponsoring;
}

async function balanceOf(pub, asset) {
  const a = await server.loadAccount(pub);
  const b = a.balances.find((x) =>
    asset.isNative() ? x.asset_type === "native" : x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer(),
  );
  return b ? b.balance : "0";
}

async function cbExists(id) {
  try {
    await server.claimableBalances().claimableBalance(id).call();
    return true;
  } catch (e) {
    if (e?.response?.status === 404 || /404|Not Found/i.test(String(e?.message))) return false;
    throw e;
  }
}

const now = () => Math.floor(Date.now() / 1000);

async function main() {
  console.log("\nRipcord · testnet kanıtı\n");

  // --- Kurulum -------------------------------------------------------------
  const issuer = Keypair.random(), anchor = Keypair.random(), user = Keypair.random();
  const RIP = new Asset("RIP", issuer.publicKey());
  log("Hesaplar", { issuer: issuer.publicKey(), anchor: anchor.publicKey(), user: user.publicKey() });
  await Promise.all([issuer, anchor, user].map((k) => friendbot(k.publicKey())));
  log("Friendbot ile fonlandı");

  await classic(anchor, [Operation.changeTrust({ asset: RIP })], "anchor trustline");
  await classic(user, [Operation.changeTrust({ asset: RIP })], "user trustline");
  await classic(issuer, [Operation.payment({ destination: user.publicKey(), asset: RIP, amount: "100" })], "ihraç");
  log("Trustline'lar açık, kullanıcıda 100 RIP");

  // ===========================================================================
  // Senaryo A — anchor teslim eder
  // ===========================================================================
  console.log("\n── A · Anchor işini yapar ──");
  {
    const acc = await server.loadAccount(user.publicKey());
    const T = deadlineFor(DELIVERY, now());
    const built = buildEscrowTx({
      user: user.publicKey(), userSequence: acc.sequenceNumber(), anchor: anchor.publicKey(),
      asset: RIP, amount: "10", deadline: T, networkPassphrase: NET, memo: "sep24:A",
    });
    // Cüzdan disiplini: imzadan önce doğrula.
    verifyEscrowTx(built.xdr, { user: user.publicKey(), anchor: anchor.publicKey(), deadline: T, asset: RIP, amount: "10" }, { networkPassphrase: NET });
    const sponsoringBefore = await sponsoring(user.publicKey());
    const r = await submit(user, built.xdr, "escrow A");
    if (!r.ok) throw Error("Emanet A düştü: " + JSON.stringify(r.codes));
    log("Emanet oluşturuldu", { tx: r.hash, balanceId: built.balanceId, deadline: T.toString() });

    // Önceden hesaplanan ID ağda var mı? Protokolün "SEP kaydına bağlanabilir" iddiası bu.
    const exists = await cbExists(built.balanceId);
    if (!exists) throw Error("Önceden hesaplanan balanceID ağda bulunamadı — hesap yanlış!");
    log("✓ Önceden hesaplanan balanceID ağdakiyle aynı");

    const sponsoringAfterCreate = await sponsoring(user.publicKey());
    if (sponsoringAfterCreate !== sponsoringBefore + 2) throw Error(`num_sponsoring ${sponsoringBefore}→${sponsoringAfterCreate}, +2 bekleniyordu`);
    log("✓ Rezerv kilitlendi: 2 alacaklı = 2 giriş sponsorlandı (1 XLM)", { sponsoringBefore, sponsoringAfterCreate });

    const aAcc = await server.loadAccount(anchor.publicKey());
    const claim = buildClaimTx({ claimant: anchor.publicKey(), claimantSequence: aAcc.sequenceNumber(), balanceId: built.balanceId, networkPassphrase: NET });
    const c = await submit(anchor, claim.xdr, "anchor claim A");
    if (!c.ok) throw Error("Anchor T'den önce alamadı, olmamalı: " + JSON.stringify(c.codes));
    log("✓ Anchor T'den önce talep etti ve aldı", { tx: c.hash, anchorRIP: await balanceOf(anchor.publicKey(), RIP) });
    const sponsoringAfterClaim = await sponsoring(user.publicKey());
    if (sponsoringAfterClaim !== sponsoringBefore) throw Error(`talep sonrası num_sponsoring ${sponsoringAfterClaim}, ${sponsoringBefore} bekleniyordu`);
    log("✓ Rezerv oluşturana (kullanıcıya) döndü — anchor'a değil", { sponsoringAfterClaim });
  }

  // ===========================================================================
  // Senaryo B — anchor ölür
  // ===========================================================================
  console.log("\n── B · Anchor ölür ──");
  {
    const acc = await server.loadAccount(user.publicKey());
    const t0 = now();
    const T = deadlineFor(DELIVERY, t0);
    const built = buildEscrowTx({
      user: user.publicKey(), userSequence: acc.sequenceNumber(), anchor: anchor.publicKey(),
      asset: RIP, amount: "10", deadline: T, networkPassphrase: NET, memo: "sep24:B",
    });
    const r = await submit(user, built.xdr, "escrow B");
    if (!r.ok) throw Error("Emanet B düştü: " + JSON.stringify(r.codes));
    log("Emanet oluşturuldu", { tx: r.hash, balanceId: built.balanceId, deadline: T.toString() });
    const ripAfterEscrow = await balanceOf(user.publicKey(), RIP);
    log("Kullanıcının RIP'i emanette", { userRIP: ripAfterEscrow });

    // Kullanıcı erken davranırsa alamaz — protokol simetrik.
    {
      const uAcc = await server.loadAccount(user.publicKey());
      const early = buildClaimTx({ claimant: user.publicKey(), claimantSequence: uAcc.sequenceNumber(), balanceId: built.balanceId, networkPassphrase: NET });
      const e = await submit(user, early.xdr, "user early claim");
      if (e.ok) throw Error("Kullanıcı T'den önce aldı — protokol kırık!");
      log("✓ Kullanıcı T'den önce alamadı", { codes: e.codes });
    }

    // Anchor ölü: hiçbir şey yapmıyor. T'nin geçmesini bekliyoruz.
    const wait = Number(T) - now() + 8; // ledger kapanış payı
    log(`Anchor sessiz. T'ye ${wait} sn…`);
    await sleep(wait * 1000);

    // Anchor geç kalkarsa artık alamaz.
    {
      const aAcc = await server.loadAccount(anchor.publicKey());
      const late = buildClaimTx({ claimant: anchor.publicKey(), claimantSequence: aAcc.sequenceNumber(), balanceId: built.balanceId, networkPassphrase: NET });
      const l = await submit(anchor, late.xdr, "anchor late claim");
      if (l.ok) throw Error("Anchor T'den sonra aldı — protokol kırık!");
      log("✓ Anchor T'den sonra talep etti, REDDEDİLDİ", { codes: l.codes });
    }

    // Kullanıcı tek başına geri alır. Anchor yok, yönetici yok, hakem yok.
    {
      const uAcc = await server.loadAccount(user.publicKey());
      const back = buildClaimTx({ claimant: user.publicKey(), claimantSequence: uAcc.sequenceNumber(), balanceId: built.balanceId, networkPassphrase: NET });
      const b = await submit(user, back.xdr, "user reclaim");
      if (!b.ok) throw Error("Kullanıcı T'den sonra alamadı: " + JSON.stringify(b.codes));
      log("✓ Kullanıcı parasını KİMSEYE SORMADAN geri aldı", { tx: b.hash, userRIP: await balanceOf(user.publicKey(), RIP) });
    }
    if (await cbExists(built.balanceId)) throw Error("Emanet hâlâ duruyor?");
    log("✓ Emanet kaydı silindi");
  }

  report.result = "PASS";
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-escrow.json", JSON.stringify(report, null, 2));
  console.log("\nSONUÇ: PASS · reports/testnet-escrow.json\n");
}

main().catch((e) => {
  report.result = "FAIL";
  report.error = e.message;
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-escrow.json", JSON.stringify(report, null, 2));
  console.error("\nSONUÇ: FAIL —", e.message, "\n");
  process.exit(1);
});
