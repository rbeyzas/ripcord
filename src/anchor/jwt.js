// SEP-10 JWT — HS256, bağımlılıksız. Demo anchor için yeterli; üretimde RS256/ES256
// ve anahtar rotasyonu gerekir. Bu dosya güvenlik iddiasında bulunmaz, sadece spec'in
// şekline uyar: iss, sub, iat, exp, jti.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function sign(payload, secret, { ttlSeconds = 900 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSeconds, jti: randomUUID(), ...payload };
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  const sig = b64u(createHmac("sha256", secret).update(data).digest());
  return `${data}.${sig}`;
}

/** Geçersizse null döner; asla throw etmez. */
export function verify(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  let given;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
