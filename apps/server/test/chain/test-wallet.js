// The Node side of a fake browser wallet for UI tests: a page gets window.ethereum (an EIP-1193 provider)
// whose requests land here. Accounts and signing come from a test key; everything else is forwarded to the
// anvil node. Never point it at a real chain.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** In-page script: window.ethereum forwarding every request to the exposed function `__pggWallet`. */
export const INJECTED_PROVIDER = `
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      const answer = await window.__pggWallet(method, params ?? []);
      if (answer && answer.error) {
        const error = new Error(answer.error.message);
        error.code = answer.error.code;
        throw error;
      }
      return answer.result;
    },
    on() {},
    removeListener() {},
  };
`;

/**
 * -> (method, params) => Promise<{ result } | { error: { code, message } }>, for page.exposeFunction.
 * `reject` (a set of method names) makes those requests fail as if the user said no.
 */
export function testWalletHandler({ node, privateKey, reject = new Set() }) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: node.chain, transport: http(node.rpcUrl) });
  const rpc = async (method, params) => {
    const res = await fetch(node.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return res.json();
  };
  return async (method, params) => {
    try {
      if (reject.has(method))
        return { error: { code: 4001, message: 'User rejected the request' } };
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return { result: [account.address] };
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return { result: null };
        case 'eth_sendTransaction': {
          const tx = params[0];
          const hash = await wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : 0n,
          });
          return { result: hash };
        }
        default: {
          const body = await rpc(method, params);
          return body.error ? { error: body.error } : { result: body.result };
        }
      }
    } catch (error) {
      return {
        error: { code: -32000, message: error?.shortMessage ?? error?.message ?? String(error) },
      };
    }
  };
}

/** The viem account of a test key (callers outside the server package have no viem of their own). */
export const accountOf = (privateKey) => privateKeyToAccount(privateKey);
