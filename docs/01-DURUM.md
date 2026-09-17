# Uygulama durumu

Bu dosya ilerledikçe güncellenir. Her madde ya test ya da testnet çıktısıyla desteklenir;
"yapıldı" demek "kanıtı var" demektir.

---

## 15 Eylül (Salı gecesi) — Katman 0 çekirdeği ve testnet kanıtı

### Yapıldı

**`src/escrow.js`** — protokolün Katman 0 çekirdeği. Soroban yok, klasik operasyonlar.
- `deadlineFor(seconds, now)` — teslim süresinden mutlak son tarih. Alt sınır 60 sn,
  üst sınır 1 yıl. `now` enjekte edilebilir.
- `escrowClaimants({anchor, user, deadline})` — normatif yüklem çifti:
  `[anchor: before(T), user: not(before(T))]`. Sıra sabit. `rel_before` hiçbir yerde üretilmez.
- `balanceIdFor({txSource, txSequence, opIndex})` — `sha256(ENVELOPE_TYPE_OP_ID ‖ …)`,
  Horizon biçiminde 72 hex. Gönderilmeden önce hesaplanır → SEP kaydına bağlanır.
- `buildEscrowTx(...)` — imzasız XDR + önceden hesaplanmış `balanceId` + son tarih.
  Tutar `units.js`'ten geçer (7 ondalık, sıfır/negatif reddi). 5 dk geçerlilik penceresi.
- `buildClaimTx(...)` — anchor ve kullanıcı için aynı yapı; kim alır, ağ karar verir.
- `verifyEscrowTx(xdr, expect)` — **kullanıcı imzalamadan önceki savunma hattı.** Tek op,
  iki alacaklı, doğru sıra, tümleyen yüklemler, aynı T, beklenen T/tutar/varlık, kaynak
  kullanıcı, `rel_before` yok, fazladan op yok. Uyumsuzluk → tüm sorunları listeleyerek fırlatır.

**`tests/escrow.test.js`** — 15 test. Aralarında: sahte anchor, yer değiştirmiş
alacaklılar, emanetin yanına gizlenmiş ödeme, farklı T/tutar/varlık — hepsi yakalanıyor.

**`scripts/escrow-check.mjs`** — gerçek testnet kanıtı. Kendi test varlığını ihraç
eder, dış anchor'a bağımlı değil.

### Testnet sonucu — iki kez çalıştırıldı, iki kez PASS

```
── A · Anchor işini yapar ──
  ✓ Önceden hesaplanan balanceID ağdakiyle aynı
  ✓ Rezerv kilitlendi: 2 alacaklı = 2 giriş sponsorlandı (1 XLM)
  ✓ Anchor T'den önce talep etti ve aldı
  ✓ Rezerv oluşturana (kullanıcıya) döndü — anchor'a değil

── B · Anchor ölür ──
  ✓ Kullanıcı T'den önce alamadı            → op_cannot_claim
  ✓ Anchor T'den sonra talep etti, REDDEDİLDİ → op_cannot_claim
  ✓ Kullanıcı parasını KİMSEYE SORMADAN geri aldı
  ✓ Emanet kaydı silindi
```

Ham çıktı ve tx hash'leri: `reports/testnet-escrow.json`.

Protokolün üç temel iddiası ağ tarafından uygulandı — bizim kodumuz değil, stellar-core
reddetti. Bu, sunumdaki "sözleşme kuralı değil, protokol garantisi" cümlesinin kanıtı.

### Öğrenilenler

- **Rezerv bakiyeden düşülmüyor.** İlk ölçümüm `balance` alanına bakıyordu ve yalnızca
  ücret farkını görüyordu. Doğru ölçüm `num_sponsoring`: oluşturmada +2, talepte geri
  0. Script düzeltildi ve bunu artık doğruluyor.
- SDK 17'de yüklemler tipli sınıf (`p.type === "claimPredicateBeforeAbsoluteTime"`,
  `p.absBefore` bigint). `switch()/arm()` API'si yok.
- `balanceId`'de kaynak ve sıra **işlemin**kidir, operasyonun değil. Kurucu, hesap
  sırası + 1 ile hesaplıyor ve testnet doğruladı.

### Doğrulama

- `npm test`: **25/25** (10 units + 15 escrow)
- `npm run escrow:check`: **PASS** ×2

---

## Sıradaki

1. Öldürülebilir yerel SEP-24 anchor stub'ı (sahnede kapatmak için)
2. İkiz arayüz: bugünkü akış vs Ripcord, cüzdan imzasıyla
3. SEP taslağı metni + tehdit modeli

