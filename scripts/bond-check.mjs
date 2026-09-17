// Ripcord Katman 1 — teminatlı emanet, gerçek testnet kanıtı.
//
//   A. Anchor teslim eder: claim → itiraz penceresi → finalize → anchor alır
//   B. Anchor ölür: T geçer → anchor claim REDDEDİLİR (TooLate) → kullanıcı reclaim
//   C. Anchor yalan söyler: claim → kullanıcı dispute → hakem resolve(user_wins)
//      → kullanıcı tutar + teminattan ceza alır; anchor'ın teminatı azalır
//   + Teminatsız yükümlülük açılamaz (InsufficientBond) — ödeme gücü sinyalinin özü
//
// Kendi test varlığını ihraç eder, SAC'ını ve sözleşmeyi deploy eder. stellar CLI gerekmez.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  Address, Asset, Contract, Keypair, Networks, Operation, TransactionBuilder,
  hash, nativeToScVal, scValToNative, rpc, BASE_FEE, Horizon,
} from "@stellar/stellar-sdk";

const WASM = process.env.RIPCORD_WASM || ["contracts/ripcord-bond/target/wasm32v1-none/release/ripcord_bond.wasm", "contracts/ripcord-bond/artifacts/ripcord_bond.wasm"].find((f) => existsSync(f)) || "contracts/ripcord-bond/artifacts/ripcord_bond.wasm";
const RPC = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const HZ = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const NET = Networks.TESTNET;
const server = new rpc.Server(RPC);
const horizon = new Horizon.Server(HZ);
const DELIVERY = Number(process.env.DELIVERY_SECONDS || 75);
const CHALLENGE = Number(process.env.CHALLENGE_SECONDS || 30);
const PENALTY_BPS = 1000; // %10

if (!existsSync(WASM)) { console.error(`WASM yok: ${WASM}\n  npm run contract:build`); process.exit(1); }
// Evreler: setup,A,B,C (varsayılan hepsi). Durum work/bond-state.json'da tutulur — testnet
// anahtarları, atılabilir. Bir çağrıya sığmayan ortamlarda evre evre koşmak için.
const PHASES = (process.env.PHASES || "setup,A,B,C").split(",");
const STATE = "work/bond-state.json";
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
const saveState = (st) => { mkdirSync("work", { recursive: true }); writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 }); };

