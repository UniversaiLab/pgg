import { describe, expect, test } from 'bun:test';
import { CommitRevealDealer } from '../src/dealer.js';
import { CANONICAL_DECK, deriveDeck, verifyHand } from '../src/fairness.js';
import { IllegalActionError, PokerTable } from '../src/table.js';
import { referenceWinners } from './reference-eval.js';

/** Draw-order deck whose hole cards (seat order, 2 each) and board are as given; rest is filler. */
function craftDeck(holes, board = []) {
  const head = [...holes.flat(), ...board];
  expect(new Set(head).size).toBe(head.length); // a typo here would silently corrupt a test
  return [...head, ...CANONICAL_DECK.filter((code) => !head.includes(code))];
}

function threeHanded(options = {}, stacks = [1000, 1000, 1000]) {
  const table = new PokerTable({
    tableId: 't',
    numSeats: 6,
    smallBlind: 50,
    bigBlind: 100,
    ...options,
  });
  for (const [i, seat] of [0, 2, 5].entries()) table.sitDown(seat, stacks[i]);
  return table;
}

const passive = (legal) => (legal.actions.includes('check') ? ['check'] : ['call']);
const aggressive = (legal) => {
  if (legal.actions.includes('raise')) return ['raise', legal.max];
  if (legal.actions.includes('bet')) return ['bet', legal.max];
  return passive(legal);
};

function playOut(table, choose = passive) {
  const events = [];
  for (let guard = 0; table.inHand; guard++) {
    expect(guard).toBeLessThan(200);
    const seat = table.snapshot(null).toAct;
    const [action, amount] = choose(table.snapshot(seat).legal, seat);
    events.push(...table.act(seat, action, amount).events);
  }
  return events;
}

const totalChips = (table) => table.snapshot(null).seats.reduce((s, p) => s + (p ? p.chips : 0), 0);

describe('deck control', () => {
  test('deals exactly the supplied deck: holes in seat order, then flop, turn, river', () => {
    const table = threeHanded();
    const deck = [...CANONICAL_DECK];
    table.startHand({ deck, handNo: 1 });
    expect(table.snapshot(0).seats[0].cards).toEqual(['2c', '3c']);
    expect(table.snapshot(2).seats[2].cards).toEqual(['4c', '5c']);
    expect(table.snapshot(5).seats[5].cards).toEqual(['6c', '7c']);
    playOut(table);
    const { dealt, result } = table.lastHand();
    expect(dealt).toEqual(deck.slice(0, 11));
    expect(result.board).toEqual(deck.slice(6, 11));
  });

  test('holds on every hand, even as the button moves', () => {
    const table = threeHanded();
    for (let handNo = 1; handNo <= 6; handNo++) {
      const deck = deriveDeck({ serverSeed: '07'.repeat(32), tableId: 't', handNo });
      table.startHand({ deck, handNo });
      [0, 2, 5].forEach((seat, k) => {
        expect(table.snapshot(seat).seats[seat].cards).toEqual([deck[2 * k], deck[2 * k + 1]]);
      });
      playOut(table);
      expect(table.lastHand().dealt).toEqual(deck.slice(0, table.lastHand().dealt.length));
    }
  });

  test('rejects a malformed deck without starting a hand', () => {
    const table = threeHanded();
    const bad = [
      CANONICAL_DECK.slice(0, 51),
      [...CANONICAL_DECK.slice(0, 51), '2c'],
      [...CANONICAL_DECK.slice(0, 51), 'Zz'],
      'nope',
    ];
    for (const deck of bad) expect(() => table.startHand({ deck, handNo: 1 })).toThrow();
    expect(table.inHand).toBe(false);
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 }); // still usable
    expect(table.inHand).toBe(true);
  });
});