---

## 15 Eylül (gece, devam) — öldürülebilir anchor ve uçtan uca SEP akışı

### Yapıldı

**`src/anchor/server.js`** — kendi demo anchor'ımız. SEP-1 (`stellar.toml`), SEP-10
(challenge üretimi ve imza doğrulama, SDK `WebAuth`), SEP-24 çekim alt kümesi
(`/info`, `/transactions/withdraw/interactive`, `/transaction`), **Ripcord uzantısı**:
`/info`'da `withdraw[asset].escrow = {supported, max_delivery_seconds, modes}`; işlem
kaydında `escrow_mode`, `escrow_claimant`, `escrow_balance_id`, `escrow_deadline`,
`escrow_outcome`. Fiat ödeme simüle ve öyle olduğunu söylüyor.

İki arıza modu, sahne kumandası `/admin/*`:
- **ölü** — `POST /admin/kill`, süreç kapanır.
- **zombi** — `POST /admin/freeze`. HTTP cevap verir, zinciri **görür**, kaydeder, ama
  **teslim etmez**. AnchorUSD'nin bugünkü davranışı.

Gözcü her 3 sn Horizon'a bakar. Ripcord işlemlerinde `claimable_balances?claimant=anchor`,
legacy'de `payments?join=transactions` (memo eşlemesi). "Görmek" ile "teslim etmek"
ayrı: donmuş anchor ödemeyi gördüğünü `pending_anchor` ile kaydeder ve orada kalır.

**`src/anchor/jwt.js`** — HS256, bağımlılıksız. Üretim iddiası yok.

**`scripts/anchor-setup.mjs`** — anchor hesabı + trustline + `.env` (0600, secret
ekrana basılmaz). `--own-asset` ile kendi RIP varlığı + fonlanmış demo kullanıcı.

**`scripts/anchor-check.mjs`** — cüzdan rolünde, yerel anchor'a karşı tam SEP akışı.

### Uçtan uca sonuç — PASS

| | Anchor | Sonuç | Kullanıcı |
|---|---|---|---|
| A · Ripcord | sağlıklı | `completed / claimed_by_anchor` | −10, teslim |
| B · Ripcord | zombi | `refunded / reclaimed_by_user` | ±0, **geri aldı** |
| C · legacy | zombi | `pending_anchor` sonsuza kadar | −10, anchor'da kaldı |

Ham kayıt: `reports/anchor-e2e.json`.

### Uçtan uca koşunun yakaladığı iki hata

1. **Yarış.** Anchor'ın talebi ağa giderken (~5 sn) bir sonraki gözcü turu emaneti
   "kaybolmuş" görüp yanlışlıkla "kullanıcı geri aldı" işaretledi. Düzeltme protokolün
   kendisinden: kullanıcı yalnızca **T'den sonra** alabilir. Emanet T'den önce yoksa
   bizim talebimizdir; T'den sonra yoksa kullanıcı almıştır. Ayrıca turlar artık
   örtüşmüyor (`watching` kilidi) ve talep yoldayken `claiming` bayrağı var.
2. **Donmuş anchor bakmıyordu.** İlk sürümde `freeze` gözcüyü tamamen durduruyordu;
   çözülünce emaneti hiç görmediği için `reclaimed_by_user` üretemiyordu. Dondurmak
   "teslim etme" demek, "gözünü kapat" değil. Legacy tarafında bu daha da anlamlı:
   zombi anchor parayı **aldığını** kaydediyor ve `pending_anchor`'da kalıyor.

### Öğrenilenler

- `localhost` Node'un fetch'inde `::1`'e çözülebiliyor; anchor `127.0.0.1`'de.
  `dns.setDefaultResultOrder("ipv4first")`. BillRail'deki Freighter tuzağının aynısı.
- Horizon claimable balance kaydında yüklem `{abs_before, abs_before_epoch}` biçiminde
  geliyor; `abs_before_epoch` doğrudan T.
