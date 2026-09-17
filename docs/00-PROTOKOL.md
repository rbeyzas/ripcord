# Ripcord — Anchor arıza protokolü

**Anchor çökerse kullanıcının parası ne olur?**
Bugünkü cevap: hiçbir şey olmaz. Kullanıcı bekler. Sonsuza kadar.

*Tarih: 15 Eylül 2026 · Hackathon: Rise In × Stellar Pro, 19–20 Eylül, Scale Track*
*Bu dokümandaki her teknik iddia stellar-core kaynağından, CAP/SEP metinlerinden veya
canlı ağ sorgusundan doğrulanmıştır. Doğrulanamayanlar açıkça işaretlenmiştir.*

---

## 1. Tek cümle

SEP-24/SEP-6 para çekme akışında kullanıcı, token'ı anchor'ın hesabına **düz bir ödeme**
olarak gönderir; o an itibarıyla hiçbir dayanağı kalmaz. Ripcord bu ödemeyi, anchor'ın
**yalnızca işini yaparak** alabileceği, yapmazsa kullanıcının **kimseye sormadan geri
alabileceği** bir emanete çevirir.

---

## 2. Boşluk spec'in kendi metninde

SEP-24 §"Withdraw": kullanıcı `withdraw_anchor_account` adresine memo'lu bir ödeme yapar.
O ödeme kesinleştiği anda para anchor'ın custody'sindedir.

Spec'teki durum listesi şu 16 değeri içeriyor:

```
incomplete, pending_user_transfer_start, pending_user_transfer_complete,
pending_external, pending_anchor, on_hold, pending_stellar, pending_trust,
pending_user, completed, refunded, expired, no_market, too_small,
too_large, error
```

Bu listede iki tane süre kavramı var ve **ikisi de kullanıcıyı bağlıyor**:

- **`expired`** — *"fonlar anchor'a hiç ulaşmadı ve işlem kullanıcı tarafından terk edilmiş
  sayılıyor… **anchor'lar bir işlemin ne zaman süresi dolmuş sayılacağını belirlemekten
  sorumludur**."* Yani: kullanıcı ödemezse zaman aşımı. Hakemi de anchor.
- **`user_action_required_by`** — yine kullanıcıya konan, anchor'ın belirlediği süre.

**Spec'te şunlar yok:**
- Anchor'ın teslim etmesi gereken bir süre
- Kullanıcının iptal edebileceği bir uç, durum ya da metot (`PATCH`/`DELETE` yok)
- Kullanıcının parasını gönderdikten sonra herhangi bir başvuru yolu

`refunded` durumu var — ama spec'te onu **tetikleyebilecek hiçbir kullanıcı eylemi yok**.
SEP-31 aynısını açıkça yazıyor: *"**Eğer Alıcı Anchor fonları iade etmeye karar verirse**…"*

Kullanıcının parası gittikten sonra spec'in bütün kelime dağarcığı anchor'ın
kontrolünde: `pending_anchor`, `on_hold`, `pending_external`, `error`.
Kullanıcı için modellenmiş tek sonuç: **beklemek**.

> `dispute` kelimesi SEP-6, SEP-24, SEP-31 ve SEP-38'de **sıfır kez** geçiyor.
> Stellar'da escrow SEP'i yok. Bu boşluk taslak hâlinde bile değil.

---

## 3. Bu varsayımsal değil — canlı kanıt

**AnchorUSD.** Bugün, 15 Eylül 2026 itibarıyla:

| | |
|---|---|
| `status.anchorusd.com` | **"All systems operational"** — boş olay geçmişi |
| `api.anchorusd.com/transfer/info` | `"deposit":{"USD":{"enabled":true}}` — hâlâ mevduat kabul ettiğini söylüyor |
| `stellar.toml` | `status="live"`, *"denetlenmiş, ABD merkezli bir escrow hesabında tutulur"* |
| Zincirdeki gerçek | **1,93 milyon USD** dolaşımda, **38.350 trustline**, fiyat **$0,314** |
| 7 günlük SDEX hacmi | **8,03 USD** |

Yani: iddia katmanı hâlâ "her şey yolunda" diyor, defter başka bir şey söylüyor,
38 binden fazla hesap elindeki token'ı paraya çeviremiyor.

