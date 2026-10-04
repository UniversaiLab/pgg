// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaultBase} from "./Base.t.sol";
import {PokerVault} from "../src/PokerVault.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @dev Drives the vault with random but well-formed activity: funding a table, starting an epoch, signed
///      hand states, cooperative settles with rollover, exits from stale and fresh states, challenges,
///      finalising after the window, a recipient getting blacklisted, and withdrawals. Calls that the vault
///      rightly refuses are ignored; the invariants in the test contract must hold after every sequence.
///
///      Each action is a whole step that usually succeeds (fund everybody, start whoever is seated, ...),
///      because single-call actions almost never chain into an exit. `hits` counts what really happened,
///      and `test_scriptReachesEveryPath` proves every path is reachable.
contract VaultHandler is Test {
    uint256 internal constant U = 1e6;

    PokerVault public vault;
    MockToken public token;
    address public arbiter;
    uint256 public arbiterPk;
    address public house;
    address[] public players;
    uint256[] public sessionPks;
    address[] public sessionKeys;

    bytes32[2] public tableIds = [keccak256("inv-1"), keccak256("inv-2")];
    mapping(bytes32 => address[]) internal roster; // set while an epoch is running
    mapping(bytes32 => uint64) internal lastNonce;
    mapping(bytes32 => PokerVault.State[]) internal history;
    mapping(bytes32 => uint256) internal epochFrom; // index in `history` where the running epoch begins
    mapping(bytes32 => PokerVault.State) internal pendingExit;
    mapping(bytes32 => bool) internal hasPendingExit;

    mapping(bytes32 => uint256) public hits;
    bytes32 internal constant H_DEPOSIT = "deposit";
    bytes32 internal constant H_LEAVE = "leave";
    bytes32 internal constant H_START = "start";
    bytes32 internal constant H_SETTLE = "settle";
    bytes32 internal constant H_ROLLOVER = "rollover"; // a settle where somebody stayed
    bytes32 internal constant H_EXIT = "exit";
    bytes32 internal constant H_EXIT_STALE = "exitStale"; // an exit from a state that was not the newest
    bytes32 internal constant H_DEPOSIT_EXIT = "exitDeposits";
    bytes32 internal constant H_CHALLENGE = "challenge";
    bytes32 internal constant H_FINALIZE = "finalize";
    bytes32 internal constant H_CREDIT = "credit"; // a payout the token refused, parked for pulling
    bytes32 internal constant H_WITHDRAW = "withdraw";

    constructor(
        PokerVault vault_,
        MockToken token_,
        address arbiter_,
        uint256 arbiterPk_,
        address house_,
        address[] memory players_,
        uint256[] memory sessionPks_,
        address[] memory sessionKeys_
    ) {
        (vault, token, arbiter, arbiterPk, house) = (vault_, token_, arbiter_, arbiterPk_, house_);
        players = players_;
        sessionPks = sessionPks_;
        sessionKeys = sessionKeys_;
        for (uint256 i; i < tableIds.length; ++i) {
            vm.prank(arbiter_);
            vault_.createTable(tableIds[i], 3, 10 * U, 1_000_000 * U);
        }
    }

    function tableCount() external view returns (uint256) {
        return tableIds.length;
    }

    // ----- helpers -----

    function _id(uint256 t) internal view returns (bytes32) {
        return tableIds[bound(t, 0, tableIds.length - 1)];
    }

    function _tbl(bytes32 id)
        internal
        view
        returns (PokerVault.Status status, uint64 nonce, uint64 deadline, uint256 escrow, uint256 rakePaid)
    {
        (status,,,, nonce, deadline,,, escrow, rakePaid,,) = vault.tables(id);
    }

    function _creditTotal() internal view returns (uint256 total) {
        for (uint256 i; i < players.length; ++i) {
            total += vault.withdrawable(players[i]);
        }
        total += vault.withdrawable(house);
    }

    /// @dev A state from the running epoch (or, with `anyEpoch`, from anywhere in the table's history).
    function _pickState(bytes32 id, uint256 pick, bool anyEpoch)
        internal
        view
        returns (bool ok, PokerVault.State memory s)
    {
        PokerVault.State[] storage h = history[id];
        uint256 from = anyEpoch ? 0 : epochFrom[id];
        if (h.length <= from) return (false, s);
        return (true, h[from + bound(pick, 0, h.length - from - 1)]);
    }

    function _sign(PokerVault.State memory s) internal view returns (bytes memory arb, bytes[] memory ps) {
        bytes32 digest = vault.stateDigest(s);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(arbiterPk, digest);
        arb = abi.encodePacked(r, sg, v);
        ps = new bytes[](s.players.length);
        for (uint256 i; i < s.players.length; ++i) {
            for (uint256 j; j < players.length; ++j) {
                if (players[j] == s.players[i]) {
                    (v, r, sg) = vm.sign(sessionPks[j], digest);
                    ps[i] = abi.encodePacked(r, sg, v);
                }
            }
        }
    }

    /// @dev A random state that is valid for the table as it stands now: conserves its escrow, respects the
    ///      rake cap, uses a fresh nonce.
    function _makeState(bytes32 id, bool isFinal, uint256 seed) internal returns (PokerVault.State memory s) {
        (, uint64 nonce,, uint256 escrow, uint256 rakePaid) = _tbl(id);
        address[] storage r = roster[id];
        uint256 n = r.length;
        uint64 next = lastNonce[id] > nonce ? lastNonce[id] + 1 : nonce + 1;
        lastNonce[id] = next;

        uint256 rakeDelta = uint256(keccak256(abi.encode(seed, "rake"))) % (escrow / 20 + 1);
        uint256 left = escrow - rakeDelta;
        s.tableId = id;
        s.nonce = next;
        s.isFinal = isFinal;
        s.players = r;
        s.balances = new uint256[](n);
        s.keep = new bool[](n);
        for (uint256 i; i + 1 < n; ++i) {
            uint256 take = uint256(keccak256(abi.encode(seed, i))) % (left + 1);
            s.balances[i] = take;
            left -= take;
        }
        s.balances[n - 1] = left;
        s.rake = rakePaid + rakeDelta;
        s.volume = s.rake * 20;
        if (isFinal) {
            for (uint256 i; i < n; ++i) {
                s.keep[i] = (seed >> i) & 1 == 1 && s.balances[i] > 0;
            }
        }
    }

    // ----- actions -----

    /// @dev Everybody whose bit is set in `mask` deposits a random amount (a top-up if already seated).
    function fund(uint256 t, uint256 mask, uint256 seed) external {
        bytes32 id = _id(t);
        for (uint256 i; i < players.length; ++i) {
            if ((mask >> i) & 1 == 0) continue;
            uint256 amount = 10 * U + (uint256(keccak256(abi.encode(seed, i))) % (50_000 * U));
            vm.prank(players[i]);
            try vault.deposit(id, amount, sessionKeys[i]) {
                hits[H_DEPOSIT]++;
            } catch {}
        }
    }

    function leave(uint256 p, uint256 t) external {
        vm.prank(players[bound(p, 0, players.length - 1)]);
        try vault.leave(_id(t)) {
            hits[H_LEAVE]++;
        } catch {}
    }

    /// @dev The arbiter starts the epoch with whoever is seated.
    function start(uint256 t) external {
        bytes32 id = _id(t);
        address[] memory seated = new address[](players.length);
        uint256 count;
        for (uint256 i; i < players.length; ++i) {
            (uint256 dep,) = vault.seats(id, players[i]);
            if (dep > 0) seated[count++] = players[i];
        }
        address[] memory r = new address[](count);
        for (uint256 i; i < count; ++i) {
            r[i] = seated[i];
        }
        vm.prank(arbiter);
        try vault.start(id, r) {
            roster[id] = r;
            epochFrom[id] = history[id].length;
            hits[H_START]++;
        } catch {}
    }

    /// @dev Plays `hands` hands off-chain: each is a fully signed state, nothing happens on-chain.
    function play(uint256 t, uint256 seed, uint256 hands) external {
        bytes32 id = _id(t);
        (PokerVault.Status st,,,,) = _tbl(id);
        if (st != PokerVault.Status.Active && st != PokerVault.Status.Exiting) return;
        hands = bound(hands, 1, 4);
        for (uint256 h; h < hands; ++h) {
            history[id].push(_makeState(id, false, uint256(keccak256(abi.encode(seed, h)))));
        }
    }

    function settleFinal(uint256 t, uint256 seed) external {
        bytes32 id = _id(t);
        (PokerVault.Status st,,,,) = _tbl(id);
        if (st != PokerVault.Status.Active && st != PokerVault.Status.Exiting) return;
        PokerVault.State memory s = _makeState(id, true, seed);
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        uint256 credits = _creditTotal();
        try vault.settle(s, arb, ps) {
            hits[H_SETTLE]++;
            for (uint256 i; i < s.keep.length; ++i) {
                if (s.keep[i]) {
                    hits[H_ROLLOVER]++;
                    break;
                }
            }
            if (_creditTotal() > credits) hits[H_CREDIT]++;
            hasPendingExit[id] = false;
            delete roster[id]; // stayers stay seated; the next `start` rebuilds the roster from the seats
        } catch {}
    }

    /// @dev A member starts an exit from some state in the table's history, the newest or a stale one.
    function startExit(uint256 t, uint256 pick, bool anyEpoch) external {
        bytes32 id = _id(t);
        (bool ok, PokerVault.State memory s) = _pickState(id, pick, anyEpoch);
        if (!ok || roster[id].length == 0) return;
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.prank(roster[id][0]);
        try vault.startExit(s, arb, ps) {
            pendingExit[id] = s;
            hasPendingExit[id] = true;
            hits[H_EXIT]++;
            if (s.nonce < lastNonce[id]) hits[H_EXIT_STALE]++;
        } catch {}
    }

    function exitFromDeposits(uint256 t) external {
        bytes32 id = _id(t);
        address[] memory r = roster[id];
        if (r.length == 0) return;
        vm.prank(r[0]);
        try vault.startExitFromDeposits(id, r) {
            pendingExit[id] = vault.depositState(id, r);
            hasPendingExit[id] = true;
            hits[H_DEPOSIT_EXIT]++;
        } catch {}
    }

    function challenge(uint256 t, uint256 pick, bool anyEpoch) external {
        bytes32 id = _id(t);
        (bool ok, PokerVault.State memory s) = _pickState(id, pick, anyEpoch);
        if (!ok) return;
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        try vault.challenge(s, arb, ps) {
            pendingExit[id] = s;
            hasPendingExit[id] = true;
            hits[H_CHALLENGE]++;
        } catch {}
    }

    function finalizeExit(uint256 t) external {
        bytes32 id = _id(t);
        (PokerVault.Status st,, uint64 deadline,,) = _tbl(id);
        if (st != PokerVault.Status.Exiting || !hasPendingExit[id]) return;
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        uint256 credits = _creditTotal();
        try vault.finalizeExit(pendingExit[id]) {
            hits[H_FINALIZE]++;
            if (_creditTotal() > credits) hits[H_CREDIT]++;
            hasPendingExit[id] = false;
            delete roster[id];
        } catch {}
    }

    function advance(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    function setBlocked(uint256 p, bool isBlocked) external {
        token.setBlocked(players[bound(p, 0, players.length - 1)], isBlocked);
    }

    function withdraw(uint256 p) external {
        address who = p % (players.length + 1) == players.length ? house : players[p % players.length];
        vm.prank(who);
        try vault.withdraw(who) {
            hits[H_WITHDRAW]++;
        } catch {}
    }
}

contract PokerVaultInvariantTest is VaultBase {
    VaultHandler internal handler;
    uint256 internal supply;

    string[12] internal names = [
        "deposit",
        "leave",
        "start",
        "settle",
        "rollover",
        "exit",
        "exitStale",
        "exitDeposits",
        "challenge",
        "finalize",
        "credit",
        "withdraw"
    ];

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, token, arbiter, arbiterPk, house, players, sessionPks, sessionKeys);
        supply = token.totalSupply();
        // the players approved the vault in the base set-up; the handler acts as them through vm.prank
        targetContract(address(handler));
    }

    function _accounts() internal view returns (address[] memory a) {
        a = new address[](players.length + 1);
        for (uint256 i; i < players.length; ++i) {
            a[i] = players[i];
        }
        a[players.length] = house;
    }

    /// The vault never holds less (or more) than it owes.
    function invariant_vaultBalanceEqualsLiabilities() public view {
        assertEq(token.balanceOf(address(vault)), vault.totalLocked());
    }

    /// What it owes is exactly the table escrows plus the payouts parked for pulling.
    function invariant_liabilitiesAreEscrowPlusCredits() public view {
        uint256 total;
        for (uint256 t; t < handler.tableCount(); ++t) {
            (,,,,,,,, uint256 escrow,,,) = vault.tables(handler.tableIds(t));
            total += escrow;
        }
        address[] memory a = _accounts();
        for (uint256 i; i < a.length; ++i) {
            total += vault.withdrawable(a[i]);
        }
        assertEq(total, vault.totalLocked());
    }

    /// No tokens are created or destroyed.
    function invariant_tokensAreConserved() public view {
        uint256 total = token.balanceOf(address(vault));
        address[] memory a = _accounts();
        for (uint256 i; i < a.length; ++i) {
            total += token.balanceOf(a[i]);
        }
        assertEq(total, supply);
    }

    /// A table's escrow is exactly the deposits of its players, whatever state it is in.
    function invariant_escrowEqualsSeatDeposits() public view {
        for (uint256 t; t < handler.tableCount(); ++t) {
            bytes32 id = handler.tableIds(t);
            (PokerVault.Status status,, uint8 seated,,,,,, uint256 escrow,,,) = vault.tables(id);
            uint256 sum;
            uint256 count;
            for (uint256 i; i < players.length; ++i) {
                (uint256 dep,) = vault.seats(id, players[i]);
                sum += dep;
                if (dep > 0) count++;
            }
            assertEq(escrow, sum, "escrow != sum of deposits");
            assertEq(seated, count, "seated != number of seats");
            if (status == PokerVault.Status.Closed) assertEq(escrow, 0);
        }
    }

    /// The house has received exactly the cumulative rake the signed states carried, never more.
    function invariant_houseReceivedExactlyTheRakePaid() public view {
        uint256 rake;
        for (uint256 t; t < handler.tableCount(); ++t) {
            (,,,,,,,,, uint256 rakePaid,,) = vault.tables(handler.tableIds(t));
            rake += rakePaid;
        }
        assertEq(token.balanceOf(house) + vault.withdrawable(house), rake);
    }

    /// Adds this run's counts to process-wide totals and prints them (forge -vv), so a green result can be
    /// checked against what the random sequences actually did.
    function afterInvariant() public {
        string memory line;
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat("HITS_", names[i]);
            uint256 total = vm.envOr(key, uint256(0)) + handler.hits(bytes32(bytes(names[i])));
            vm.setEnv(key, vm.toString(total));
            line = string.concat(line, names[i], "=", vm.toString(total), " ");
        }
        console.log(line);
    }

    /// A fixed sequence through every path, so the handler cannot silently rot into doing nothing.
    function test_scriptReachesEveryPath() public {
        // table 0, epoch 1: fund, start, play, cooperative settle where players 0 and 2 stay and the
        // blacklisted player 1 is paid (so their share is parked as a credit)
        handler.fund(0, 7, 1);
        handler.start(0);
        handler.play(0, 11, 4);
        handler.setBlocked(1, true);
        handler.settleFinal(0, 5);
        handler.setBlocked(1, false);
        handler.withdraw(1);

        // between epochs: one stayer leaves, everybody tops up or joins, the next epoch starts
        handler.leave(0, 0);
        handler.fund(0, 7, 3);
        handler.start(0);

        // epoch 2: a player cashes in a stale state, the newest one answers, the window passes
        handler.play(0, 99, 4);
        handler.startExit(0, 0, false);
        handler.challenge(0, 3, false);
        handler.finalizeExit(0);

        // table 1: nobody ever signed anything, so the exit returns the deposits
        handler.fund(1, 7, 2);
        handler.start(1);
        handler.exitFromDeposits(1);
        handler.finalizeExit(1);

        for (uint256 i; i < names.length; ++i) {
            assertGt(handler.hits(bytes32(bytes(names[i]))), 0, names[i]);
        }
        // and the books still balance after all of it
        invariant_vaultBalanceEqualsLiabilities();
        invariant_liabilitiesAreEscrowPlusCredits();
        invariant_tokensAreConserved();
        invariant_escrowEqualsSeatDeposits();
        invariant_houseReceivedExactlyTheRakePaid();
    }
}
