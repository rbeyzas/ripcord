# Stellar'ın 2026 gündemi ve Ripcord

Bu doküman iki iş görür: jüriye ve SDF ekibine ekosistemi **yakından** takip ettiğimizi
gösterir, ve her tasarım kararımızı Stellar'ın kendi hareketlerine bağlar. Her satır
15–16 Eylül 2026'da birincil kaynaktan doğrulandı; doğrulanamayanlar işaretli.

---

## SDF'nin ilan ettiği öncelikler

2025 yıl sonu değerlendirmesinde (13 Şubat 2026) 2026 için üç öncelik:
*asset adoption ve cross-border kullanımı hızlandırmak · kurumsal adopsiyon ·
çekirdek ağ yetenekleri.*

| SDF hamlesi | Ripcord'a etkisi |
|---|---|
| **Assets and Liquidity** hesabı (3,41 milyar XLM) — kapsamı açıkça anchor'lar ve on/off ramp'ler | Ripcord anchor rayının güvenilirlik katmanı. Fonlanan alanın tam ortası. |
| **Market Development** ekibi, LATAM/Brezilya/Avrupa/Afrika/MENA/APAC bölge sorumluları; "Distribution is the next battlefield" | Bölge sorumlusunun bir anchor'ı cüzdanlara önerirken ihtiyacı: "teslim etmezse ne olur?" Ripcord'la cevabı var. |
| RWA $4B (+%360 YTD), kurumsal adopsiyon önceliği | Kurumsal kullanıcı, custody'si belirsiz bir çekim rayını kullanmaz. Emanet + teminat + imzalı beyan tam olarak kurumsal dil. |
| **anchor-tests.stellar.org Ağustos 2026'da kapatıldı** | Anchor uyumluluğunu doğrulayan resmî servis yok. `anchor:check` ve `ui:check` bir SEP uyumluluk testinin nasıl görüneceğinin örneği. |

## Protokol katmanı — neyi neden kullandık

| Gelişme | Durum | Kararımız |
|---|---|---|
| **CAP-0023** claimable balances, mutlak zaman yüklemi | Protocol 14'ten beri | Katman 0'ın temeli. Sözleşmesiz, arşivlenmez, iptal edilemez. |
| **CAP-0033** sponsorlu rezerv | Canlı | Rezerv oluşturana (kullanıcıya) döner; anchor'a maliyet sıfır. Testnet'te `num_sponsoring` ile doğrulandı. |
| **CAP-0062 / 0066** state archival (P23) | Canlı; mainnet `minPersistentTTL` ≈120 gün, testnet 7 gün | Katman 1'de her yazımda TTL uzatma; son tarih TTL'de değil değerde. Katman 0'ı **önce** yapmamızın sebebi: klasik giriş, TTL yok. |
| **CAP-0046-12** "TTL güvenlik sınırı değildir" | Normatif | `lib.rs` başlığında alıntı. |
| **Protocol 27 "Zipper"** — CAP-0071 auth delegation | 8 Temmuz 2026 mainnet | Kullanmadık; Katman 1'de `require_auth` klasik. Delegasyon, hakem yetkisinin devri için doğal bir sonraki adım. |
| **Protocol 28 "Adapter"** — CAP-83/85/86 | Oy **16 Eylül 2026 17:00 UTC** — bugün | Eski `SOROBAN_CREDENTIALS_ADDRESS` P28 ile düşüyor; SDK 23 ve JS SDK 17 kullandığımız için etkilenmiyoruz. Testnet zaten P28. |
| **CAP-0072** G-hesaplarına sözleşme imzacısı | Taslak, protokol atanmadı | Geldiğinde kullanıcı geri alma işlemini bir politika imzacısına devredebilir ("T geçince otomatik geri al"). Yol haritasında. |

## SEP katmanı

| SEP | Durum | Ripcord ile ilişkisi |
|---|---|---|
| **SEP-24 / SEP-6** | Active | Genişlettiğimiz spec. Claimable balance yalnızca **mevduat** tarafında, yüklemler tanımsız — çekim tarafı boş. Taslağımız bunu dolduruyor. |
| **SEP-53** Sign and Verify Messages | **Final, Haziran 2026** | Katman 2. SDK 17 `signMessage/verifyMessage`. Bu SEP'i teslim beyanı için kullanan başka bir uygulama bulamadık. |
| **SEP-45** Web Auth for Contract Accounts | Taslak, Aralık 2025 | Kullanmadık: yalnızca C-hesapları için, demo cüzdanı G-hesabı. Akıllı cüzdan kullanıcıları için Ripcord'un bir sonraki adımı: `escrow_claimant` bir C-adresi olduğunda claimable balance alacaklısı G olmak zorunda — **bu, taslağımızın açık bir sorusu** ve Katman 1 (Soroban) o durumda tek yol. |
| **SEP-59** External Account API (`rail`: SEPA/SPEI/PIX) | Taslak, Mayıs 2026 | `max_delivery_seconds` ray bazında değişmeli; SEP-59'un `rail` alanıyla birleştirmek doğal. Taslağa not. |
| **SEP-38** Anchor RFQ | 5 yıldır taslak | Süre ilanını quote'a bağlamak (fiyat + süre birlikte) sonraki sürüm. |
| **SEP-31** kurumlar arası | Active, ince adopsiyon | Aynı emanet deseni sending→receiving anchor arasında da uygulanabilir. |

