// One sign round: recovery over the SERVER's digest (the client's digest field is only a consistency check),
// a duplicate is silent, a wrong signer is bad-signature, late signatures are accepted, and the deadline and
// resends come from the clock the caller passes in.
import { describe, expect, test } from 'bun:test';
import {
  buildNextState,
  epochBaseline,
  hashState,
  keccak256,
  privateKeyToAddress,
  signDigest,
  toHex,
} from '@pgg/vault';
import { ROUND_STATUS, SignRound } from '../../src/vault/round.js';

const DOMAIN = { chainId: 31337, verifyingContract: `0x${'0d'.repeat(20)}` };
const TABLE = `0x${'7a'.repeat(32)}`;
const keyFor = (name) => toHex(keccak256(new TextEncoder().encode(`round:${name}`)));
const N = (1n << 256n) - 0x14551231950b75fc4402da1732fc9bebfn; // secp256k1 order

function world(names = ['alice', 'bob', 'carol']) {
  const members = names
    .map((name) => {
      const walletKey = keyFor(`wallet:${name}`);
      const sessionKey = keyFor(`session:${name}`);
      return {
        name,
        wallet: privateKeyToAddress(walletKey),
        sessionKey,
        session: privateKeyToAddress(sessionKey),
      };
    })
    .sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const base = epochBaseline({
    tableId: TABLE,
    players: members.map((m) => m.wallet),
    deposits: members.map(() => 1000n),
    nonce: 4n,
    rake: 0n,
    volume: 0n,
  });
  const state = buildNextState({
    prev: base,
    balances: members.map((_, i) => 1000n + (i === 0 ? 10n : 0n) - (i === 1 ? 10n : 0n)),
  });
  const digest = hashState(state, DOMAIN);
  const arbiterSig = signDigest(keyFor('arbiter'), digest);
  const sigOf = (m, d = digest) => signDigest(m.sessionKey, d);
  return { members, state, digest, arbiterSig, sigOf };
}

const TIMING = { signTimeoutMs: 30_000, resendMs: [10_000, 20_000] };
const open = (w, over = {}) =>
  new SignRound({
    state: w.state,
    digest: w.digest,
    arbiterSig: w.arbiterSig,
    sessionKeys: w.members.map((m) => m.session),
    reason: 'hand',
    handNo: 7,
    openedAt: 1_000,
    timing: TIMING,
    ...over,
  });

