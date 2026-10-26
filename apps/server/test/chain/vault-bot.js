// A headless player at a vault table, over a real WebSocket and a real chain. It is the scripted Bot of
// ../bot.js (login, connect, check/call play) plus what a browser does at a vault table:
//
//   - its wallet (a funded anvil account) mints test tokens, approves and deposits with viem, after the
//     session key is written to storage (a Map standing in for localStorage);
//   - every vault message goes through the web app's own controller (apps/web/src/lib/vault.js), which
//     is @pgg/vault's createSigner and createLedger with an RPC chain view of the anvil node, so epochs
//     are pinned against the chain and every signreq is judged against the stacks this bot saw;
//   - it can leave, go silent (its signatures are held back, not sent), come back (they are sent), keep
//     every bundle it was shown, and call the contract itself (a stale startExit).
import { CLIENT, ERR, SERVER } from '@pgg/protocol/constants';
import { createRpcChainView, createSigner, fromWire, RECORD_PREFIX } from '@pgg/vault';
import { createVaultController } from '../../../web/src/lib/vault.js';
import { Bot } from '../bot.js';

/** A synchronous localStorage over a Map. */
export function mapStorage(map = new Map()) {
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

export class VaultBot extends Bot {
  /**
   * @param {object} options  Bot's options, plus
   *   node      startAnvil()'s node (walletFor, publicClient, account)
   *   deployed  deployVault()'s result (token, vault, ABIs)
   *   tableId   the game table id ('vault-1')
   */
  constructor({ node, deployed, tableId = 'vault-1', ...options }) {
    super({ aggression: 0, ...options });
    this.node = node;
    this.deployed = deployed;
    this.vaultTableId = tableId;
    this.domain = { chainId: node.chainId, verifyingContract: deployed.vault.toLowerCase() };
    this.storage = mapStorage();
    this.signer = createSigner({ storage: this.storage, now: () => Date.now() });
    this.bundles = []; // every BUNDLE message received, wire form, in order
    this.deals = []; // { handNo, epoch, head, held } at every new hand this bot saw dealt
    this.genesis = null; // the nonce of the newest epoch message's genesis state
    this.silent = false;
    this.held = new Map(); // nonce -> the sig message held back while silent
    this.sentSigs = 0;
    this.claimRetries = 0;
    this.wallet = null; // the viem account
    this.address = null;
    this.tableKey = null;
    this.#lastDealt = null;
    this.controller = createVaultController({
      storage: this.storage,
      send: (message) => this.#controllerSend(message),
      chainView: createRpcChainView({ rpcUrl: node.rpcUrl, vault: deployed.vault }),
      domain: this.domain,
      locks: null, // one "tab": the storage lease is always this bot's
      tabId: `bot-${options.name}`,
    });
    this.onMessageHook = (msg) => this.#vaultMessage(msg);
  }

  #lastDealt;

  // ---- money on chain --------------------------------------------------------------------------

  async #write(address, abi, functionName, args) {
    const hash = await this.node
      .walletFor(this.wallet)
      .writeContract({ address, abi, functionName, args });
    const receipt = await this.node.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${this.name}: ${functionName} reverted`);
    return receipt;
  }

  /** The wallet's token balance (bigint). */
  tokens() {
    const { token, tokenAbi } = this.deployed;
    return this.node.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [this.wallet.address],
    });
  }

  /**
   * Mint `amount` test tokens, make the session key (written to storage BEFORE the deposit exists),
   * approve and deposit at `tableKey`. `unit` is the table's chipUnit (bigint).
   */
  async deposit(tableKey, amount, unit) {
    this.wallet ??= await this.node.account(`vault-bot:${this.name}`);
    this.address = this.wallet.address.toLowerCase();
    this.tableKey = tableKey.toLowerCase();
    const made = this.signer.ensureSessionKey(this.tableKey, {
      wallet: this.address,
      domain: this.domain,
      unit,
    });
    if (!made.ok) throw new Error(`${this.name}: no session key (${made.kind})`);
    const { token, tokenAbi, vault, vaultAbi } = this.deployed;
    await this.#write(token, tokenAbi, 'mint', [this.wallet.address, amount]);
    await this.#write(token, tokenAbi, 'approve', [vault, amount]);
    await this.#write(vault, vaultAbi, 'deposit', [this.tableKey, amount, made.address]);
    return made.address;
  }

  /** Call startExit with a bundle this bot was shown (wire form), straight from the wallet. */
  async startExit(bundle) {
    const { vault, vaultAbi } = this.deployed;
    return this.#write(vault, vaultAbi, 'startExit', [
      fromWire(bundle.state),
      bundle.arbiterSig,
      [...bundle.playerSigs],
    ]);
  }

  // ---- the vault table -------------------------------------------------------------------------

  /** Claim every vault table this bot holds a key for, as the web app does after each welcome. */
  claim() {
    return this.controller.claimAll();
  }

  /** Press Leave: the controller notes the head nonce first (rule C2), then the request goes out. */
  vaultLeave() {
    this.controller.noteLeave(this.vaultTableId);
    this.send({ t: CLIENT.LEAVE });
  }

  /** Stop answering: signatures are still made (and recorded) but held back. */
  goSilent() {
    this.silent = true;
  }

  /** Answer again: the held signatures go out (a re-sent signreq gets the identical one anyway). */
  comeBack() {
    this.silent = false;
    for (const message of this.held.values()) this.#controllerSend(message);
    this.held.clear();
  }

  /** What the controller shows for the table (signedNonce, bundleNonce, failure, refused, ...). */
  get ui() {
    return this.controller.state(this.vaultTableId);
  }

  /** This bot's durable record (the signer's), parsed. */
  get record() {
    const raw = this.storage.getItem(RECORD_PREFIX + this.tableKey);
    return raw ? JSON.parse(raw) : null;
  }

  /** The newest bundle this bot was shown (wire form), or null. */
  get newestBundle() {
    let best = null;
    for (const b of this.bundles) {
      if (best === null || BigInt(b.state.nonce) > BigInt(best.state.nonce)) best = b;
    }
    return best;
  }

  /** Point the bot at a (restarted) server and reconnect with the same login token. */
  async reconnect({ url, wsUrl }) {
    this.close();
    this.httpUrl = url;
    this.wsUrl = wsUrl;
    this.tableId = null;
    this.seat = null;
    await this.login(this.token);
    await this.connect();
  }

  #controllerSend(message) {
    if (message.t === CLIENT.SIGN && this.silent) {
      this.held.set(message.nonce, message);
      return true;
    }
    if (!this.connected) return false;
    if (message.t === CLIENT.SIGN) this.sentSigs += 1;
    this.send(message);
    return true;
  }

  #vaultMessage(msg) {
    switch (msg.t) {
      case SERVER.WELCOME:
        this.controller.setContext({ playerId: msg.player.id, tables: msg.tables });
        // the server keeps no binding across a restart: a device with a key claims on every welcome
        this.controller.claimAll();
        return undefined;
      case SERVER.LOBBY:
        this.controller.setContext({ tables: msg.tables });
        return undefined;
      case SERVER.ERROR:
        if (msg.code === ERR.CLAIM_PENDING && this.claimRetries < 50) {
          this.claimRetries += 1;
          setTimeout(() => this.connected && this.controller.claimAll(), 200);
        }
        return undefined;
      case SERVER.BUNDLE:
        this.bundles.push(msg);
        return this.controller.handle(msg);
      case SERVER.TABLE:
        this.#noteDeal(msg.state);
        return this.controller.handle(msg);
      case SERVER.EPOCH:
        this.genesis = BigInt(msg.state.nonce);
        return this.controller.handle(msg);
      case SERVER.SIGN_REQ:
      case SERVER.UNSEATED:
        return this.controller.handle(msg);
      default:
        return undefined;
    }
  }

  // At every new deal: the head nonce the table shows and the newest all-signed state this bot holds (its
  // newest bundle, or the epoch's genesis before the epoch's first hand). The server sends bundle(n) before
  // anything that follows state n, so at a deal the two must be equal (S1).
  #noteDeal(state) {
    if (!state?.vault || !state.inHand || state.handNo === this.#lastDealt) return;
    this.#lastDealt = state.handNo;
    let held = this.genesis;
    const newest = this.newestBundle;
    if (newest && (held === null || BigInt(newest.state.nonce) > held)) {
      held = BigInt(newest.state.nonce);
    }
    this.deals.push({
      handNo: state.handNo,
      epoch: state.vault.epoch,
      head: state.vault.nonce,
      held: held === null ? null : String(held),
    });
  }
}
