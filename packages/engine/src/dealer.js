// Commit-reveal dealer. Browser-safe (no poker-ts), so it can also run in tests and tooling.
//
// Flow for one hand:
//   commit(n)            publish the commitment (do this DURING hand n-1)
//   submitClientSeed()   players answer with a seed of their own; the server can no longer pick
//                        its seed after seeing them, because the commitment is already out
//   deal(n)              derive the deck and close client seeds
//   complete(n)          the hand is over
//   reveal(n)            release the server seed (only after complete)
//
// `Dealer` is an interface on purpose: anything that can hand back a 52-card draw order and later
// a verifiable proof can replace this (e.g. SRA mental poker).

import {
  commitSeed,
  deriveDeck,
  isCardCode,
  newServerSeed,
  normalizeClientSeeds,
} from './fairness.js';

/**
 * @typedef {{ commit(handNo: number): {handNo:number, commitment:string},
 *   submitClientSeed(handNo:number, seat:number, seed:string): void,
 *   deal(handNo:number): string[],
 *   complete(handNo:number): void,
 *   reveal(handNo:number): object }} Dealer
 */

const STATE = Object.freeze({ COMMITTED: 'committed', DEALT: 'dealt', COMPLETE: 'complete' });

export class CommitRevealDealer {
  #tableId;
  #newSeed;
  #hands = new Map();

  /**
   * @param {{ tableId: string, newSeed?: () => string }} options `newSeed` is for tests only.
   */
  constructor({ tableId, newSeed = newServerSeed }) {
    this.#tableId = tableId;
    this.#newSeed = newSeed;
  }

  #hand(handNo, ...allowed) {
    const hand = this.#hands.get(handNo);
    if (!hand) throw new Error(`hand ${handNo} was never committed`);
    if (!allowed.includes(hand.state)) {
      throw new Error(`hand ${handNo} is ${hand.state}, expected ${allowed.join(' or ')}`);
    }
    return hand;
  }

  /** Create the secret for `handNo` and return only its commitment. */
  commit(handNo) {
    if (this.#hands.has(handNo)) throw new Error(`hand ${handNo} already committed`);
    const serverSeed = this.#newSeed();
    const commitment = commitSeed(serverSeed);
    this.#hands.set(handNo, {
      serverSeed,
      commitment,
      clientSeeds: new Map(),
      state: STATE.COMMITTED,
    });
    return { handNo, commitment };
  }

  /** Record a player's seed. Only possible between commit() and deal(). */
  submitClientSeed(handNo, seat, seed) {
    const hand = this.#hand(handNo, STATE.COMMITTED);
    normalizeClientSeeds([{ seat, seed }]); // validate shape
    if (hand.clientSeeds.has(seat)) throw new Error(`seat ${seat} already submitted a seed`);
    hand.clientSeeds.set(seat, seed);
  }

  /** @returns {string[]} 52 card codes in draw order */
  deal(handNo) {
    const hand = this.#hand(handNo, STATE.COMMITTED);
    const clientSeeds = [...hand.clientSeeds].map(([seat, seed]) => ({ seat, seed }));
    const deck = deriveDeck({
      serverSeed: hand.serverSeed,
      clientSeeds,
      tableId: this.#tableId,
      handNo,
    });
    if (!deck.every(isCardCode)) throw new Error('derived an invalid deck');
    hand.state = STATE.DEALT;
    return deck;
  }

  /** Mark the hand finished; unlocks reveal(). */
  complete(handNo) {
    this.#hand(handNo, STATE.DEALT).state = STATE.COMPLETE;
  }

  /** Release the secret for a finished hand and forget it. */
  reveal(handNo) {
    const hand = this.#hand(handNo, STATE.COMPLETE);
    this.#hands.delete(handNo);
    return {
      tableId: this.#tableId,
      handNo,
      commitment: hand.commitment,
      serverSeed: hand.serverSeed,
      clientSeeds: normalizeClientSeeds(
        [...hand.clientSeeds].map(([seat, seed]) => ({ seat, seed })),
      ),
    };
  }

  /** Drop an abandoned hand without revealing it (for example, the table closed). */
  discard(handNo) {
    this.#hands.delete(handNo);
  }
}