describe('settlement', () => {
  test('fold-out before the flop: no rake, no reveal', () => {
    const table = threeHanded({ rake: { bps: 500 } });
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    table.act(0, 'fold');
    const { events } = table.act(2, 'fold'); // BB wins
    const end = events.find((e) => e.type === 'hand-end').result;
    expect(end.rake).toBe(0);
    expect(end.pot).toBe(150);
    expect(end.reveals).toEqual([]);
    expect(end.stacks[5]).toBe(1050);
    expect(end.stacks[2]).toBe(950);
  });

  test('5% rake on a showdown is taken from the winner and recorded', () => {
    const table = threeHanded({ rake: { bps: 500 } });
    const deck = craftDeck(
      [
        ['As', 'Ah'],
        ['Ks', 'Kh'],
        ['Qs', 'Qh'],
      ],
      ['2c', '7d', '9h', 'Jc', '3s'],
    );
    table.startHand({ deck, handNo: 1 });
    playOut(table);
    const { result } = table.lastHand();
    expect(result.pot).toBe(300);
    expect(result.rake).toBe(15);
    expect(result.payouts).toEqual([{ seat: 0, gross: 300, rake: 15, net: 285 }]);
    expect(result.stacks).toEqual([1185, 0, 900, 0, 0, 900]);
    expect(table.ledger()).toEqual({ handsPlayed: 1, potVolume: 300, rakeTaken: 15, aborted: 0 });
    expect(result.reveals.map((r) => r.seat)).toEqual([0, 2, 5]);
  });

  test('side pots: short stack wins the main pot only, uncalled chips come back', () => {
    const table = threeHanded({}, [100, 300, 500]);
    const deck = craftDeck(
      [
        ['As', 'Ah'],
        ['Ks', 'Kh'],
        ['Qs', 'Qh'],
      ],
      ['2c', '7d', '9h', 'Jc', '3s'],
    );
    table.startHand({ deck, handNo: 1 });
    playOut(table, aggressive);
    const { result } = table.lastHand();
    // seat 0 (100) wins the 300 main pot; seat 2 beats seat 5 for the 400 side pot; seat 5's
    // extra 200 was never called.
    expect(result.stacks).toEqual([300, 0, 400, 0, 0, 200]);
    expect(result.pot).toBe(300 + 400 + 200);
    expect(result.rake).toBe(0);
    expect(result.pots.map((p) => [p.size, p.eligible])).toEqual([
      [300, [0, 2, 5]],
      [400, [2, 5]],
      [200, [5]],
    ]);
    expect(result.busted).toEqual([]); // everyone keeps something
  });

  test('a player who loses their whole stack is reported busted', () => {
    const table = new PokerTable({ tableId: 't', numSeats: 6, smallBlind: 50, bigBlind: 100 });
    table.sitDown(0, 500);
    table.sitDown(2, 500);
    const deck = craftDeck(
      [
        ['As', 'Ah'],
        ['Ks', 'Kh'],
      ],
      ['2c', '7d', '9h', 'Jc', '3s'],
    );
    table.startHand({ deck, handNo: 1 });
    playOut(table, aggressive);
    const { result } = table.lastHand();
    expect(result.stacks).toEqual([1000, 0, 0, 0, 0, 0]);
    expect(result.busted).toEqual([2]);
  });

  test('all-in player is not forgotten when another player folds on the turn', () => {
    // poker-ts 1.5.0 drops the all-in seat from later pots and then never deals the river. Seat 1
    // (all-in, 99) turns trip nines on the river card that poker-ts would have skipped.
    const table = new PokerTable({ tableId: 't', numSeats: 6, smallBlind: 5, bigBlind: 10 });
    for (const [seat, chips] of [1000, 100, 1000, 1000].entries()) table.sitDown(seat, chips);
    const board = ['2c', '7d', 'Kh', '3s', '9c'];
    const deck = craftDeck(
      [
        ['Qc', 'Qd'],
        ['9d', '9s'],
        ['4c', '5h'],
        ['Ah', 'Kd'],
      ],
      board,
    );
    table.startHand({ deck, handNo: 1 });
    const events = [];
    const act = (seat, action, amount) => events.push(...table.act(seat, action, amount).events);
    act(3, 'raise', 100);
    act(0, 'fold');
    act(1, 'call'); // small blind calls all-in
    act(2, 'call');
    act(2, 'check'); // flop
    act(3, 'check');
    act(2, 'fold'); // turn: leaves one player able to act plus the all-in seat
    expect(table.inHand).toBe(false);
    const { result, dealt } = table.lastHand();
    expect(result.board).toEqual(board); // the river was dealt
    expect(dealt).toEqual(deck.slice(0, 13)); // and it is the next card of the committed deck
    expect(result.stacks).toEqual([1000, 300, 900, 900, 0, 0]);
    expect(events.filter((e) => e.type === 'street').map((e) => e.round)).toEqual([
      'flop',
      'turn',
      'river',
    ]);
  });

  describe('short stack all-in (poker-ts 1.5.0 loses these payouts)', () => {
    // Seat 0 has 4 chips, below the 5/10 blinds, and calls all-in. Seat 2 posts the big blind and
    // folds. Seat 0 holds trip fives and wins the 4-chip main pot (4 x 4 = 16); seat 1's two pair
    // beats seat 3 for the 18-chip side pot.
    const deck = craftDeck(
      [
        ['3s', '5c'],
        ['6d', '4c'],
        ['8s', '8h'],
        ['Qc', '3d'],
      ],
      ['8c', '2c', '4d', '5s', '5d'],
    );
    const play = (script) => {
      const table = new PokerTable({ tableId: 'r', numSeats: 6, smallBlind: 5, bigBlind: 10 });
      for (const [seat, chips] of [4, 2524, 408, 20742].entries()) table.sitDown(seat, chips);
      table.startHand({ deck, handNo: 1 });
      for (const [seat, action] of script) table.act(seat, action);
      return table;
    };
    const preflop = [
      [3, 'call'],
      [0, 'call'],
      [1, 'call'],
      [2, 'fold'],
    ];
    const expected = [16, 2532, 398, 20732, 0, 0];

    test('check-down to showdown', () => {
      const table = play([
        ...preflop,
        [1, 'check'],
        [3, 'check'],
        [1, 'check'],
        [3, 'check'],
        [1, 'check'],
        [3, 'check'],
      ]);
      expect(table.lastHand().result.stacks).toEqual(expected);
      expect(table.lastHand().result.pots.map((p) => p.size)).toEqual([16, 18]);
    });

    test('opponent folds on the turn', () => {
      const table = play([...preflop, [1, 'check'], [3, 'check'], [1, 'check'], [3, 'fold']]);
      expect(table.lastHand().result.stacks).toEqual(expected);
    });

    test('opponent folds on the flop', () => {
      const table = play([...preflop, [1, 'check'], [3, 'fold']]);
      expect(table.lastHand().result.stacks).toEqual(expected);
    });

    test('the short-stack winner keeps their seat and their winnings', () => {
      const table = play([
        ...preflop,
        [1, 'check'],
        [3, 'check'],
        [1, 'check'],
        [3, 'check'],
        [1, 'check'],
        [3, 'check'],
      ]);
      const seats = table.snapshot(null).seats;
      expect(seats[0]).toMatchObject({ seat: 0, chips: 16 }); // poker-ts would have deleted it
      expect(table.bustedSeats()).toEqual([]);
    });
  });

  test('rake splits across winners of different pots and conserves chips', () => {
    const table = threeHanded({ rake: { bps: 500 } }, [100, 300, 500]);
    const deck = craftDeck(
      [
        ['As', 'Ah'],
        ['Ks', 'Kh'],
        ['Qs', 'Qh'],
      ],
      ['2c', '7d', '9h', 'Jc', '3s'],
    );
    table.startHand({ deck, handNo: 1 });
    playOut(table, aggressive);
    const { result } = table.lastHand();
    expect(result.rake).toBe(Math.floor((result.pot * 500) / 10000));
    expect(result.stacks.reduce((a, b) => a + b, 0) + result.rake).toBe(900);
    expect(result.payouts.reduce((s, p) => s + p.rake, 0)).toBe(result.rake);
  });

  test('every street is announced as it is dealt', () => {
    const table = threeHanded();
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    const streets = playOut(table).filter((e) => e.type === 'street');
    expect(streets.map((e) => e.round)).toEqual(['flop', 'turn', 'river']);
    expect(streets.map((e) => e.board.length)).toEqual([3, 4, 5]);
  });
});

