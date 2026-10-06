// One sign round: a reserved, arbiter-signed state waiting for every member's session-key signature
// (docs/signing-layer.md sections 1 and 6). A small state machine with no store and no clock of its own:
//
//   open        issued, nobody has signed yet
//   collecting  some signatures are in (Map address -> sig)
//   complete    every member signed: the coordinator saves the bundle
//   abandoned   the epoch ended under it (Settled or ExitFinalized); nothing more is accepted
//
// A round past its soft deadline is still open or collecting: late signatures are accepted, because a late
// signature is what ends a stall (or, once an exit is running, what lets the watchtower challenge it).
//
// Verification is the arbiter's own: recover the signer over the digest THIS server reserved for the nonce
// and compare it with the seat's session key. The digest a client sends is only a consistency check (F2): a
// client that signed something else has a bug, and a signature is never judged against a digest the client
// chose.
import { normalizeAddress, tryRecoverSigner } from '@pgg/vault';

export const ROUND_STATUS = Object.freeze({
  open: 'open',
  collecting: 'collecting',
  complete: 'complete',
  abandoned: 'abandoned',
});

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;

const isTime = (n) => typeof n === 'number' && Number.isFinite(n);
const refuse = (code, msg) => ({ ok: false, code, msg });

export class SignRound {
  #nonce;
  #state;
  #digest;
  #arbiterSig;
  #reason;
  #handNo;
  #signers; // address -> session key, in state order
  #sigs = new Map(); // address -> sig, in the order they arrived
  #status = ROUND_STATUS.open;
  #openedAt = 0;
  #deadline = 0;
  #resendAt = [];
  #expired = false;
  #timing;

  /**
   * @param {{ state: object, digest: string, arbiterSig: string, sessionKeys: string[],
   *   reason: string, handNo: number|null, openedAt: number,
   *   timing: { signTimeoutMs: number, resendMs: number[] },
   *   playerSigs?: Map<string, string> }} options
   *   sessionKeys[i] is the session key of state.players[i]; playerSigs are signatures already stored
   *   (after a restart they are kept: those members are not asked again).
   */
  constructor({
    state,
    digest,
    arbiterSig,
    sessionKeys,
    reason,
    handNo = null,
    openedAt,
    timing,
    playerSigs,
  }) {
    if (!state || !Array.isArray(state.players) || typeof state.nonce !== 'bigint') {
      throw new TypeError('state must be an internal State');
    }
    if (typeof digest !== 'string' || !DIGEST.test(digest))
      throw new TypeError('digest must be 32 bytes');
    if (typeof arbiterSig !== 'string' || !SIGNATURE.test(arbiterSig)) {
      throw new TypeError('arbiterSig must be a 65-byte signature');
    }
    if (!Array.isArray(sessionKeys) || sessionKeys.length !== state.players.length) {
      throw new TypeError('sessionKeys must have one key per player');
    }
    if (!isTime(openedAt)) throw new TypeError('openedAt must be a clock time');
    if (!timing || !isTime(timing.signTimeoutMs) || !Array.isArray(timing.resendMs)) {
      throw new TypeError('timing must be { signTimeoutMs, resendMs }');
    }
    this.#nonce = state.nonce;
    this.#state = state;
    this.#digest = digest.toLowerCase();
    this.#arbiterSig = arbiterSig.toLowerCase();
    this.#reason = reason;
    this.#handNo = handNo;
    this.#timing = timing;
    this.#signers = new Map(
      state.players.map((player, i) => [
        normalizeAddress(player),
        normalizeAddress(sessionKeys[i], 'sessionKey'),
      ]),
    );
    for (const [address, sig] of playerSigs ?? []) {
      const who = normalizeAddress(address);
      if (this.#signers.has(who)) this.#sigs.set(who, String(sig).toLowerCase());
    }
    this.#schedule(openedAt);
    this.#settleStatus();
  }

  get nonce() {
    return this.#nonce;
  }

  get state() {
    return this.#state;
  }

  get digest() {
    return this.#digest;
  }

  get arbiterSig() {
    return this.#arbiterSig;
  }

  get reason() {
    return this.#reason;
  }

  get handNo() {
    return this.#handNo;
  }

  get status() {
    return this.#status;
  }

  get openedAt() {
    return this.#openedAt;
  }

  /** Soft deadline (clock ms) carried in the signreq. */
  get deadline() {
    return this.#deadline;
  }

  /** True once the soft deadline has passed (see due()). */
  get expired() {
    return this.#expired;
  }

  get isComplete() {
    return this.#status === ROUND_STATUS.complete;
  }

