// Katman 1 istemcisi — ripcord-bond sözleşmesiyle konuşan tek modül.
// Anchor (claim/finalize), cüzdan sunucusu (open/dispute/reclaim XDR'ı) ve hakem (resolve)
// aynı kodu kullanır. Gizli anahtar burada yok: imzalanacak XDR döner, imzalayan çağırır.
//
// Soroban akışı: kur → simüle → assemble (kaynak/ücret/auth) → imzala → gönder → bekle.
// Simülasyon sözleşme hatasını `Error(Contract, #N)` olarak verir; isme çeviriyoruz.

import {
  Address, Contract, Networks, TransactionBuilder, Transaction, nativeToScVal, scValToNative, rpc, BASE_FEE,
} from "@stellar/stellar-sdk";

export const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NET = Networks.TESTNET;
const server = new rpc.Server(RPC_URL);

/** Sözleşmenin hata sözlüğü — lib.rs ile birebir. */
export const CONTRACT_ERRORS = {
  1: "AlreadyInitialized", 2: "NotInitialized", 3: "BadAmount", 4: "BadDeadline", 5: "InsufficientBond",
  6: "BondLocked", 7: "NotFound", 8: "WrongState", 9: "TooLate", 10: "TooEarly", 11: "WindowClosed", 12: "ArbiterChange",
};
export const STATES = ["Open", "Claimed", "Disputed", "Settled", "Reclaimed", "Resolved"];

const addr = (g) => new Address(g).toScVal();
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n) => nativeToScVal(Number(n), { type: "u32" });
const b32 = (buf) => nativeToScVal(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));

export function contractError(simError) {
  const m = /Error\(Contract, #(\d+)\)/.exec(String(simError));
  return m ? CONTRACT_ERRORS[Number(m[1])] || `#${m[1]}` : String(simError).split("\n")[0].slice(0, 200);
}

/** JSON'a giden BigInt'leri dizgeye çevir. */
export const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * İmzaya hazır, assemble edilmiş Soroban işlemi. `source` require_auth'u karşılayan
 * hesap olmalı (open → user, claim → anchor, resolve → hakem); simülasyon auth'u
 * kaynak hesap modunda doldurur, ek imza gerekmez.
 */
export async function buildInvoke({ source, contractId, method, args }) {
  const acc = await server.getAccount(source);
  const c = new Contract(contractId);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(c.call(method, ...args))
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const e = Error(`Sözleşme reddetti: ${contractError(sim.error)}`);
    e.contractError = contractError(sim.error);
    throw e;
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  return { xdr: prepared.toXDR(), networkPassphrase: NET, simulated: sim.result?.retval ? plain(scValToNative(sim.result.retval)) : null };
}

/** İmzalı Soroban XDR'ını gönder, kesinleşmeyi bekle, dönüş değerini ver. */
export async function submitInvoke(signedXdr) {
  const tx = new Transaction(signedXdr, NET);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw Error("Ağ reddetti: " + JSON.stringify(sent.errorResult).slice(0, 200));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const got = await server.getTransaction(sent.hash);
    if (got.status === "SUCCESS") return { hash: sent.hash, value: got.returnValue ? plain(scValToNative(got.returnValue)) : null };
    if (got.status === "FAILED") throw Error("İşlem zincirde düştü: " + sent.hash);
  }
  throw Error("Kesinleşme zaman aşımı: " + sent.hash);
}

/** Salt-okunur çağrı — simülasyon, imza yok. Kaynak herhangi bir mevcut hesap. */
export async function read({ contractId, method, args, source }) {
  const acc = await server.getAccount(source);
  const c = new Contract(contractId);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET }).addOperation(c.call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const e = Error(contractError(sim.error));
    e.contractError = contractError(sim.error);
    throw e;
  }
  return sim.result?.retval ? plain(scValToNative(sim.result.retval)) : null;
}

// --- Sözleşme metotlarına isimli sarmalayıcılar -----------------------------------------
export const calls = {
  bond: (anchor, amountMinor, arbiter) => ({ method: "bond", args: [addr(anchor), i128(amountMinor), addr(arbiter)] }),
  open: (user, anchor, amountMinor, deadline) => ({ method: "open", args: [addr(user), addr(anchor), i128(amountMinor), u64(deadline)] }),
  claim: (id, attestationHash) => ({ method: "claim", args: [u64(id), b32(attestationHash)] }),
  dispute: (id) => ({ method: "dispute", args: [u64(id)] }),
  finalize: (id) => ({ method: "finalize", args: [u64(id)] }),
  reclaim: (id) => ({ method: "reclaim", args: [u64(id)] }),
  resolve: (id, userWins) => ({ method: "resolve", args: [u64(id), nativeToScVal(Boolean(userWins))] }),
  get: (id) => ({ method: "get", args: [u64(id)] }),
  stats: (anchor) => ({ method: "stats", args: [addr(anchor)] }),
  config: () => ({ method: "config", args: [] }),
  init: (token, challengeSecs, penaltyBps) => ({ method: "init", args: [addr(token), u64(challengeSecs), u32(penaltyBps)] }),
};

/** Sözleşme dönüşünü sade nesneye çevirir (state enum → dizge). */
export function normalizeObligation(o) {
  if (!o) return null;
  const state = typeof o.state === "string" ? o.state : Array.isArray(o.state) ? o.state[0] : String(o.state);
  return { ...o, state, amount: String(o.amount), deadline: Number(o.deadline), claimed_at: Number(o.claimed_at) };
}
export function normalizeBond(b) {
  if (!b) return null;
  return { total: String(b.total), locked: String(b.locked), open: Number(b.open), arbiter: b.arbiter };
}
