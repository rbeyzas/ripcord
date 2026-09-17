# Sunum slaytları ve video metni

Resmî şablonun kopyasına bu içerik yerleştirilir; yapı korunur, slayt eklenebilir.
Her slaytta **tek fikir**. Rakamların hepsi `reports/` ya da `docs/00-PROTOKOL.md` §3'ten.

---

## Slaytlar

**1 · Kapak**
Ripcord — Anchor arıza protokolü
*"Anchor çökerse paranız ne olur?"*
Rise In × Stellar Pro Hackathon 2026 · Scale Track

**2 · Soru**
Büyük harfle tek cümle: **Anchor bugün kapanırsa paranız nerede?**
Alt: *Spec'e göre: anchor'da. Sonsuza kadar.*

**3 · Spec'in kendi metni**
SEP-24 durum listesi, 16 değer, aynen.
Vurgu: `refunded` — kullanıcı tetikleyemez · `expired` — kullanıcı ödemezse
Alt: *Anchor'ı bağlayan süre yok. İptal ucu yok. "dispute" kelimesi dört SEP'te sıfır kez.*

**4 · Canlı kanıt** (ekran görüntüsü `npm run evidence`)
Sol: `status="live"` · "denetlenmiş, ABD merkezli escrow" · deposit/withdraw enabled
Sağ: 1.929.632 USD dolaşımda · 38.350 trustline · $0,31 · haftalık hacim 8 dolar
Alt, küçük: *Zarar iddiası değil. Anchor'ın beyanının hizmet durumu hakkında hiçbir şey
söylemediğinin ölçümü.*

**5 · Fikir**
```
BUGÜN     payment(anchor, 100 USDC)        → custody anchor'da. Anında. Kalıcı.
RIPCORD   claimableBalance(100 USDC, [
            anchor : before(T)
            user   : not(before(T)) ])
```
Alt: *İki yüklem tam tümleyen. İptal operasyonu yok. Uygulayan: stellar-core.*

**6 · Teslim süresi bir üründür**
`GET /info → escrow.max_delivery_seconds`
*Görünmez bir risk → ilan edilen, uygulanan, rekabet edilen bir söz.*
*"48 saatte ödemezsem paranız size döner."*

**7 · Üç katman** (tablo)
| | Mekanizma | Garanti |
|---|---|---|
| 0 | Claimable balance — sözleşmesiz | Anchor hiçbir şey yapmazsa T'den sonra kullanıcı alır |
| 1 | Soroban teminat + itiraz + ilan edilmiş hakem | "Ödedim" deyip ödemeyen ceza öder; ödeme gücü zincirde |
| 2 | SEP-53 imzalı beyan | "Dedi/demedi" inkâr edilemez |
Alt: *Katman 0 bugün mainnet'te çalışır; bir anchor bir öğleden sonrada benimser.*

**8 · Demo** — canlı; slayt sadece başlık: *Anchor'ı öldürüyoruz.*

**9 · Ne gerçek, ne simüle** (README'deki tablo)
Alt: *Reddeden bizim kodumuz değil: `op_cannot_claim`, `TooLate`, `InsufficientBond`.*

**10 · Dürüst sınırlar**
- Hiçbir sözleşme fiat'ın bankaya ulaştığını doğrulayamaz
- Garanti anchor'ın izni olmadan; ihraççının değil (USDC `auth_revocable: true`)
- Mevduat yönü kapsam dışı — tek kaldıraç teminat, o da tam karşılamaz

**11 · Stellar'ın 2026 gündemiyle** (`05-STELLAR-2026-HIZALAMA.md`'den 4 satır)
- SDF önceliği: cross-border + asset adoption; Assets & Liquidity 3,41B XLM; "Distribution is the next battlefield"
- SDK "Money Movement Epic" (Ağustos): *"kesin ödeme sonucu yok"* — Ripcord'un sonucu zincirden okunur
- SEP-53 Final (Haziran) — ilk kez teslim beyanı için
- anchor-tests.stellar.org kapandı (Ağustos) — `anchor:check` bir uyumluluk testinin örneği

**12 · Ekosistem ve teknik**
Stellar Wallets Kit v2 (her imza) · JS SDK 17 · Soroban SDK 23 · testnet sözleşme adresi
33 birim + 9 sözleşme testi · 6 testnet kanıt script'i · CI

