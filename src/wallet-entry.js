// Tarayıcı için bundle edilen cüzdan katmanı. esbuild bunu public/vendor/wallets.js'e derler.
//
// ENTEGRASYON PARTNERİ: Stellar Wallets Kit v2 (Eligible Integration Partners listesi,
// "Wallets" kategorisi). Yük taşıyor: bu katman olmadan ödeyen escrow'u fonlayamaz ve
// operatör hiçbir şey mutabakatlayamaz — yani ürünün ana akışı hiç başlamaz.
//
// Ham window.freighterApi yerine geçti. Kazanç: Freighter, xBull, Albedo, Rabet, Hana,
// Lobstr, Klever, OneKey, Ledger, Trezor ve WalletConnect tek arayüzden; kullanıcı kendi
// cüzdanını seçiyor. Kripto bilmeyen kullanıcı için "hangi cüzdan" sorusu modalda çözülüyor.
//
// NOT: SWK v2 STATİK API kullanıyor (StellarWalletsKit.init/…), v1'deki `new StellarWalletsKit()`
// örneklemesi değil. Eski blog örnekleri v1'i anlatıyor.

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";

const TESTNET = Networks.TESTNET;
let ready = false;
let selectedAddress = null;

/** Kit'i bir kez kur. Yalnızca testnet — mainnet kasten devre dışı. */
function ensureInit() {
  if (ready) return;
  StellarWalletsKit.init({
    network: TESTNET,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new RabetModule(),
      new HanaModule(),
      new LobstrModule(),
    ],
    authModal: { showInstallLabel: true },
  });
  ready = true;
}

/**
 * Cüzdan seçtir ve adresi döndür. Modal kullanıcıya kurulu cüzdanları gösterir.
 * Aynı oturumda ikinci çağrıda modal açılmaz.
 */
export async function connect({ force = false } = {}) {
  ensureInit();
  if (selectedAddress && !force) return selectedAddress;
  const { address } = await StellarWalletsKit.authModal();
  if (!address) throw Error("Cüzdan adres vermedi");
  selectedAddress = address;
  return address;
}

/**
 * İmzasız XDR'ı imzalat. networkPassphrase sunucudan gelir, burada tahmin edilmez.
 * Sunucu testnet dışı bir ağ gönderirse imzalamayı reddederiz — mainnet kazası olmasın.
 */
export async function sign(xdr, networkPassphrase, address) {
  if (networkPassphrase !== TESTNET)
    throw Error("Bu demo yalnızca testnet imzalar; sunucudan gelen ağ testnet değil.");
  ensureInit();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase,
    address: address || selectedAddress || undefined,
  });
  if (!signedTxXdr) throw Error("Cüzdan imzalı XDR vermedi");
  return signedTxXdr;
}

/** Cüzdanı unut — demoda farklı hesapla tekrar denemek için. */
export async function disconnect() {
  selectedAddress = null;
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    /* modül desteklemiyorsa sorun değil */
  }
}

export const currentAddress = () => selectedAddress;

/**
 * Tanılama: hangi cüzdan tarayıcıda gerçekten bulunabiliyor.
 * Modal "Install" gösteriyorsa sebebi burada görünür — eklenti sayfaya enjekte olamamıştır.
 */
export async function diagnose() {
  ensureInit();
  const wallets = await StellarWalletsKit.refreshSupportedWallets();
  return {
    // Freighter content script'i sayfaya bunu koyar. Yoksa enjeksiyon olmamıştır.
    freighterInjected: Boolean(window.freighter),
    origin: location.origin,
    detected: wallets
      .filter((w) => w.isAvailable)
      .map((w) => w.name),
    notDetected: wallets
      .filter((w) => !w.isAvailable)
      .map((w) => w.name),
  };
}

/** Cüzdanın kendi bildirdiği ağ — kullanıcı mainnet'teyse uyarabilmek için. */
export async function walletNetwork() {
  ensureInit();
  try {
    const { networkPassphrase } = await StellarWalletsKit.getNetwork();
    return networkPassphrase;
  } catch {
    return null;
  }
}
