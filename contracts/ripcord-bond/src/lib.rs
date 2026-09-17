//! Ripcord — Katman 1: teminatlı emanet.
//!
//! Katman 0 (claimable balance) şunu garanti eder: anchor hiçbir şey yapmazsa kullanıcı
//! T'den sonra parasını tek başına alır. Garanti EDEMEDİĞİ şey: anchor "aldım" deyip
//! fiat'ı hiç ödememesi. Bu sözleşme onu pahalı kılar:
//!
//!   · Anchor TEMİNAT yatırır ve bir HAKEM ilan eder. Kullanıcı bu anchor'ı seçerek
//!     hakemi kabul etmiş olur — hakem sonradan atanmaz, güven modeli baştan görünür.
//!   · Emanet açılırken anchor'ın serbest teminatı tutar kadar kilitlenir. Yani anchor
//!     üstlenebileceğinden fazla yükümlülük alamaz; açık yükümlülükleri zincirde sayılır.
//!   · `claim` parayı hemen vermez, itiraz penceresi açar. Kullanıcı `dispute` ederse
//!     hakem karar verir; kullanıcı haklıysa parasını VE teminattan ceza alır.
//!   · Anchor T'den önce hiç `claim` etmezse kullanıcı `reclaim` eder — Katman 0 ile aynı.
//!
//! Dürüst sınır: hakem, fiat'ın gerçekten ödenip ödenmediğini zincir dışında değerlendirir.
//! Sözleşme bunu doğrulayamaz; yalnızca yalanı pahalı ve süreci öngörülebilir kılar.
//!
//! Zaman: `env.ledger().timestamp()`. TTL asla güvenlik sınırı değildir (CAP-46-12);
//! son tarih girişin DEĞERİNDE saklanır ve kodda karşılaştırılır.

#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env};

