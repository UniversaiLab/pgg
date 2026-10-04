// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PokerVault} from "../src/PokerVault.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @dev Cross-language check. test/vectors/state.json is written by packages/protocol/scripts/vault-vector.js
///      with viem: a state, its EIP-712 digest and signatures made by viem. Here the real contract must
///      hash the same state to the same digest and accept those signatures in a real `settle`. If the
///      JS typed data and the Solidity struct ever drift apart, this test (or the JS one) fails.
contract CompatTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("test/vectors/state.json");
    }

    function _state() internal view returns (PokerVault.State memory s) {
        s.tableId = vm.parseJsonBytes32(json, ".state.tableId");
        s.nonce = uint64(vm.parseJsonUint(json, ".state.nonce"));
        s.isFinal = vm.parseJsonBool(json, ".state.isFinal");
        s.players = vm.parseJsonAddressArray(json, ".state.players");
        s.balances = vm.parseJsonUintArray(json, ".state.balances");
        s.keep = vm.parseJsonBoolArray(json, ".state.keep");
        s.rake = vm.parseJsonUint(json, ".state.rake");
        s.volume = vm.parseJsonUint(json, ".state.volume");
    }

    function _deploy(MockToken token) internal returns (PokerVault) {
        address at = vm.parseJsonAddress(json, ".vault");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo(
            "PokerVault.sol:PokerVault",
            abi.encode(
                address(token),
                makeAddr("house"),
                vm.parseJsonAddress(json, ".arbiter"),
                makeAddr("owner"),
                uint32(1 days),
                uint16(500)
            ),
            at
        );
        return PokerVault(at);
    }

    function test_contractHashesLikeViem() public {
        PokerVault vault = _deploy(new MockToken(6));
        assertEq(vault.STATE_TYPEHASH(), vm.parseJsonBytes32(json, ".stateTypehash"), "type string differs");
        assertEq(vault.domainSeparator(), vm.parseJsonBytes32(json, ".domainSeparator"), "domain differs");
        assertEq(vault.stateDigest(_state()), vm.parseJsonBytes32(json, ".digest"), "digest differs");
    }

    function test_contractAcceptsViemSignatures() public {
        MockToken token = new MockToken(6);
        PokerVault vault = _deploy(token);
        PokerVault.State memory s = _state();
        address arbiter = vm.parseJsonAddress(json, ".arbiter");
        address[] memory keys = vm.parseJsonAddressArray(json, ".sessionKeys");

        vm.prank(arbiter);
        vault.createTable(s.tableId, 6, 1e6, 10_000e6);
        for (uint256 i; i < s.players.length; ++i) {
            token.mint(s.players[i], 1_000e6);
            vm.startPrank(s.players[i]);
            token.approve(address(vault), type(uint256).max);
            vault.deposit(s.tableId, 1_000e6, keys[i]);
            vm.stopPrank();
        }
        vm.prank(arbiter);
        vault.start(s.tableId, s.players);

        bytes memory arbiterSig = vm.parseJsonBytes(json, ".signatures.arbiter");
        bytes[] memory playerSigs = vm.parseJsonBytesArray(json, ".signatures.players");
        vault.settle(s, arbiterSig, playerSigs);

        // players 0 and 2 stayed on (their chips are still in the vault), player 1 cashed out
        assertEq(token.balanceOf(s.players[1]), 900e6);
        assertEq(token.balanceOf(makeAddr("house")), 40e6);
        assertEq(token.balanceOf(address(vault)), 2_060e6);
        assertEq(vault.totalLocked(), 2_060e6);
        (uint256 d0,) = vault.seats(s.tableId, s.players[0]);
        assertEq(d0, 1_500e6);
    }

    /// @dev Flip one byte of one viem signature and the contract must refuse it.
    function test_contractRejectsACorruptedViemSignature() public {
        MockToken token = new MockToken(6);
        PokerVault vault = _deploy(token);
        PokerVault.State memory s = _state();
        address[] memory keys = vm.parseJsonAddressArray(json, ".sessionKeys");
        vm.prank(vm.parseJsonAddress(json, ".arbiter"));
        vault.createTable(s.tableId, 6, 1e6, 10_000e6);
        for (uint256 i; i < s.players.length; ++i) {
            token.mint(s.players[i], 1_000e6);
            vm.startPrank(s.players[i]);
            token.approve(address(vault), type(uint256).max);
            vault.deposit(s.tableId, 1_000e6, keys[i]);
            vm.stopPrank();
        }
        vm.prank(vm.parseJsonAddress(json, ".arbiter"));
        vault.start(s.tableId, s.players);

        bytes memory arbiterSig = vm.parseJsonBytes(json, ".signatures.arbiter");
        bytes[] memory playerSigs = vm.parseJsonBytesArray(json, ".signatures.players");
        playerSigs[1][5] = bytes1(uint8(playerSigs[1][5]) ^ 0x01);
        vm.expectRevert();
        vault.settle(s, arbiterSig, playerSigs);
    }
}
