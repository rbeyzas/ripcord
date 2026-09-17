import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECIMALS,
  toMinor,
  toDisplay,
  fromMinor,
  format,
  assertMinor,
  toContractArg,
  toProviderAmount,
} from "../src/units.js";

test("decimals are Stellar's 7, not 6", () => {
  assert.equal(DECIMALS, 7);
  assert.equal(toMinor("1"), 10_000_000);
  assert.equal(toMinor("20"), 200_000_000);
  assert.equal(toMinor("0.5"), 5_000_000);
  assert.equal(toMinor("20.5"), 205_000_000);
});

test("round trip preserves value without float drift", () => {
  for (const s of ["0.0000001", "1.2345678", "999999.9999999", "20.5"]) {
    assert.equal(fromMinor(toMinor(s)), s.includes(".") ? padTo7(s) : s + ".0000000");
  }
  function padTo7(s) {
    const [w, f] = s.split(".");
    return `${w}.${f.padEnd(7, "0")}`;
  }
});

test("rejects too many decimals instead of silently rounding", () => {
  assert.throws(() => toMinor("1.00000001"), /En fazla 7 ondalık/);
});

test("rejects malformed, zero, negative, non-integer minor", () => {
  assert.throws(() => toMinor("abc"), /Geçersiz tutar/);
  assert.throws(() => toMinor("-1"), /Geçersiz tutar/);
  assert.throws(() => toMinor("1e6"), /Geçersiz tutar/);
  assert.throws(() => assertMinor(0), /pozitif/);
  assert.throws(() => assertMinor(-5), /negatif/); // negatif ayrı mesaj verir
  assert.throws(() => assertMinor(1.5), /tam sayı/);
  assert.throws(() => assertMinor("x"), /tam sayı/);
});

test("guards i128 and JS safe-integer bounds", () => {
  assert.throws(() => assertMinor((1n << 127n)), /i128/);
  assert.throws(() => assertMinor(2n ** 60n), /güvenli tam sayı/);
  assert.equal(assertMinor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("format shows 2 places by default and never rounds up", () => {
  assert.equal(format(205_000_000, "USDC"), "20.50 USDC");
  assert.equal(format(205_999_999, "USDC"), "20.59 USDC"); // kesme, yuvarlama değil
  assert.equal(format(10_000_000), "1.00");
  assert.equal(format(10_000_000, "USDC", 0), "1 USDC");
});

test("contract arg is a plain integer string", () => {
  assert.equal(toContractArg(205_000_000), "205000000");
  assert.equal(toContractArg("205000000"), "205000000");
});

test("provider amount cuts to provider decimals only when lossless", () => {
  assert.equal(toProviderAmount(205_000_000, 2), "20.50");
  assert.equal(toProviderAmount(200_000_000, 0), "20");
  assert.throws(() => toProviderAmount(205_000_001, 2), /kesilemez/);
});

// Sıfır bakiye gösterilebilir olmalı; sıfır TUTAR sözleşmeye gidemez.
// Bu ayrım olmadan "bakiyeniz 0 USDC" mesajını üretmek bile hata fırlatıyordu
// ve kullanıcı ham simülasyon hatası görüyordu.
test("zero is a valid balance to display but an invalid amount to send", () => {
  assert.equal(toMinor("0"), 0);
  assert.equal(toMinor("0.0000000"), 0);
  assert.equal(fromMinor(0), "0.0000000");
  assert.equal(format(0, "USDC"), "0.00 USDC");
  assert.throws(() => assertMinor(0), /pozitif/);
  assert.throws(() => toContractArg(0), /pozitif/);
});

test("negative values are rejected everywhere", () => {
  assert.throws(() => fromMinor(-1), /negatif/);
  assert.throws(() => assertMinor(-1), /negatif/);
});

// Ham Soroban hataları yüzlerce satır diagnostic event; gerçek sebep içeride gömülü.
// Kullanıcıya ne yapacağını söyleyen mesaja çeviriyoruz.