describe('action validation', () => {
  const started = () => {
    const table = threeHanded();
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    return table;
  };

  test('rejects wrong seat, illegal action and bad amounts with stable codes', () => {
    const table = started();
    const code = (fn) => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalActionError);
        return error.code;
      }
      return 'no-error';
    };
    expect(code(() => table.act(2, 'call'))).toBe('not-your-turn');
    expect(code(() => table.act(0, 'check'))).toBe('illegal-action'); // facing the big blind
    expect(code(() => table.act(0, 'raise', 150))).toBe('bad-amount'); // below the min raise
    expect(code(() => table.act(0, 'raise', 10_000))).toBe('bad-amount'); // more than the stack
    expect(code(() => table.act(0, 'raise', 250.5))).toBe('bad-amount');
    expect(code(() => table.act(0, 'raise'))).toBe('bad-amount');
  });

  test('a rejected action changes nothing', () => {
    const table = started();
    const before = JSON.stringify(table.snapshot(0));
    expect(() => table.act(2, 'call')).toThrow();
    expect(() => table.act(0, 'raise', 1)).toThrow();
    expect(JSON.stringify(table.snapshot(0))).toBe(before);
  });

  test('nothing is actionable between hands, and seating is locked during one', () => {
    const table = threeHanded();
    expect(() => table.act(0, 'fold')).toThrow(/no-action-pending/);
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    expect(() => table.sitDown(1, 100)).toThrow(IllegalActionError);
    expect(() => table.standUp(0)).toThrow(IllegalActionError);
    expect(() => table.startHand({ deck: [...CANONICAL_DECK], handNo: 2 })).toThrow();
  });

  test('timeoutAction checks when free and folds otherwise', () => {
    const table = started();
    expect(table.timeoutAction()).toEqual({ seat: 0, action: 'fold' }); // facing the blind
    table.act(0, 'call');
    table.act(2, 'call');
    expect(table.timeoutAction()).toEqual({ seat: 5, action: 'check' }); // BB option
    expect(threeHanded().timeoutAction()).toBeNull();
  });
});

