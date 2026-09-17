# Mimari

Scale Track şartı: Mermaid diyagramı sistemi doğru yansıtmalı. Aşağıdaki her diyagram
kodda çalışan bir şeyi gösterir; "planlanan" hiçbir kutu yok.

## Sistem görünümü

```mermaid
flowchart LR
  subgraph Browser["Tarayıcı — cüzdan"]
    UI[İkiz arayüz<br/>public/app.js]
    SWK[Stellar Wallets Kit v2<br/>Freighter / xBull / Albedo …]
    UI -- imzasız XDR --> SWK
    SWK -- imzalı XDR --> UI
  end

  subgraph Wallet["Cüzdan sunucusu — src/server.js<br/>gizli anahtar YOK"]
    ESC[escrow.js<br/>buildEscrowTx · verifyEscrowTx<br/>balanceIdFor · buildClaimTx]
    ATT[attest.js<br/>verifyAttestation]
  end

  subgraph Anchor["Demo anchor — src/anchor/server.js<br/>öldürülebilir"]
    SEP1[SEP-1 stellar.toml]
    SEP10[SEP-10 auth]
    SEP24[SEP-24 withdraw + Ripcord uzantısı]
    W[Gözcü: görür / teslim eder]
    ADM[/admin: freeze · kill/]
  end

  subgraph Net["Stellar testnet"]
    HZ[Horizon]
    RPC[Soroban RPC]
    CB[(Claimable balance<br/>Katman 0)]
    K1[(ripcord-bond<br/>Katman 1)]
  end

  UI <-- /api --> Wallet
  Wallet -- SEP-1/10/24 --> Anchor
  Wallet -- gönder / bakiye --> HZ
  W -- claimant=anchor --> HZ
  W -- claim --> CB
  HZ --- CB
  RPC --- K1
```

Üç süreç, üç güven alanı. Sahnede **anchor ölürken cüzdan sunucusu ayakta kalır** —
kullanıcının çıkışı anchor'a bağımlı değil, olması gereken bu.

## Aynı çekim, iki yol

```mermaid
sequenceDiagram
  participant U as Kullanıcı (cüzdan)
  participant A as Anchor
  participant L as Stellar

  Note over U,L: BUGÜN — SEP-24
  U->>A: POST /transactions/withdraw/interactive
  A-->>U: pending_user_transfer_start · withdraw_anchor_account · memo
  U->>L: Payment(anchor, 10 USDC, memo)
  Note over A,L: Custody anchor'da. Anında. Kalıcı.
  A--xU: (anchor ölür) status: pending_anchor … sonsuza kadar
  Note over U: Spec'te başlatabileceği eylem yok.

  Note over U,L: RIPCORD
  U->>A: GET /info → escrow.max_delivery_seconds = 90
  U->>A: POST …/withdraw/interactive {escrow_mode: claimable_balance}
  A-->>U: pending_user_transfer_start · escrow_claimant · 90 sn
  U->>U: buildEscrowTx → verifyEscrowTx (imzadan ÖNCE)
  U->>L: CreateClaimableBalance [anchor: before(T), user: not(before(T))]
  A->>L: claimant=anchor ile gözle
  alt anchor teslim eder (T'den önce)
    A->>A: fiat öde (simüle) · SEP-53 beyanı imzala
    A->>L: ClaimClaimableBalance
    A-->>U: completed · claimed_by_anchor · escrow_attestation
    U->>U: beyanı stellar.toml SIGNING_KEY ile doğrula
  else anchor ölür / donar
    Note over L: T geçer. Anchor kalıcı olarak kilitli.
    U->>L: ClaimClaimableBalance (kimseye sormadan)
    L-->>U: para geri
    A-->>U: (anchor yaşıyorsa) refunded · reclaimed_by_user
  end
```

## Katman 0 — yüklem ve durumlar

```mermaid
stateDiagram-v2
  [*] --> Open : CreateClaimableBalance<br/>anchor before(T) · user not(before(T))
  Open --> ClaimedByAnchor : anchor claim, closeTime < T
  Open --> ReclaimedByUser : user claim, closeTime ≥ T
  ClaimedByAnchor --> [*]
  ReclaimedByUser --> [*]
  note right of Open
    İptal operasyonu yok.
    Tek çıkış: ClaimClaimableBalanceOp.
    Kim alır → yükleme göre stellar-core karar verir.
  end note
```

`before(T)` ⇔ `closeTime < T` · `not(before(T))` ⇔ `closeTime ≥ T`. Tam tümleyen.

