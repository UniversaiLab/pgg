// The rules docs/trust-model.md ("Rules the clients and the server must follow") asks honest
// implementations to follow, as predicates that tests can drive with hostile input. The contract can only
// stop so much; these are what stop a lying server from getting a signature, and a lying client or a
// restarted server from signing two things at one nonce.
//
//   clientShouldSign(req, view)  C1a-C1e and C2: may this player's client sign this request?
//   decideSign({ req, last })    the durable nonce record behind C1a, C2 and S4 (client and arbiter)
//   serverMayCoSign(...)         S3: no co-signing with an expired session key
//   canDeal(view)                S1: no next hand before the last state has every signature
//
// The predicates never throw on bad input: a request they cannot make sense of is a refusal, and a deal
// they cannot confirm is a "no". The shapes of `req` and `view` are documented in README.md.
import { verifyBundle } from './bundle.js';
import { domainsEqual, hashState, normalizeDomain } from './eip712.js';
import { normalizeAddress, normalizeState } from './state.js';

export const RULES = Object.freeze({
  C1a: 'Sign only a nonce above the last one you signed, or the identical digest again; never two digests at one nonce.',
  C1b: 'Every balance, the rake and the volume must move by exactly what you saw at the table.',
  C1c: 'Balances plus rake must add up to what the last all-signed state held.',
  C1d: 'Same table, same roster, same domain as pinned; the digest is yours to compute.',
  C1e: 'Rake never decreases and never exceeds the vault cap of the volume.',
  C2: 'Sign a final state only when you are leaving or rotating, and nothing higher after it in the epoch.',
  S1: 'Do not deal the next hand before the last state has every signature.',
  S3: 'Do not co-sign with a session key past its policy expiry.',
  S4: 'Never sign two states with the same nonce (decideSign, on the arbiter side).',
});

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const INTENTS = ['play', 'leave', 'rotate'];

