// The wallet a vault-mode server hands to the Hub and the TableActor. Vault tables never move play-money
// chips (the money is in the escrow contract), so a call that still reaches the wallet is a call site that
// was missed. It must fail closed: debit refuses, nothing is ever credited, every balance is 0, and the
// invariant the play-money wallet keeps (issued === held + chips at tables) holds trivially at 0 === 0.
// Same shape as PlayMoneyWallet (apps/server/src/wallet.js) so it can be swapped in without touching a caller.

export class NullWallet {
  /** @returns {number} always 0: there is no account to open */
  open(_playerId) {
    return 0;
  }

  balance(_playerId) {
    return 0;
  }

  /** @returns {boolean} always false: nothing can be bought with chips that do not exist */
  debit(_playerId, _amount) {
    return false;
  }

  credit(_playerId, _amount) {}

  creditHouse(_amount) {}

  get house() {
    return 0;
  }

  get issued() {
    return 0;
  }

  get held() {
    return 0;
  }
}