  /** Still accepting signatures (open or collecting, also past the deadline). */
  get isLive() {
    return this.#status === ROUND_STATUS.open || this.#status === ROUND_STATUS.collecting;
  }

  /** Members whose signature is still missing, in state order. */
  get missing() {
    return [...this.#signers.keys()].filter((address) => !this.#sigs.has(address));
  }

  hasSigned(address) {
    return this.#sigs.has(String(address).toLowerCase());
  }

  /** The signatures in STATE order, as makeBundle wants them. Only meaningful once complete. */
  get playerSigs() {
    return [...this.#signers.keys()].map((address) => this.#sigs.get(address) ?? null);
  }

  get signatures() {
    return new Map(this.#sigs);
  }

  #schedule(now) {
    this.#openedAt = now;
    this.#deadline = now + this.#timing.signTimeoutMs;
    this.#resendAt = this.#timing.resendMs
      .filter((ms) => isTime(ms) && ms > 0)
      .map((ms) => now + ms)
      .sort((a, b) => a - b);
    this.#expired = false;
  }

  #settleStatus() {
    if (!this.isLive) return;
    if (this.#sigs.size === this.#signers.size) this.#status = ROUND_STATUS.complete;
    else if (this.#sigs.size > 0) this.#status = ROUND_STATUS.collecting;
    else this.#status = ROUND_STATUS.open;
  }

  /**
   * Is this a good signature from `address` for this round? Pure: nothing is recorded (the coordinator
   * persists first, then calls record()).
   *   { ok: true, duplicate: false }            new and valid
   *   { ok: true, duplicate: true }             the very signature we already hold: silent success
   *   { ok: true, duplicate: true, conflict }   a different valid signature: the stored one is kept
   *   { ok: false, code, msg }                  code 'bad-signature' (wrong signer, broken bytes, or the
   *                                             client says it signed another digest), 'not-a-signer',
   *                                             or 'round-closed'
   */
  verify(address, { digest, sig }) {
    if (!this.isLive && this.#status !== ROUND_STATUS.complete) {
      return refuse('round-closed', `the round at nonce ${this.#nonce} is closed`);
    }
    let who;
    try {
      who = normalizeAddress(address);
    } catch {
      return refuse('not-a-signer', 'not a member of this state');
    }
    const key = this.#signers.get(who);
    if (key === undefined) return refuse('not-a-signer', 'not a member of this state');
    if (typeof digest !== 'string' || digest.toLowerCase() !== this.#digest) {
      return refuse('bad-signature', `nonce ${this.#nonce} has another digest`);
    }
    if (typeof sig !== 'string' || !SIGNATURE.test(sig)) {
      return refuse('bad-signature', 'a signature is 65 bytes of hex');
    }
    const lower = sig.toLowerCase();
    const held = this.#sigs.get(who);
    if (held === lower) return { ok: true, duplicate: true };
    const signer = tryRecoverSigner(this.#digest, lower);
    if (signer.address !== key) {
      return refuse('bad-signature', 'the signature is not from the session key of this seat');
    }
    if (held !== undefined) return { ok: true, duplicate: true, conflict: true };
    return { ok: true, duplicate: false };
  }

  /** Records a signature verify() accepted (and the store has persisted). Returns the new status. */
  record(address, sig) {
    if (!this.isLive) return this.#status;
    const who = normalizeAddress(address);
    if (!this.#signers.has(who)) throw new RangeError(`${who} is not a signer of this round`);
    if (!this.#sigs.has(who)) this.#sigs.set(who, String(sig).toLowerCase());
    this.#settleStatus();
    return this.#status;
  }

  /**
   * What the clock says should happen now: `resend` is true once for every resend point passed since the
   * last call (send the signreq again to the members still missing), `expired` is true exactly once, when
   * the soft deadline first passes.
   */
  due(now) {
    if (!this.isLive) return { resend: false, expired: false };
    let resend = false;
    while (this.#resendAt.length > 0 && this.#resendAt[0] <= now) {
      this.#resendAt.shift();
      resend = true;
    }
    let expired = false;
    if (!this.#expired && now >= this.#deadline) {
      this.#expired = true;
      expired = true;
    }
    return { resend, expired };
  }

  /** The next clock time due() has something to say, or null. */
  nextWakeAt() {
    if (!this.isLive) return null;
    const times = [...this.#resendAt];
    if (!this.#expired) times.push(this.#deadline);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** Re-issue after a restart: the same state, digest and signatures, a fresh deadline and resends. */
  reissue(now) {
    if (!this.isLive) return;
    this.#schedule(now);
  }

  abandon() {
    if (this.isLive) this.#status = ROUND_STATUS.abandoned;
  }
}
