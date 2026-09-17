#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, BytesN, Env,
};

const CHALLENGE: u64 = 600;
const PENALTY_BPS: u32 = 1_000; // %10

struct Fixture {
    env: Env,
    c: RipcordBondClient<'static>,
    user: Address,
    anchor: Address,
    arbiter: Address,
    token: soroban_sdk::token::Client<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_800_000_000);

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let mint = StellarAssetClient::new(&env, &sac.address());
    let token = soroban_sdk::token::Client::new(&env, &sac.address());

    let user = Address::generate(&env);
    let anchor = Address::generate(&env);
    let arbiter = Address::generate(&env);
    mint.mint(&user, &1_000_0000000);
    mint.mint(&anchor, &1_000_0000000);

    let id = env.register(RipcordBond, ());
    let c = RipcordBondClient::new(&env, &id);
    c.init(&sac.address(), &CHALLENGE, &PENALTY_BPS);
    Fixture { env, c, user, anchor, arbiter, token }
}

fn now(env: &Env) -> u64 {
    env.ledger().timestamp()
}
fn warp(env: &Env, secs: u64) {
    env.ledger().with_mut(|l| l.timestamp += secs);
}
fn att(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

#[test]
fn happy_path_claim_then_finalize() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    let id = f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    assert_eq!(f.token.balance(&f.user), 950_0000000, "kullanıcıdan emanete geçti");
    let s = f.c.stats(&f.anchor).unwrap();
    assert_eq!((s.total, s.locked, s.open), (100_0000000, 50_0000000, 1), "teminat kilitlendi");

    f.c.claim(&id, &att(&f.env));
    assert_eq!(f.c.get(&id).state, State::Claimed);
    // Pencere kapanmadan finalize edilemez.
    assert_eq!(f.c.try_finalize(&id).err().unwrap().unwrap(), Error::TooEarly);
    warp(&f.env, CHALLENGE);
    f.c.finalize(&id);
    assert_eq!(f.c.get(&id).state, State::Settled);
    assert_eq!(f.token.balance(&f.anchor), 900_0000000 + 50_0000000, "anchor teminatını yatırdı, tutarı aldı");
    let s = f.c.stats(&f.anchor).unwrap();
    assert_eq!((s.locked, s.open), (0, 0), "kilit çözüldü");
}

#[test]
fn anchor_dies_user_reclaims() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    let id = f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    // T'den önce kullanıcı alamaz.
    assert_eq!(f.c.try_reclaim(&id).err().unwrap().unwrap(), Error::TooEarly);
    warp(&f.env, 3600);
    // T'den sonra anchor alamaz — Katman 0 yüklemiyle aynı kural.
    assert_eq!(f.c.try_claim(&id, &att(&f.env)).err().unwrap().unwrap(), Error::TooLate);
    f.c.reclaim(&id);
    assert_eq!(f.c.get(&id).state, State::Reclaimed);
    assert_eq!(f.token.balance(&f.user), 1_000_0000000, "para tamamen geri döndü");
    assert_eq!(f.c.stats(&f.anchor).unwrap().locked, 0);
}

#[test]
fn dispute_user_wins_gets_penalty_from_bond() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    let id = f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    f.c.claim(&id, &att(&f.env)); // anchor "ödedim" dedi ama ödemedi
    f.c.dispute(&id);
    assert_eq!(f.c.get(&id).state, State::Disputed);
    // İtirazlıyken finalize/reclaim mümkün değil.
    assert_eq!(f.c.try_finalize(&id).err().unwrap().unwrap(), Error::WrongState);
    f.c.resolve(&id, &true);
    let o = f.c.get(&id);
    assert_eq!((o.state, o.user_won), (State::Resolved, true));
    // Kullanıcı: 50 geri + %10 ceza = 55. Teminat 100 → 95.
    assert_eq!(f.token.balance(&f.user), 1_000_0000000 + 5_0000000);
    let s = f.c.stats(&f.anchor).unwrap();
    assert_eq!((s.total, s.locked, s.open), (95_0000000, 0, 0));
}

#[test]
fn dispute_anchor_wins() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    let id = f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    f.c.claim(&id, &att(&f.env));
    f.c.dispute(&id);
    f.c.resolve(&id, &false);
    assert_eq!(f.token.balance(&f.anchor), 950_0000000, "anchor tutarı aldı, teminat bozulmadı");
    assert_eq!(f.c.stats(&f.anchor).unwrap().total, 100_0000000);
}

#[test]
fn dispute_window_closes() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    let id = f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    f.c.claim(&id, &att(&f.env));
    warp(&f.env, CHALLENGE);
    assert_eq!(f.c.try_dispute(&id).err().unwrap().unwrap(), Error::WindowClosed);
}

#[test]
fn anchor_cannot_take_more_than_its_bond() {
    // Ödeme gücü sinyalinin özü: teminatsız yükümlülük açılamaz.
    let f = setup();
    f.c.bond(&f.anchor, &60_0000000, &f.arbiter);
    f.c.open(&f.user, &f.anchor, &50_0000000, &(now(&f.env) + 3600));
    let r = f.c.try_open(&f.user, &f.anchor, &20_0000000, &(now(&f.env) + 3600));
    assert_eq!(r.err().unwrap().unwrap(), Error::InsufficientBond);
    // Teminatsız anchor'a hiç açılamaz.
    let stranger = Address::generate(&f.env);
    let r = f.c.try_open(&f.user, &stranger, &1_0000000, &(now(&f.env) + 3600));
    assert_eq!(r.err().unwrap().unwrap(), Error::InsufficientBond);
}

#[test]
fn locked_bond_cannot_be_withdrawn() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    f.c.open(&f.user, &f.anchor, &80_0000000, &(now(&f.env) + 3600));
    assert_eq!(f.c.try_unbond(&f.anchor, &30_0000000).err().unwrap().unwrap(), Error::BondLocked);
    f.c.unbond(&f.anchor, &20_0000000); // serbest kısım çekilebilir
    assert_eq!(f.c.stats(&f.anchor).unwrap().total, 80_0000000);
}

#[test]
fn arbiter_cannot_change_while_obligations_open() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    f.c.open(&f.user, &f.anchor, &10_0000000, &(now(&f.env) + 3600));
    let other = Address::generate(&f.env);
    assert_eq!(f.c.try_bond(&f.anchor, &1_0000000, &other).err().unwrap().unwrap(), Error::ArbiterChange);
}

#[test]
fn rejects_bad_inputs() {
    let f = setup();
    f.c.bond(&f.anchor, &100_0000000, &f.arbiter);
    assert_eq!(f.c.try_open(&f.user, &f.anchor, &0, &(now(&f.env) + 3600)).err().unwrap().unwrap(), Error::BadAmount);
    assert_eq!(f.c.try_open(&f.user, &f.anchor, &1, &(now(&f.env) + 10)).err().unwrap().unwrap(), Error::BadDeadline);
    assert_eq!(f.c.try_get(&99).err().unwrap().unwrap(), Error::NotFound);
    assert_eq!(f.c.try_init(&f.anchor, &1, &1).err().unwrap().unwrap(), Error::AlreadyInitialized);
}
