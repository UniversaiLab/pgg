// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PokerVault} from "../src/PokerVault.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @dev Shared set-up: a vault on a 6-decimal token, an arbiter, a house and `N` players (sorted by address,
///      as the roster must be), each with a separate session key. Signs states the way the server and the
///      clients will.
abstract contract VaultBase is Test {
    uint256 internal constant U = 1e6; // one token, 6 decimals
    uint32 internal constant WINDOW = 1 days;
    uint16 internal constant RAKE_BPS = 500;
    bytes32 internal constant T1 = keccak256("table-1");

    PokerVault internal vault;
    MockToken internal token;

    address internal owner = makeAddr("owner");
    address internal house = makeAddr("house");
    address internal stranger = makeAddr("stranger");
    address internal arbiter;
    uint256 internal arbiterPk;

    uint256 internal constant N = 3;
    address[] internal players; // sorted ascending
    uint256[] internal sessionPks; // session key of players[i]
    address[] internal sessionKeys;

    function setUp() public virtual {
        (arbiter, arbiterPk) = makeAddrAndKey("arbiter");
        token = new MockToken(6);
        vault = new PokerVault(token, house, arbiter, owner, WINDOW, RAKE_BPS);

        address[] memory addrs = new address[](N);
        uint256[] memory pks = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            (addrs[i], pks[i]) = makeAddrAndKey(string.concat("player", vm.toString(i)));
        }
        // insertion sort by wallet address, keeping each wallet's session key beside it
        for (uint256 i = 1; i < N; ++i) {
            for (uint256 j = i; j > 0 && addrs[j - 1] > addrs[j]; --j) {
                (addrs[j - 1], addrs[j]) = (addrs[j], addrs[j - 1]);
                (pks[j - 1], pks[j]) = (pks[j], pks[j - 1]);
            }
        }
        for (uint256 i; i < N; ++i) {
            players.push(addrs[i]);
            // the session key is deliberately NOT the wallet key
            uint256 spk = uint256(keccak256(abi.encode("session", pks[i])));
            sessionPks.push(spk);
            sessionKeys.push(vm.addr(spk));
            token.mint(addrs[i], 1_000_000 * U);
            vm.prank(addrs[i]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    // ----- scenario helpers -----

    function _create(bytes32 id) internal {
        vm.prank(arbiter);
        vault.createTable(id, 6, 100 * U, 10_000 * U);
    }

    function _depositAll(bytes32 id, uint256 each) internal {
        for (uint256 i; i < N; ++i) {
            vm.prank(players[i]);
            vault.deposit(id, each, sessionKeys[i]);
        }
    }

    function _start(bytes32 id) internal {
        vm.prank(arbiter);
        vault.start(id, players);
    }

    /// @dev Open table `id`, everyone deposits `each`, arbiter starts the epoch.
    function _openAndStart(bytes32 id, uint256 each) internal {
        _create(id);
        _depositAll(id, each);
        _start(id);
    }

    function _bal(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _keep(bool a, bool b, bool c) internal pure returns (bool[] memory r) {
        r = new bool[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _state(
        bytes32 id,
        uint64 nonce,
        bool isFinal,
        uint256[] memory balances,
        bool[] memory keep,
        uint256 rake,
        uint256 volume
    ) internal view returns (PokerVault.State memory s) {
        s.tableId = id;
        s.nonce = nonce;
        s.isFinal = isFinal;
        s.players = players;
        s.balances = balances;
        s.keep = keep;
        s.rake = rake;
        s.volume = volume;
    }

    /// @dev A regular per-hand state; rake 0 unless given.
    function _hand(bytes32 id, uint64 nonce, uint256[] memory balances, uint256 rake)
        internal
        view
        returns (PokerVault.State memory)
    {
        return _state(id, nonce, false, balances, _keep(false, false, false), rake, rake == 0 ? 0 : rake * 100);
    }

    function _final(bytes32 id, uint64 nonce, uint256[] memory balances, uint256 rake)
        internal
        view
        returns (PokerVault.State memory)
    {
        return _state(id, nonce, true, balances, _keep(false, false, false), rake, rake == 0 ? 0 : rake * 100);
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signatures of the arbiter and of every player's session key over `s`.
    function _sign(PokerVault.State memory s) internal view returns (bytes memory arb, bytes[] memory ps) {
        bytes32 digest = vault.stateDigest(s);
        arb = _sig(arbiterPk, digest);
        ps = new bytes[](s.players.length);
        for (uint256 i; i < s.players.length; ++i) {
            ps[i] = _sig(sessionPks[i], digest);
        }
    }

    function _settle(PokerVault.State memory s) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vault.settle(s, arb, ps);
    }

    function _startExit(address by, PokerVault.State memory s) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.prank(by);
        vault.startExit(s, arb, ps);
    }

    function _challenge(address by, PokerVault.State memory s) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.prank(by);
        vault.challenge(s, arb, ps);
    }

    function _tokenBal(address a) internal view returns (uint256) {
        return token.balanceOf(a);
    }
}