**13 · Yol haritası**
1. SEP PR → `stellar/stellar-protocol` (Meridian, 28–29 Ekim)
2. İlk cüzdan + ilk anchor pilotu
3. `bonded_contract` modu spec'e; ödeme gücü panosu (kamuya açık)
4. SCF #46 (8 Kasım) — Integration track, dilimler 10/20/30/40

**14 · Kim satın alır** (tek slayt, dört satır — `docs/07`'den önceki cevap)
Cüzdanlar (rozet) → Anchor'lar (itibar satın alınabilir) → RWA ihraççıları (itfa) → SDF

**15 · Ekip + soru**
*"Hangi anchor'la pilot yapalım?"*

---

## Video metni — 2 dk 40 sn, ekran kaydı

Kayıt: 1080p, sistem sesi kapalı, mikrofon. Her satır bir ekran hareketiyle eşleşir.
Sıkıştırılmış süreler: `ANCHOR_DELIVERY_SECONDS=75`. Kesme yok, tek çekim; iki prova sonra kayıt.

**[0:00] Ekran: arayüz, üç boş şerit.**
> Stellar'da bir anchor'dan para çekiyorsunuz. Anchor bugün kapanırsa paranız nerede?
> Spec'e göre: anchor'da. Alttaki liste SEP-24'ün on altı durumu. "Paramı geri ver" yok.

**[0:15] Terminal: `npm run evidence` akar.**
> Bu varsayım değil. Mainnet, şu an: durum sayfası "her şey yolunda", bir milyon dokuz yüz
> bin dolaşımda, otuz sekiz bin hesap, fiyat otuz bir sent. Anchor'ın beyanı hizmet
> durumu hakkında hiçbir şey söylemiyor. Ripcord bu yüzden beyana değil zincire güvenir.

**[0:40] Sol Çek → Freighter → tamamlandı.**
> Sol: bugünkü SEP-24. Düz ödeme, anchor'ın hesabına. Sağlıklı anchor teslim etti;
> SEP-53 ile imzalı beyanı da doğrulandı — inkâr edemez.

**[0:55] Orta Çek → Freighter → tamamlandı.**
> Orta: aynı çekim, Ripcord. İki alacaklılı emanet: anchor T'den önce, ben T'den sonra.
> Bunu bizim kodumuz değil stellar-core uyguluyor. Sağlıklı anchor'da fark yok.

**[1:10] Dondur. Sol Çek, orta Çek.**
> Şimdi anchor zombi: cevap veriyor, teslim etmiyor. Solda param anchor'da, `pending_anchor`,
> yapabileceğim eylem yok. Ortada emanette, geri sayım.

**[1:30] Sağ şerit: Çek → claim → itiraz et → demo hakemi.**
> Geri sayım sürerken üçüncü katman: anchor "ödedim" derse? Teminat yatırmış, hakem ilan
> etmiş. Talep parayı vermiyor, pencere açıyor. İtiraz ediyorum; hakem beni haklı buluyor;
> tutar artı yüzde on ceza teminattan. Kart: doksan dokuzdan doksan sekize.

**[2:05] Orta: Paramı geri al → Freighter.**
> Süre doldu. Anchor'a sormadım, yöneticiye sormadım, hakeme sormadım. Para döndü.
> Soldaki hâlâ anchor'da.

**[2:20] Öldür.**
> Artık HTTP de yok. Emanet anchor'dan bağımsız; Horizon'dan okuyoruz.

**[2:30] Kapanış, arayüz durur.**
> Teslim süresi artık ilan edilen ve uygulanan bir söz. Sözleşmesiz katman bugün mainnet'te
> çalışır. SEP taslağı hazır. Ripcord.

---

## Prova kontrol listesi

- [ ] `.env` taze, anchor teminatı 100, açık yükümlülük 0
- [ ] Freighter: ana hesap, Test Net, trustline açık, ≥ 60 RIP
- [ ] İki terminal görünür; anchor logu akıyor (jüri logu sever)
- [ ] `evidence` bir kez önceden koşuldu (ağ yedeği)
- [ ] Explorer sekmesi açık
- [ ] Süre: Dondur → iki Çek → sağ şerit anlatımı → geri sayım biterken "Paramı geri al"
- [ ] Söylenmeyecekler: "kullanıcılar para kaybetti", "trustless", "sigorta"
