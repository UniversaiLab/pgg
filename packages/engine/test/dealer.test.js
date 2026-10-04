import { describe, expect, test } from 'bun:test';
import { CommitRevealDealer } from '../src/dealer.js';
import { deriveDeck, verifyHand } from '../src/fairness.js';

describe('CommitRevealDealer', () => {
  test('commit -> client seeds -> deal -> complete -> reveal verifies end to end', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    const { commitment } = dealer.commit(1);
    dealer.submitClientSeed(1, 3, 'aa');
    dealer.submitClientSeed(1, 0, 'bb');
    const deck = dealer.deal(1);
    dealer.complete(1);
    const proof = dealer.reveal(1);

    expect(proof.commitment).toBe(commitment);
    expect(proof.clientSeeds.map((s) => s.seat)).toEqual([0, 3]);
    expect(verifyHand({ ...proof, dealt: deck }).ok).toBe(true);
    expect(deck).toEqual(deriveDeck(proof));
  });

  test('the server cannot see or reveal its seed early', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    dealer.commit(1);
    expect(() => dealer.reveal(1)).toThrow(/committed/);
    dealer.deal(1);
    expect(() => dealer.reveal(1)).toThrow(/dealt/);
  });

  test('client seeds close once the deck is dealt', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    dealer.commit(1);
    dealer.deal(1);
    expect(() => dealer.submitClientSeed(1, 0, 'aa')).toThrow();
  });

  test('rejects duplicate, malformed and unknown-hand operations', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    dealer.commit(1);
    expect(() => dealer.commit(1)).toThrow(/already/);
    dealer.submitClientSeed(1, 0, 'aa');
    expect(() => dealer.submitClientSeed(1, 0, 'bb')).toThrow(/already/);
    expect(() => dealer.submitClientSeed(1, 1, 'not hex')).toThrow();
    expect(() => dealer.deal(99)).toThrow(/never committed/);
  });

  test('a revealed hand is forgotten, so its secret cannot be revealed twice', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    dealer.commit(1);
    dealer.deal(1);
    dealer.complete(1);
    dealer.reveal(1);
    expect(() => dealer.reveal(1)).toThrow(/never committed/);
  });

  test('can commit hand N+1 while hand N is still in play, and discard abandoned hands', () => {
    const dealer = new CommitRevealDealer({ tableId: 'tbl' });
    dealer.commit(1);
    dealer.deal(1);
    dealer.commit(2); // published during hand 1
    dealer.submitClientSeed(2, 0, 'aa');
    dealer.complete(1);
    expect(dealer.reveal(1).handNo).toBe(1);
    dealer.discard(2);
    expect(() => dealer.deal(2)).toThrow(/never committed/);
  });

  test('uses an injected seed source (deterministic tests)', () => {
    const seed = '11'.repeat(32);
    const dealer = new CommitRevealDealer({ tableId: 'tbl', newSeed: () => seed });
    dealer.commit(5);
    expect(dealer.deal(5)).toEqual(deriveDeck({ serverSeed: seed, tableId: 'tbl', handNo: 5 }));
  });
});
