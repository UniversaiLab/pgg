// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PokerVault} from "../src/PokerVault.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Deploys one PokerVault for one token on the chain the RPC points at.
///
///   TOKEN=0x... HOUSE=0x... ARBITER=0x... OWNER=0x... \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --verify
///
/// Optional: EXIT_WINDOW (seconds, default 86400) and MAX_RAKE_BPS (default 500).
/// There are deliberately no built-in token addresses. Look up the official USDC / USDT address for the
/// chain in the issuer's documentation, check it in a block explorer, and pass it in. The script prints
/// the token's symbol and decimals so you can see you pointed at the right contract.
///
/// OWNER should be a multisig; it can pause new deposits and rotate the arbiter, and nothing else.
/// ARBITER is the game server's signing key (a KMS/HSM key on mainnet).
/// HOUSE receives the rake.
contract Deploy is Script {
    function run() external returns (PokerVault vault) {
        IERC20 token = IERC20(vm.envAddress("TOKEN"));
        address house = vm.envAddress("HOUSE");
        address arbiter = vm.envAddress("ARBITER");
        address owner = vm.envAddress("OWNER");
        uint32 exitWindow = uint32(vm.envOr("EXIT_WINDOW", uint256(1 days)));
        uint16 maxRakeBps = uint16(vm.envOr("MAX_RAKE_BPS", uint256(500)));

        console.log("chain id    ", block.chainid);
        console.log("token       ", address(token));
        console.log("token symbol", IDecimals(address(token)).symbol());
        console.log("decimals    ", IDecimals(address(token)).decimals());
        console.log("house       ", house);
        console.log("arbiter     ", arbiter);
        console.log("owner       ", owner);
        console.log("exit window ", exitWindow);
        console.log("max rake bps", maxRakeBps);

        vm.startBroadcast();
        vault = new PokerVault(token, house, arbiter, owner, exitWindow, maxRakeBps);
        vm.stopBroadcast();

        console.log("PokerVault  ", address(vault));
    }
}
