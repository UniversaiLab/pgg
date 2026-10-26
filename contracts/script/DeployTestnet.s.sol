// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PokerVault} from "../src/PokerVault.sol";
import {MockToken} from "../test/mocks/MockToken.sol";

/// @notice TESTNETS ONLY (Polygon Amoy, BSC testnet, a local anvil): deploys a MockToken that anyone may mint
///         (6 decimals, like USDC) and a PokerVault for it, so the whole app can be played with free test money.
///         Never use this on a mainnet: use Deploy.s.sol with the issuer's real token address.
///
///   HOUSE=0x... ARBITER=0x... OWNER=0x... \
///   forge script script/DeployTestnet.s.sol --rpc-url $RPC --broadcast
///
/// Optional: EXIT_WINDOW (seconds, default 3600, the contract's minimum) and MAX_RAKE_BPS (default 500).
contract DeployTestnet is Script {
    function run() external returns (MockToken token, PokerVault vault) {
        require(block.chainid != 1 && block.chainid != 137 && block.chainid != 56, "testnets only");
        address house = vm.envAddress("HOUSE");
        address arbiter = vm.envAddress("ARBITER");
        address owner = vm.envAddress("OWNER");
        uint32 exitWindow = uint32(vm.envOr("EXIT_WINDOW", uint256(1 hours)));
        uint16 maxRakeBps = uint16(vm.envOr("MAX_RAKE_BPS", uint256(500)));

        vm.startBroadcast();
        token = new MockToken(6);
        vault = new PokerVault(IERC20(address(token)), house, arbiter, owner, exitWindow, maxRakeBps);
        vm.stopBroadcast();

        console.log("chain id    ", block.chainid);
        console.log("MockToken   ", address(token));
        console.log("PokerVault  ", address(vault));
        console.log("arbiter     ", arbiter);
        console.log("exit window ", exitWindow);
    }
}