// Kalıcı girişleri her yazımda uzat: mainnet tabanı ~120 gün, biz 180 güne kadar isteriz.
const TTL_THRESHOLD: u32 = 17_280 * 30; // 30 gün altına inerse
const TTL_EXTEND: u32 = 17_280 * 180; // 180 güne çek
// DİKKAT: bu kontrol UYGULAMA anındaki ledger zamanına göre yapılır, simülasyon anına
// göre değil. Cüzdan T'yi tam `now + 60` olarak kurarsa, simülasyon ile uygulama
// arasındaki birkaç saniyede BadDeadline yer. Testnet'te yaşandı. Cüzdanlar pay bırakmalı.
const MIN_DELIVERY_SECS: u64 = 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    BadAmount = 3,
    BadDeadline = 4,
    InsufficientBond = 5,
    BondLocked = 6,
    NotFound = 7,
    WrongState = 8,
    TooLate = 9, // anchor T'den sonra talep etti
    TooEarly = 10, // kullanıcı T'den önce geri almak istedi / pencere kapanmadı
    WindowClosed = 11, // itiraz penceresi kapandı
    ArbiterChange = 12, // açık yükümlülük varken hakem değiştirilemez
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    Config,
    Seq,
    Bond(Address),
    Ob(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// `claim` sonrası kullanıcının itiraz edebileceği süre (sn).
    pub challenge_secs: u64,
    /// Kullanıcı itirazı kazanırsa teminattan alınan ceza, tutarın on binde biri cinsinden.
    pub penalty_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bond {
    pub total: i128,
    pub locked: i128,
    pub open: u32,
    pub arbiter: Address,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Open,      // fon emanette, anchor T'den önce claim edebilir
    Claimed,   // anchor "teslim ettim" dedi; itiraz penceresi açık
    Disputed,  // kullanıcı itiraz etti; hakem bekleniyor
    Settled,   // anchor aldı (itirazsız)
    Reclaimed, // anchor T'ye kadar hiçbir şey yapmadı; kullanıcı geri aldı
    Resolved,  // hakem karar verdi
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Obligation {
    pub user: Address,
    pub anchor: Address,
    pub amount: i128,
    pub deadline: u64,
    pub state: State,
    pub claimed_at: u64,
    pub attestation: BytesN<32>, // SEP-53 imzalı beyanın hash'i (Katman 2 köprüsü)
    pub user_won: bool,
}

#[contract]
pub struct RipcordBond;

#[contractimpl]
impl RipcordBond {
    /// Varlık başına bir örnek. Yönetici yok; yapılandırma bir kez.
    pub fn init(env: Env, token: Address, challenge_secs: u64, penalty_bps: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Token) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Config, &Config { challenge_secs, penalty_bps });
        env.storage().instance().set(&DataKey::Seq, &0u64);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        Ok(())
    }

    // ---------------------------------------------------------------- teminat

    /// Anchor teminat yatırır ve hakemini ilan eder. Açık yükümlülük varken hakem değişemez.
    pub fn bond(env: Env, anchor: Address, amount: i128, arbiter: Address) -> Result<Bond, Error> {
        anchor.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let token = token_client(&env)?;
        let mut b = read_bond(&env, &anchor).unwrap_or(Bond { total: 0, locked: 0, open: 0, arbiter: arbiter.clone() });
        if b.open > 0 && b.arbiter != arbiter {
            return Err(Error::ArbiterChange);
        }
        b.arbiter = arbiter;
        token.transfer(&anchor, &env.current_contract_address(), &amount);
        b.total += amount;
        write_bond(&env, &anchor, &b);
        Ok(b)
    }

    /// Yalnızca serbest (kilitsiz) teminat çekilebilir.
    pub fn unbond(env: Env, anchor: Address, amount: i128) -> Result<Bond, Error> {
        anchor.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let mut b = read_bond(&env, &anchor).ok_or(Error::NotFound)?;
        if b.total - b.locked < amount {
            return Err(Error::BondLocked);
        }
        token_client(&env)?.transfer(&env.current_contract_address(), &anchor, &amount);
        b.total -= amount;
        write_bond(&env, &anchor, &b);
        Ok(b)
    }

    // ---------------------------------------------------------------- emanet

    /// Kullanıcı emanet açar. Anchor'ın serbest teminatı tutarı karşılamıyorsa REDDEDİLİR:
    /// anchor üstlenemeyeceği yükümlülük alamaz. Yükümlülük zincirde sayılır.
    pub fn open(env: Env, user: Address, anchor: Address, amount: i128, deadline: u64) -> Result<u64, Error> {
        user.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let now = env.ledger().timestamp();
        if deadline < now + MIN_DELIVERY_SECS {
            return Err(Error::BadDeadline);
        }
        let mut b = read_bond(&env, &anchor).ok_or(Error::InsufficientBond)?;
        if b.total - b.locked < amount {
            return Err(Error::InsufficientBond);
        }
        token_client(&env)?.transfer(&user, &env.current_contract_address(), &amount);
        b.locked += amount;
        b.open += 1;
        write_bond(&env, &anchor, &b);

        let id: u64 = env.storage().instance().get(&DataKey::Seq).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::Seq, &id);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        write_ob(
            &env,
            id,
            &Obligation {
                user,
                anchor,
                amount,
                deadline,
                state: State::Open,
                claimed_at: 0,
                attestation: BytesN::from_array(&env, &[0u8; 32]),
                user_won: false,
            },
        );
        Ok(id)
    }

    /// Anchor "teslim ettim" der. T'den SONRA reddedilir — Katman 0'daki yüklemle aynı kural.
    /// Para hemen gitmez; itiraz penceresi açılır.
    pub fn claim(env: Env, id: u64, attestation: BytesN<32>) -> Result<Obligation, Error> {
        let mut o = read_ob(&env, id)?;
        o.anchor.require_auth();
        if o.state != State::Open {
            return Err(Error::WrongState);
        }
        let now = env.ledger().timestamp();
        if now >= o.deadline {
            return Err(Error::TooLate);
        }
        o.state = State::Claimed;
        o.claimed_at = now;
        o.attestation = attestation;
        write_ob(&env, id, &o);
        Ok(o)
    }

    /// Kullanıcı, pencere içinde itiraz eder. Fon ve teminat dilimi donar; hakem bekler.
    pub fn dispute(env: Env, id: u64) -> Result<Obligation, Error> {
        let mut o = read_ob(&env, id)?;
        o.user.require_auth();
        if o.state != State::Claimed {
            return Err(Error::WrongState);
        }
        let cfg = config(&env)?;
        if env.ledger().timestamp() >= o.claimed_at + cfg.challenge_secs {
            return Err(Error::WindowClosed);
        }
        o.state = State::Disputed;
        write_ob(&env, id, &o);
        Ok(o)
    }

    /// İtirazsız geçen pencereden sonra HERKES çağırabilir: para anchor'a, teminat serbest.
    pub fn finalize(env: Env, id: u64) -> Result<Obligation, Error> {
        let mut o = read_ob(&env, id)?;
        if o.state != State::Claimed {
            return Err(Error::WrongState);
        }
        let cfg = config(&env)?;
        if env.ledger().timestamp() < o.claimed_at + cfg.challenge_secs {
            return Err(Error::TooEarly);
        }
        token_client(&env)?.transfer(&env.current_contract_address(), &o.anchor, &o.amount);
        release(&env, &o.anchor, o.amount);
        o.state = State::Settled;
        write_ob(&env, id, &o);
        Ok(o)
    }

    /// Anchor T'ye kadar hiçbir şey yapmadıysa kullanıcı tek başına geri alır.
    pub fn reclaim(env: Env, id: u64) -> Result<Obligation, Error> {
        let mut o = read_ob(&env, id)?;
        o.user.require_auth();
        if o.state != State::Open {
            return Err(Error::WrongState);
        }
        if env.ledger().timestamp() < o.deadline {
            return Err(Error::TooEarly);
        }
        token_client(&env)?.transfer(&env.current_contract_address(), &o.user, &o.amount);
        release(&env, &o.anchor, o.amount);
        o.state = State::Reclaimed;
        write_ob(&env, id, &o);
        Ok(o)
    }

    /// Hakem karar verir. Kullanıcı haklıysa: tutar + teminattan ceza kullanıcıya.
    /// Anchor haklıysa: tutar anchor'a. Her iki hâlde teminat kilidi çözülür.
    pub fn resolve(env: Env, id: u64, user_wins: bool) -> Result<Obligation, Error> {
        let mut o = read_ob(&env, id)?;
        if o.state != State::Disputed {
            return Err(Error::WrongState);
        }
        let mut b = read_bond(&env, &o.anchor).ok_or(Error::NotFound)?;
        b.arbiter.require_auth();
        let token = token_client(&env)?;
        let me = env.current_contract_address();
        if user_wins {
            let cfg = config(&env)?;
            let mut penalty = o.amount * (cfg.penalty_bps as i128) / 10_000;
            // Teminat cezayı karşılamıyorsa kalan teminatın tamamı gider; sözleşme borca girmez.
            let free_total = b.total; // kilitli dilim de bu yükümlülüğe ait; ceza oradan da alınabilir
            if penalty > free_total {
                penalty = free_total;
            }
            token.transfer(&me, &o.user, &(o.amount + penalty));
            b.total -= penalty;
        } else {
            token.transfer(&me, &o.anchor, &o.amount);
        }
        b.locked -= o.amount;
        b.open -= 1;
        write_bond(&env, &o.anchor, &b);
        o.state = State::Resolved;
        o.user_won = user_wins;
        write_ob(&env, id, &o);
        Ok(o)
    }

    // ---------------------------------------------------------------- görünümler

    pub fn get(env: Env, id: u64) -> Result<Obligation, Error> {
        read_ob(&env, id)
    }

    /// Anchor'ın ödeme gücü özeti: toplam teminat, kilitli (açık yükümlülük), açık sayısı.
    pub fn stats(env: Env, anchor: Address) -> Option<Bond> {
        read_bond(&env, &anchor)
    }

    pub fn config(env: Env) -> Result<Config, Error> {
        config(&env)
    }
}