## SDK katmanı — SDF'nin kendi teşhisi

JS SDK **"Money Movement Epic"** (issue #1624, 10 Ağustos 2026), SDF bakımcılarının sözleriyle:
*"SDK ham operasyonları veriyor, doğruluk kurallarını entegratöre bırakıyor; her ödeme
ekibi aynı parçaları yeniden yazıyor ve hatanın bedelini production'da ödüyor."*

| Epic'teki tema | Ripcord'da karşılığı |
|---|---|
| "Kesin ödeme sonucu yok" — `pollTransaction` üç durumu tek `NOT_FOUND` ile karıştırıyor (#1615) | Emanetin sonucu **zincirden** okunur: var / anchor aldı (T'den önce yok) / kullanıcı aldı (T'den sonra yok). Anchor'a sormadan kesin sonuç. `watchRipcord` bu kuralla çalışıyor. |
| Sıra numarası → mükerrer ödeme (#1599) | `balanceIdFor` işlem sırasına bağlı; aynı emanet iki kez kurulamaz, kurulursa farklı id'dir ve anchor eşlemez. |
| Rezerv matematiği SDK'da yok (#1601) | 2 alacaklı = 1 XLM, sponsor kullanıcı, `num_sponsoring` ile ölçüldü; SEP taslağında yazıyor. |
| Ücret/fee-bump manuel | Kapsam dışı; OpenZeppelin Relayer (Launchtube'un halefi) ile birleşebilir. |

## Ekosistem araçları

| Araç | Durum | Kararımız |
|---|---|---|
| **Stellar Wallets Kit v2** | Eligible Integration Partner | Tek imza yolu. Statik API (`StellarWalletsKit.init/authModal/signTransaction`). |
| **OpenZeppelin Relayer + Channels** | Launchtube'un resmî halefi | Kullanmadık; ücret sponsorluğu bu protokolün sorunu değil. |
| **Anchor Platform** | SDF referans anchor | Demo anchor'ımız AP değil — kasten, çünkü sahnede öldürülebilir olmalı. Ripcord'un AP'ye eklenmesi, benimseme yolunun en kısa hâli: `/info` alanı + gözcü. |
| **x402 / MPP** | SDF x402 Foundation'da yönetim kurulunda | Kapsam dışı; ajan ödemeleri farklı problem. |
| **Stellar Private Payments** | Dev preview, 24 Ağustos 2026 | Kapsam dışı; gizli emanet ilginç ama dev preview üstüne 4 günde inşa edilmez. |

## SCF v7 — nereye başvuracağız

- **Track:** Integration (mevcut primitifler üstüne) ya da RFP (SDF'nin kapattığı
  uyumluluk testinin yerine geçen araç). Panel değerlendirmesi.
- **Build Award** tavan $150K, dilimler 10/20/30/40; son %40 "kanıtlanmış UX hazırlığı" —
  canlı cüzdan + anchor çifti demek.
- **#46 son tarih 8 Kasım 2026.** Round #44: 46 ödül, $4,56M — tarihin en büyüğü.
- **Meridian 2026: 28–29 Ekim, Lizbon.** SEP taslağını orada tartışmak için doğru yer.

## Kasten kullanmadıklarımız

Bunları yazmak, "her şeyi ekleyelim" refleksinden daha güçlü bir sinyal:
- **Passkey / SEP-45** — demo kullanıcısı G-hesabı; C-hesabı alacaklı olamaz, ayrı tasarım.
- **x402** — problem farklı.
- **Private Payments** — dev preview.
- **DeFi partnerleri** (Soroswap, Blend, DeFindex) — çekim emanetinde getiri kazandırmak
  mümkün ama kullanıcının parasını riske sokar; protokolün amacı riski **azaltmak**.

## Açık sorular — SDF'ye soracaklarımız

1. Claimable balance alacaklısı C-adresi olamıyor. Akıllı cüzdanlar için önerilen yol
   Katman 1 mi, yoksa CAP düzeyinde bir genişleme mi?
2. `refunded` + `escrow_outcome` yeterli mi, yoksa yeni bir durum (`reclaimed`) mı?
3. `max_delivery_seconds` SEP-59'un `rail` alanına mı bağlanmalı?
4. anchor-tests.stellar.org'un yerini alacak bir plan var mı; `anchor:check` benzeri
   bir uyumluluk paketi RFP konusu olur mu?
