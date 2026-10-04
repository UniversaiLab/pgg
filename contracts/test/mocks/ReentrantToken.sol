// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockToken} from "./MockToken.sol";

interface IReceiverHook {
    function onTokensReceived() external;
}

/// @dev An ERC-777-style token: after a transfer it calls a hook on the recipient if it is a contract.
///      Together with `HostilePlayer` it lets a recipient run code in the middle of a vault payout.
contract HookToken is MockToken {
    constructor() MockToken(6) {}

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to.code.length > 0) {
            try IReceiverHook(to).onTokensReceived() {} catch {}
        }
    }
}
