# Demo senaryosu — sahne ve Lounge Day

Süre hedefi: **6 dakika**. Her beat'in yedeği var. Prova en az 5 kez.

## Kurulum (sahneye çıkmadan 15 dk önce)

```
npm run anchor      # terminal 1 — görünür kalsın, log akacak
npm run dev         # terminal 2
```
- Tarayıcı `http://localhost:4173`, Freighter testnet'te, demo hesabı bağlı, SEP-10 tamam.
- Cüzdanda ≥ 50 USDC (ya da RIP). **USDC tercih**: parayı `tr-mock-anchor` depozitosuyla
  almış olun → "gerçek anchor'dan giren para". BillRail akışı.
- `ANCHOR_DELIVERY_SECONDS=90`. Daha kısa olursa sahnede nefes yok; daha uzun olursa sıkar.
- İkinci sekmede `npm run evidence` çıktısı hazır (canlı çalıştırılacak ama yedek dursun).
- Explorer sekmesi açık.

## Beat'ler

**0:00 — Soru.** *"Stellar'da bir anchor'dan para çekiyorsunuz. Anchor bugün kapanırsa
paranız nerede?"* Bekle. Cevap: *"Spec'e göre: anchor'da. Sonsuza kadar."*

**0:30 — Spec.** Alttaki kartı göster: 16 durum. *"'Paramı geri ver' diye bir durum yok.
`refunded` var, ama onu kullanıcı tetikleyemez. Anchor'ı bağlayan tek bir süre yok.
Kullanıcı için modellenmiş tek sonuç: beklemek."*

**1:00 — Canlı kanıt.** Terminalde `npm run evidence`. Çıktı akarken:
*"Bu mainnet, şu an. status='live', 'denetlenmiş escrow'. Defter: 1,9 milyon dolaşımda,
38 bin trustline, fiyat 31 sent, haftalık hacim 8 dolar."* Sonra **dur**:
*"Bu bir dolandırıcılık iddiası değil. Anchor'ın kendi beyanının hizmet durumu hakkında
hiçbir şey söylemediğinin ölçümü. Ripcord bu yüzden beyana değil, zincire güvenir."*

**2:00 — İkiz çekim.** Sol şeritte Çek → Freighter imzala. Sağ şeritte Çek → Freighter
imzala. *"Aynı 10 USDC, aynı anchor. Solda düz ödeme — bugünkü SEP-24. Sağda iki
alacaklılı emanet: anchor T'den önce alabilir, ben T'den sonra. Arada boşluk yok,
örtüşme yok, iptal operasyonu yok. Bunu bizim kodumuz değil, stellar-core uyguluyor."*
Sağda geri sayım başlar. Anchor sağdakini birkaç saniyede alır → **"teslim edildi +
SEP-53 imzalı beyan doğrulandı"**. *"Sağlıklı anchor'da fark yok. Şimdi anchor'ı bozalım."*

**3:00 — Dondur.** Üstten **Dondur**. Rozet ZOMBİ. *"HTTP açık, zinciri görüyor, teslim
etmiyor. AnchorUSD'nin bugünkü hâli."* İki şeritte tekrar Çek. Sol: `pending_anchor`,
anchor bakiyesi arttı. *"Param onda. Spec'te yapabileceğim eylem: yok."*
Sağ: emanette, geri sayım.

**4:00 — Öldür.** Üstten **Öldür**. Terminal 1 kapanır. Rozet ÖLÜ. *"Artık HTTP de yok."*
Sol şerit: *"— anchor cevap vermiyor —"*. Sağ şerit: geri sayım sürüyor. *"Emanetin
zincirdeki hâli anchor'dan bağımsız; Horizon'dan okuyoruz."*

**4:45 — Ripcord.** T geçer. **"Paramı geri al"** belirir. Bas. Freighter imzala.
*"Anchor'a sormadım. Yöneticiye sormadım. Hakeme sormadım."* Bakiye döner. Explorer'ı aç.

**5:15 — Katman 1, 20 saniye.** *"Anchor 'ödedim' deyip ödemezse? Teminat + itiraz
penceresi + baştan ilan edilmiş hakem. Testnet'te: teminatı aşan yükümlülük açılamıyor,
haklı kullanıcı teminattan ceza alıyor."* Sözleşme adresini göster.

**5:45 — Kapanış.** *"Teslim süresi artık görünmez bir risk değil: ilan edilen, uygulanan,
rekabet edilen bir söz. '48 saatte ödemezsem paranız size döner.' SEP taslağı hazır,
`stellar-protocol`'e açacağız."*

## Yedekler

| Sorun | Yedek |
|---|---|
| Freighter imzalamıyor | `npm run ui:check` terminalde — aynı akış, demo anahtarıyla. Ekrana yansıt. |
| Wi-Fi yok | `reports/*.json` çıktıları + kayıtlı ekran videosu. |
| Anchor öldürülünce yeniden gerekiyor | `npm run anchor` — 2 sn. Bellek sıfırlanır, normal. |
| `evidence` erişemiyor | `reports/evidence-stablecoin.anchorusd.com.json` (15 Eylül). |
| T çok uzun | Anchor'ı `ANCHOR_DELIVERY_SECONDS=75` ile açın (altı 60). |

## Söylenmeyecekler

- "AnchorUSD kullanıcıları para kaybetti" — **belgelenmiş değil.** "Terk", "hırsızlık" değil.
- "Trustless" — değil. "Anchor'ın izni olmadan" ve "ihraççı hariç".
- "Fiat doğrulanıyor" — doğrulanmıyor; beyan imzalanıyor.

## Lounge Day — SDF ve yatırımcıya 90 saniye

Problem cümlesi → canlı kanıt → "sözleşmesiz, bugün benimsenebilir" → SEP taslağı →
SCF #46 planı → soru: *"Hangi anchor'la pilot yapalım?"* Sorunun kendisi traction sinyali.
