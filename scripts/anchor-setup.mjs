// Demo anchor'ı testnet'te hazırlar ve .env yazar.
//
//   npm run anchor:setup                 → testnet USDC ile (kullanıcı USDC'yi TR anchor'dan alır)
//   npm run anchor:setup -- --own-asset  → kendi RIP varlığımız + fonlanmış demo kullanıcı
//                                          (dış anchor'a bağımlı olmayan uçtan uca test için)
//
// Gizli anahtarlar yalnızca .env'e (0600) yazılır; ekrana basılmaz.

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Address, Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import { buildInvoke, submitInvoke, calls } from "../src/bond.js";

const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;
const horizon = new Horizon.Server(HORIZON);
const ownAsset = process.argv.includes("--own-asset");
const force = process.argv.includes("--force");
const USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// Derlenmiş WASM önce cargo çıktısında, yoksa depodaki artefaktta aranır — Rust kurmadan çalışır.
const WASM = ["contracts/ripcord-bond/target/wasm32v1-none/release/ripcord_bond.wasm", "contracts/ripcord-bond/artifacts/ripcord_bond.wasm"].find((f) => existsSync(f)) || "contracts/ripcord-bond/artifacts/ripcord_bond.wasm";
const CHALLENGE = Number(process.env.RIPCORD_CHALLENGE_SECONDS || 45); // demo: kısa itiraz penceresi
const PENALTY_BPS = 1000;

if (existsSync(".env") && !force) {
  console.error(".env zaten var. Üzerine yazmak için: --force");
  process.exit(1);
}

async function friendbot(pub) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && r.status !== 400) throw Error(`friendbot ${r.status} (${pub.slice(0, 6)}…)`);
}
async function send(kp, ops, label) {
  const acc = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).setTimeout(120);
  ops.forEach((o) => b.addOperation(o));
  const tx = b.build();
  tx.sign(kp);
  try {
    await horizon.submitTransaction(tx);
    console.log("  ✓", label);
  } catch (e) {
    throw Error(`${label}: ${JSON.stringify(e?.response?.data?.extras?.result_codes || e.message)}`);
  }
}

const anchor = Keypair.random();
console.log("\nRipcord anchor kurulumu · testnet\n");
console.log("  anchor  ", anchor.publicKey());
await friendbot(anchor.publicKey());
console.log("  ✓ friendbot");

let assetKey = USDC;
const env = [`ANCHOR_SECRET=${anchor.secret()}`, `ANCHOR_PUBLIC=${anchor.publicKey()}`];

if (ownAsset) {
  const issuer = Keypair.random(), user = Keypair.random();
  await Promise.all([friendbot(issuer.publicKey()), friendbot(user.publicKey())]);
  const RIP = new Asset("RIP", issuer.publicKey());
  assetKey = `RIP:${issuer.publicKey()}`;
  await send(anchor, [Operation.changeTrust({ asset: RIP })], "anchor trustline RIP");
  await send(user, [Operation.changeTrust({ asset: RIP })], "demo kullanıcı trustline RIP");
  await send(issuer, [
    Operation.payment({ destination: user.publicKey(), asset: RIP, amount: "500" }),
    Operation.payment({ destination: anchor.publicKey(), asset: RIP, amount: "500" }), // teminat için
  ], "demo kullanıcıya ve anchor'a 500 RIP");
  // İhraççı anahtarı musluk için saklanır: canlı demoda bağlanan cüzdana test varlığı vermek.
  env.push(`DEMO_USER_SECRET=${user.secret()}`, `DEMO_USER_PUBLIC=${user.publicKey()}`, `ISSUER_SECRET=${issuer.secret()}`);
  console.log("  demo kullanıcı", user.publicKey());
} else {
  const [code, issuer] = USDC.split(":");
  await send(anchor, [Operation.changeTrust({ asset: new Asset(code, issuer) })], "anchor trustline USDC");
}

// --- Katman 1: sözleşme deploy + init + hakem ------------------------------------------
// WASM yoksa (cargo kurulu değilse) Katman 1 atlanır; Katman 0 ve 2 çalışmaya devam eder.
if (existsSync(WASM)) {
  const [code, issuerPub] = assetKey.split(":");
  const asset = new Asset(code, issuerPub);
  const deployer = Keypair.random(), arbiter = Keypair.random();
  await Promise.all([friendbot(deployer.publicKey()), friendbot(arbiter.publicKey())]);
  const soroban = async (kp, op, label) => {
    // Klasik op'lar için (SAC/upload/create) buildInvoke yerine düz simülasyon yolu
    const { rpc, TransactionBuilder: TB, BASE_FEE } = await import("@stellar/stellar-sdk");
    const srv = new rpc.Server(process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org");
    const acc = await srv.getAccount(kp.publicKey());
    const tx = new TB(acc, { fee: BASE_FEE, networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
    const sim = await srv.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw Error(`${label}: ${sim.error.split("\n")[0].slice(0, 160)}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(kp);
    const r = await submitInvoke(prepared.toXDR());
    console.log("  ✓", label);
    return r;
  };
  // SAC: kendi varlığımızda deploy gerekir; USDC'ninki zaten var (hata alırsak yok sayarız).
  try { await soroban(deployer, Operation.createStellarAssetContract({ asset }), "SAC deploy"); } catch (e) { if (!/already|exists/i.test(e.message)) console.log("  · SAC:", e.message.slice(0, 80)); }
  const tokenId = asset.contractId(NET);
  const wasm = readFileSync(WASM);
  await soroban(deployer, Operation.uploadContractWasm({ wasm }), "wasm upload");
  const created = await soroban(deployer, Operation.createCustomContract({ address: Address.fromString(deployer.publicKey()), wasmHash: hash(wasm), salt: randomBytes(32) }), "ripcord-bond deploy");
  const contractId = created.value;
  const init = await buildInvoke({ source: deployer.publicKey(), contractId, ...calls.init(tokenId, CHALLENGE, PENALTY_BPS) });
  const t = new (await import("@stellar/stellar-sdk")).Transaction(init.xdr, NET); t.sign(deployer);
  await submitInvoke(t.toXDR());
  console.log("  ✓ init · itiraz penceresi", CHALLENGE, "sn · ceza %", PENALTY_BPS / 100);
  console.log("  sözleşme", contractId);
  console.log("  hakem   ", arbiter.publicKey(), "(demo — .env'de ARBITER_SECRET)");
  env.push(`RIPCORD_BOND_CONTRACT=${contractId}`, `ARBITER_SECRET=${arbiter.secret()}`, `ARBITER_PUBLIC=${arbiter.publicKey()}`);
} else {
  console.log("  · Katman 1 atlandı: WASM yok (npm run contract:build). Katman 0 ve 2 çalışır.");
}

env.push(`ANCHOR_ASSET=${assetKey}`, `ANCHOR_DELIVERY_SECONDS=${process.env.ANCHOR_DELIVERY_SECONDS || 90}`, `ANCHOR_PORT=4200`);
writeFileSync(".env", env.join("\n") + "\n", { mode: 0o600 });
console.log("\n  .env yazıldı (0600). Anchor'ı başlat:  npm run anchor\n");
