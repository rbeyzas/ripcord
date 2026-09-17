# Canlı deploy — Fly.io

Tek konteyner: `src/supervisor.js` anchor'ı ve cüzdanı ayrı süreçler olarak yönetir.
**Öldür** gerçek süreç ölümüdür (HTTP kesilir), **Dirilt** yeni bir süreçtir. Sahnede yalan yok.

## Bir kez

```
brew install flyctl && fly auth signup           # ya da fly auth login
npm run anchor:setup -- --own-asset --force      # yerelde: hesaplar + sözleşme → .env
fly launch --no-deploy --copy-config             # fly.toml'daki adı size özel yapın
fly secrets import < .env                        # anahtarlar imaja değil, secret'a
fly deploy
```

`fly.toml`: `auto_stop_machines = false`, `min_machines_running = 1` — sahnede uyumasın.

## Her deploy

```
fly deploy
```

## Kontrol

```
curl https://<app>.fly.dev/api/state | jq '{alive, frozen, asset, bond: .bond.stats}'
```

## Sahne kumandası canlı URL'de

Üst çubuk: Dondur · Çöz · Öldür · **Dirilt** (yalnızca ölüyken görünür). Dirilt,
supervisor'a IPC ile "yeni anchor süreci" der; yerelde bu düğme yoktur (terminalden
`npm run anchor`).

## Jüri onboarding — herkese açık demo

Bağlanan cüzdan hazır değilse üst kartta üç adım belirir:
1. **Friendbot ile fonla** — hesap ağda yoksa
2. **Trustline aç** — bir Freighter imzası
3. **100 RIP al** — ihraççı öder; hesap başına 10 dk'da bir

Bu, handbook'un "ekip dışı gerçek kullanıcı onboard etti" metriğini karşılar: salondaki
biri kendi Freighter'ıyla 60 saniyede kullanıcı olur, anchor'ı **kendisi** öldürür.

## Sınırlar

- Testnet periyodik sıfırlanır; sıfırlanırsa `anchor:setup --force` + `fly secrets import`.
- Konteyner yeniden başlarsa anchor'ın bellek içi işlem kayıtları gider (SEP kayıtları
  demo anchor'da bellekte). Zincirdeki emanetler ve yükümlülükler kalır — kullanıcının
  geri alma hakkı anchor'ın hafızasına bağlı değildir; zaten protokolün noktası bu.
- Demo hakemi (`ARBITER_SECRET`) cüzdan sunucusunda. Üretimde bağımsız taraf; arayüzde
  öyle etiketli.
