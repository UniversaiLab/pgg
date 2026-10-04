// The PokerVault ABI, committed as data so the browser and the server share one copy and nothing has to
// read contracts/out at run time. GENERATED: `bun packages/vault/scripts/vault-abi.js` rewrites it from
// the forge artifact, and test/abi.test.js fails when it is out of date.
export const pokerVaultAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'token_',
        type: 'address',
        internalType: 'contract IERC20',
      },
      {
        name: 'house_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'arbiter_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'owner_',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'exitWindow_',
        type: 'uint32',
        internalType: 'uint32',
      },
      {
        name: 'maxRakeBps_',
        type: 'uint16',
        internalType: 'uint16',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'EXIT_WINDOW',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'HOUSE',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_EXIT_WINDOW',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_PLAYERS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint8',
        internalType: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_RAKE_BPS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint16',
        internalType: 'uint16',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MIN_EXIT_WINDOW',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'RAKE_BPS_CEILING',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint16',
        internalType: 'uint16',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'STATE_TYPEHASH',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TOKEN',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IERC20',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'acceptOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'arbiter',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'challenge',
    inputs: [
      {
        name: 's',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
      {
        name: 'arbiterSig',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: 'playerSigs',
        type: 'bytes[]',
        internalType: 'bytes[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'createTable',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'maxPlayers',
        type: 'uint8',
        internalType: 'uint8',
      },
      {
        name: 'minDeposit',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxDeposit',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'sessionKey',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'depositState',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'players',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'domainSeparator',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'eip712Domain',
    inputs: [],
    outputs: [
      {
        name: 'fields',
        type: 'bytes1',
        internalType: 'bytes1',
      },
      {
        name: 'name',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'version',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'chainId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'verifyingContract',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'salt',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'extensions',
        type: 'uint256[]',
        internalType: 'uint256[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'finalizeExit',
    inputs: [
      {
        name: 's',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'leave',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pause',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'paused',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingOwner',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'renounceOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'seats',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'player',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'deposit',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'sessionKey',
        type: 'address',
        internalType: 'address',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setArbiter',
    inputs: [
      {
        name: 'newArbiter',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setSessionKey',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'sessionKey',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'settle',
    inputs: [
      {
        name: 's',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
      {
        name: 'arbiterSig',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: 'playerSigs',
        type: 'bytes[]',
        internalType: 'bytes[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'start',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'players',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'startExit',
    inputs: [
      {
        name: 's',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
      {
        name: 'arbiterSig',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: 'playerSigs',
        type: 'bytes[]',
        internalType: 'bytes[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'startExitFromDeposits',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'players',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'stateDigest',
    inputs: [
      {
        name: 's',
        type: 'tuple',
        internalType: 'struct PokerVault.State',
        components: [
          {
            name: 'tableId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'nonce',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'isFinal',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'players',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'balances',
            type: 'uint256[]',
            internalType: 'uint256[]',
          },
          {
            name: 'keep',
            type: 'bool[]',
            internalType: 'bool[]',
          },
          {
            name: 'rake',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'volume',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tables',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: 'status',
        type: 'uint8',
        internalType: 'enum PokerVault.Status',
      },
      {
        name: 'maxPlayers',
        type: 'uint8',
        internalType: 'uint8',
      },
      {
        name: 'seated',
        type: 'uint8',
        internalType: 'uint8',
      },
      {
        name: 'arbiter',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'nonce',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'exitDeadline',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'minDeposit',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxDeposit',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'escrow',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'rakePaid',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'rosterHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'exitDigest',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalLocked',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'transferOwnership',
    inputs: [
      {
        name: 'newOwner',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'unpause',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdraw',
    inputs: [
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdrawable',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'ArbiterChanged',
    inputs: [
      {
        name: 'arbiter',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Challenged',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'by',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'nonce',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'digest',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'deadline',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'player',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'total',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'sessionKey',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'EIP712DomainChanged',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExitFinalized',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'nonce',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'rakePaid',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'rakeDelta',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExitStarted',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'by',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'nonce',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'digest',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'deadline',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Left',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'player',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferStarted',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      {
        name: 'previousOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newOwner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Paused',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Payout',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'pushed',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SessionKeySet',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'player',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'sessionKey',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'nonce',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'rakePaid',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'rakeDelta',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'stayers',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Started',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'players',
        type: 'address[]',
        indexed: false,
        internalType: 'address[]',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TableCreated',
    inputs: [
      {
        name: 'tableId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'arbiter',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'maxPlayers',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'minDeposit',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'maxDeposit',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Unpaused',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'BadConfig',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BadKeep',
    inputs: [
      {
        name: 'index',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'BadLength',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BadRoster',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BadSessionKey',
    inputs: [],
  },
  {
    type: 'error',
    name: 'BadSignature',
    inputs: [
      {
        name: 'index',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'BadTableParams',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DepositOutOfRange',
    inputs: [],
  },
  {
    type: 'error',
    name: 'DigestMismatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignature',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureLength',
    inputs: [
      {
        name: 'length',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ECDSAInvalidSignatureS',
    inputs: [
      {
        name: 's',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
  },
  {
    type: 'error',
    name: 'EnforcedPause',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ExitWindowClosed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ExitWindowOpen',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ExpectedPause',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidShortString',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NoSeat',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotArbiter',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotConserved',
    inputs: [
      {
        name: 'claimed',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'escrow',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'NotFinal',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotMember',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NothingToWithdraw',
    inputs: [],
  },
  {
    type: 'error',
    name: 'OwnableInvalidOwner',
    inputs: [
      {
        name: 'owner',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'OwnableUnauthorizedAccount',
    inputs: [
      {
        name: 'account',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'RakeDecreased',
    inputs: [],
  },
  {
    type: 'error',
    name: 'RakeTooHigh',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReentrancyGuardReentrantCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'RenounceDisabled',
    inputs: [],
  },
  {
    type: 'error',
    name: 'RosterMismatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'StaleNonce',
    inputs: [
      {
        name: 'given',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'current',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'StringTooLong',
    inputs: [
      {
        name: 'str',
        type: 'string',
        internalType: 'string',
      },
    ],
  },
  {
    type: 'error',
    name: 'TableExists',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TableFull',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferMismatch',
    inputs: [],
  },
  {
    type: 'error',
    name: 'WrongStatus',
    inputs: [
      {
        name: 'actual',
        type: 'uint8',
        internalType: 'enum PokerVault.Status',
      },
    ],
  },
  {
    type: 'error',
    name: 'ZeroAmount',
    inputs: [],
  },
];
