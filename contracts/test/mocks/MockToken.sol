// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC-20 with the misbehaviours real stablecoins have: a blacklist (USDC), a global pause, and an
///      optional transfer fee. Decimals are configurable (6 for USDC, 18 for BSC USDT).
contract MockToken is ERC20 {
    uint8 private immutable _decimals;
    uint256 public feeBps;
    bool public paused;
    mapping(address => bool) public blocked;

    constructor(uint8 decimals_) ERC20("Mock USD", "mUSD") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function setPaused(bool isPaused) external {
        paused = isPaused;
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!paused, "token paused");
        require(!blocked[from] && !blocked[to], "blacklisted");
        if (feeBps != 0 && from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