**Tempo (EURT):** 1,28 milyon dolaşımda, 8.523 fonlu hesap, $0,078. 28 Mart 2024'te
bir pivot duyurusu var, EURT'nin akıbeti hakkında **tek kelime yok**.

**apay.io:** ihraççı kendi `home_domain`'ini **`dead.apay.io`** olarak değiştirmiş.
10.728 hesapta 1.211,70 ETH, paritenin ~%1,4'ü.

**SDF hiçbiri için hiçbir şey yayınlamadı.** Ne blog, ne kapanış duyurusu, ne
kullanıcı yönlendirmesi, ne post-mortem. Anchor'lar `anchors.stellar.org`'dan
sessizce, tarihsiz biçimde kayboldu.

### Dürüstlük sınırı — sunumda buna uyacağız

Savunulabilir tez **"hırsızlık" değil, "terk"**. Tek bir anchor (apay.io) için
"kullanıcı fonları erişilemez hâle geldi" iddiası var, o da bir operatör Telegram
mesajının ikinci elden aktarımı. **Hiçbiri için belgelenmiş bir kullanıcı zararı yok.**
Bunu abartmak, bir jüri üyesinin çürütmesi en kolay şey olur.

Ayrıca ters yönde de dikkat: **Settle Network'ün domaini ölü ama anchor'ı sağlam** —
`pubnet-sep.latamex.com` adresinden hizmet veriyor. "Domain ölü" hiçbir şey kanıtlamaz.
Bu yüzden Ripcord asla "şu anchor dolandırıcı" demez; **"bu işlem teslim edilmedi"** der.
Fark, tek bir işlem hakkında konuşmakla bir kurum hakkında konuşmak arasındaki farktır.

---

## 4. Protokol

### Temel fikir

```
BUGÜN     payment(anchor_hesabı, 100 USDC, memo)
          └─> anchor'da custody. Anında. Kalıcı. Geri dönüşsüz.

RIPCORD   createClaimableBalance(100 USDC, [
             anchor : abs_before(T)        ← yalnızca T'den ÖNCE alabilir
             user   : not(abs_before(T))   ← yalnızca T'den SONRA alabilir
          ])
          └─> T geçtiğinde anchor kalıcı olarak kilitlenir, kullanıcı tek başına alır.
```

İki yüklem **tam tümleyen**: anchor'ınki `T > closeTime`, kullanıcınınki `closeTime >= T`.
Arada ne boşluk var ne örtüşme. Bu bir sözleşme kuralı değil, **protokol garantisi** —
stellar-core'un `ClaimClaimableBalanceOpFrame::validatePredicate` fonksiyonu uyguluyor.

Ve kritik olan şu: Stellar'da bir claimable balance'ı silen **tek** işlem
`ClaimClaimableBalanceOp`'tur. İptal operasyonu **yoktur**. Anchor T'den sonra
fikrini değiştiremez, geri alamaz, dondurmaz.

### Katman 0 — Yerel mod (sözleşme yok) ⭐ hackathon teslimi

Saf claimable balance. **Soroban yok, deploy yok, yönetişim yok.** Bugün mainnet'te
çalışır; herhangi bir anchor bunu bir öğleden sonrada benimseyebilir. Benimsenebilirliği
bu yapıyor.

Akış:
1. Kullanıcı SEP-24/6 çekim başlatır. Anchor `GET /info`'da **teslim süresini ilan eder** (aşağıya bakın).
2. Cüzdan, ödeme yerine `CreateClaimableBalance` gönderir. `balanceID` deterministik:
   `sha256(ENVELOPE_TYPE_OP_ID ‖ kaynak hesap ‖ seqNum ‖ opNum)` — **iki taraf da
   göndermeden önce hesaplayabilir**, böylece SEP işlem kaydına bağlanır.
3. Anchor fiat'ı öder, T'den önce `claim()` eder.
4. Anchor ölürse T geçer; kullanıcı `claim()` eder. **Kimsenin onayı gerekmez.**

**Teslim süresi bir ürün özelliğidir.** Anchor `GET /info`'da varlık ve yöntem bazında
ilan eder, kullanıcı **imzalamadan önce görür**. Böylece anchor güvenilirliği görünmez
bir riskten **ilan edilmiş, uygulanan, rekabet edilen bir söze** dönüşür:
*"48 saatte ödemezsem paranız size döner."* Ripcord'un asıl ürün tezi budur.