- Spec'te "kullanıcı emaneti geri aldı" durumu yok. `refunded` + `escrow_outcome:
  reclaimed_by_user` kullandık; SEP taslağına not düşüldü.

### Doğrulama

- `npm test`: 25/25
- `npm run escrow:check`: PASS ×2
- `npm run anchor:check` (anchor açıkken): **PASS**

### Çalıştırma

```
npm run anchor:setup -- --own-asset   # bir kez; .env yazar
npm run anchor                         # terminal 1
npm run anchor:check                   # terminal 2 — ~3 dk
```

---

## 15 Eylül (gece, son) — ikiz arayüz ve cüzdan sunucusu

### Yapıldı

**`src/server.js`** — cüzdanın arka ucu, anchor'dan AYRI süreç (anchor ölürken bu
ayakta kalır). Hiçbir gizli anahtar tutmaz. SEP-10 challenge'ı **alır ve doğrular**
(sıra 0, kaynak = SIGNING_KEY, ağ testnet), tarayıcı imzalar. Çekimde legacy için
düz ödeme XDR'ı, ripcord için `buildEscrowTx` + **`verifyEscrowTx`** — anchor'ın
ilan ettiği süre ve alacaklıyla birebir doğrulanmadan imzaya gitmez. `/api/reclaim`
anchor'a **hiç sormaz**. Ölü anchor için kayıt **uydurmaz**: `anchorAlive:false, anchor:null`.

**`public/`** — ikiz ekran. Sol: bugünkü SEP-24. Sağ: Ripcord. Üstte anchor durumu
(CANLI / ZOMBİ / ÖLÜ) ve sahne kumandası (Dondur / Çöz / Öldür). Bakiyeler: cüzdan,
emanette, anchor hesabı — Horizon'dan, anchor'dan bağımsız. Ripcord şeridinde geri
sayım; T geçince **"Paramı geri al"**. Altta SEP-24 durum listesi aynen: *"paramı geri
ver" diye bir durum yok.*

**`src/wallet-entry.js`** — BillRail'den; Stellar Wallets Kit v2 (entegrasyon partneri).

**`scripts/ui-check.mjs`** — tarayıcının çağıracağı API sırası, demo kullanıcı yerelde
imzalar. Öldürme dahil **PASS**.

### Tarayıcıda test edilmedi

Freighter imzası ve sayfa görünümü sandbox'ta test edilemez (eklenti yok).
**Sizin makinede ilk iş:** `npm run dev` → `http://localhost:4173` → cüzdan bağla →
sağ şeritte Çek → Dondur → T bekle → Paramı geri al. Hata olursa ekran görüntüsü.

### Doğrulama

- `npm test`: 25/25 · `escrow:check` PASS · `anchor:check` PASS · `ui:check` PASS

---

## 16 Eylül (gece) — SEP taslağı ve Katman 1 sözleşmesi

### Yapıldı

**`docs/SEP-XXXX-escrowed-withdrawals.md`** — İngilizce, gerçek SEP şablonunda:
Preamble, Simple Summary, Motivation (spec alıntıları + AnchorUSD gözlemi, zarar iddiası
yok), Abstract, Specification (§1 `/info` ilanı, §2 `escrow_mode` isteği, §3 kayıt
alanları, §4 normatif işlem yapısı, §5 balanceID eşleme, §6 anchor davranışı, §7
kullanıcı davranışı, §8 durum semantiği), Design Rationale, Security Concerns.
Kod SEP'e hizalandı: istek alanı `escrow_mode: "claimable_balance"`, bilinmeyen mod
→ 400 (sessizce düz ödemeye düşmek yasak). `anchor:check` yeniden PASS.