// ---------------------------------------------------------------- yardımcılar

fn token_client(env: &Env) -> Result<token::Client<'_>, Error> {
    let t: Address = env.storage().instance().get(&DataKey::Token).ok_or(Error::NotInitialized)?;
    Ok(token::Client::new(env, &t))
}

fn config(env: &Env) -> Result<Config, Error> {
    env.storage().instance().get(&DataKey::Config).ok_or(Error::NotInitialized)
}

fn read_bond(env: &Env, anchor: &Address) -> Option<Bond> {
    let k = DataKey::Bond(anchor.clone());
    let b: Option<Bond> = env.storage().persistent().get(&k);
    if b.is_some() {
        env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND);
    }
    b
}

fn write_bond(env: &Env, anchor: &Address, b: &Bond) {
    let k = DataKey::Bond(anchor.clone());
    env.storage().persistent().set(&k, b);
    env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND);
}

fn read_ob(env: &Env, id: u64) -> Result<Obligation, Error> {
    let k = DataKey::Ob(id);
    let o: Obligation = env.storage().persistent().get(&k).ok_or(Error::NotFound)?;
    env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND);
    Ok(o)
}

fn write_ob(env: &Env, id: u64, o: &Obligation) {
    let k = DataKey::Ob(id);
    env.storage().persistent().set(&k, o);
    env.storage().persistent().extend_ttl(&k, TTL_THRESHOLD, TTL_EXTEND);
}

/// Yükümlülük kapanınca teminat kilidini çöz.
fn release(env: &Env, anchor: &Address, amount: i128) {
    if let Some(mut b) = read_bond(env, anchor) {
        b.locked -= amount;
        b.open -= 1;
        write_bond(env, anchor, &b);
    }
}

#[cfg(test)]
mod test;