const nonceOf = (value, field) => {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${field} must be a non-negative bigint`);
};

const digestOf = (value, field) => {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new TypeError(`${field} must be a 32-byte 0x digest`);
  }
  return value.toLowerCase();
};

/**
 * What to do with a request to sign nonce `req.nonce` / digest `req.digest`, given `last`, the durable
 * record of the highest nonce signed in this epoch: null (nothing yet) or { nonce, digest, isFinal }.
 *
 *   'new'                  sign it, and write the record BEFORE sending the signature
 *   'repeat'               the very same digest at the same nonce: send the same signature again
 *   'refuse-lower'         a nonce below one already signed
 *   'refuse-equivocation'  a different digest at a nonce already signed
 *   'refuse-after-final'   something above a final state signed in this epoch
 *
 * Bad arguments throw TypeError: the caller must not guess a decision.
 */
export function decideSign({ req, last }) {
  const nonce = nonceOf(req?.nonce, 'req.nonce');
  const digest = digestOf(req?.digest, 'req.digest');
  if (last === null || last === undefined) return 'new';
  const lastNonce = nonceOf(last.nonce, 'last.nonce');
  const lastDigest = digestOf(last.digest, 'last.digest');
  if (nonce < lastNonce) return 'refuse-lower';
  if (nonce === lastNonce) return digest === lastDigest ? 'repeat' : 'refuse-equivocation';
  return last.isFinal ? 'refuse-after-final' : 'new'; // any truthy flag counts: fail closed
}

// ---- client side ---------------------------------------------------------------------------------------

const chips = (value, field) => {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw new RangeError(`${field} must be a whole number of chips`);
};

/** Validate the view; a broken view is a refusal ("VIEW"), never a guess. */
function readView(view) {
  if (view === null || typeof view !== 'object') throw new RangeError('view must be an object');
  const baseline = normalizeState(view.baseline);
  if (!Array.isArray(view.roster)) throw new RangeError('roster must be an array');
  const roster = view.roster.map((a, i) => normalizeAddress(a, `roster[${i}]`));
  if (typeof view.tableId !== 'string' || !HEX32.test(view.tableId)) {
    throw new RangeError('tableId must be 32 bytes of 0x hex');
  }
  if (typeof view.unit !== 'bigint' || view.unit <= 0n) {
    throw new RangeError('unit must be a bigint above 0');
  }
  if (!Number.isInteger(view.maxRakeBps) || view.maxRakeBps < 0 || view.maxRakeBps > 10_000) {
    throw new RangeError('maxRakeBps must be an integer from 0 to 10000');
  }
  if (!INTENTS.includes(view.intent)) throw new RangeError(`intent must be one of ${INTENTS}`);
  let last = null;
  if (view.last !== null && view.last !== undefined) {
    last = {
      nonce: nonceOf(view.last.nonce, 'last.nonce'),
      digest: digestOf(view.last.digest, 'last.digest'),
      isFinal: Boolean(view.last.isFinal),
    };
  }
  const seen = view.observed ?? { deltas: roster.map(() => 0), rake: 0, pot: 0 };
  if (!Array.isArray(seen.deltas) || seen.deltas.length !== roster.length) {
    throw new RangeError('observed.deltas must have one entry per roster seat');
  }
  return {
    me: normalizeAddress(view.me, 'me'),
    domain: normalizeDomain(view.domain),
    tableId: view.tableId.toLowerCase(),
    roster,
    unit: view.unit,
    maxRakeBps: BigInt(view.maxRakeBps),
    baseline,
    last,
    intent: view.intent,
    observed: {
      deltas: seen.deltas.map((d, i) => chips(d, `observed.deltas[${i}]`)),
      rake: chips(seen.rake, 'observed.rake'),
      pot: chips(seen.pot, 'observed.pot'),
    },
  };
}

const sum = (values) => values.reduce((a, b) => a + b, 0n);
const sameAddresses = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * May this player's client sign `req`? Returns { ok: true } or { ok: false, rule, detail }, where rule is
 * one of C1a, C1b, C1c, C1d, C1e, C2, or MALFORMED (the state is not a valid State) or VIEW (the client's
 * own view is unusable). Checked in this order, cheap structure first and the money from the coarsest
 * invariant down to the exact per-player amounts:
 *
 *   C1d  table, roster and domain are the pinned ones; the digest is computed with the pinned domain
 *   C1a  decideSign: a lower nonce or a second digest at one nonce is refused (an identical digest is
 *        approved at once: the same signature goes out again); the nonce must also beat the baseline's
 *   C2   nothing above a final state; a final state only with intent leave/rotate, keep[me] false when
 *        leaving, and no kept seat with an empty balance (settle would revert with BadKeep)
 *   C1e  rake not below the baseline's and within maxRakeBps of volume
 *   C1c  balances + rake equal the baseline's balances + rake
 *   C1b  each balance moved by the observed chips * unit; rake and volume by observed rake and pot * unit
 *
 *   req   { state, domain?, digest? }  a decoded request; `domain` and `digest`, when the server sent them,
 *         must agree with the pinned domain and the locally computed digest
 *   view  see README.md
 */
export function clientShouldSign(req, view) {
  const refuse = (rule, detail) => ({ ok: false, rule, detail });
  try {
    let state;
    try {
      state = normalizeState(req?.state);
    } catch (error) {
      return refuse('MALFORMED', error.message);
    }
    let v;
    try {
      v = readView(view);
    } catch (error) {
      return refuse('VIEW', error.message);
    }
    const meIndex = v.roster.indexOf(v.me);
    if (meIndex < 0) return refuse('VIEW', 'me is not on the roster');
    if (!sameAddresses(v.baseline.players, v.roster) || v.baseline.tableId !== v.tableId) {
      return refuse('VIEW', 'the baseline is not for this table and roster');
    }

    // C1d
    if (state.tableId !== v.tableId) return refuse('C1d', 'wrong table');
    if (!sameAddresses(state.players, v.roster))
      return refuse('C1d', 'the roster is not the pinned one');
    if (req.domain !== undefined && !domainsEqual(req.domain, v.domain)) {
      return refuse('C1d', 'the request is for another domain than the pinned one');
    }
    const digest = hashState(state, v.domain);
    if (req.digest !== undefined && String(req.digest).toLowerCase() !== digest) {
      return refuse('C1d', 'the digest sent does not match the state under the pinned domain');
    }

    // C1a and the nonce half of C2
    const decision = decideSign({ req: { nonce: state.nonce, digest }, last: v.last });
    if (decision === 'repeat') return { ok: true };
    if (decision === 'refuse-lower') {
      return refuse('C1a', `nonce ${state.nonce} is below the last signed ${v.last.nonce}`);
    }
    if (decision === 'refuse-equivocation') {
      return refuse('C1a', `a different state was already signed at nonce ${state.nonce}`);
    }
    if (decision === 'refuse-after-final') {
      return refuse(
        'C2',
        `a final state was signed at nonce ${v.last.nonce}; nothing may follow it`,
      );
    }
    if (state.nonce <= v.baseline.nonce) {
      return refuse('C1a', `nonce ${state.nonce} does not extend the baseline ${v.baseline.nonce}`);
    }

    // C2: a final state
    if (state.isFinal) {
      if (v.intent === 'play')
        return refuse('C2', 'a final state, but you are not leaving or rotating');
      if (v.intent === 'leave' && state.keep[meIndex]) {
        return refuse('C2', 'you are leaving, but the state keeps your chips at the table');
      }
      const empty = state.keep.findIndex((kept, i) => kept && state.balances[i] === 0n);
      if (empty >= 0) return refuse('C2', `player ${empty} is kept with a zero balance (BadKeep)`);
    }

    // C1e
    const base = v.baseline;
    if (state.rake < base.rake) return refuse('C1e', 'rake decreased');
    if (state.rake * 10_000n > v.maxRakeBps * state.volume) {
      return refuse(
        'C1e',
        `rake ${state.rake} is above ${v.maxRakeBps} bps of volume ${state.volume}`,
      );
    }

    // C1c
    const before = sum(base.balances) + base.rake;
    const after = sum(state.balances) + state.rake;
    if (after !== before)
      return refuse('C1c', `balances + rake are ${after}, the baseline held ${before}`);

    // C1b
    for (let i = 0; i < v.roster.length; i++) {
      const expected = v.observed.deltas[i] * v.unit;
      const moved = state.balances[i] - base.balances[i];
      if (moved !== expected) {
        return refuse('C1b', `player ${i} balance moves by ${moved}, the hand moved ${expected}`);
      }
    }
    if (state.rake - base.rake !== v.observed.rake * v.unit) {
      return refuse(
        'C1b',
        `rake moves by ${state.rake - base.rake}, the hand took ${v.observed.rake * v.unit}`,
      );
    }
    if (state.volume - base.volume !== v.observed.pot * v.unit) {
      return refuse(
        'C1b',
        `volume moves by ${state.volume - base.volume}, the pot was ${v.observed.pot * v.unit}`,
      );
    }
    return { ok: true };
  } catch (error) {
    return refuse('INTERNAL', String(error?.message ?? error)); // fail closed
  }
}

// ---- server side ---------------------------------------------------------------------------------------

/**
 * S3: may the arbiter co-sign for a session key this old? True while the key's age is within the policy
 * maximum (both in ms). Anything that is not a finite, non-negative number is a "no".
 */
export function serverMayCoSign({ sessionKeyAgeMs, policyMaxMs } = {}) {
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return valid(sessionKeyAgeMs) && valid(policyMaxMs) && sessionKeyAgeMs <= policyMaxMs;
}

/**
 * S1, with the reason. Returns null when the next hand may be dealt, else { reason, detail } with reason
 * one of: bad-view, not-active, round-open, member-not-claimed, member-offline, no-bundle,
 * bundle-not-head, bundle-final, bundle-incomplete, bundle-invalid.
 *
 *   view { active, roundOpen, head, bundle, members: [{ claimed, online }], verify? }
 */
export function dealBlocker(view) {
  const no = (reason, detail = '') => ({ reason, detail });
  try {
    if (view === null || typeof view !== 'object') return no('bad-view', 'view must be an object');
    const { active, roundOpen, head, bundle, members, verify } = view;
    if (typeof active !== 'boolean' || typeof roundOpen !== 'boolean' || !Array.isArray(members)) {
      return no('bad-view', 'active, roundOpen and members are required');
    }
    if (!active) return no('not-active');
    if (roundOpen) return no('round-open');
    if (members.length < 2) return no('bad-view', 'a table needs at least two members');
    for (let i = 0; i < members.length; i++) {
      if (members[i]?.claimed !== true) return no('member-not-claimed', `member ${i}`);
      if (members[i]?.online !== true) return no('member-offline', `member ${i}`);
    }
    if (head === null || head === undefined) return null; // first hand of the epoch: nothing to wait for
    if (!bundle) return no('no-bundle');
    const state = bundle.state;
    if (nonceOf(head, 'head') !== state?.nonce)
      return no('bundle-not-head', `bundle ${state?.nonce}, head ${head}`);
    if (state.isFinal) return no('bundle-final');
    const n = state.players?.length;
    const complete =
      n === members.length &&
      SIGNATURE.test(bundle.arbiterSig) &&
      Array.isArray(bundle.playerSigs) &&
      bundle.playerSigs.length === n &&
      bundle.playerSigs.every((sig) => SIGNATURE.test(sig));
    if (!complete) return no('bundle-incomplete');
    if (verify) {
      const result = verifyBundle(bundle, verify);
      if (!result.ok) return no('bundle-invalid', result.error);
    }
    return null;
  } catch (error) {
    return no('bad-view', String(error?.message ?? error)); // fail closed
  }
}

/** S1: true only when the next hand may be dealt. See dealBlocker for the view and the reasons. */
export const canDeal = (view) => dealBlocker(view) === null;
