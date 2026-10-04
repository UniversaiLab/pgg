// Seeded generators for the equivalence test: a VALID State for a table (conserves its escrow, rake inside
// the cap, nonce above the table's), and the faults that turn it into every way a State can be wrong.
//
// A case is a plan, not yet signed: the state to submit, who signs it (and over which digest), and edits to
// apply to the signature bytes afterwards. materialize() signs it. Everything here is pure and seeded, so a
// failing case replays from its label.
//
// The faults are written from the CONTRACT's point of view (PokerVault._verify), not from checkState's, so
// the test is not marking its own homework: each fault says which error the contract should answer with
// when it is the only fault, and the test checks the contract really did (that guards the generator).
import { hashState } from '../../src/eip712.js';
import { UINT64_MAX, UINT256_MAX } from '../gen.js';

export const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const HALF = ORDER >> 1n;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sum = (list) => list.reduce((a, b) => a + b, 0n);
const ceilDiv = (a, b) => (a + b - 1n) / b;
/** Roughly uniform in [0, max]. */
const below = (rng, max) => (max <= 0n ? 0n : rng.bigint(max.toString(2).length + 8) % (max + 1n));
const word = (n) => n.toString(16).padStart(64, '0');

const cloneState = (s) => ({
  ...s,
  players: [...s.players],
  balances: [...s.balances],
  keep: [...s.keep],
});

// --- signature bytes -------------------------------------------------------------------------------------
const isSig = (sig) => typeof sig === 'string' && sig.length === 132;
const parts = (sig) => ({
  r: BigInt(`0x${sig.slice(2, 66)}`),
  s: BigInt(`0x${sig.slice(66, 130)}`),
  v: Number.parseInt(sig.slice(130, 132), 16),
});
const join = ({ r, s, v }) => `0x${word(r)}${word(s)}${v.toString(16).padStart(2, '0')}`;

// --- valid states ----------------------------------------------------------------------------------------
function pickNonce(rng, current) {
  const step = rng.pick([
    0n,
    0n,
    1n,
    2n,
    BigInt(1 + rng.int(50)),
    rng.bigint(16),
    rng.bigint(40),
    rng.bigint(63),
  ]);
  const nonce = current + 1n + step;
  return nonce > UINT64_MAX ? UINT64_MAX : nonce;
}

function pickRakeDelta(rng, escrow) {
  switch (rng.int(8)) {
    case 0:
    case 1:
    case 2:
      return 0n;
    case 3:
      return 1n;
    case 4:
      return escrow / 50n;
    case 5:
      return below(rng, escrow / 20n);
    case 6:
      return below(rng, escrow);
    default:
      return escrow > 0n && rng.bool(0.2) ? escrow : below(rng, escrow / 100n);
  }
}

/** The smallest volume that allows `rake` under a cap of `bps` basis points. */
const lowestVolume = (rake, bps) => ceilDiv(rake * 10_000n, bps);
/** The most rake a `volume` allows. */
const mostRake = (volume, bps) => (bps * volume) / 10_000n;

function pickVolume(rng, rake, bps) {
  const lowest = lowestVolume(rake, bps);
  switch (rng.int(5)) {
    case 0:
    case 1:
      return lowest; // right on the cap
    case 2:
      return lowest + 1n;
    case 3:
      return lowest + below(rng, 10n ** 12n);
    default:
      return lowest + rng.bigint(1 + rng.int(120));
  }
}

function spread(rng, total, size, alive) {
  const out = new Array(size).fill(0n);
  const cuts = alive.slice(1).map(() => below(rng, total));
  cuts.sort(cmp);
  let previous = 0n;
  alive.forEach((index, k) => {
    const upto = k < cuts.length ? cuts[k] : total;
    out[index] = upto - previous;
    previous = upto;
  });
  return out;
}

/** Share `total` among `size` players: all to one, all but a unit, even, some at zero, or random. */
function splitEscrow(rng, total, size) {
  const out = new Array(size).fill(0n);
  if (total === 0n) return out;
  const everyone = out.map((_, i) => i);
  switch (rng.int(6)) {
    case 0:
      out[rng.int(size)] = total;
      return out;
    case 1: {
      const a = rng.int(size);
      const b = (a + 1 + rng.int(size - 1)) % size;
      out[a] = total - 1n;
      out[b] = 1n;
      return out;
    }
    case 2: {
      const share = total / BigInt(size);
      out.fill(share);
      out[0] += total - share * BigInt(size);
      return out;
    }
    case 3: {
      const alive = everyone.filter(() => rng.bool(0.5));
      return spread(rng, total, size, alive.length ? alive : [rng.int(size)]);
    }
    default:
      return spread(rng, total, size, everyone);
  }
}