## Katman 1 — ripcord-bond sözleşmesi

```mermaid
stateDiagram-v2
  [*] --> Open : open(user, anchor, amount, T)<br/>serbest teminat ≥ amount şart
  Open --> Claimed : claim(id, attestation)<br/>anchor · now < T
  Open --> Reclaimed : reclaim(id)<br/>user · now ≥ T
  Claimed --> Disputed : dispute(id)<br/>user · pencere içinde
  Claimed --> Settled : finalize(id)<br/>herkes · pencere sonrası
  Disputed --> Resolved : resolve(id, user_wins)<br/>hakem
  Settled --> [*]
  Reclaimed --> [*]
  Resolved --> [*]
  note right of Resolved
    user_wins: tutar + ceza (teminattan) → kullanıcı
    else: tutar → anchor
    her hâlde teminat kilidi çözülür
  end note
```

Hakem `bond()` anında anchor tarafından ilan edilir; açık yükümlülük varken değişemez.
Kullanıcı anchor'ı seçerek hakemi de seçmiş olur — güven modeli baştan görünür.

## Soroban tasarım kararları

| Karar | Gerekçe |
|---|---|
| Yükümlülük ve teminat **persistent**, yapılandırma **instance** | Yükümlülük kaybolursa fon kilitlenir; temporary kasten yok. |
| Her yazımda `extend_ttl(30 gün eşik → 180 gün)` | Mainnet tabanı ~120 gün; uzun emanetler için pay. |
| Son tarih girişin **değerinde**, TTL'de değil | CAP-46-12: TTL güvenlik sınırı değildir, herkes uzatabilir. |
| `claim` fonu **vermez**, pencere açar | Katman 0'ın açığı: "aldım" deyip ödememe. Pencere + teminat bunu pahalı kılar. |
| `finalize` herkes çağırabilir | Anchor'ın parasını alması için ek bir yetkiye gerek yok; kilitli kalmasın. |
| `open` serbest teminatı **kilitler** | Anchor üstlenemeyeceği yükümlülük alamaz. `stats()` = canlı ödeme gücü. |
| Hakem `bond()`'da sabit | Sonradan atanan hakem, güven modelini gizler. |
| Yönetici yok | `init` bir kez; yükseltme yolu yok. Küçük ve denetlenebilir. |

## Güven sınırı — açıkça

- **Zincir doğrulayamaz:** fiat bankaya ulaştı mı. Katman 2 beyanı "dedi/demedi"yi
  imzalı belgeye çevirir, gerçeği kanıtlamaz.
- **Hakem:** Katman 1'de güven hakemdedir; anchor'ın ilan ettiği, kullanıcının anchor'ı
  seçerek kabul ettiği bir taraf. Bu bir tasarım seçimidir, gizlenmez.
- **İhraççı:** clawback / `auth_revocable` protokolün dışındadır. USDC'de `auth_revocable: true`.
- **Demo anchor:** bizim. Fiat simüle. TOML'u öyle olduğunu söylüyor.

## Bileşenler ve sorumlulukları

| Dosya | Sorumluluk | Kanıt |
|---|---|---|
| `src/escrow.js` | Katman 0: yüklemler, balanceId, kur, doğrula, talep | 15 test · `escrow:check` |
| `src/attest.js` | Katman 2: SEP-53 beyan kur/imzala/doğrula | 8 test · `ui:check` |
| `src/units.js` | 7 ondalık tutar disiplini (BillRail'den) | 10 test |
| `src/anchor/server.js` | Demo anchor: SEP-1/10/24 + Ripcord ilanı + gözcü + kumanda | `anchor:check` |
| `src/server.js` | Cüzdan arka ucu: XDR kur/doğrula, gönder, beyan doğrula | `ui:check` |
| `public/` | İkiz arayüz, Wallets Kit | tarayıcı |
| `contracts/ripcord-bond` | Katman 1 | 9 Rust testi · `bond:check` |

## Nasıl test edilir

```
npm test               # 33 birim testi
npm run escrow:check   # Katman 0 testnet
npm run anchor:check   # anchor açıkken: SEP akışı + zombi + reclaim + legacy sıkışma
npm run ui:check       # iki sunucu açıkken: tarayıcı API sırası + SEP-53 + öldürme
npm run contract:test  # Katman 1, 9 test
npm run bond:check     # Katman 1 testnet: teminat, TooLate, reclaim, dispute, ceza
```