describe('stacks, button and aborts', () => {
  const dealHand = (table, handNo) => table.startHand({ deck: [...CANONICAL_DECK], handNo });
  const foldAround = (table) => {
    while (table.inHand) table.act(table.toAct, 'fold');
  };

  test('the button rotates through occupied seats and skips empty ones', () => {
    const table = threeHanded(); // seats 0, 2, 5
    const buttons = [];
    for (let handNo = 1; handNo <= 7; handNo++) {
      dealHand(table, handNo);
      buttons.push(table.snapshot(null).button);
      foldAround(table);
    }
    expect(buttons).toEqual([0, 2, 5, 0, 2, 5, 0]);
  });

  test('the button moves on when its owner leaves', () => {
    const table = threeHanded();
    dealHand(table, 1); // button 0
    foldAround(table);
    table.standUp(2);
    dealHand(table, 2);
    expect(table.snapshot(null).button).toBe(5); // seat 2 is empty, so next is seat 5
    expect(table.snapshot(null).seats[2]).toBeNull();
  });

  test('seating works on the table between hands, and not during one', () => {
    const table = threeHanded();
    expect(table.chipsAt(0)).toBe(1000);
    expect(table.chipsAt(1)).toBeNull();
    table.topUp(0, 250);
    expect(table.chipsAt(0)).toBe(1250);
    expect(table.standUp(0)).toBe(1250);
    expect(table.chipsAt(0)).toBeNull();
    expect(table.totalChips()).toBe(2000);
    expect(() => table.standUp(0)).toThrow(IllegalActionError);
    expect(() => table.topUp(0, 10)).toThrow(IllegalActionError);
    expect(() => table.sitDown(2, 10)).toThrow(IllegalActionError); // taken
    dealHand(table, 1);
    expect(() => table.topUp(2, 10)).toThrow(IllegalActionError);
  });

  test('aborting a hand refunds everyone and the table carries on', () => {
    const table = threeHanded({ rake: { bps: 300 } });
    dealHand(table, 1);
    table.act(table.toAct, 'raise', 400);
    expect(table.totalChips()).toBe(3000);
    const { events } = table.abortHand('test');
    expect(events).toEqual([{ type: 'hand-aborted', handNo: 1, reason: 'test' }]);
    expect(table.inHand).toBe(false);
    for (const seat of [0, 2, 5]) expect(table.chipsAt(seat)).toBe(1000);
    expect(table.lastHand()).toBeNull();
    expect(table.ledger()).toMatchObject({ handsPlayed: 0, rakeTaken: 0, aborted: 1 });
    expect(table.abortHand().events).toEqual([]); // nothing to abort now
    dealHand(table, 2); // and the next hand deals normally
    playOut(table);
    expect(table.totalChips() + table.ledger().rakeTaken).toBe(3000);
  });

  test('all-in players keep their claim on the pot through later betting rounds', () => {
    // Seats 0 and 2 are short stacks that go all-in on the flop and tie (A-K high). Seats 3 and 5
    // stay in and keep betting. Seat 1 folds the small blind, making the pot odd (249).
    // poker-ts 1.5.0 drops the all-in seats from the pot and awards all 249 to seat 5, who lost.
    const table = new PokerTable({ tableId: 'r', numSeats: 6, smallBlind: 5, bigBlind: 10 });
    for (const [seat, chips] of [
      [0, 61],
      [1, 1000],
      [2, 61],
      [3, 1000],
      [5, 1000],
    ]) {
      table.sitDown(seat, chips);
    }
    table.startHand({
      deck: craftDeck(
        [
          ['As', 'Kd'],
          ['2h', '3h'],
          ['Ah', 'Kc'],
          ['4d', '5h'],
          ['6d', '7c'],
        ],
        ['2c', '9h', 'Jc', 'Qd', '3s'],
      ),
      handNo: 1,
    });
    const script = [
      [3, 'call'],
      [5, 'call'],
      [0, 'call'],
      [1, 'fold'],
      [2, 'check'],
      [2, 'bet', 51],
      [3, 'call'],
      [5, 'call'],
      [0, 'call'],
      [3, 'check'],
      [5, 'check'],
      [3, 'check'],
      [5, 'check'],
    ];
    for (const [seat, action, amount] of script) table.act(seat, action, amount);
    const { result } = table.lastHand();
    // 249 split two ways; the odd chip goes to the first winner clockwise from the button (seat 2).
    expect(result.stacks).toEqual([124, 995, 125, 939, 0, 939]);
    expect(result.pots.map((p) => [p.size, p.eligible, p.winners.map((w) => w.seat)])).toEqual([
      [249, [0, 2, 3, 5], [0, 2]],
    ]);
  });
});