### Katman 1 — Teminatlı mod (Soroban)

Katman 0'ın açığı: anchor `claim()` edip fiat'ı hiç ödemeyebilir. Katman 1 bunu pahalı kılar.

- Anchor **teminat** yatırır.
- `claim()` parayı anında serbest bırakmaz; bir **itiraz penceresi** başlatır.
- Kullanıcı pencere içinde `dispute()` edebilir.
- İtiraz yoksa anchor alır. İtiraz varsa açılışta **iki tarafın önceden anlaştığı**
  hakeme gider. Hakem sonradan atanmaz — bu, güven modelini gizlemek yerine görünür kılar.
- Yanlış itirazı caydırmak için itiraz edenin de küçük bir teminatı yanar.

**Yan ürün, asıl değer:** çekimler emanete alındığında her anchor'ın **açık
yükümlülükleri zincirde sayılabilir hâle gelir**. "Bu anchor'ın 400 açık çekimi ve
2M$ borcu var, teminatı 50K$" — bugün Stellar'da hiç var olmayan bir **canlı ödeme
gücü sinyali**. AnchorUSD yıllar önce bağırırdı.

### Katman 2 — Beyanlı mod

`claim()` çağrısı, fiat ödemesine referans veren **SEP-53 ile imzalanmış bir beyan**
taşır. (SEP-53 "Sign and Verify Messages" Haziran 2026'da **Final** oldu ve bu iş için
kimse kullanmıyor.) Fiat'ın taşındığını kanıtlamaz — ama "dedi/demedi"yi
**inkâr edilemez imzalı bir belgeye** çevirir. Gerçek dünyadaki ihtilafta delildir.

---

## 5. Dürüst sınırlar — tehdit modeli

Bunları slaytta **biz söyleyeceğiz**, jüri sormadan önce. Bir protokolü oyuncaktan
ayıran şey budur.

**1. Hiçbir sözleşme paranın bankaya ulaştığını doğrulayamaz.** Böyle bir oracle yok.
Ripcord fiat ayağını güvensizleştirmez. Yaptığı şu: (a) zarar penceresini sınırlar,
(b) hiçbir şey olmadığında kullanıcıya tek taraflı çıkış verir, (c) yalanı pahalı ve
inkâr edilemez kılar, (d) anchor ödeme gücünü kamuya açar.

**2. Garanti "anchor'ın izni olmadan"dır, "hiç kimsenin izni olmadan" değil.**
İhraççı hâlâ iki şey yapabilir:
- **Clawback** — oluşturma anında trustline'da clawback açıksa, bakiye yüklemlerden
  bağımsız olarak yok edilebilir.
- **Yetki iptali** — `auth_revocable` açıksa ihraççı kullanıcının trustline yetkisini
  iptal ederek talebi kalıcı olarak engelleyebilir.

Canlı kontrol ettik: **USDC ihraççısında `auth_clawback_enabled: false` ama
`auth_revocable: true`.** Yani Circle bir talebi engelleyebilir. Bu tehdit modeline yazılır.

**3. Rezerv maliyeti gerçek — ve KULLANICIDA.** İki alacaklılı bir claimable balance
**2 × base reserve = 1,0 XLM** kilitler. Sponsor, oluşturan hesaptır: yani **kullanıcı**.
Rezerv talep anında sponsora döner (anchor alsa da kullanıcı alsa da kullanıcıya).
`numSponsoring != 0` olduğu sürece kullanıcı hesabını merge edemez — emanet kapanınca
serbest kalır. Anchor'a rezerv yükü **yoktur**; testnet'te `num_sponsoring` ile doğrulandı
(oluşturmada +2, talepte 0). *Önceki sürümde bu yük yanlışlıkla anchor'a yazılmıştı;
düzeltildi.* Kullanıcı için 1 XLM'lik geçici kilit, çekim başına kabul edilebilir bir
maliyettir ve anchor için "benimseme bedeli yok" argümanını güçlendirir.

