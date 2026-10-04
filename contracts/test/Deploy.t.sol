// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract DeployTest is Test {
    function test_deployScriptBuildsAConfiguredVault() public {
        MockToken token = new MockToken(18);
        vm.setEnv("TOKEN", vm.toString(address(token)));
        vm.setEnv("HOUSE", vm.toString(makeAddr("house")));
        vm.setEnv("ARBITER", vm.toString(makeAddr("arbiter")));
        vm.setEnv("OWNER", vm.toString(makeAddr("owner")));
        vm.setEnv("EXIT_WINDOW", "172800");
        vm.setEnv("MAX_RAKE_BPS", "300");

        Deploy script = new Deploy();
        address vault = address(script.run());
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("EXIT_WINDOW()"));
        assertTrue(ok);
        assertEq(abi.decode(data, (uint32)), 172800);
        (ok, data) = vault.staticcall(abi.encodeWithSignature("MAX_RAKE_BPS()"));
        assertEq(abi.decode(data, (uint16)), 300);
    }
}
