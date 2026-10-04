// Play-money ledger, in memory. Everything that moves chips goes through here so a test (and,
// later, the Postgres-backed version) can prove nothing is created or destroyed:
//   sum(balances) + chips at tables + house === total ever issued

export class PlayMoneyWallet {
  #balances = new Map();
  #house = 0;
  #issued = 0;
  #startBalance;

  constructor({ startBalance }) {
    this.#startBalance = startBalance;
  }

  /** Create the account on first sight; a no-op after that. */
  open(playerId) {
    if (!this.#balances.has(playerId)) {
      this.#balances.set(playerId, this.#startBalance);
      this.#issued += this.#startBalance;
    }
    return this.#balances.get(playerId);
  }

  balance(playerId) {
    return this.#balances.get(playerId) ?? 0;
  }

  /** @returns {boolean} false (and no change) when the balance is too low */
  debit(playerId, amount) {
    const balance = this.#balances.get(playerId);
    if (!Number.isSafeInteger(amount) || amount <= 0 || balance === undefined || balance < amount) {
      return false;
    }
    this.#balances.set(playerId, balance - amount);
    return true;
  }

  credit(playerId, amount) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('bad credit amount');
    if (!this.#balances.has(playerId)) throw new Error('unknown player');
    this.#balances.set(playerId, this.#balances.get(playerId) + amount);
  }

  creditHouse(amount) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('bad house amount');
    this.#house += amount;
  }

  get house() {
    return this.#house;
  }

  /** Chips handed out so far; the invariant above must always equal this. */
  get issued() {
    return this.#issued;
  }

  /** Balances plus house. Add the chips sitting at tables to compare with `issued`. */
  get held() {
    let total = this.#house;
    for (const balance of this.#balances.values()) total += balance;
    return total;
  }
}