const ERR = { 1: "AlreadyInitialized", 2: "NotInitialized", 3: "BadAmount", 4: "BadDeadline", 5: "InsufficientBond", 6: "BondLocked", 7: "NotFound", 8: "WrongState", 9: "TooLate", 10: "TooEarly", 11: "WindowClosed", 12: "ArbiterChange" };
const report = { network: "testnet", at: new Date().toISOString(), steps: [] };
const log = (msg, extra = {}) => { console.log(`  ${msg}`); report.steps.push({ msg, ...extra, t: new Date().toISOString() }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const U = (n) => BigInt(Math.round(n * 1e7)); // 7 ondalık

async function friendbot(pub) { const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`); if (!r.ok && r.status !== 400) throw Error(`friendbot ${r.status}`); }

/** Soroban çağrısı. Sözleşme hatasını isimle döner, fırlatmaz. */
async function invoke(kp, op) {
  const acc = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const m = /Error\(Contract, #(\d+)\)/.exec(sim.error);
    return { ok: false, error: m ? ERR[Number(m[1])] || `#${m[1]}` : sim.error.split("\n")[0].slice(0, 160) };
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") return { ok: false, error: JSON.stringify(sent.errorResult).slice(0, 160) };
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return { ok: true, hash: sent.hash, value: got.returnValue ? scValToNative(got.returnValue) : null };
    if (got.status === "FAILED") return { ok: false, error: "FAILED " + sent.hash };
  }
  return { ok: false, error: "zaman aşımı " + sent.hash };
}
const must = async (kp, op, label) => { const r = await invoke(kp, op); if (!r.ok) throw Error(`${label}: ${r.error}`); return r; };
const mustFail = async (kp, op, want, label) => { const r = await invoke(kp, op); if (r.ok) throw Error(`${label}: başarılı oldu, ${want} bekleniyordu`); if (r.error !== want) throw Error(`${label}: ${r.error}, ${want} bekleniyordu`); return r; };

async function classic(kp, ops) {
  const acc = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acc, { fee: "100", networkPassphrase: NET }).setTimeout(120);
  ops.forEach((o) => b.addOperation(o));
  const tx = b.build(); tx.sign(kp);
  try { await horizon.submitTransaction(tx); } catch (e) { throw Error(JSON.stringify(e?.response?.data?.extras?.result_codes || e.message)); }
}
async function bal(pub, asset) {
  const a = await horizon.loadAccount(pub);
  const b = a.balances.find((x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer());
  return b ? b.balance : "0";
}
const addr = (g) => new Address(g).toScVal();
const i128 = (n) => nativeToScVal(n, { type: "i128" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const b32 = (buf) => nativeToScVal(buf);

async function main() {
  console.log("\nRipcord · Katman 1 testnet kanıtı\n");
  let st = loadState();
  let issuer, anchor, user, arbiter, deployer, RIP, c;
  const hydrate = () => {
    issuer = Keypair.fromSecret(st.issuer); anchor = Keypair.fromSecret(st.anchor); user = Keypair.fromSecret(st.user);
    arbiter = Keypair.fromSecret(st.arbiter); deployer = Keypair.fromSecret(st.deployer);
    RIP = new Asset("RIP", issuer.publicKey()); c = new Contract(st.contract);
  };

  if (PHASES.includes("setup")) {
    issuer = Keypair.random(); anchor = Keypair.random(); user = Keypair.random(); arbiter = Keypair.random(); deployer = Keypair.random();
    await Promise.all([issuer, anchor, user, arbiter, deployer].map((k) => friendbot(k.publicKey())));
    RIP = new Asset("RIP", issuer.publicKey());
    await classic(anchor, [Operation.changeTrust({ asset: RIP })]);
    await classic(user, [Operation.changeTrust({ asset: RIP })]);
    await classic(issuer, [
      Operation.payment({ destination: anchor.publicKey(), asset: RIP, amount: "1000" }),
      Operation.payment({ destination: user.publicKey(), asset: RIP, amount: "1000" }),
    ]);
    log("Hesaplar fonlandı, RIP dağıtıldı", { anchor: anchor.publicKey(), user: user.publicKey(), arbiter: arbiter.publicKey() });

    await must(deployer, Operation.createStellarAssetContract({ asset: RIP }), "SAC deploy");
    const tokenId = RIP.contractId(NET);
    log("SAC deploy edildi", { token: tokenId });

    const wasm = readFileSync(WASM);
    await must(deployer, Operation.uploadContractWasm({ wasm }), "wasm upload");
    const created = await must(deployer, Operation.createCustomContract({ address: Address.fromString(deployer.publicKey()), wasmHash: hash(wasm), salt: randomBytes(32) }), "deploy");
    const CID = created.value; // scValToNative(Address) → "C…"
    c = new Contract(CID);
    await must(deployer, c.call("init", addr(tokenId), u64(CHALLENGE), u32(PENALTY_BPS)), "init");
    log("Sözleşme deploy + init", { contract: CID, explorer: `https://stellar.expert/explorer/testnet/contract/${CID}` });

    await mustFail(user, c.call("open", addr(user.publicKey()), addr(anchor.publicKey()), i128(U(10)), u64(now() + DELIVERY)), "InsufficientBond", "teminatsız open");
    log("✓ Teminatsız anchor'a yükümlülük açılamadı (InsufficientBond)");
    await must(anchor, c.call("bond", addr(anchor.publicKey()), i128(U(100)), addr(arbiter.publicKey())), "bond");
    await mustFail(user, c.call("open", addr(user.publicKey()), addr(anchor.publicKey()), i128(U(150)), u64(now() + DELIVERY)), "InsufficientBond", "aşırı open");
    log("✓ Teminatı aşan yükümlülük reddedildi — ödeme gücü zincirde uygulanıyor");

    st = { issuer: issuer.secret(), anchor: anchor.secret(), user: user.secret(), arbiter: arbiter.secret(), deployer: deployer.secret(), contract: CID, steps: report.steps };
    saveState(st);
  } else {
    if (!st) throw Error("Önce setup evresi: PHASES=setup");
    hydrate();
    report.steps = st.steps || [];
  }

  const stats = async () => (await must(user, c.call("stats", addr(anchor.publicKey())), "stats")).value;
  const open = async (label) => {
    const r = await must(user, c.call("open", addr(user.publicKey()), addr(anchor.publicKey()), i128(U(40)), u64(now() + DELIVERY)), `open ${label}`);
    return { id: r.value, deadline: now() + DELIVERY };
  };

  if (PHASES.includes("A")) {
    console.log("\n── A · Anchor teslim eder ──");
    const A = await open("A");
    await must(anchor, c.call("claim", u64(A.id), b32(randomBytes(32))), "claim A");
    await mustFail(user, c.call("finalize", u64(A.id)), "TooEarly", "erken finalize");
    log("✓ A: claim edildi; itiraz penceresi kapanmadan finalize edilemiyor");
    await sleep((CHALLENGE + 6) * 1000);
    await must(user, c.call("finalize", u64(A.id)), "finalize A"); // herkes çağırabilir
    log("✓ A: pencere itirazsız kapandı, anchor aldı", { anchorRIP: await bal(anchor.publicKey(), RIP), stats: fmt(await stats()) });
    st.steps = report.steps; saveState(st);
  }

  if (PHASES.includes("B")) {
    console.log("\n── B · Anchor ölür ──");
    const B = await open("B");
    await mustFail(user, c.call("reclaim", u64(B.id)), "TooEarly", "erken reclaim");
    log("B: emanet açık, anchor sessiz; kullanıcı T'den önce alamadı (TooEarly)");
    await sleep(Math.max(0, B.deadline - now() + 6) * 1000);
    await mustFail(anchor, c.call("claim", u64(B.id), b32(randomBytes(32))), "TooLate", "geç claim");
    log("✓ B: anchor T'den sonra claim etti, sözleşme reddetti (TooLate)");
    await must(user, c.call("reclaim", u64(B.id)), "reclaim B");
    log("✓ B: kullanıcı tek başına geri aldı", { userRIP: await bal(user.publicKey(), RIP), stats: fmt(await stats()) });
    st.steps = report.steps; saveState(st);
  }

  if (PHASES.includes("C")) {
    console.log("\n── C · Anchor 'ödedim' der, ödemez ──");
    const C = await open("C");
    await must(anchor, c.call("claim", u64(C.id), b32(randomBytes(32))), "claim C");
    await must(user, c.call("dispute", u64(C.id)), "dispute C");
    await mustFail(user, c.call("finalize", u64(C.id)), "WrongState", "itirazlı finalize");
    log("✓ C: kullanıcı itiraz etti; itirazlıyken finalize mümkün değil");
    const before = await bal(user.publicKey(), RIP);
    await must(arbiter, c.call("resolve", u64(C.id), nativeToScVal(true)), "resolve C");
    const after = await bal(user.publicKey(), RIP);
    const s = await stats();
    log("✓ C: hakem kullanıcıyı haklı buldu — tutar + %10 ceza kullanıcıya, teminat azaldı", { userBefore: before, userAfter: after, stats: fmt(s) });
    if (Number(after) - Number(before) < 43.9) throw Error("ceza kullanıcıya gelmedi");
    if (BigInt(s.total) !== U(96)) throw Error(`teminat 96 olmalıydı, ${s.total}`);
    report.contract = st.contract; report.result = "PASS";
    mkdirSync("reports", { recursive: true });
    writeFileSync("reports/testnet-bond.json", JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log("\nSONUÇ: PASS · reports/testnet-bond.json\n");
  }
}
const fmt = (s) => s ? { total: (Number(s.total) / 1e7).toFixed(2), locked: (Number(s.locked) / 1e7).toFixed(2), open: s.open } : null;

main().catch((e) => {
  report.result = "FAIL"; report.error = e.message;
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/testnet-bond.json", JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.error("\nSONUÇ: FAIL —", e.message, "\n"); process.exit(1);
});
