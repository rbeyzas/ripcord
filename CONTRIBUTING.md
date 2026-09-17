# Katkı

Ripcord iki şeydir: bir **SEP taslağı** ve onun **referans uygulaması**. İkisine de katkı olur.

## Protokol tartışması
Taslak: `docs/SEP-XXXX-escrowed-withdrawals.md`. Değişiklik önermeden önce §"Security
Concerns" ve `docs/00-PROTOKOL.md` §5'teki tehdit modelini okuyun. Açık sorular
`docs/05-STELLAR-2026-HIZALAMA.md` sonunda. Taslak `stellar/stellar-protocol`'e PR olarak
açılınca tartışma oraya taşınır.

## Kod
- `npm test` ve `npm run contract:test` yeşil olmalı; CI ikisini de koşar.
- Sözleşme değişirse `npm run contract:build` sonrası `contracts/ripcord-bond/artifacts/`
  güncellenir; CI artefaktın derlemeyle aynı olduğunu doğrular.
- Gerçek testnet kanıtı: `escrow:check`, `anchor:check`, `ui:check`, `bond:check`, `bonded:check`.
- Kural: **mock'u gizleme, etiketle.** Simüle olan her şey arayüzde ve dokümanda öyle yazar.
- Kural: **beyana değil zincire güven.** Anchor'ın "tamamlandı" demesi sonuç değildir;
  claimable balance'ın / yükümlülüğün zincirdeki hâli sonuçtur.

## Güvenlik
Gizli anahtarlar `.env`'de (0600, gitignore). Testnet dışı hiçbir ağ yok. Bir açık
bulursanız issue açmadan önce alperen@patika.dev'e yazın.
