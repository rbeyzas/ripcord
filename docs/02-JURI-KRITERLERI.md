# Hackathon şartları ve jüri kriterleri — Ripcord'un durumu

Kaynak: Pro Hackathon 2026 Handbook ve resmî 6 kriter (BillRail'de derlenmişti,
`billrail/docs/11` ve `13`). ✅ karşılandı · 🟡 kısmi · ❌ yok · 👤 sizin işiniz

**Teslim: 20 Eylül 12:00 · Scale Track kutusu işaretlenecek.**

---

## Üç zorunlu şart

| # | Şart | Durum |
|---|---|---|
| 1 | **Integration:** Eligible Integration Partners'tan bir protokol, yük taşıyan | ✅ **Stellar Wallets Kit v2.** Yük taşıyor: emanet, SEP-10 challenge ve geri alma işlemlerinin üçü de cüzdanda imzalanır; kit olmadan akış başlamaz. |
| 2 | **Anchor / Local Payments:** gerçek fiat rayı — TL girip bakiye çıkarma **ya da tersi** | 🟡 Ripcord tam olarak **"tersi"**: bakiye → fiat çekimi. SEP-1/10/24 gerçek, Stellar tarafı gerçek testnet. Fiat bacağı sandbox (öyle etiketli). **Güçlendirme:** sahnedeki USDC'yi `tr-mock-anchor.fly.dev`'den gerçek SEP-6 depozito ile alın (BillRail akışı) → "gerçek anchor'dan giren para, Ripcord ile çıkıyor". 👤 |
| 3 | **Core Feature:** entegrasyon ürünün yaptığı işin parçası | ✅ Protokolün kendisi SEP-24 çekiminin çekirdeğini değiştiriyor. |

## Scale Track ek teslimatları

| Teslimat | Durum |
|---|---|
| Mermaid mimari diyagramı | ✅ `03-MIMARI.md` — sistem, sıra, iki durum makinesi |
| Hackathon sonrası SCF/InstAward yol haritası | ✅ `00-PROTOKOL.md` §9 + `04-SCF-TECHNICAL-WRITEUP.md` |
| SCF RFP formatında kısa teknik yazı | ✅ `04-SCF-TECHNICAL-WRITEUP.md` (İngilizce) |
| Soroban SDK ile yazılmış, testnet'e dağıtılmış sözleşme | ✅ `ripcord-bond` · `CCKGTC4IIHONXWXIZI33T5SYXAGPWUCEKCJBNY5YZRDTPGBSGYZUPVLV` |
| Skill dosyası atfı (yol vererek) | 🟡 README'ye eklenecek — aşağıda |

---

## 1. Anlamlı fikir ve gerçek dünya etkisi

| Kriter | Durum |
|---|---|
| Problem net ve spesifik mi? | ✅ SEP-24 çekiminde anchor'ı bağlayan süre yok, kullanıcının iptal yolu yok. Spec metninden alıntıyla. |
| Anlamlı kullanım mı? | ✅ Ödeme/on-off ramp — SDF'nin 2026 birinci önceliği "cross-border ve asset adoption". |
| Etkinin ölçeği? | ✅ **Ölçülü:** AnchorUSD'de 38.350 trustline, 1,93M USD dolaşımda, $0,31; Tempo 8.523 hesap. Zarar iddiası **yok** — terk, hırsızlık değil. |
| Pazar geçerliliği kanıtı? | ❌ 👤 **Bir anchor operatörüyle görüşme** (`max_delivery_seconds` sorusu) + salonda 3 cüzdan geliştiricisine "bunu entegre eder miydin?" Cevap ne olursa olsun sunumda kullanılır. |

## 2. Teknik uygulama

| Kriter | Durum |
|---|---|
| Testnet'te dağıtılmış ve **iddia edilen özellikler gerçekten çalışıyor** | ✅ Beş ayrı kanıt script'i, hepsi PASS, hepsi `reports/`'ta. Reddeden bizim kodumuz değil, stellar-core (`op_cannot_claim`) ve sözleşme (`TooLate`). |
| Front-end kararlı, uçtan uca | 🟡 API sırası headless PASS; **Freighter ile tarayıcı testi** 👤 |
| **Soroban depolama tipleri ve auth doğru mu?** | ✅ Yükümlülük/teminat `persistent` + TTL uzatma; yapılandırma `instance`; `temporary` kasten yok. Auth: `user.require_auth` open/dispute/reclaim; `anchor.require_auth` bond/unbond/claim; `arbiter.require_auth` resolve; `finalize` herkese açık (gerekçeli). Son tarih TTL'de değil değerde (CAP-46-12). |
| Tasarım probleme uygun ve dokümante | ✅ `00-PROTOKOL.md`, `03-MIMARI.md` tasarım kararları tablosu, SEP taslağı Design Rationale |
| Mermaid diyagramı sistemi doğru yansıtıyor mu? | ✅ Her kutu çalışan kod. |
| Passkey / smart wallet | Kullanılmadı; zorunlu değil. SEP-45 ile ilişki `05-STELLAR-2026-HIZALAMA.md`'de. |