describe('information hiding', () => {
  test("a seat's snapshot never contains another seat's hole cards", () => {
    const table = threeHanded();
    const deck = craftDeck(
      [
        ['As', 'Ah'],
        ['Ks', 'Kh'],
        ['Qs', 'Qh'],
      ],
      ['2c', '7d', '9h', 'Jc', '3s'],
    );
    table.startHand({ deck, handNo: 1 });
    const mine = JSON.stringify(table.snapshot(0));
    expect(mine).toContain('"As"');
    for (const hidden of ['"Ks"', '"Kh"', '"Qs"', '"Qh"']) expect(mine).not.toContain(hidden);
    const spectator = JSON.stringify(table.snapshot(null));
    for (const card of ['"As"', '"Ah"', '"Ks"', '"Kh"', '"Qs"', '"Qh"']) {
      expect(spectator).not.toContain(card);
    }
  });

  test('a bet range is only reported when betting or raising is actually legal', () => {
    // Seat 2 has 150 chips (100 left after the small blind) facing a raise to 500: it can only
    // call all-in or fold. poker-ts still reports a range; we must not pass it on.
    const table = threeHanded({}, [1000, 150, 1000]);
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    table.act(0, 'raise', 500);
    const legal = table.snapshot(2).legal;
    expect(legal.actions).not.toContain('raise');
    expect(legal.actions).not.toContain('bet');
    expect(legal.min).toBeUndefined();
    expect(legal.max).toBeUndefined();
    expect(legal.toCall).toBe(100); // all it has left

    const open = threeHanded();
    open.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    const free = open.snapshot(0).legal;
    expect(free.actions).toContain('raise');
    expect(free.min).toBeLessThanOrEqual(free.max);
  });

  test('legal actions are only offered to the seat on the clock', () => {
    const table = threeHanded();
    table.startHand({ deck: [...CANONICAL_DECK], handNo: 1 });
    expect(table.snapshot(0).legal).not.toBeNull();
    expect(table.snapshot(2).legal).toBeNull();
    expect(table.snapshot(null).legal).toBeNull();
    expect(table.snapshot(0).legal.toCall).toBe(100);
  });
});