/**
 * A State the contract accepts for `table`: the table's roster, a nonce above its nonce, balances that add up
 * (with rake) to its escrow exactly, rake not below what it has paid and within the cap, a volume often right
 * on the cap. `final` makes it fit for settle: isFinal, and `keep` only where the balance is above zero.
 */
export function validState(rng, table, { final = false } = {}) {
  const row = table.ctx.table;
  const bps = BigInt(table.ctx.maxRakeBps);
  const size = table.players.length;
  let rakeDelta = pickRakeDelta(rng, row.escrow);
  if (rng.bool(0.15)) {
    // a total rake that is a whole multiple of the cap's basis points, so the cap is met with equality
    const aligned = ceilDiv(row.rakePaid + rakeDelta, bps) * bps - row.rakePaid;
    if (aligned <= row.escrow) rakeDelta = aligned;
  }
  if (rakeDelta > row.escrow) rakeDelta = row.escrow; // a table with no escrow has no rake to take
  const rake = row.rakePaid + rakeDelta;
  const balances = splitEscrow(rng, row.escrow - rakeDelta, size);
  return {
    tableId: table.id,
    nonce: pickNonce(rng, row.nonce),
    isFinal: final ? true : rng.bool(0.3),
    players: [...table.players],
    balances,
    // keep is only read by settle: a plain state may carry any flags, even keep with nothing left
    keep: balances.map((b) => (final ? b > 0n && rng.bool(0.6) : rng.bool())),
    rake,
    volume: pickVolume(rng, rake, bps),
  };
}

// --- plans -----------------------------------------------------------------------------------------------
/**
 * A case before signing. `signers` say who signs each slot (and optionally over what), `sigDelta` changes how
 * many player signatures are sent, `stale` signs the base state instead of the submitted one, `domain` signs
 * under another EIP-712 domain, and `edits` rewrite the signature bytes at the end.
 */
export function newPlan(table, entry, state) {
  return {
    table,
    entry,
    base: state,
    state: cloneState(state),
    stale: false,
    domain: null,
    signers: {
      arbiter: { who: 'arbiter' },
      players: table.seats.map((_, index) => ({ who: 'seat', index })),
    },
    sigDelta: 0,
    edits: [],
    faults: [],
  };
}

export const planLabel = (plan) =>
  `${plan.table.name}/${plan.entry} nonce=${plan.state.nonce} faults=[${plan.faults.join(', ')}]`;

/**
 * Sign a plan. `sign(ref, digest)` signs as { who: 'arbiter' | 'seat' | 'stranger', index } and
 * `domain` is the vault's. Returns what to submit: { state, arbiterSig, playerSigs }.
 */
export async function materialize(plan, { sign, domain }) {
  const signed = plan.stale ? plan.base : plan.state;
  const under = plan.domain ?? domain;
  const digest = hashState(signed, under);
  let otherDigest = null;
  const digestFor = (ref) => {
    if (ref.over === 'other') {
      otherDigest ??= hashState({ ...signed, rake: signed.rake + 1n }, under);
      return otherDigest;
    }
    return ref.domain ? hashState(signed, ref.domain) : digest;
  };
  const count = Math.max(0, plan.state.players.length + plan.sigDelta);
  const playerRef = (i) => plan.signers.players[i] ?? { who: 'stranger', index: i };
  let sigs = {
    arbiterSig: await sign(plan.signers.arbiter, digestFor(plan.signers.arbiter)),
    playerSigs: await Promise.all(
      Array.from({ length: count }, (_, i) => sign(playerRef(i), digestFor(playerRef(i)))),
    ),
  };
  for (const edit of plan.edits) sigs = edit(sigs);
  return { state: plan.state, ...sigs };
}

// --- state faults ----------------------------------------------------------------------------------------
const row = (plan) => plan.table.ctx.table;
const bpsOf = (plan) => BigInt(plan.table.ctx.maxRakeBps);
const sizeOf = (plan) => plan.state.players.length;
const randomAddress = (rng) => rng.hex(20);
const otherIndex = (rng, size, not) => (not + 1 + rng.int(size - 1)) % size;

