// The rules docs/trust-model.md ("Rules the clients and the server must follow") asks honest
// implementations to follow, as predicates that tests can drive with hostile input. The contract can only
// stop so much; these are what stop a lying server from getting a signature, and a lying client or a
// restarted server from signing two things at one nonce.
//
//   clientShouldSign(req, view)  C1a-C1e and C2: may this player's client sign this request? A yes carries
//                                the digest to sign, computed here, so nobody signs the server's copy
//   decideSign({ req, last })    the durable nonce record behind C1a, C2 and S4 (client and arbiter)
//   serverMayCoSign(...)         S3: no co-signing with an expired session key
//   canDeal(view)                S1: no next hand before the last state has every signature
//
// The predicates never throw on bad input: a request they cannot make sense of is a refusal, and a deal
// they cannot confirm is a "no". The shapes of `req` and `view` are documented in README.md.
import { EXPECT_ERRORS, verifyBundle } from './bundle.js';
import { RAKE_BPS_CEILING } from './check.js';
import { domainsEqual, hashState, normalizeDomain } from './eip712.js';
import { normalizeAddress, normalizeState } from './state.js';

export const RULES = Object.freeze({
  C1a: 'Sign only the very next nonce after the last state you hold, or the identical digest again; never two digests at one nonce.',
  C1b: 'Every balance, the rake and the volume must move by exactly what you saw at the table since the last state you hold.',
  C1c: 'Balances plus rake must add up to what the last state you hold (the one you signed, if newer) held.',
  C1d: 'Same table, same roster, same domain as pinned; the digest is yours to compute, and the one you sign.',
  C1e: 'Rake never decreases and never exceeds the vault cap of the volume.',
  C2: 'Sign a final state only when you are leaving or rotating, nothing at all after one in the epoch, and no keep flag in a state that is not final.',
  S1: 'Do not deal the next hand before the last state has every signature, verified for this table and domain.',
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

const gapOf = (value) => {
  if (value === undefined) return 1n; // an honest server steps the nonce by one
  const gap = typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n;
  if (gap < 1n) throw new RangeError('maxNonceGap must be an integer of 1 or more');
  return gap;
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
  // the vault's constructor refuses a cap above its ceiling, so a larger number did not come from a vault
  if (
    !Number.isInteger(view.maxRakeBps) ||
    view.maxRakeBps < 0 ||
    view.maxRakeBps > RAKE_BPS_CEILING
  ) {
    throw new RangeError(`maxRakeBps must be an integer from 0 to ${RAKE_BPS_CEILING}`);
  }
  if (!INTENTS.includes(view.intent)) throw new RangeError(`intent must be one of ${INTENTS}`);
  if (view.myBalance !== undefined && (typeof view.myBalance !== 'bigint' || view.myBalance < 0n)) {
    throw new RangeError('myBalance must be a non-negative bigint (token base units)');
  }
  let last = null;
  if (view.last !== null && view.last !== undefined) {
    last = {
      nonce: nonceOf(view.last.nonce, 'last.nonce'),
      digest: digestOf(view.last.digest, 'last.digest'),
      isFinal: Boolean(view.last.isFinal),
      state:
        view.last.state === undefined || view.last.state === null
          ? null
          : normalizeState(view.last.state),
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
    maxNonceGap: gapOf(view.maxNonceGap),
    myBalance: view.myBalance ?? null,
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
 * May this player's client sign `req`? Returns { ok: true, digest } or { ok: false, rule, detail }. The
 * digest is the one THIS function computed from the state under the pinned domain: sign that, never a
 * digest the server sent (a request that carries a different one is refused). rule is one of C1a, C1b,
 * C1c, C1d, C1e, C2, MALFORMED (the state is not a valid State) or VIEW (the client's own view is
 * unusable, or contradicts what the client knows). Checked in this order, cheap structure first and the
 * money from the coarsest invariant down to the exact per-player amounts:
 *
 *   C1d  table, roster and domain are the pinned ones; the digest is computed with the pinned domain
 *   C1a  decideSign: a lower nonce or a second digest at one nonce is refused (an identical digest is
 *        approved at once: the same signature goes out again); the nonce must beat the baseline's and be
 *        at most `maxNonceGap` (default 1: exactly the next one) above the newest state held
 *   C2   nothing above a final state (signed by me, or all-signed as the baseline); a final state only
 *        with intent leave/rotate, keep[me] false when leaving, and no kept seat with an empty balance
 *        (settle would revert with BadKeep); a state that is not final carries no keep flag
 *   C1e  rake not below the base's and within maxRakeBps of volume
 *   C1c  balances + rake equal the base's balances + rake
 *   C1b  each balance moved by the observed chips * unit; rake and volume by observed rake and pot * unit
 *
 * "The base" for the money checks is the last state this client SIGNED when that is newer than the
 * all-signed baseline (a hand I signed whose round is still open must not be rewound by the next
 * request), else the baseline. `observed` is what happened at the table since the base.
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
    // The baseline usually arrives from the server, so a lie in it (my chips moved to another seat) would
    // pass every money check below. myBalance is what I know independently, e.g. from my own deposit.
    if (v.myBalance !== null && v.baseline.balances[meIndex] !== v.myBalance) {
      return refuse(
        'VIEW',
        `the baseline gives you ${v.baseline.balances[meIndex]} but you know you have ${v.myBalance}`,
      );
    }
    // the record of what I signed must describe itself truthfully, or it cannot anchor the money checks
    const { last } = v;
    if (last?.state) {
      const mine = last.state;
      if (mine.tableId !== v.tableId || !sameAddresses(mine.players, v.roster)) {
        return refuse('VIEW', 'last.state is not for this table and roster');
      }
      if (mine.nonce !== last.nonce || mine.isFinal !== last.isFinal) {
        return refuse('VIEW', 'last.state does not match last.nonce and last.isFinal');
      }
      if (hashState(mine, v.domain) !== last.digest) {
        return refuse('VIEW', 'last.state does not hash to last.digest');
      }
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
    const decision = decideSign({ req: { nonce: state.nonce, digest }, last });
    if (decision === 'repeat') return { ok: true, digest };
    if (decision === 'refuse-lower') {
      return refuse('C1a', `nonce ${state.nonce} is below the last signed ${last.nonce}`);
    }
    if (decision === 'refuse-equivocation') {
      return refuse('C1a', `a different state was already signed at nonce ${state.nonce}`);
    }
    if (decision === 'refuse-after-final') {
      return refuse('C2', `a final state was signed at nonce ${last.nonce}; nothing may follow it`);
    }
    if (state.nonce <= v.baseline.nonce) {
      return refuse('C1a', `nonce ${state.nonce} does not extend the baseline ${v.baseline.nonce}`);
    }
    // An honest server steps the nonce by one. A bigger jump is refused: at the extreme one signature
    // would burn the whole uint64 space, and no later state could ever follow it or challenge an exit.
    const lastAhead = last !== null && last.nonce > v.baseline.nonce;
    const newest = lastAhead ? last.nonce : v.baseline.nonce;
    if (state.nonce - newest > v.maxNonceGap) {
      return refuse(
        'C1a',
        `nonce ${state.nonce} skips ahead of ${newest} (at most ${v.maxNonceGap} per state)`,
      );
    }

    // C2: a final state
    if (v.baseline.isFinal) {
      return refuse(
        'C2',
        'the baseline is a final state: the epoch is over and nothing may follow it',
      );
    }
    if (state.isFinal) {
      if (v.intent === 'play')
        return refuse('C2', 'a final state, but you are not leaving or rotating');
      if (v.intent === 'leave' && state.keep[meIndex]) {
        return refuse('C2', 'you are leaving, but the state keeps your chips at the table');
      }
      const empty = state.keep.findIndex((kept, i) => kept && state.balances[i] === 0n);
      if (empty >= 0) return refuse('C2', `player ${empty} is kept with a zero balance (BadKeep)`);
    } else if (state.keep.some(Boolean)) {
      // the contract reads keep only in settle, but the digest covers it: an honest server sends all false
      return refuse('C2', 'a state that is not final carries a keep flag');
    }

    // The money is judged against the last state I signed when it is newer than the baseline.
    if (lastAhead && last.state === null) {
      return refuse(
        'VIEW',
        `you signed nonce ${last.nonce}, ahead of the baseline, but last.state is missing: the hand cannot be checked against it`,
      );
    }
    const base = lastAhead ? last.state : v.baseline;

    // C1e
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
    if (after !== before) {
      const held = lastAhead ? 'the state you signed' : 'the baseline';
      return refuse('C1c', `balances + rake are ${after}, ${held} held ${before}`);
    }

    // C1b
    if (v.observed.rake < 0n || v.observed.pot < 0n) {
      // no hand has a negative pot or rake: a ledger that says so is broken, and volume would go down
      return refuse('VIEW', 'observed.rake and observed.pot must not be negative');
    }
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
    return { ok: true, digest };
  } catch (error) {
    return refuse('INTERNAL', String(error?.message ?? error)); // fail closed
  }
}

// ---- server side ---------------------------------------------------------------------------------------

/**
 * S3: may the arbiter co-sign for a session key this old? True while the key's age is within the policy
 * maximum (both in ms). Anything that is not a finite, non-negative number, including no argument at all,
 * is a "no".
 */
export function serverMayCoSign(args) {
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  try {
    const { sessionKeyAgeMs, policyMaxMs } = args ?? {};
    return valid(sessionKeyAgeMs) && valid(policyMaxMs) && sessionKeyAgeMs <= policyMaxMs;
  } catch {
    return false;
  }
}

// The verifier the gate needs: who the arbiter is and how to find a seat's session key. Without it the
// gate could only check that signatures look complete, and 65 zero bytes look complete.
function readVerifier(verify) {
  if (verify === null || typeof verify !== 'object' || typeof verify.sessionKeyOf !== 'function') {
    return null;
  }
  try {
    return {
      arbiter: normalizeAddress(verify.arbiter, 'arbiter'),
      sessionKeyOf: verify.sessionKeyOf,
    };
  } catch {
    return null;
  }
}

/**
 * S1, with the reason. Returns null when the next hand may be dealt, else { reason, detail } with reason
 * one of: bad-view, no-verifier, not-active, round-open, member-not-claimed, member-offline, no-bundle,
 * bundle-not-head, bundle-final, bundle-incomplete, bundle-wrong-table, bundle-invalid.
 *
 *   view { active, roundOpen, head, bundle, members: [{ claimed, online }],
 *          verify: { arbiter, sessionKeyOf },        required: the gate verifies every signature
 *          tableId, domain, roster? }                what this table is: the bundle must be for it
 *
 * `head` has no default: null means "no hand has been proposed in this epoch yet", a nonce means one has,
 * and a missing (undefined) head is a bad view, never an open gate.
 */
export function dealBlocker(view) {
  const no = (reason, detail = '') => ({ reason, detail });
  try {
    if (view === null || typeof view !== 'object') return no('bad-view', 'view must be an object');
    const { active, roundOpen, head, bundle, members, verify, tableId, domain, roster } = view;
    if (typeof active !== 'boolean' || typeof roundOpen !== 'boolean' || !Array.isArray(members)) {
      return no('bad-view', 'active, roundOpen and members are required');
    }
    if (head === undefined) {
      return no('bad-view', 'head is required: null before the first hand, else the nonce');
    }
    if (typeof tableId !== 'string' || !HEX32.test(tableId)) {
      return no('bad-view', 'tableId must be 32 bytes of 0x hex');
    }
    const expect = { domain: normalizeDomain(domain), tableId: tableId.toLowerCase() };
    if (roster !== undefined) {
      if (!Array.isArray(roster) || roster.length !== members.length) {
        return no('bad-view', 'roster must list one address per member');
      }
      expect.players = roster.map((a, i) => normalizeAddress(a, `roster[${i}]`));
    }
    const verifier = readVerifier(verify);
    if (!verifier) return no('no-verifier', 'verify must be { arbiter, sessionKeyOf }');

    if (!active) return no('not-active');
    if (roundOpen) return no('round-open');
    if (members.length < 2) return no('bad-view', 'a table needs at least two members');
    for (let i = 0; i < members.length; i++) {
      if (members[i]?.claimed !== true) return no('member-not-claimed', `member ${i}`);
      if (members[i]?.online !== true) return no('member-offline', `member ${i}`);
    }
    if (head === null) return null; // first hand of the epoch: nothing to wait for
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
    const result = verifyBundle(bundle, { ...verifier, expect });
    if (!result.ok) {
      const reason = EXPECT_ERRORS.includes(result.error) ? 'bundle-wrong-table' : 'bundle-invalid';
      return no(reason, `${result.error} ${result.args.join(' ')}`.trim());
    }
    return null;
  } catch (error) {
    return no('bad-view', String(error?.message ?? error)); // fail closed
  }
}

/** S1: true only when the next hand may be dealt. See dealBlocker for the view and the reasons. */
export const canDeal = (view) => dealBlocker(view) === null;
