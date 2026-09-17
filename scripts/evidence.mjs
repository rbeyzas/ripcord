// Canlı kanıt: bir anchor'ın İDDİA katmanı ile DEFTER yan yana.
//
//   npm run evidence                                  → stablecoin.anchorusd.com
//   npm run evidence -- <domain> [--asset CODE:ISSUER] → TOML'a ulaşılamazsa defter yine okunur
//
// İddia katmanı: stellar.toml (status), SEP-6 /info, SEP-1 DOCUMENTATION.
// Defter: Horizon /assets (dolaşımdaki tutar, trustline sayısı), stellar.expert (fiyat, hacim).
//
// Çerçeve — sunumda buna uyulacak: TERK, hırsızlık değil. Bu script "dolandırıcı" demez;
// "iddia şu, defter şu" der. Zarar iddiası üretmez. Erişilemeyeni "erişilemedi" diye yazar.

import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const domain = args.find((a) => !a.startsWith("--")) || "stablecoin.anchorusd.com";
const assetArg = args[args.indexOf("--asset") + 1];
const KNOWN = { "stablecoin.anchorusd.com": "USD:GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX" };
const fallbackAsset = (args.includes("--asset") && assetArg) || KNOWN[domain] || null;
const HZ = "https://horizon.stellar.org";
const UA = "Ripcord evidence/0.1 (+hackathon research; alperen@patika.dev)";
const out = { domain, at: new Date().toISOString(), claims: {}, ledger: {}, unreachable: [] };

async function get(url, timeoutMs = 12000) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: null, error: e?.cause?.code || e.name };
  }
}
const pick = (re, s) => re.exec(s || "")?.[1] ?? null;

console.log(`\nRipcord · kanıt · ${domain} · ${out.at}\n`);