/**
 * Set the rake and move the difference to or from the balances, so the escrow still adds up. False (and
 * nothing changed) when the balances cannot give that much.
 */
function setRake(plan, rake) {
  const s = plan.state;
  const delta = rake - s.rake;
  if (delta > 0n) {
    if (sum(s.balances) < delta) return false;
    let left = delta;
    const biggestFirst = s.balances
      .map((_, i) => i)
      .sort((a, b) => cmp(s.balances[b], s.balances[a]));
    for (const i of biggestFirst) {
      const take = left < s.balances[i] ? left : s.balances[i];
      s.balances[i] -= take;
      left -= take;
      if (left === 0n) break;
    }
  } else if (delta < 0n) {
    if (s.balances.length === 0) return false;
    s.balances[0] += -delta;
  }
  s.rake = rake;
  return true;
}

/** Every fault: { name, expects, entries?, apply(plan, rng) -> applied? }. `expects` is what the contract
 *  must answer when this is the only fault: a list of names ('ok' = accepted), or a function of the plan. */
export const MUTATIONS = [];
const fault = (name, expects, apply, entries) => MUTATIONS.push({ name, expects, apply, entries });
const ALL_RAKE_OK = (plan) => (plan.entry === 'settle' ? ['ok', 'BadKeep'] : ['ok']);

// nonce
fault('nonce.equal', ['StaleNonce'], (plan) => {
  plan.state.nonce = row(plan).nonce;
  return true;
});
fault('nonce.below', ['StaleNonce'], (plan, rng) => {
  if (row(plan).nonce === 0n) return false;
  plan.state.nonce = below(rng, row(plan).nonce - 1n);
  return true;
});
fault('nonce.zero', ['StaleNonce'], (plan) => {
  plan.state.nonce = 0n;
  return true;
});
fault('nonce.max', ['ok'], (plan) => {
  plan.state.nonce = UINT64_MAX;
  return true;
});

// array lengths, each array alone
fault('len.balances.short', ['BadLength'], (plan) => {
  if (plan.state.balances.length === 0) return false;
  plan.state.balances.pop();
  return true;
});
fault('len.balances.long', ['BadLength'], (plan, rng) => {
  plan.state.balances.push(below(rng, 1000n));
  return true;
});
fault('len.keep.short', ['BadLength'], (plan) => {
  if (plan.state.keep.length === 0) return false;
  plan.state.keep.pop();
  return true;
});
fault('len.keep.long', ['BadLength'], (plan, rng) => {
  plan.state.keep.push(rng.bool());
  return true;
});
fault('len.players.short', ['BadLength'], (plan) => {
  if (sizeOf(plan) === 0) return false;
  plan.state.players.pop();
  return true;
});
fault('len.players.long', ['BadLength'], (plan, rng) => {
  plan.state.players.push(randomAddress(rng));
  return true;
});
fault('len.sigs.short', ['BadLength'], (plan) => {
  if (sizeOf(plan) + plan.sigDelta < 1) return false;
  plan.sigDelta -= 1;
  return true;
});
fault('len.sigs.long', ['BadLength'], (plan) => {
  plan.sigDelta += 1;
  return true;
});
fault('len.sigs.none', ['BadLength'], (plan) => {
  if (sizeOf(plan) === 0) return false;
  plan.sigDelta = -sizeOf(plan);
  return true;
});
fault('len.sigs.many', ['BadLength'], (plan, rng) => {
  plan.sigDelta += 1 + rng.int(6);
  return true;
});

// the roster
const rosterFault = (name, change) =>
  fault(name, ['RosterMismatch'], (plan, rng) => {
    const s = plan.state;
    const n = sizeOf(plan);
    if (s.balances.length !== n || s.keep.length !== n) return false; // keep this fault alone
    return change(s, n, rng) !== false;
  });