## 3. Ekosistem uyumu

| Kriter | Durum |
|---|---|
| Integration Partner entegre ve yük taşıyor | ✅ Wallets Kit — yukarıda |
| **Gerçek anchor / yerel ödeme rayı (SEP akışlarıyla)** ⭐ ağır madde | 🟡 SEP-1/10/24 gerçek; fiat sandbox, etiketli. 👤 tr-mock-anchor ile depozito ekleyin. |
| SDK/CLI/skills idiomatik | ✅ JS SDK 17 (`Claimant`, `WebAuth`, `signMessage`, `rpc.assembleTransaction`), Soroban SDK 23, stellar CLI gerekmeden JS ile deploy. |
| Skill dosyaları yol vererek atfedilmiş | 🟡 README'ye: `CheesecakeLabs/stellar-anchor-skill/blob/main/SKILL.md` (SEP-1/10/24 akışları, BillRail'den devam). Başka skill kullanılmadı; bunu da açıkça yazacağız. |

## 4. Kullanıcı deneyimi

| Kriter | Durum |
|---|---|
| Kripto bilmeyen için sezgisel | 🟡 İkiz ekran, Türkçe, sade; cüzdan adımı hâlâ cüzdan istiyor. |
| Özellikler **UI'da görünür**, README'de iddia değil | ✅ İlan edilen süre, doğrulanmış yüklemler, geri sayım, "Paramı geri al", SEP-53 beyanı, anchor durum rozeti, canlı bakiyeler. |
| Düzenli, uçtan uca takip edilebilir | 🟡 README jüri girişi olarak son kez gözden geçirilecek. |

## 5. Traction ve süreklilik

| Kriter | Durum |
|---|---|
| **Etkinlikte** ekip dışı gerçek kullanıcı | ❌ 👤 Salonda demo ettirin — anchor'ı **onlar** öldürsün. Unutulmaz. |
| Hackathon sonrası yol haritası | ✅ SEP taslağını `stellar/stellar-protocol`'e PR olarak açmak; SCF Integration/RFP track; ilk cüzdan + ilk anchor pilotu. |
| SCF / InstAward niyeti açık mı? | ✅ Yazılı. Sunumda söylenecek. |
| Ekip devam edebilir mi? | 👤 Sunumda. |

## 6. Sunum ve dokümantasyon

| Kriter | Durum |
|---|---|
| Net anlatım | ✅ README + `00-PROTOKOL.md` tek cümle + demo senaryosu |
| Ön bilgisiz jüri için takip edilebilir | ✅ Mermaid sıra diyagramı "aynı çekim, iki yol" |
| **Nasıl test edilir** | ✅ README "Kanıt" bölümü: altı komut |
| SCF formatında teknik yazı | ✅ `04-SCF-TECHNICAL-WRITEUP.md` |

---

## Sizin işleriniz — öncelik sırasıyla

1. 👤 **Freighter ile tarayıcı testi** — tek doğrulanmamış parça (`01-DURUM.md` sonundaki komutlar)
2. 👤 **GitHub public + LICENSE**
3. 👤 **tr-mock-anchor'dan USDC depozito** → sahnedeki paranın kaynağı gerçek anchor olsun (Şart 2'yi güçlendirir)
4. 👤 **Anchor operatörü görüşmesi** — `max_delivery_seconds` (görev #23)
5. 👤 Sunum şablonunun kopyası; portalda Scale Track
6. 👤 Etkinlikte: Workshop #3 Anchor Integration, office hours'ta mentor'a SEP taslağını göster

## Üç davranış kuralı (BillRail'den devam)

**Mock'u gizleme, etiketle.** Fiat simüle; TOML'da, arayüzde, README'de yazıyor.
**UI'da göster, README'de iddia etme.** Her katman ekranda.
**Hırsızlık değil, terk.** AnchorUSD hakkında zarar iddiası yok; ölçülen gerçekler var.