// --- İddia katmanı ---------------------------------------------------------------
const toml = await get(`https://${domain}/.well-known/stellar.toml`);
if (!toml.ok) {
  out.unreachable.push({ what: "stellar.toml", ...toml });
  console.log(`  stellar.toml       erişilemedi (${toml.status ?? toml.error})`);
} else {
  const t = toml.text;
  out.claims.toml = {
    status: pick(/^\s*status\s*=\s*"([^"]+)"/m, t),
    orgName: pick(/ORG_NAME\s*=\s*"([^"]+)"/, t),
    transferServer: pick(/^\s*TRANSFER_SERVER\s*=\s*"([^"]+)"/m, t),
    transferServer24: pick(/^\s*TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/m, t),
    desc: pick(/^\s*desc\s*=\s*"([^"]{0,200})/m, t),
  };
  // İlk para birimi
  const cur = /\[\[CURRENCIES\]\]([\s\S]*?)(?=\[\[|$)/.exec(t)?.[1] || "";
  out.claims.asset = { code: pick(/code\s*=\s*"([^"]+)"/, cur), issuer: pick(/issuer\s*=\s*"(G[A-Z2-7]{55})"/, cur) };
  console.log(`  stellar.toml       status="${out.claims.toml.status}" · ${out.claims.toml.orgName ?? ""}`);
  if (out.claims.toml.desc) console.log(`                     "${out.claims.toml.desc.slice(0, 110)}…"`);

  const ts = out.claims.toml.transferServer || out.claims.toml.transferServer24;
  if (ts) {
    const info = await get(`${ts.replace(/\/$/, "")}/info`);
    if (info.ok) {
      try {
        const j = JSON.parse(info.text);
        const dep = j.deposit || {};
        const enabled = Object.entries(dep).filter(([, v]) => v?.enabled).map(([k]) => k);
        out.claims.info = { depositEnabled: enabled, withdrawEnabled: Object.entries(j.withdraw || {}).filter(([, v]) => v?.enabled).map(([k]) => k) };
        console.log(`  /info              deposit enabled: [${enabled.join(", ") || "—"}] · withdraw enabled: [${out.claims.info.withdrawEnabled.join(", ") || "—"}]`);
      } catch { out.unreachable.push({ what: "/info", reason: "JSON değil" }); console.log("  /info              JSON ayrıştırılamadı"); }
    } else { out.unreachable.push({ what: "/info", ...info }); console.log(`  /info              erişilemedi (${info.status ?? info.error})`); }
  }
}

// --- Defter --------------------------------------------------------------------------
if (!out.claims.asset?.issuer && fallbackAsset) {
  const [c, i] = fallbackAsset.split(":");
  out.claims.asset = { code: c, issuer: i, source: "fallback" };
  console.log(`  varlık             TOML'dan okunamadı; bilinen ihraççı kullanılıyor ${c}:${i.slice(0, 6)}…`);
}
const { code, issuer } = out.claims.asset || {};
if (code && issuer) {
  const a = await get(`${HZ}/assets?asset_code=${code}&asset_issuer=${issuer}`);
  if (a.ok) {
    const rec = JSON.parse(a.text)?._embedded?.records?.[0];
    if (rec) {
      const acc = rec.accounts || {};
      out.ledger.horizon = {
        outstanding: rec.balances?.authorized ?? rec.amount ?? null,
        trustlines: (acc.authorized || 0) + (acc.authorized_to_maintain_liabilities || 0),
        flags: rec.flags,
      };
      console.log(`  Horizon            ${code}:${issuer.slice(0, 6)}… dolaşımda ${Number(out.ledger.horizon.outstanding).toLocaleString("en-US", { maximumFractionDigits: 2 })} · ${out.ledger.horizon.trustlines.toLocaleString("en-US")} trustline`);
    }
  } else { out.unreachable.push({ what: "horizon", ...a }); console.log(`  Horizon            erişilemedi (${a.status ?? a.error})`); }

  const se = await get(`https://api.stellar.expert/explorer/public/asset/${code}-${issuer}`);
  if (se.ok) {
    try {
      const j = JSON.parse(se.text);
      out.ledger.market = { price: j.price ?? null, volume7d: j.volume7d ?? null, trades: j.trades ?? null };
      const vol = j.volume7d != null ? (Number(j.volume7d) / 1e7).toFixed(2) : "—";
      console.log(`  stellar.expert     fiyat ${j.price != null ? "$" + Number(j.price).toFixed(3) : "—"} · 7 gün hacim ${vol} · toplam işlem ${j.trades ?? "—"}`);
    } catch { console.log("  stellar.expert     JSON ayrıştırılamadı"); }
  } else { out.unreachable.push({ what: "stellar.expert", ...se }); console.log(`  stellar.expert     erişilemedi (${se.status ?? se.error})`); }

  const issuerAcc = await get(`${HZ}/accounts/${issuer}`);
  if (issuerAcc.ok) {
    const j = JSON.parse(issuerAcc.text);
    out.ledger.issuer = { homeDomain: j.home_domain ?? null, lastModified: j.last_modified_time ?? null };
    console.log(`  ihraççı hesabı     home_domain=${j.home_domain ?? "—"} · son değişiklik ${j.last_modified_time ?? "—"}`);
  }
}

// --- Yorum — ölçülü -------------------------------------------------------------------
console.log("");
const s = out.claims.toml?.status;
const px = out.ledger.market?.price;
if (s === "live" && px != null && px < 0.9) {
  console.log(`  İddia katmanı "live" diyor; defterde varlık paritenin ${(px * 100).toFixed(0)}%'inde işlem görüyor.`);
  console.log("  Bu bir zarar iddiası değildir. Anchor'ın kendi beyanının, hizmet durumunun");
  console.log("  güvenilir bir göstergesi olmadığının ölçümüdür. Ripcord bu yüzden beyana değil");
  console.log("  zincirdeki yükleme güvenir.");
} else if (out.unreachable.length) {
  console.log(`  ${out.unreachable.length} kaynak erişilemedi. "Erişilemedi" ≠ "yok" — bot duvarı olabilir. Yorum yapılmaz.`);
} else {
  console.log("  İddia ve defter arasında çelişki gözlenmedi.");
}

mkdirSync("reports", { recursive: true });
const file = `reports/evidence-${domain.replace(/[^a-z0-9.]/gi, "_")}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n  → ${file}\n`);