rosterFault('roster.swap', (s, n, rng) => {
  if (n < 2) return false;
  const i = rng.int(n);
  const j = otherIndex(rng, n, i);
  [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
});
rosterFault('roster.permute', (s, n, rng) => {
  // the same swap applied to balances and keep too: a consistent, re-ordered state
  if (n < 2) return false;
  const i = rng.int(n);
  const j = otherIndex(rng, n, i);
  for (const list of [s.players, s.balances, s.keep]) [list[i], list[j]] = [list[j], list[i]];
});
rosterFault('roster.duplicate', (s, n, rng) => {
  if (n < 2) return false;
  const i = rng.int(n);
  s.players[otherIndex(rng, n, i)] = s.players[i];
});
rosterFault('roster.remove', (s, n, rng) => {
  if (n < 1) return false;
  const i = rng.int(n);
  for (const list of [s.players, s.balances, s.keep]) list.splice(i, 1);
});
rosterFault('roster.replace', (s, n, rng) => {
  if (n < 1) return false;
  s.players[rng.int(n)] = randomAddress(rng);
});
rosterFault('roster.unsorted', (s, n) => {
  if (n < 2) return false;
  s.players.reverse();
});
rosterFault('roster.add', (s, n, rng) => {
  s.players.splice(rng.int(n + 1), 0, randomAddress(rng));
  s.balances.push(0n);
  s.keep.push(false);
});
rosterFault('roster.empty', (s) => {
  s.players.length = 0;
  s.balances.length = 0;
  s.keep.length = 0;
});
rosterFault('roster.zeroAddress', (s, n, rng) => {
  if (n < 1) return false;
  s.players[rng.int(n)] = `0x${'00'.repeat(20)}`;
});

// rake and volume
fault('rake.decreased', ['RakeDecreased'], (plan, rng) => {
  const paid = row(plan).rakePaid;
  if (paid === 0n) return false;
  plan.state.rake = rng.pick([paid - 1n, 0n, below(rng, paid - 1n)]);
  return true;
});
fault('rake.aboveCap', ['RakeTooHigh'], (plan) => {
  // one unit more rake than this volume allows, the extra taken from the balances so the sum still adds up
  const target = mostRake(plan.state.volume, bpsOf(plan)) + 1n;
  if (target < row(plan).rakePaid) return false;
  return setRake(plan, target);
});
fault('volume.justBelow', ['RakeTooHigh'], (plan) => {
  if (plan.state.rake === 0n) return false;
  plan.state.volume = lowestVolume(plan.state.rake, bpsOf(plan)) - 1n;
  return true;
});
fault('volume.zero', ['RakeTooHigh'], (plan) => {
  if (plan.state.rake === 0n && !setRake(plan, 1n)) return false;
  plan.state.volume = 0n;
  return true;
});
fault('rake.exactCap', ALL_RAKE_OK, (plan) => {
  // valid, on the boundary: exactly the rake this volume allows (and not below what is paid)
  const target = mostRake(plan.state.volume, bpsOf(plan));
  if (target < row(plan).rakePaid || target === plan.state.rake) return false;
  return setRake(plan, target);
});
fault('rake.huge', ['Panic'], (plan, rng) => {
  plan.state.rake = UINT256_MAX / 10_000n + 1n + (rng.bool() ? 0n : below(rng, 1n << 200n));
  return true;
});
fault('volume.huge', ['Panic'], (plan, rng) => {
  plan.state.volume = UINT256_MAX / bpsOf(plan) + 1n + (rng.bool() ? 0n : below(rng, 1n << 200n));
  return true;
});
fault('rake.hugeNoOverflow', ['RakeTooHigh', 'NotConserved'], (plan) => {
  // the largest values whose products still fit: no Panic, so the ordinary checks answer
  plan.state.rake = UINT256_MAX / 10_000n;
  plan.state.volume = UINT256_MAX / bpsOf(plan);
  return true;
});

// the balances
fault('balance.plusOne', ['NotConserved'], (plan, rng) => {
  if (sizeOf(plan) === 0 || plan.state.balances.length === 0) return false;
  plan.state.balances[rng.int(plan.state.balances.length)] += 1n;
  return true;
});
fault('balance.minusOne', ['NotConserved'], (plan, rng) => {
  const spendable = plan.state.balances.map((b, i) => (b > 0n ? i : -1)).filter((i) => i >= 0);
  if (spendable.length === 0) return false;
  plan.state.balances[rng.pick(spendable)] -= 1n;
  return true;
});
fault('balance.max', ['NotConserved'], (plan, rng) => {
  // 2^256-1 in one balance, nothing elsewhere, no new rake: the sum fits, it just is not the escrow
  if (plan.state.balances.length === 0) return false;
  plan.state.balances.fill(0n);
  plan.state.balances[rng.int(plan.state.balances.length)] = UINT256_MAX;
  plan.state.rake = row(plan).rakePaid;
  return true;
});
fault('balance.sumOverflow', ['Panic'], (plan, rng) => {
  const n = plan.state.balances.length;
  if (n < 2) return false;
  const a = rng.int(n);
  const b = otherIndex(rng, n, a);
  if (rng.bool()) {
    plan.state.balances[a] = 1n << 255n;
    plan.state.balances[b] = 1n << 255n;
  } else {
    plan.state.balances[a] = UINT256_MAX;
    if (plan.state.balances[b] === 0n) plan.state.balances[b] = 1n;
  }
  return true;
});

// settle's own checks (the other entry points do not read these)
fault(
  'isFinal.false',
  ['NotFinal'],
  (plan) => {
    plan.state.isFinal = false;
    return true;
  },
  ['settle'],
);
fault(
  'isFinal.true',
  ['ok'],
  (plan) => {
    plan.state.isFinal = true;
    return true;
  },
  ['startExit', 'challenge'],
);
fault(
  'keep.zeroBalance',
  (plan) => (plan.entry === 'settle' ? ['BadKeep'] : ['ok']),
  (plan, rng) => {
    // a seat marked keep with nothing left: the balance moves to someone else so the sum is unchanged
    const n = plan.state.balances.length;
    if (n < 2 || plan.state.keep.length !== n) return false;
    const from = rng.int(n);
    const to = otherIndex(rng, n, from);
    plan.state.balances[to] += plan.state.balances[from];
    plan.state.balances[from] = 0n;
    plan.state.keep[from] = true;
    return true;
  },
);

// --- signature faults ------------------------------------------------------------------------------------
/** Rewrite one signature slot ('arbiter' or a player index) after signing. */
function editSig(plan, target, fn) {
  plan.edits.push((sigs) => {
    if (target === 'arbiter') return { ...sigs, arbiterSig: fn(sigs.arbiterSig) };
    if (target >= sigs.playerSigs.length) return sigs;
    const playerSigs = [...sigs.playerSigs];
    playerSigs[target] = fn(playerSigs[target]);
    return { ...sigs, playerSigs };
  });
}
/** Only for a well-formed 65-byte signature (an earlier fault may already have broken this one). */
const onWhole = (fn) => (sig) => (isSig(sig) ? fn(sig) : sig);
const withV = (v) => onWhole((sig) => join({ ...parts(sig), v }));

function setSigner(plan, target, ref) {
  if (target === 'arbiter') plan.signers.arbiter = ref;
  else plan.signers.players[target] = ref;
}

const BAD_SIGNATURE = ['BadSignature'];
const OTHER_DOMAIN = (domain, rng) =>
  rng.bool()
    ? { ...domain, chainId: domain.chainId + 1 }
    : { ...domain, verifyingContract: `0x${'ab'.repeat(20)}` };

/** Signature faults by kind: { expects, apply(plan, target, rng) -> applied? }. `target` is 'arbiter' or an index. */
export const SIG_FAULTS = {
  'wrong.stranger': {
    expects: BAD_SIGNATURE,
    apply(plan, target, rng) {
      setSigner(plan, target, { who: 'stranger', index: rng.int(4) });
      return true;
    },
  },
  'wrong.seat': {
    expects: BAD_SIGNATURE,
    apply(plan, target, rng) {
      const seats = plan.table.seats.length;
      if (seats < 2) return false;
      const index = target === 'arbiter' ? rng.int(seats) : otherIndex(rng, seats, target);
      setSigner(plan, target, { who: 'seat', index });
      return true;
    },
  },
  'wrong.arbiterKey': {
    expects: BAD_SIGNATURE,
    apply(plan, target) {
      if (target === 'arbiter') return false;
      setSigner(plan, target, { who: 'arbiter' });
      return true;
    },
  },
  otherDigest: {
    expects: BAD_SIGNATURE,
    apply(plan, target) {
      const ref = target === 'arbiter' ? plan.signers.arbiter : plan.signers.players[target];
      setSigner(plan, target, { ...(ref ?? { who: 'stranger', index: 0 }), over: 'other' });
      return true;
    },
  },
  wrongDomain: {
    expects: BAD_SIGNATURE,
    apply(plan, target, rng) {
      const ref = target === 'arbiter' ? plan.signers.arbiter : plan.signers.players[target];
      const domain = OTHER_DOMAIN(plan.table.ctx.domain, rng);
      setSigner(plan, target, { ...(ref ?? { who: 'stranger', index: 0 }), domain });
      return true;
    },
  },
  empty: {
    expects: ['ECDSAInvalidSignatureLength'],
    apply(plan, target) {
      editSig(plan, target, () => '0x');
      return true;
    },
  },
  length: {
    expects: ['ECDSAInvalidSignatureLength'],
    apply(plan, target, rng) {
      const wanted = rng.pick([
        1,
        20,
        32,
        33,
        63,
        64,
        66,
        96,
        97,
        129,
        130,
        131,
        200,
        1 + rng.int(300),
      ]);
      const length = wanted === 65 ? 66 : wanted;
      const padding = rng.hex(length).slice(2);
      editSig(plan, target, (sig) => `0x${(sig.slice(2) + padding).slice(0, length * 2)}`);
      return true;
    },
  },
  'v.0': { expects: ['ECDSAInvalidSignature'], apply: vFault(0) },
  'v.1': { expects: ['ECDSAInvalidSignature'], apply: vFault(1) },
  'v.29': { expects: ['ECDSAInvalidSignature'], apply: vFault(29) },
  'v.other': { expects: ['ECDSAInvalidSignature'], apply: vFault(null) },
  'v.27': { expects: ['ok', 'BadSignature', 'ECDSAInvalidSignature'], apply: vFault(27) },
  'v.28': { expects: ['ok', 'BadSignature', 'ECDSAInvalidSignature'], apply: vFault(28) },
  highS: {
    expects: ['ECDSAInvalidSignatureS'],
    apply(plan, target, rng) {
      editSig(
        plan,
        target,
        onWhole((sig) => {
          const p = parts(sig);
          // the malleable twin (n - s, v flipped) is the realistic one; the rest are the edges
          // (an earlier fault may already have pushed s above the order, where n - s is negative)
          const twin =
            p.s <= ORDER
              ? { ...p, s: ORDER - p.s, v: p.v === 27 ? 28 : 27 }
              : { ...p, s: HALF + 1n };
          const choices = [
            twin,
            twin,
            { ...p, s: HALF + 1n },
            { ...p, s: ORDER - 1n },
            { ...p, s: ORDER },
            { ...p, s: ORDER + 1n },
            { ...p, s: UINT256_MAX },
          ];
          return join(rng.pick(choices));
        }),
      );
      return true;
    },
  },
  zeroS: {
    expects: ['ECDSAInvalidSignature'],
    apply(plan, target) {
      editSig(
        plan,
        target,
        onWhole((sig) => join({ ...parts(sig), s: 0n })),
      );
      return true;
    },
  },
  zeroR: {
    expects: ['ECDSAInvalidSignature'],
    apply(plan, target) {
      editSig(
        plan,
        target,
        onWhole((sig) => join({ ...parts(sig), r: 0n })),
      );
      return true;
    },
  },
  allZero: {
    expects: ['ECDSAInvalidSignature'],
    apply(plan, target) {
      editSig(plan, target, () => `0x${'00'.repeat(65)}`);
      return true;
    },
  },
  bigR: {
    expects: ['ECDSAInvalidSignature'],
    apply(plan, target, rng) {
      const r = rng.pick([ORDER, ORDER + 1n, UINT256_MAX]);
      editSig(
        plan,
        target,
        onWhole((sig) => join({ ...parts(sig), r })),
      );
      return true;
    },
  },
  randomR: {
    expects: ['ECDSAInvalidSignature', 'BadSignature'],
    apply(plan, target, rng) {
      const r = rng.bigint(255); // below the order; about half of all values are the x of a curve point
      editSig(
        plan,
        target,
        onWhole((sig) => join({ ...parts(sig), r })),
      );
      return true;
    },
  },
  bitFlip: {
    expects: ['BadSignature', 'ECDSAInvalidSignature', 'ECDSAInvalidSignatureS'],
    apply(plan, target, rng) {
      const bit = rng.int(65 * 8);
      editSig(
        plan,
        target,
        onWhole((sig) => {
          const bytes = sig.slice(2).match(/../g);
          const at = bit >> 3;
          bytes[at] = ((Number.parseInt(bytes[at], 16) ^ (1 << (bit & 7))) & 0xff)
            .toString(16)
            .padStart(2, '0');
          return `0x${bytes.join('')}`;
        }),
      );
      return true;
    },
  },
};

function vFault(wanted) {
  return (plan, target, rng) => {
    const v = wanted ?? rng.pick([2, 3, 26, 30, 31, 55, 127, 255]);
    editSig(plan, target, withV(v));
    return true;
  };
}

const pickTarget = (plan, rng) => {
  const n = plan.state.players.length;
  const at = rng.int(n + 1);
  return at === n ? 'arbiter' : at;
};

for (const [kind, spec] of Object.entries(SIG_FAULTS)) {
  fault(`sig.${kind}`, spec.expects, (plan, rng) => spec.apply(plan, pickTarget(plan, rng), rng));
}
fault('sig.swapPlayers', BAD_SIGNATURE, (plan, rng) => {
  const n = plan.state.players.length;
  if (n < 2) return false;
  const i = rng.int(n - 1);
  const j = i + 1 + rng.int(n - 1 - i);
  plan.edits.push((sigs) => {
    if (j >= sigs.playerSigs.length) return sigs;
    const playerSigs = [...sigs.playerSigs];
    [playerSigs[i], playerSigs[j]] = [playerSigs[j], playerSigs[i]];
    return { ...sigs, playerSigs };
  });
  return true;
});
fault('sig.staleDigest', BAD_SIGNATURE, (plan) => {
  // a harmless change to the state with the old signatures kept: only the digest is wrong
  plan.state.volume += 1n;
  plan.stale = true;
  return true;
});
fault('sig.allWrongDomain', BAD_SIGNATURE, (plan, rng) => {
  plan.domain = OTHER_DOMAIN(plan.table.ctx.domain, rng);
  return true;
});

// --- applying faults -------------------------------------------------------------------------------------
/** The expected answers for a plan with exactly one fault; null when the fault does not say. */
export function expectedFor(mutation, plan) {
  return typeof mutation.expects === 'function' ? mutation.expects(plan) : mutation.expects;
}

const inRange = (state) =>
  state.nonce >= 0n &&
  state.nonce <= UINT64_MAX &&
  [...state.balances, state.rake, state.volume].every((v) => v >= 0n && v <= UINT256_MAX);

/**
 * Apply a fault if it fits this plan. Returns whether it did. A fault that does not fit, or that (on top of
 * earlier faults) would push a number out of its type, changes nothing: this test is about states the
 * contract can be asked about, and a value beyond uint256 cannot even be sent.
 */
export function applyMutation(plan, mutation, rng) {
  if (mutation.entries && !mutation.entries.includes(plan.entry)) return false;
  const before = {
    state: cloneState(plan.state),
    sigDelta: plan.sigDelta,
    stale: plan.stale,
    domain: plan.domain,
    signers: { arbiter: plan.signers.arbiter, players: [...plan.signers.players] },
    edits: plan.edits.length,
  };
  if (!mutation.apply(plan, rng) || !inRange(plan.state)) {
    plan.state = before.state;
    plan.sigDelta = before.sigDelta;
    plan.stale = before.stale;
    plan.domain = before.domain;
    plan.signers = before.signers;
    plan.edits.length = before.edits;
    return false;
  }
  plan.faults.push(mutation.name);
  return true;
}

/** Apply a signature fault of `kind` to one slot ('arbiter' or an index). */
export function applySigFault(plan, kind, target, rng) {
  if (!SIG_FAULTS[kind].apply(plan, target, rng)) return false;
  plan.faults.push(`sig.${kind}@${target}`);
  return true;
}

/** A plan with `count` faults (fewer if they do not fit), drawn from `pool`; sometimes the old signatures stay. */
export function multiFault(plan, rng, pool, count) {
  for (let tries = 0, done = 0; done < count && tries < 40; tries++) {
    if (applyMutation(plan, rng.pick(pool), rng)) done++;
  }
  if (rng.bool(0.2)) {
    plan.stale = true;
    plan.faults.push('stale');
  }
  return plan;
}

export const LATE = MUTATIONS.filter((m) =>
  /^(sig|balance|rake|volume|keep|isFinal)\./.test(m.name),
);
