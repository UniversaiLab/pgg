// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PokerVault} from "../../src/PokerVault.sol";
import {IReceiverHook} from "./ReentrantToken.sol";

/// @dev A player that is a contract. When the vault pays it, it uses the token hook to call back into the
///      vault with something that would succeed if the vault were not protected against re-entrancy
///      (depositing into a table that has just gone back to Filling).
contract HostilePlayer is IReceiverHook {
    PokerVault public immutable VAULT;
    bytes32 public tableId;
    bool public armed;
    bool public attempted;
    bool public reentered;

    constructor(PokerVault vault_) {
        VAULT = vault_;
    }

    function approveVault(IERC20 token) external {
        token.approve(address(VAULT), type(uint256).max);
    }

    function deposit(bytes32 id, uint256 amount, address sessionKey) external {
        VAULT.deposit(id, amount, sessionKey);
    }

    function leave(bytes32 id) external {
        VAULT.leave(id);
    }

    function withdraw() external {
        VAULT.withdraw(address(this));
    }

    function arm(bytes32 id) external {
        (tableId, armed) = (id, true);
    }

    function onTokensReceived() external override {
        if (!armed) return;
        armed = false;
        attempted = true;
        try VAULT.deposit(tableId, 10e6, address(this)) {
            reentered = true;
        } catch {}
    }
}