describe('SignRound: signatures', () => {
  test('open, collecting, complete; signatures come back in state order', () => {
    const w = world();
    const round = open(w);
    expect(round.status).toBe(ROUND_STATUS.open);
    expect(round.missing).toEqual(w.members.map((m) => m.wallet));
    const order = [w.members[2], w.members[0], w.members[1]];
    order.forEach((m, i) => {
      const sig = w.sigOf(m);
      expect(round.verify(m.wallet, { digest: w.digest, sig })).toEqual({
        ok: true,
        duplicate: false,
      });
      expect(round.record(m.wallet, sig)).toBe(
        i < 2 ? ROUND_STATUS.collecting : ROUND_STATUS.complete,
      );
    });
    expect(round.isComplete).toBe(true);
    expect(round.missing).toEqual([]);
    expect(round.playerSigs).toEqual(w.members.map((m) => w.sigOf(m).toLowerCase()));
    expect(round).toMatchObject({
      nonce: 5n,
      reason: 'hand',
      handNo: 7,
      arbiterSig: w.arbiterSig.toLowerCase(),
    });
  });

  test('the same signature again is a silent success, in any case of hex, also after the round completed', () => {
    const w = world(['a', 'b']);
    const round = open(w);
    const [m, n] = w.members;
    round.record(m.wallet, w.sigOf(m));
    expect(
      round.verify(m.wallet, {
        digest: w.digest,
        sig: w.sigOf(m).toUpperCase().replace('0X', '0x'),
      }),
    ).toEqual({
      ok: true,
      duplicate: true,
    });
    round.record(n.wallet, w.sigOf(n));
    expect(
      round.verify(n.wallet, {
        digest: w.digest.toUpperCase().replace('0X', '0x'),
        sig: w.sigOf(n),
      }),
    ).toEqual({
      ok: true,
      duplicate: true,
    });
  });

  test("a signature by any key but the seat's session key is bad-signature (wallet key, another seat's key)", () => {
    const w = world();
    const round = open(w);
    const [a, b] = w.members;
    const byWallet = signDigest(keyFor(`wallet:${a.name}`), w.digest);
    expect(round.verify(a.wallet, { digest: w.digest, sig: byWallet })).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    expect(round.verify(a.wallet, { digest: w.digest, sig: w.sigOf(b) })).toMatchObject({
      ok: false,
      code: 'bad-signature',
    });
    expect(round.status).toBe(ROUND_STATUS.open);
  });

  test("the client's digest is only a consistency check: a signature over another digest never passes", () => {
    const w = world();
    const round = open(w);
    const [a] = w.members;
    const other = `0x${'99'.repeat(32)}`;
    // the client names the other digest: refused before recovery
    expect(round.verify(a.wallet, { digest: other, sig: w.sigOf(a, other) })).toMatchObject({
      code: 'bad-signature',
    });
    // the client names OUR digest but signed another one: recovery over our digest finds a stranger
    expect(round.verify(a.wallet, { digest: w.digest, sig: w.sigOf(a, other) })).toMatchObject({
      code: 'bad-signature',
    });
    expect(round.verify(a.wallet, { sig: w.sigOf(a) })).toMatchObject({ code: 'bad-signature' });
  });

  test('broken bytes, high-s and bad v are bad-signature; strangers are not-a-signer', () => {
    const w = world();
    const round = open(w);
    const [a] = w.members;
    const sig = w.sigOf(a);
    const r = sig.slice(2, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130), 16);
    const highS = `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
    for (const bad of [
      sig.slice(0, -2),
      `${sig}00`,
      highS,
      `${sig.slice(0, 130)}01`,
      `${sig.slice(0, 130)}1d`,
      'nope',
      42,
      null,
    ]) {
      expect(round.verify(a.wallet, { digest: w.digest, sig: bad })).toMatchObject({
        ok: false,
        code: 'bad-signature',
      });
    }
    expect(round.verify(`0x${'ee'.repeat(20)}`, { digest: w.digest, sig })).toMatchObject({
      code: 'not-a-signer',
    });
    expect(round.verify('not an address', { digest: w.digest, sig })).toMatchObject({
      code: 'not-a-signer',
    });
    expect(() => round.record(`0x${'ee'.repeat(20)}`, sig)).toThrow(RangeError);
  });

  test('signatures stored before a restart are kept, and those members are not asked again', () => {
    const w = world();
    const [a, b, c] = w.members;
    const stored = new Map([
      [a.wallet.toUpperCase().replace('0X', '0x'), w.sigOf(a)],
      [`0x${'ee'.repeat(20)}`, w.sigOf(b)], // not a member: ignored
    ]);
    const round = open(w, { playerSigs: stored });
    expect(round.status).toBe(ROUND_STATUS.collecting);
    expect(round.missing).toEqual([b.wallet, c.wallet]);
    const all = open(w, { playerSigs: new Map(w.members.map((m) => [m.wallet, w.sigOf(m)])) });
    expect(all.isComplete).toBe(true);
  });

  test('an abandoned round accepts nothing; record() on a closed round changes nothing', () => {
    const w = world();
    const round = open(w);
    const [a] = w.members;
    round.abandon();
    expect(round.status).toBe(ROUND_STATUS.abandoned);
    expect(round.isLive).toBe(false);
    expect(round.verify(a.wallet, { digest: w.digest, sig: w.sigOf(a) })).toMatchObject({
      code: 'round-closed',
    });
    expect(round.record(a.wallet, w.sigOf(a))).toBe(ROUND_STATUS.abandoned);
    expect(round.hasSigned(a.wallet)).toBe(false);
    // a complete round is not abandoned by a late abandon(): its bundle is what the epoch ends on
    const done = open(w, { playerSigs: new Map(w.members.map((m) => [m.wallet, w.sigOf(m)])) });
    done.abandon();
    expect(done.status).toBe(ROUND_STATUS.complete);
  });
});

describe('SignRound: the clock', () => {
  test('resends at +10 s and +20 s, the soft deadline at +30 s, each reported once', () => {
    const w = world();
    const round = open(w);
    expect(round.deadline).toBe(31_000);
    expect(round.nextWakeAt()).toBe(11_000);
    expect(round.due(10_999)).toEqual({ resend: false, expired: false });
    expect(round.due(11_000)).toEqual({ resend: true, expired: false });
    expect(round.due(11_000)).toEqual({ resend: false, expired: false });
    expect(round.nextWakeAt()).toBe(21_000);
    // a late tick that passes both remaining points reports both at once
    expect(round.due(40_000)).toEqual({ resend: true, expired: true });
    expect(round.expired).toBe(true);
    expect(round.due(50_000)).toEqual({ resend: false, expired: false });
    expect(round.nextWakeAt()).toBeNull();
  });

  test('a round past its deadline still accepts signatures: a late signature is what ends a stall', () => {
    const w = world(['a', 'b']);
    const round = open(w);
    round.due(1_000_000);
    expect(round.expired).toBe(true);
    for (const m of w.members) {
      expect(round.verify(m.wallet, { digest: w.digest, sig: w.sigOf(m) }).ok).toBe(true);
      round.record(m.wallet, w.sigOf(m));
    }
    expect(round.isComplete).toBe(true);
    expect(round.due(2_000_000)).toEqual({ resend: false, expired: false });
  });

  test('reissue after a restart: the same state, digest and signatures, a fresh deadline and resends', () => {
    const w = world();
    const [a] = w.members;
    const round = open(w, { playerSigs: new Map([[a.wallet, w.sigOf(a)]]) });
    round.due(100_000);
    round.reissue(200_000);
    expect(round).toMatchObject({
      digest: w.digest.toLowerCase(),
      deadline: 230_000,
      openedAt: 200_000,
      expired: false,
    });
    expect(round.hasSigned(a.wallet)).toBe(true);
    expect(round.due(210_000)).toEqual({ resend: true, expired: false });
  });

  test('zero, negative or unusable resend times are ignored', () => {
    const w = world();
    const round = open(w, {
      timing: { signTimeoutMs: 30_000, resendMs: [0, -5, Number.NaN, 5_000] },
    });
    expect(round.nextWakeAt()).toBe(6_000);
  });
});

describe('SignRound: construction is checked', () => {
  test('a bad state, digest, arbiter signature, key list, clock or timing throws TypeError', () => {
    const w = world();
    const bad = [
      { state: null },
      { state: { ...w.state, nonce: 5 } },
      { digest: '0x12' },
      { arbiterSig: '0x' },
      { sessionKeys: w.members.slice(1).map((m) => m.session) },
      { openedAt: Number.NaN },
      { timing: { signTimeoutMs: 30_000 } },
    ];
    for (const over of bad) expect(() => open(w, over)).toThrow(TypeError);
  });
});
