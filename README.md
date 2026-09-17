# Ripcord

**Anchor çökerse kullanıcının parası ne olur?** Bugün: hiçbir şey. Kullanıcı bekler.

SEP-24/SEP-6 çekiminde kullanıcı token'ı anchor'ın hesabına düz bir ödemeyle gönderir;
o andan sonra spec'te kullanıcının başlatabileceği tek bir eylem yoktur — anchor'ı
bağlayan süre yok, iptal ucu yok, `refunded` var ama yalnızca anchor tetikler. Ripcord
o ödemeyi, anchor'ın **yalnızca işini yaparak** alabileceği ve yapmazsa kullanıcının
**kimseye sormadan geri alabileceği** bir emanete çevirir.

```
BUGÜN     payment(anchor, 100 USDC)          → anchor'da custody. Anında. Kalıcı.
RIPCORD   claimableBalance(100 USDC, [
            anchor : before(T),               → yalnızca T'den ÖNCE
            user   : not(before(T)) ])        → yalnızca T'den SONRA
```

İki yüklem tam tümleyen; Stellar'da claimable balance'ı iptal eden operasyon yok.
T geçince anchor kalıcı olarak kilitlenir. Bunu bizim kodumuz değil, stellar-core uygular.

## Üç katman

| | Mekanizma | Garanti | Kanıt |
|---|---|---|---|
| **0** | İki alacaklılı claimable balance — sözleşme yok, deploy yok | Anchor hiçbir şey yapmazsa kullanıcı T'den sonra tek başına alır | `escrow:check` · testnet `op_cannot_claim` |
| **1** | Soroban `ripcord-bond`: teminat + itiraz penceresi + baştan ilan edilmiş hakem | "Ödedim" deyip ödemeyen anchor teminatından ceza öder; teminatsız yükümlülük açılamaz; ödeme gücü zincirde sayılır | `bond:check` · testnet **`CCKGTC4IIHONXWXIZI33T5SYXAGPWUCEKCJBNY5YZRDTPGBSGYZUPVLV`** |
| **2** | SEP-53 imzalı teslim beyanı (`stellar.toml` SIGNING_KEY) | "Dedi/demedi" inkâr edilemez belge olur | `ui:check` |

Teslim süresi anchor tarafından `GET /info`'da **ilan edilir** ve kullanıcı imzadan önce
görür: görünmez bir risk, ilan edilen ve uygulanan bir söze dönüşür.

## Jüri için 5 dakika

```
npm install
npm run anchor:setup -- --own-asset   # anchor hesabı + test varlığı + demo kullanıcı → .env
npm run anchor                         # terminal 1 — öldürülebilir demo anchor
npm run dev                            # terminal 2 — cüzdan arayüzü → http://localhost:4173
```

Cüzdan bağla → orta şeritte **Çek** → üstten **Dondur** (zombi) ya da **Öldür** → T geçince
**Paramı geri al**. Sol şerit aynı anda bugünkü SEP-24'ü gösterir: para anchor'da,
`pending_anchor`, sonsuza kadar. Üçüncü şerit (Katman 1, `contract:build` sonrası
görünür): anchor "ödedim" der → **itiraz et** → demo hakemi → teminattan ceza.

## Canlı demo

Tek konteyner, Fly.io: `docs/08-DEPLOY.md`. Bağlanan herhangi bir Freighter cüzdanı üst
karttaki üç adımla (friendbot → trustline → 100 RIP) 60 saniyede kullanıcı olur ve
anchor'ı kendisi öldürebilir. `npm run serve` aynı supervisor'ı yerelde koşar.

## Kanıt — hepsi gerçek testnet

```
npm test               # 33 birim testi (yüklemler, doğrulayıcı, SEP-53, tutar disiplini)
npm run escrow:check   # Katman 0: anchor teslim eder → alır; anchor ölür → ağ reddeder, kullanıcı alır
npm run anchor:check   # SEP-1/10/24 uçtan uca + zombi + geri alma + legacy sıkışması
npm run ui:check       # tarayıcının API sırası + SEP-53 doğrulama + öldürme
npm run contract:test  # Katman 1, 9 Rust testi
npm run bond:check     # Katman 1 testnet: teminat sınırı, TooLate, reclaim, dispute → ceza
npm run bonded:check   # Katman 1 cüzdan akışı (PHASE=D itiraz→hakem · PHASE=E zombi→geri al)
npm run evidence       # canlı: bir anchor'ın iddia katmanı vs defter
```