describe('fuzz: random legal play', () => {
  // Deterministic LCG so any failure is reproducible from the hand number in the message.
  const makeRand = (seed) => {
    let state = seed;
    return (n) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
  };

  // FUZZ_HANDS / FUZZ_SEED let you run far longer locally: FUZZ_HANDS=20000 bun test -t fuzz
  const HANDS = Number(process.env.FUZZ_HANDS ?? 300);
  const SEED = Number(process.env.FUZZ_SEED ?? 2024);

  test(`${HANDS} hands: chips conserved, proofs verify, winners match the reference evaluator`, () => {
    const rand = makeRand(SEED);
    const table = new PokerTable({
      tableId: 'fuzz',
      numSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      rake: { bps: 300, cap: 40 },
    });
    let seedCounter = 0;
    const dealer = new CommitRevealDealer({
      tableId: 'fuzz',
      newSeed: () => (++seedCounter).toString(16).padStart(64, '0'),
    });
    let showdowns = 0;
    let multiPot = 0;
    let rakeSeen = 0;

    for (let handNo = 1; handNo <= HANDS; handNo++) {
      // Keep at least 3 players with a mix of deep and short stacks.
      for (const seat of table.bustedSeats()) table.standUp(seat);
      for (let seat = 0; seat < 6 && table.playableSeats().length < 4; seat++) {
        if (!table.snapshot(null).seats[seat]) table.sitDown(seat, 20 + rand(980));
      }

      const before = totalChips(table);
      const { commitment } = dealer.commit(handNo);
      for (const seat of table.playableSeats())
        dealer.submitClientSeed(handNo, seat, `${seat}f`.padStart(4, '0'));
      const deck = dealer.deal(handNo);
      table.startHand({ deck, handNo });

      const chipsBefore = table.totalChips();
      for (let guard = 0; table.inHand; guard++) {
        expect(guard).toBeLessThan(300);
        expect(table.totalChips(), `hand ${handNo} mid-hand`).toBe(chipsBefore);
        const seat = table.snapshot(null).toAct;
        const legal = table.snapshot(seat).legal;
        const roll = rand(100);
        if (roll < 18 && legal.actions.includes('fold')) {
          table.act(seat, 'fold');
        } else if (
          roll < 40 &&
          (legal.actions.includes('raise') || legal.actions.includes('bet'))
        ) {
          const kind = legal.actions.includes('raise') ? 'raise' : 'bet';
          const span = legal.max - legal.min;
          const amount = rand(4) === 0 ? legal.max : legal.min + rand(Math.min(span, 60) + 1);
          table.act(seat, kind, amount);
        } else {
          table.act(seat, legal.actions.includes('check') ? 'check' : 'call');
        }
      }

      const { result, dealt } = table.lastHand();
      const where = `hand ${handNo}`;
      expect(result.stacks.reduce((a, b) => a + b, 0) + result.rake, where).toBe(before);
      expect(
        result.payouts.reduce((s, p) => s + p.gross, 0),
        where,
      ).toBe(result.pot);

      dealer.complete(handNo);
      const proof = dealer.reveal(handNo);
      expect(proof.commitment).toBe(commitment);
      expect(verifyHand({ ...proof, dealt }).ok, where).toBe(true);

      rakeSeen += result.rake;
      if (result.reveals.length > 1) {
        showdowns++;
        if (result.pots.length > 1) multiPot++;
        // Our settlement (pokersolver) must match a brute-force reference evaluator on every pot.
        const hole = new Map(result.reveals.map((r) => [r.seat, r.cards]));
        for (const pot of result.pots) {
          if (pot.eligible.length < 2) continue;
          const reference = referenceWinners(
            pot.eligible.map((seat) => [seat, hole.get(seat)]),
            result.board,
          );
          expect(
            pot.winners.map((w) => w.seat).sort((a, b) => a - b),
            where,
          ).toEqual(reference);
        }
      }
    }

    // The run must actually exercise the interesting paths, or the checks above prove little.
    expect(showdowns).toBeGreaterThan(HANDS / 8);
    expect(multiPot).toBeGreaterThan(HANDS / 100);
    expect(rakeSeen).toBeGreaterThan(0);
    if (process.env.FUZZ_REPORT) {
      console.log(
        `fuzz: ${HANDS} hands, ${showdowns} showdowns, ${multiPot} multi-pot, ${rakeSeen} rake`,
      );
    }
  }, 600_000); // long runs (FUZZ_HANDS) are synchronous; the default 5s timeout would flag them
});
