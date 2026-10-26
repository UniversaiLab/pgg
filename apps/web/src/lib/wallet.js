// The player's own wallet (MetaMask, Coinbase Wallet, Rabby, a wallet's in-app browser: anything that injects
// an EIP-1193 provider as window.ethereum). Loaded lazily with the vault controller, never for play money.
//
// It only moves money the player approves in their wallet: approve + deposit into the vault, leave a table
// that has not started, start an exit from the newest all-signed state this device holds, finish an exit,
// and withdraw a payout the token refused to push. The session key that signs hand states is NOT this wallet:
// it is made by the vault signer and written to storage before the deposit names it on chain.
import { addressAt, calls, stringAt, wordAt } from '@pgg/vault';

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code; // no-wallet | rejected | wrong-chain | reverted | timeout | rpc
  }
}

const hexChain = (id) => `0x${Number(id).toString(16)}`;

function asWalletError(error) {
  if (error instanceof WalletError) return error;
  // EIP-1193: 4001 = the user said no
  if (error?.code === 4001) return new WalletError('rejected', 'You cancelled it in your wallet');
  return new WalletError('rpc', error?.message ?? String(error));
}

/**
 * @param {object} options
 *   provider   EIP-1193 provider (default window.ethereum)
 *   chainId    the chain the app build pins (VITE_VAULT_CHAIN_ID)
 *   rpcUrl     offered to the wallet if it does not know the chain yet
 *   vault      the vault address the app build pins
 *   sleep      (ms) => Promise, injectable for tests
 *   pollMs     receipt polling interval
 */
export function createWallet({
  provider = globalThis.ethereum,
  chainId,
  rpcUrl = null,
  vault,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 1_000,
  receiptTimeoutMs = 180_000,
} = {}) {
  let address = null;
  let tokenInfo = null;

  const request = async (method, params = []) => {
    if (!provider?.request) throw new WalletError('no-wallet', 'No wallet found in this browser');
    try {
      return await provider.request({ method, params });
    } catch (error) {
      throw asWalletError(error);
    }
  };

  const call = (to, data) => request('eth_call', [{ to, data }, 'latest']);

  async function ensureChain() {
    const current = Number(await request('eth_chainId'));
    if (current === Number(chainId)) return;
    try {
      await request('wallet_switchEthereumChain', [{ chainId: hexChain(chainId) }]);
    } catch (error) {
      // 4902: the wallet does not know this chain; offer it (a local or test chain)
      if (
        error.code === 'rpc' &&
        rpcUrl &&
        /4902|Unrecognized|not been added/i.test(error.message)
      ) {
        await request('wallet_addEthereumChain', [
          {
            chainId: hexChain(chainId),
            chainName: `PGG chain ${chainId}`,
            rpcUrls: [rpcUrl],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          },
        ]);
      } else if (error.code === 'rejected') {
        throw new WalletError(
          'wrong-chain',
          'Switch your wallet to the table’s network to continue',
        );
      } else throw error;
    }
    if (Number(await request('eth_chainId')) !== Number(chainId)) {
      throw new WalletError('wrong-chain', 'Switch your wallet to the table’s network to continue');
    }
  }

  async function waitFor(hash) {
    const end = Date.now() + receiptTimeoutMs;
    while (Date.now() < end) {
      const receipt = await request('eth_getTransactionReceipt', [hash]);
      if (receipt) {
        if (receipt.status !== '0x1')
          throw new WalletError('reverted', 'The transaction failed on chain');
        return receipt;
      }
      await sleep(pollMs);
    }
    throw new WalletError('timeout', 'The transaction is taking long; check your wallet');
  }

  async function send(to, data) {
    if (!address) throw new WalletError('no-wallet', 'Connect your wallet first');
    await ensureChain();
    const hash = await request('eth_sendTransaction', [{ from: address, to, data }]);
    return waitFor(hash);
  }

  async function token() {
    if (tokenInfo) return tokenInfo;
    const tokenAddress = addressAt(await call(vault, calls.token()));
    const decimals = Number(wordAt(await call(tokenAddress, calls.decimals())));
    let symbol = 'USD';
    try {
      symbol = stringAt(await call(tokenAddress, calls.symbol()));
    } catch {
      // a token without symbol(): the label is only cosmetic
    }
    tokenInfo = { address: tokenAddress, decimals, symbol };
    return tokenInfo;
  }

  return {
    get available() {
      return Boolean(provider?.request);
    },
    get address() {
      return address;
    },

    /** Ask the wallet for an account and the table's chain. -> address (lowercase) */
    async connect() {
      const accounts = await request('eth_requestAccounts');
      if (!accounts?.length) throw new WalletError('rejected', 'No account was shared');
      address = String(accounts[0]).toLowerCase();
      await ensureChain();
      return address;
    },

    token,

    /** personal_sign of a text message with the connected account. */
    async signMessage(text) {
      if (!address) throw new WalletError('no-wallet', 'Connect your wallet first');
      const bytes = new TextEncoder().encode(text);
      const hexText = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      return request('personal_sign', [hexText, address]);
    },

    /** { token, balance, allowance, withdrawable } in token base units (bigint). */
    async balances() {
      const t = await token();
      const [balance, allowance, owed] = await Promise.all([
        call(t.address, calls.balanceOf(address)),
        call(t.address, calls.allowance(address, vault)),
        call(vault, calls.withdrawable(address)),
      ]);
      return {
        token: t,
        balance: wordAt(balance),
        allowance: wordAt(allowance),
        withdrawable: wordAt(owed),
      };
    },

    /**
     * Approve (only if needed) and deposit `amount` at `tableKey`, naming `sessionKey` as this seat's signer.
     * onStep('approve' | 'deposit') before each wallet prompt.
     */
    async deposit({ tableKey, amount, sessionKey, onStep = () => {} }) {
      const t = await token();
      const allowance = wordAt(await call(t.address, calls.allowance(address, vault)));
      if (allowance < amount) {
        onStep('approve');
        await send(t.address, calls.approve(vault, amount));
      }
      onStep('deposit');
      return send(vault, calls.deposit(tableKey, amount, sessionKey));
    },

    /** Test chains only: the MockToken lets anyone mint. */
    async mintTestTokens(amount) {
      const t = await token();
      return send(t.address, calls.mint(address, amount));
    },

    /** Take the deposit back while the table has not started (Filling). */
    leave: (tableKey) => send(vault, calls.leave(tableKey)),
    /** Start an exit from the newest all-signed bundle (wire or internal form, strings allowed). */
    startExit: (bundle) => send(vault, calls.startExit(bundle)),
    /** Start an exit that returns every deposit (no state was ever signed this epoch). */
    startExitFromDeposits: (tableKey, players) =>
      send(vault, calls.startExitFromDeposits(tableKey, players)),
    /** Pay out an exit once its window has passed. Anyone may call it. */
    finalizeExit: (state) => send(vault, calls.finalizeExit(state)),
    /** Pull a payout the token refused to push (a blocked recipient), to this wallet. */
    withdraw: () => send(vault, calls.withdraw(address)),
  };
}

export const formatUnits = (amount, decimals) => {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 2)}` : String(whole);
};

/** The EIP-4361 sign-in message (the server checks the same layout). */
export function siweMessage({ domain, address, uri, chainId, nonce, now = new Date() }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to PGG. This signature only proves you own this wallet; it cannot move funds.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${new Date(now.getTime() + 10 * 60_000).toISOString()}`,
  ].join('\n');
}