**`contracts/ripcord-bond/`** — Katman 1, Soroban (SDK 23.0.1, BillRail'in kilit
dosyasıyla; `ed25519-dalek 3.0` SDK 23 ile uyumsuz, 2.2.0'a sabit).
- `bond(anchor, amount, arbiter)` — teminat + hakem ilanı. Açık yükümlülük varken hakem değişemez.
- `open(user, anchor, amount, deadline)` — **serbest teminat tutarı karşılamıyorsa reddedilir.**
  Anchor üstlenemeyeceği yükümlülük alamaz; açık yükümlülükler zincirde sayılır.
- `claim(id, attestation)` — T'den sonra `TooLate`. Para gitmez, itiraz penceresi açılır.
- `dispute(id)` — pencere içinde. `finalize(id)` — itirazsız pencere sonrası, herkes çağırabilir.
- `reclaim(id)` — T geçti ve claim yok → kullanıcı tek başına.
- `resolve(id, user_wins)` — hakem. Kullanıcı haklıysa tutar + `penalty_bps` teminattan.
- `stats(anchor)` — `{total, locked, open}`: **ödeme gücü görünümü**.
- TTL: kalıcı girişler her yazımda 180 güne uzatılır; son tarih girişin değerinde,
  TTL asla güvenlik sınırı değil.

9 Rust testi, 30 KB WASM, uyarısız.

**`scripts/bond-check.mjs`** — testnet kanıtı, evreli (`PHASES=setup,A,B,C`).
SAC + sözleşme deploy, stellar CLI gerekmez.

### Testnet sonucu — PASS · sözleşme `CCKGTC4IIHONXWXIZI33T5SYXAGPWUCEKCJBNY5YZRDTPGBSGYZUPVLV`

| | Sonuç | Bakiye |
|---|---|---|
| teminatsız `open` | `InsufficientBond` | — |
| teminatı aşan `open` | `InsufficientBond` | — |
| A · claim → pencere → finalize | anchor aldı | anchor 940 (1000 − 100 teminat + 40) |
| B · T geçti → anchor claim | **`TooLate`** | — |
| B · kullanıcı reclaim | geri aldı | kullanıcı bakiyesi korundu |
| C · claim → dispute → resolve(user) | tutar + %10 ceza kullanıcıya | 920 → 964 · teminat 100 → **96** |

### Öğrenilenler

- **Alt sınır yarışı.** `DELIVERY=60` ile `open` simülasyonda geçip zincirde
  `BadDeadline` ile düştü: kontrol uygulama anındaki ledger zamanına göre yapılıyor,
  simülasyon anına göre değil; aradaki birkaç saniye yetti. `rel_before`'u
  yasaklamamızla aynı sınıf. Cüzdan T'yi payla kurmalı. `lib.rs`'e not düşüldü.
- Sandbox'ta arka plan süreçleri çağrı bitince ölüyor; bu yüzden script evreli.
  Kullanıcı makinesinde `npm run bond:check` tek seferde koşar (~5 dk).

### Doğrulama

- `npm test` 25/25 · `contract:test` 9/9 · `escrow:check` PASS · `anchor:check` PASS ·
  `ui:check` PASS · **`bond:check` PASS**

### Katman 1'in arayüze bağlanması — yapılmadı

İkiz arayüz şu an Katman 0 ile çalışıyor. Katman 1'i üçüncü şerit olarak eklemek
(teminat paneli + `stats` görünümü) sıradaki iş; sözleşme ve kanıt hazır.

---

## 16 Eylül (gece, devam) — Katman 2, Katman 1 arayüzde, jüri dokümanları

### Yapıldı

**Katman 2 — `src/attest.js`.** SEP-53 (Final, Haziran 2026) ile imzalı teslim beyanı.
Kanonik JSON (sıralı anahtar, boşluksuz) → `Keypair.signMessage` → cüzdan tarafında
`stellar.toml` SIGNING_KEY ile `verifyMessage`. Kanonik olmayan ya da başka anahtarla
imzalanmış beyan, imza geçse bile reddedilir. 8 test. Anchor hem legacy hem ripcord
teslimlerinde beyan üretir (Katman 2 tek başına benimsenebilir); beyanın hash'i Katman 1
`claim(id, attestation)`'a gider. Arayüzde "SEP-53 · doğrulandı ✓ · ref FAST-…".

**Katman 1 arayüzde.** `src/bond.js` paylaşımlı sözleşme istemcisi (anchor + cüzdan sunucusu
+ hakem). `anchor:setup` artık SAC + sözleşme deploy + init yapar, hakem üretir (`ARBITER_*`),
`RIPCORD_BOND_CONTRACT` yazar; WASM yoksa Katman 1'i atlar, 0 ve 2 çalışır. Anchor açılışta
teminat yatırır (100), `/info`'da `bonded_contract` modunu ilan eder, yükümlülükleri id
sırasıyla tarar, claim → pencere → finalize; Disputed → `on_hold`; Reclaimed/Resolved →
dürüst kayıt. Cüzdan sunucusu: `mode: bonded` → `open` XDR (simüle+assemble, kullanıcı
imzalar), `/api/bond/dispute|reclaim`, `/api/admin/resolve` (**demo hakemi**, etiketli).
Arayüz: üçüncü şerit + "anchor teminatı · zincirde" kartı (`stats`: toplam/kilitli/açık).

**Dokümanlar.** `02-JURI-KRITERLERI.md` (şartlar + 6 kriter madde madde),
`03-MIMARI.md` (Mermaid ×4 + Soroban kararları), `04-SCF-TECHNICAL-WRITEUP.md` (İngilizce,
SCF formatı), `05-STELLAR-2026-HIZALAMA.md` (P23–P28, CAP-71/72, SEP-45/53/59, SDK
Money Movement Epic, SCF v7 — neyi neden kullandık/kullanmadık), `06-DEMO-SENARYOSU.md`
(6 dk beat, yedekler, söylenmeyecekler). README jüri girişi olarak yeniden yazıldı.

**`scripts/evidence.mjs`** — canlı kanıt: `stablecoin.anchorusd.com` iddia katmanı
(`status="live"`, deposit/withdraw enabled) vs defter (1.929.632 USD dolaşımda, 38.350
trustline, $0,312, haftalık hacim 8,03). Zarar iddiası üretmez; erişilemeyeni "erişilemedi"
yazar. AnchorUSD'nin gerçek domaini `stablecoin.anchorusd.com`, ihraççı `GDUKMG…YLEX`.

### Doğrulama

- `npm test` **33/33** · `contract:test` 9/9 · `escrow:check` · `anchor:check` · `ui:check` (SEP-53 dahil) ·
  `bond:check` · **`bonded:check` D ve E PASS** · `evidence` canlı
- Katman 1 demo sözleşmesi (bu kurulum): `CADMM576CT25552UMQY2O4DRWGSJUECCIIVH5TMCYE56VJNH2RKX3MLG`

### Not — repo içindeki `.env`

Sandbox'taki kurulum `.env`'i repo köküne yazdı (gitignore'da, 0600, testnet anahtarları).
Doğrudan kullanabilirsiniz (`npm run anchor` / `npm run dev`) ya da `npm run anchor:setup --
--own-asset --force` ile kendi kurulumunuzu yapın. Freighter'a `DEMO_USER_SECRET`'ı
import edin (yalnızca testnet demo hesabı).

### Tarayıcıda test edilmedi (değişmedi)

Freighter imzası — Katman 0 ve Katman 1 (Soroban işlemi imzalama dahil). Freighter Soroban
işlemlerini imzalar; SWK `signTransaction` aynen geçirir. Hata olursa ekran görüntüsü.

---

## 17 Eylül — tarayıcı testi geçti, canlı deploy hazırlığı

### Tarayıcıda doğrulandı (kullanıcı makinesi, Freighter)
Katman 0: emanet → anchor claim → SEP-53 doğrulandı; Dondur → geri sayım → **Paramı geri al**.
Katman 1: `open` (Soroban imzası Freighter'da) → anchor claim → itiraz → hakem → teminat 99→98.
Legacy: `pending_anchor`, para anchor'da. Öldür: HTTP yok, bakiyeler önbellekten okunuyor.

### Bugün düzeltilenler
- SEP-10 token ömrü 15 dk → 12 saat; 401'de arayüz "cüzdanı yeniden bağla" diyor.
- Statik dosyalara `Cache-Control: no-store` — sahnede eski `app.js` riski kapandı.
- Anchor ölüyken varlık/adres son bilinen değerden; bakiye ve emanetler Horizon'dan okunmaya
  devam ediyor.
- Şerit başına hata gösterimi; `[poll …]` konsol teşhisi.

### Canlı deploy altyapısı
- **`src/supervisor.js`**: anchor ve cüzdan ayrı child process. Öldür = gerçek ölüm,
  yeniden başlatılmaz; **Dirilt** = IPC ile yeni fork. Cüzdan çökerse kendiliğinden döner.
  Sandbox'ta doğrulandı: kill → `alive:false, fromCache:true` → revive → yeni pid.
- **Musluk**: `/api/faucet/xlm|trustline|fund`. Sıfır bir hesap için uçtan uca PASS:
  friendbot → trustline (imza) → 100 RIP → 10 dk oran sınırı. `anchor:setup` artık
  `ISSUER_SECRET` yazıyor.
- **WASM artefaktı** `contracts/ripcord-bond/artifacts/` — Rust kurmadan setup çalışır;
  CI artefaktın derlemeyle birebir olduğunu doğrular.
- `Dockerfile`, `fly.toml`, `.dockerignore`, `docs/08-DEPLOY.md`.
- `.github/workflows/ci.yml` (npm test + cargo test + wasm karşılaştırma), `.env.example`,
  `CONTRIBUTING.md`.

### Not
`.env` bugün yeniden üretildi (yeni anchor `GAKEZF…`, sözleşme `CCW5CS…`, musluk açık).
Demo hesabı import etmeye gerek kalmadı: ana Freighter hesabıyla bağlanıp üst karttaki
üç adımı izleyin.
