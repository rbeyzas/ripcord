// Tek yetkili tutar modülü.
// Kural: motor, defter ve zincir hep AYNI birimde konuşur — Stellar'ın 7 ondalığı.
// Kullanıcıya gösterirken ya da dış sağlayıcıya (biller API) gönderirken burada dönüştürülür.
// UI tutarı asla doğrudan kontrata gitmez; kontrata giden her tutar bu modülden geçer.

export const DECIMALS = 7; // Stellar varlıkları (SAC dahil) 7 ondalık kullanır
const SCALE = 10n ** BigInt(DECIMALS);
const I128_MAX = (1n << 127n) - 1n;
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** "20.5" | "20" | 20.5 → 7 ondalıklı tam sayı (Number). Aşırı ondalık reddedilir, yuvarlama yok. */
export function toMinor(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw Error(`Geçersiz tutar: ${input}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS)
    throw Error(`En fazla ${DECIMALS} ondalık: ${input}`);
  const minor = BigInt(whole) * SCALE + BigInt(frac.padEnd(DECIMALS, "0"));
  // Sıfır geçerli bir BAKİYE'dir (boş cüzdan), geçersiz bir TUTAR'dır.
  // Ayrım assertMinor'da: o yalnızca sözleşmeye giden tutarlar için kullanılır.
  return checkMinor(minor, { allowZero: true });
}

/** 7 ondalıklı tam sayı → ondalık string ("20.5000000"). Sıfır bakiye gösterilebilir. */
export function fromMinor(minor) {
  const n = BigInt(checkMinor(minor, { allowZero: true }));
  const whole = n / SCALE;
  const frac = (n % SCALE).toString().padStart(DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** Görüntü: "20.50 USDC". places: gösterilecek ondalık (varsayılan 2, kesme değil yuvarlama yok — kısaltma). */
export function format(minor, currency = "", places = 2) {
  // Sıfır bakiye gösterilebilir olmalı (fromMinor allowZero ile çağırıyor).
  const [whole, frac] = fromMinor(minor).split(".");
  const shown = places > 0 ? `${whole}.${frac.slice(0, places)}` : whole;
  return currency ? `${shown} ${currency}` : shown;
}

/**
 * İnsan için tam ve dürüst gösterim: sondaki anlamsız sıfırlar atılır ama
 * hiçbir basamak KESİLMEZ. 20.5000000 → "20.50", 20.0000001 → "20.0000001".
 * Makbuz gibi kanıt niteliğindeki yerlerde format() yerine bunu kullanın:
 * format() kısaltır, bu kısaltmaz.
 */
export function toDisplay(minor, minPlaces = 2) {
  const [whole, frac] = fromMinor(minor).split(".");
  let f = frac.replace(/0+$/, "");
  if (f.length < minPlaces) f = f.padEnd(minPlaces, "0");
  return f ? `${whole}.${f}` : whole;
}

/**
 * Sözleşmeye giden TUTAR doğrulaması: tam sayı, kesinlikle > 0, i128 ve JS güvenli aralıkta.
 * Sıfır burada geçersizdir — kontrat `amount > 0` şart koşuyor.
 */
export function assertMinor(minor) {
  return checkMinor(minor, { allowZero: false });
}

/**
 * Ortak doğrulama. `allowZero` ayrımı kasten var: boş bir cüzdanın bakiyesi sıfır
 * olabilir ve gösterilebilir olmalı, ama sözleşmeye sıfır tutar gönderilemez.
 * Bu ayrım olmadan "bakiyeniz 0" mesajını üretmek bile hata fırlatıyordu.
 */
export function checkMinor(minor, { allowZero = false } = {}) {
  let n;
  try {
    n = typeof minor === "bigint" ? minor : BigInt(minor);
  } catch {
    throw Error(`Tutar tam sayı olmalı: ${minor}`);
  }
  if (typeof minor === "number" && !Number.isInteger(minor))
    throw Error(`Tutar tam sayı olmalı: ${minor}`);
  if (n < 0n) throw Error("Tutar negatif olamaz");
  if (!allowZero && n === 0n) throw Error("Tutar pozitif olmalı");
  if (n > I128_MAX) throw Error("Tutar i128 sınırını aşıyor");
  if (n > SAFE_MAX)
    throw Error("Tutar JS güvenli tam sayı sınırını aşıyor; BigInt yolu gerekli");
  return Number(n);
}

/** Kontrat çağrısı için string (stellar CLI / SDK i128 argümanı). */
export function toContractArg(minor) {
  return String(assertMinor(minor));
}

/** Dış sağlayıcıya (biller API) ondalık string olarak gönderilecek yerel tutar. */
export function toProviderAmount(minor, providerDecimals = 2) {
  const [whole, frac] = fromMinor(minor).split(".");
  const cut = frac.slice(0, providerDecimals);
  if (frac.slice(providerDecimals).replace(/0/g, "").length)
    throw Error(
      `Sağlayıcı ${providerDecimals} ondalık kabul ediyor; tutar kesilemez: ${fromMinor(minor)}`,
    );
  return providerDecimals > 0 ? `${whole}.${cut}` : whole;
}