Çıktılar `reports/`'ta. Reddeden bizim kodumuz değil: `op_cannot_claim` (stellar-core),
`TooLate` / `InsufficientBond` (sözleşme).

## Ne gerçek, ne simüle

| Gerçek (testnet) | Simüle |
|---|---|
| SEP-1 keşif, SEP-10 kimlik, SEP-24 çekim akışı | Fiat ödeme (log satırı + imzalı beyan) |
| Claimable balance kurma, anchor talebi, kullanıcı geri alma | Demo anchor'ın kendisi (bizim, kasten öldürülebilir) |
| Soroban sözleşmesi: tüm geçişler, ceza, `stats` | Hakem (bir anahtar çifti; üretimde adlandırılmış taraf) |
| SEP-53 imza ve doğrulama, Stellar Wallets Kit imzaları | — |

## Dokümanlar

| | |
|---|---|
| [`docs/00-PROTOKOL.md`](docs/00-PROTOKOL.md) | Boşluk, canlı kanıt, üç katman, tehdit modeli, demo |
| [`docs/SEP-XXXX-escrowed-withdrawals.md`](docs/SEP-XXXX-escrowed-withdrawals.md) | **SEP taslağı** (İngilizce, SEP şablonu) |
| [`docs/03-MIMARI.md`](docs/03-MIMARI.md) | Mermaid: sistem, sıra, durum makineleri; Soroban kararları |
| [`docs/04-SCF-TECHNICAL-WRITEUP.md`](docs/04-SCF-TECHNICAL-WRITEUP.md) | SCF formatında teknik yazı (İngilizce) |
| [`docs/05-STELLAR-2026-HIZALAMA.md`](docs/05-STELLAR-2026-HIZALAMA.md) | P23–P28, CAP-71/72, SEP-45/53/59, SDK epic, SCF v7 — neyi neden kullandık |
| [`docs/02-JURI-KRITERLERI.md`](docs/02-JURI-KRITERLERI.md) | Şartlar ve 6 kriter, madde madde |
| [`docs/06-DEMO-SENARYOSU.md`](docs/06-DEMO-SENARYOSU.md) | Sahne beat'leri, yedekler, söylenmeyecekler |
| [`docs/07-SUNUM-VE-VIDEO.md`](docs/07-SUNUM-VE-VIDEO.md) | 15 slayt içeriği, 2:40 video metni, prova listesi |
| [`docs/08-DEPLOY.md`](docs/08-DEPLOY.md) | Fly.io tek konteyner, jüri onboarding musluğu |
| [`docs/01-DURUM.md`](docs/01-DURUM.md) | Ne yapıldı, neyle kanıtlandı, ne öğrenildi |

## Dürüst sınırlar

Hiçbir sözleşme paranın bankaya ulaştığını doğrulayamaz. Katman 0 "anchor hiçbir şey
yapmadı ve para gitti" hâlini yok eder; Katman 1 "aldım deyip ödemedi"yi pahalı kılar;
Katman 2 inkâr edilemez kılar. Garanti *anchor'ın* izni olmadan geri almadır — *ihraççının*
değil (clawback / `auth_revocable`; USDC'de ikincisi açık). Rezerv (1 XLM/emanet)
kullanıcıda, talepte geri döner; anchor'a zincir maliyeti yok.

## Ekosistem

- **Stellar Wallets Kit v2** — Eligible Integration Partner; her kullanıcı imzası buradan.
- **JS SDK 17** (`Claimant`, `WebAuth`, `signMessage`, RPC deploy) · **Soroban SDK 23**.
- Skill dosyası: `CheesecakeLabs/stellar-anchor-skill/blob/main/SKILL.md` (SEP-1/10/24
  akış biçimleri; BillRail'den devam). Başka skill kullanılmadı; SEP metinleri ve
  stellar-core kaynağı doğrudan okundu.

Lisans: Apache-2.0