**4. Talep anında trustline şart.** Kullanıcı `CLAIM_CLAIMABLE_BALANCE_NO_TRUST` ile
düşebilir. Pratikte trustline zaten vardır (o token'ı göndermek için gerekliydi), ama
cüzdan talep öncesi kontrol etmeli.

**5. `rel_before` kullanılmayacak.** Oluşturma anında mutlak zamana çevriliyor ve
hangi ledger'a düştüğüne bağlı. Emanet süresi **her zaman `abs_before`**.

**6. Süre seçimi ekonomik bir karar.** Çok kısa: anchor meşru banka mutabakatını
(T+2, hafta sonu, tatil) yetiştiremez ve dürüst anchor cezalandırılır. Çok uzun:
kullanıcı bekler. Bu yüzden süre protokolde sabit değil, **anchor tarafından ilan edilen
ve kullanıcıya imzadan önce gösterilen** bir parametredir.

**7. Katman 1 için: testnet'te `minPersistentTTL` 7 gün, mainnet'te 120 gün.**
Testnet'te ayarlanan bir emanet üretimde yanlış davranır. Katman 0'ın TTL sorunu
hiç yoktur — claimable balance klasik bir ledger kaydıdır, **arşivlemeye tabi değildir**.
Katman 0'ı önce yapmamızın bir sebebi daha.

---

## 6. Anchor bunu neden kabul etsin?

Jüri bunu **mutlaka** soracak. Cevap dört katmanlı:

1. **Rekabet avantajı.** "Sigortalı çekim" ilan edebilen anchor, edemeyenden ayrışır.
   Süre ilanı doğrudan pazarlama malzemesi.
2. **Cüzdanlar zorlar.** Bir cüzdan, Ripcord destekleyen anchor'ları öne çıkarabilir
   ya da desteklemeyenlerde uyarı gösterebilir. Dağıtım gücü cüzdanlarda.
3. **Düzenleyici lehine.** Müşteri fonunun belirli bir sürede ya teslim edildiği ya
   iade edildiği, denetlenebilir biçimde. Bu bir uyum argümanıdır — SDF'nin 2026
   önceliklerinden biri kurumsal adopsiyon.
4. **Maliyeti neredeyse yok.** Anchor'a ek yükü 1 XLM rezerv ve zaten sahip olması
   gereken bir teslim disiplini. Kod tarafında `payment` yerine `claim` dinlemek.

---

## 7. Demo — sahnede anchor'ı öldürüyoruz

Ekran ikiye bölünür. Solda **bugünkü Stellar**, sağda **Ripcord**. Aynı çekim, aynı tutar.

1. İki tarafta da SEP-24 çekim başlatılır, gerçek anchor'a karşı, gerçek testnet USDC ile.
2. Sol: `payment` gider. Sağ: `createClaimableBalance` gider. İkisi de explorer'da açık.
3. **Anchor'ı kapatıyoruz.** Süreci durdururuz — sahnede, canlı.
4. Sol taraf: kullanıcının USDC'si anchor'ın hesabında. Cüzdan `pending_anchor` diyor.
   Ekrana SEP durum listesi gelir. *"Bu listede 'paramı geri ver' diye bir durum yok.
   Arayın. Yok."*
5. Sağ taraf: süre dolar (demoda 60 saniyeye sıkıştırılmış). Kullanıcı **"Paramı geri al"**a
   basar. Talep işlemi gider. **Para döner.** Anchor yok. Yönetici yok. Hakem yok.
6. Kapanış: **AnchorUSD'nin canlı durum sayfası** açılır — *"All systems operational"* —
   yanında token $0,314, 38.350 trustline, 7 günlük hacim 8,03 USD.
   *"Bu bir senaryo değil. Şu an, mainnet'te, böyle."*

Adım 4'teki sessizlik demonun kalbi. Adım 6 salonu bırakmaz.

---

## 8. Dört gün

Bugün 15 Eylül Salı akşamı. Teslim **20 Eylül 12:00**.

| Gün | Ben | Siz |
|---|---|---|
| **16 Çar** | Katman 0 çekirdeği: `createClaimableBalance` yapıcı, deterministik `balanceID`, yüklem kurucu, talep yolu, testler | Repo + Apache-2.0. Organizatöre sorular. Öldürülebilir yerel anchor kurulumu |
| **17 Per** | SEP-24/6 çekim akışına bağlama + cüzdan imzası (Wallets Kit — entegrasyon partneri şartı) + süre ilanı | Gerçek anchor operatörüyle 15 dk: *"çekim teslim sürenizi taahhüt eder miydiniz?"* |
| **18 Cum** | İkiz arayüz (bugünkü akış vs Ripcord), geri alma düğmesi, durum görselleştirmesi | Demo provası, ekran kaydı, AnchorUSD kanıt slaytı |
| **19 Cmt** | Katman 1 teminat sözleşmesi (yetişirse) + SEP taslağı metni | Workshop, office hours, mentor soruları |
| **20 Paz** | README, tehdit modeli dokümanı, video | Teslim, Scale Track kutusu |

**BillRail'den devralınan** (bu yüzden 4 gün gerçekçi): SEP-10 kimlik doğrulama,
SEP-6 istemci, `units.js` (7 ondalık), Wallets Kit sarmalayıcı, sunucu iskeleti,
makbuz sayfası, ve en önemlisi **belirsizlik disiplini**.

**Kesme sırası** (yetişmezse sondan atılır): Katman 2 → mevduat teminatı → Katman 1 →
**Katman 0 + demo**. Katman 0 tek başına eksiksiz ve kazanabilir bir teslimdir, çünkü
klasik Stellar operasyonlarıdır — Soroban'a bağımlı değil, yani en riskli bağımlılık yok.

---

## 9. SEP taslağı iskeleti

Hackathon çıktısının yanında bir taslak metin gider. SCF'de "SEP yazdım" demek
"uygulama yaptım"dan başka bir ligdir.

```
SEP-XXXX: Escrowed Withdrawals with Unilateral User Exit
Status: Draft

1. Motivation
   SEP-6/24 çekimlerinde teslim sürelerinin hiçbiri anchor'ı bağlamaz ve
   kullanıcının iptal yolu yoktur. (Durum listesi alıntısıyla.)

2. Anchor beyanı — GET /info
   withdraw[asset].escrow = {
     supported: true,
     max_delivery_seconds: 172800,     // ilan edilen teslim süresi
     modes: ["claimable_balance"]      // gelecekte "bonded_contract"
   }

3. Çekim akışı değişikliği
   pending_user_transfer_start durumunda anchor şunları da döner:
     escrow_mode, escrow_deadline (ISO 8601), escrow_claimant (anchor G...)
   Cüzdan CreateClaimableBalance gönderir; balanceID'yi önceden hesaplar.

4. İşlem kaydı
   escrow_balance_id  — yeni alan (bugün claimable_balance_id yalnızca DEPOSIT'te var)
   escrow_deadline
   escrow_outcome: claimed_by_anchor | reclaimed_by_user | pending

5. Yüklem yapısı (normatif)
   anchor: BEFORE_ABSOLUTE_TIME(T)
   user:   NOT(BEFORE_ABSOLUTE_TIME(T))
   rel_before KULLANILMAZ.

6. Güvenlik değerlendirmeleri
   ihraççı clawback/deauth riski · rezerv maliyeti ve merge kilidi ·
   talep anında trustline · süre seçiminin ekonomisi
```

Not: bugün `claimable_balance_id` **yalnızca mevduat** işlemlerinde var; SEP-6 bunu
açıkça yazıyor. **Çekim tarafında karşılığı yok** — yani emanetimizin SEP şemasında
oturacağı bir alan bile bulunmuyor. Taslağın eklediği ilk şey bu.

---

## 10. Netleşmesi gerekenler

1. **İsim.** "Ripcord" — paraşüt ipi; kimse senin yerine çekmez. Alternatifler:
   Lifeboat, Backstop, Deadman.
2. Demo anchor'ı ne olacak? BillRail'in bağlandığı `tr-mock-anchor.fly.dev` bizim
   değil, **kapatamayız**. Sahnede öldürebilmek için yerel bir SEP-24 anchor stub'ı
   gerekiyor. (16 Çarşamba işi.)
3. Katman 1 teminatı hangi varlıkta ve ne kadar? Ekonomi tasarımı — faz 2'ye bırakılabilir.
4. Ödeme gücü panosu ayrı bir ürüne benzeyebilir; **protokolün içinde bir görünüm**
   olarak kalmalı, yoksa anchor dizini projelerine benzer.
5. Mevduat yönü (fiat önce gider) bu fazda kapsam dışı. Açıkça öyle denecek.
