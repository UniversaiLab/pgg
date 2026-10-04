// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {VaultBase} from "./Base.t.sol";
import {PokerVault} from "../src/PokerVault.sol";
import {MockToken} from "./mocks/MockToken.sol";
import {NoReturnToken} from "./mocks/NoReturnToken.sol";
import {HookToken} from "./mocks/ReentrantToken.sol";
import {HostilePlayer} from "./mocks/HostilePlayer.sol";

contract PokerVaultTest is VaultBase {
    // ---------------------------------------------------------------- helpers

    function _expectSettleRevert(PokerVault.State memory s, bytes memory err) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.expectRevert(err);
        vault.settle(s, arb, ps);
    }

    function _expectExitRevert(address by, PokerVault.State memory s, bytes memory err) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.prank(by);
        vm.expectRevert(err);
        vault.startExit(s, arb, ps);
    }

    function _expectChallengeRevert(PokerVault.State memory s, bytes memory err) internal {
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.expectRevert(err);
        vault.challenge(s, arb, ps);
    }

    /// @dev The standard hand result: 3 x 1000 in, 1500 / 900 / 560 and 40 rake out.
    function _typical(uint64 nonce, bool isFinal) internal view returns (PokerVault.State memory) {
        return isFinal
            ? _final(T1, nonce, _bal(1500 * U, 900 * U, 560 * U), 40 * U)
            : _hand(T1, nonce, _bal(1500 * U, 900 * U, 560 * U), 40 * U);
    }

    function _totals() internal view returns (uint256 inVault, uint256 locked) {
        return (token.balanceOf(address(vault)), vault.totalLocked());
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_storesConfig() public view {
        assertEq(address(vault.TOKEN()), address(token));
        assertEq(vault.HOUSE(), house);
        assertEq(vault.arbiter(), arbiter);
        assertEq(vault.owner(), owner);
        assertEq(vault.EXIT_WINDOW(), WINDOW);
        assertEq(vault.MAX_RAKE_BPS(), RAKE_BPS);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(IERC20(makeAddr("eoa")), house, arbiter, owner, WINDOW, RAKE_BPS); // no code
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(token, address(0), arbiter, owner, WINDOW, RAKE_BPS);
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(token, house, address(0), owner, WINDOW, RAKE_BPS);
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(token, house, arbiter, owner, 59 minutes, RAKE_BPS);
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(token, house, arbiter, owner, 31 days, RAKE_BPS);
        vm.expectRevert(PokerVault.BadConfig.selector);
        new PokerVault(token, house, arbiter, owner, WINDOW, 501);
    }

    // ------------------------------------------------------------------ admin

    function test_admin_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.setArbiter(stranger);
        vm.stopPrank();
    }

    function test_admin_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(PokerVault.RenounceDisabled.selector);
        vault.renounceOwnership();
    }

    function test_admin_arbiterRotationOnlyAffectsNewTables() public {
        _create(T1);
        address newArbiter = makeAddr("newArbiter");
        vm.prank(owner);
        vault.setArbiter(newArbiter);

        // old arbiter can no longer create tables, but still runs the one it created
        vm.prank(arbiter);
        vm.expectRevert(PokerVault.NotArbiter.selector);
        vault.createTable(keccak256("t2"), 6, U, 10 * U);
        _depositAll(T1, 1000 * U);
        _start(T1);

        vm.prank(newArbiter);
        vault.createTable(keccak256("t2"), 6, U, 10 * U);
        (,,, address t2Arbiter,,,,,,,,) = vault.tables(keccak256("t2"));
        assertEq(t2Arbiter, newArbiter);
    }

    // ------------------------------------------------------------ createTable

    function test_createTable_onlyArbiterAndOnce() public {
        vm.prank(stranger);
        vm.expectRevert(PokerVault.NotArbiter.selector);
        vault.createTable(T1, 6, U, 10 * U);

        _create(T1);
        vm.prank(arbiter);
        vm.expectRevert(PokerVault.TableExists.selector);
        vault.createTable(T1, 6, U, 10 * U);
    }

    function test_createTable_rejectsBadParams() public {
        vm.startPrank(arbiter);
        vm.expectRevert(PokerVault.BadTableParams.selector);
        vault.createTable(bytes32(0), 6, U, 10 * U);
        vm.expectRevert(PokerVault.BadTableParams.selector);
        vault.createTable(T1, 1, U, 10 * U);
        vm.expectRevert(PokerVault.BadTableParams.selector);
        vault.createTable(T1, 11, U, 10 * U);
        vm.expectRevert(PokerVault.BadTableParams.selector);
        vault.createTable(T1, 6, 0, 10 * U);
        vm.expectRevert(PokerVault.BadTableParams.selector);
        vault.createTable(T1, 6, 11 * U, 10 * U);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- deposit

    function test_deposit_locksTokensAndRecordsSeat() public {
        _create(T1);
        vm.prank(players[0]);
        vault.deposit(T1, 500 * U, sessionKeys[0]);

        (uint256 dep, address key) = vault.seats(T1, players[0]);
        assertEq(dep, 500 * U);
        assertEq(key, sessionKeys[0]);
        assertEq(token.balanceOf(address(vault)), 500 * U);
        assertEq(vault.totalLocked(), 500 * U);
        (PokerVault.Status status,, uint8 seated,,,,,, uint256 escrow,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Filling));
        assertEq(seated, 1);
        assertEq(escrow, 500 * U);
    }

    function test_deposit_topUpKeepsOneSeat() public {
        _create(T1);
        vm.startPrank(players[0]);
        vault.deposit(T1, 500 * U, sessionKeys[0]);
        vault.deposit(T1, 200 * U, sessionKeys[1]); // also swaps the key
        vm.stopPrank();
        (uint256 dep, address key) = vault.seats(T1, players[0]);
        assertEq(dep, 700 * U);
        assertEq(key, sessionKeys[1]);
        (,, uint8 seated,,,,,,,,,) = vault.tables(T1);
        assertEq(seated, 1);
    }

    function test_deposit_enforcesLimits() public {
        _create(T1);
        vm.startPrank(players[0]);
        vm.expectRevert(PokerVault.ZeroAmount.selector);
        vault.deposit(T1, 0, sessionKeys[0]);
        vm.expectRevert(PokerVault.DepositOutOfRange.selector);
        vault.deposit(T1, 99 * U, sessionKeys[0]);
        vm.expectRevert(PokerVault.DepositOutOfRange.selector);
        vault.deposit(T1, 10_001 * U, sessionKeys[0]);
        vm.expectRevert(PokerVault.BadSessionKey.selector);
        vault.deposit(T1, 500 * U, address(0));
        vault.deposit(T1, 9_000 * U, sessionKeys[0]);
        vm.expectRevert(PokerVault.DepositOutOfRange.selector); // topping up past the maximum
        vault.deposit(T1, 1_001 * U, sessionKeys[0]);
        vm.stopPrank();
    }

    function test_deposit_tableFull() public {
        vm.prank(arbiter);
        vault.createTable(T1, 2, 100 * U, 10_000 * U);
        for (uint256 i; i < 2; ++i) {
            vm.prank(players[i]);
            vault.deposit(T1, 100 * U, sessionKeys[i]);
        }
        vm.prank(players[2]);
        vm.expectRevert(PokerVault.TableFull.selector);
        vault.deposit(T1, 100 * U, sessionKeys[2]);
    }

    function test_deposit_onlyWhileFilling() public {
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.None));
        vault.deposit(T1, 100 * U, sessionKeys[0]);

        _openAndStart(T1, 100 * U);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Active));
        vault.deposit(T1, 100 * U, sessionKeys[0]);
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        token.setFeeBps(100);
        _create(T1);
        vm.prank(players[0]);
        vm.expectRevert(PokerVault.TransferMismatch.selector);
        vault.deposit(T1, 500 * U, sessionKeys[0]);
        assertEq(vault.totalLocked(), 0);
    }

    function test_deposit_works18Decimals() public {
        MockToken usdt = new MockToken(18);
        PokerVault v = new PokerVault(usdt, house, arbiter, owner, WINDOW, RAKE_BPS);
        usdt.mint(players[0], 1_000e18);
        vm.prank(players[0]);
        usdt.approve(address(v), type(uint256).max);
        vm.prank(arbiter);
        v.createTable(T1, 6, 5e18, 500e18);
        vm.prank(players[0]);
        v.deposit(T1, 100e18, sessionKeys[0]);
        assertEq(usdt.balanceOf(address(v)), 100e18);
    }

    function test_deposit_worksWithTokenThatReturnsNothing() public {
        NoReturnToken usdt = new NoReturnToken();
        PokerVault v = new PokerVault(IERC20(address(usdt)), house, arbiter, owner, WINDOW, RAKE_BPS);
        usdt.mint(players[0], 1_000 * U);
        vm.prank(players[0]);
        usdt.approve(address(v), type(uint256).max);
        vm.prank(arbiter);
        v.createTable(T1, 6, U, 1_000 * U);
        vm.prank(players[0]);
        v.deposit(T1, 100 * U, sessionKeys[0]);
        assertEq(usdt.balanceOf(address(v)), 100 * U);

        vm.prank(players[0]);
        v.leave(T1);
        assertEq(usdt.balanceOf(players[0]), 1_000 * U);
        assertEq(v.totalLocked(), 0);
    }

    function test_setSessionKey() public {
        _create(T1);
        vm.prank(players[0]);
        vm.expectRevert(PokerVault.NoSeat.selector);
        vault.setSessionKey(T1, sessionKeys[1]);

        vm.startPrank(players[0]);
        vault.deposit(T1, 100 * U, sessionKeys[0]);
        vm.expectRevert(PokerVault.BadSessionKey.selector);
        vault.setSessionKey(T1, address(0));
        vault.setSessionKey(T1, sessionKeys[1]);
        vm.stopPrank();
        (, address key) = vault.seats(T1, players[0]);
        assertEq(key, sessionKeys[1]);
    }

    // ------------------------------------------------------------------ leave

    function test_leave_refundsWholeStake() public {
        _create(T1);
        _depositAll(T1, 300 * U);
        uint256 before = _tokenBal(players[1]);
        vm.prank(players[1]);
        vault.leave(T1);
        assertEq(_tokenBal(players[1]), before + 300 * U);
        (uint256 dep,) = vault.seats(T1, players[1]);
        assertEq(dep, 0);
        (,, uint8 seated,,,,,, uint256 escrow,,,) = vault.tables(T1);
        assertEq(seated, 2);
        assertEq(escrow, 600 * U);
        assertEq(vault.totalLocked(), 600 * U);

        vm.prank(players[1]);
        vm.expectRevert(PokerVault.NoSeat.selector);
        vault.leave(T1);
    }

    function test_leave_notWhileActive() public {
        _openAndStart(T1, 100 * U);
        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Active));
        vault.leave(T1);
    }

    // ------------------------------------------------------------------ start

    function test_start_onlyTableArbiter() public {
        _create(T1);
        _depositAll(T1, 100 * U);
        vm.prank(stranger);
        vm.expectRevert(PokerVault.NotArbiter.selector);
        vault.start(T1, players);
        vm.prank(players[0]);
        vm.expectRevert(PokerVault.NotArbiter.selector);
        vault.start(T1, players);
    }

    function test_start_requiresExactSortedRoster() public {
        _create(T1);
        _depositAll(T1, 100 * U);

        address[] memory two = new address[](2);
        (two[0], two[1]) = (players[0], players[1]);
        vm.startPrank(arbiter);
        vm.expectRevert(PokerVault.BadRoster.selector); // a seated player is missing
        vault.start(T1, two);

        address[] memory unsorted = new address[](3);
        (unsorted[0], unsorted[1], unsorted[2]) = (players[1], players[0], players[2]);
        vm.expectRevert(PokerVault.BadRoster.selector);
        vault.start(T1, unsorted);

        address[] memory dup = new address[](3);
        (dup[0], dup[1], dup[2]) = (players[0], players[1], players[1]);
        vm.expectRevert(PokerVault.BadRoster.selector);
        vault.start(T1, dup);

        address[] memory ghost = new address[](3);
        (ghost[0], ghost[1], ghost[2]) = (players[0], players[1], address(type(uint160).max));
        vm.expectRevert(PokerVault.BadRoster.selector); // right count, but not a depositor
        vault.start(T1, ghost);
        vm.stopPrank();
    }

    function test_start_needsTwoPlayers() public {
        _create(T1);
        vm.prank(players[0]);
        vault.deposit(T1, 100 * U, sessionKeys[0]);
        address[] memory one = new address[](1);
        one[0] = players[0];
        vm.prank(arbiter);
        vm.expectRevert(PokerVault.BadRoster.selector);
        vault.start(T1, one);
    }

    function test_start_setsActiveOnce() public {
        _openAndStart(T1, 100 * U);
        (PokerVault.Status status,,,,,,,,,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Active));
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Active));
        vault.start(T1, players);
    }

    // ----------------------------------------------------------------- settle

    function test_settle_paysPlayersAndHouse() public {
        _openAndStart(T1, 1000 * U);
        uint256 a = _tokenBal(players[0]);
        uint256 b = _tokenBal(players[1]);
        uint256 c = _tokenBal(players[2]);

        vm.prank(stranger); // anyone may submit a fully signed final state
        _settle(_typical(7, true));

        assertEq(_tokenBal(players[0]), a + 1500 * U);
        assertEq(_tokenBal(players[1]), b + 900 * U);
        assertEq(_tokenBal(players[2]), c + 560 * U);
        assertEq(_tokenBal(house), 40 * U);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalLocked(), 0);
        (
            PokerVault.Status status,,
            uint8 seated,
            address tArbiter,
            uint64 nonce,,,,
            uint256 escrow,
            uint256 rakePaid,,
        ) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Filling));
        assertEq(seated, 0);
        assertEq(tArbiter, arbiter);
        assertEq(nonce, 7);
        assertEq(escrow, 0);
        assertEq(rakePaid, 40 * U);
        (uint256 dep,) = vault.seats(T1, players[0]);
        assertEq(dep, 0);
    }

    function test_settle_rolloverKeepsStayersInTheVault() public {
        _openAndStart(T1, 1000 * U);
        // player 0 keeps playing, 1 cashes out, 2 keeps playing
        PokerVault.State memory s =
            _state(T1, 5, true, _bal(1500 * U, 900 * U, 560 * U), _keep(true, false, true), 40 * U, 4000 * U);
        uint256 b = _tokenBal(players[1]);
        _settle(s);

        assertEq(_tokenBal(players[1]), b + 900 * U);
        assertEq(_tokenBal(players[0]), 1_000_000 * U - 1000 * U); // nothing sent to the stayer
        assertEq(token.balanceOf(address(vault)), 2060 * U);
        assertEq(vault.totalLocked(), 2060 * U);
        (uint256 dep0, address key0) = vault.seats(T1, players[0]);
        assertEq(dep0, 1500 * U);
        assertEq(key0, sessionKeys[0]); // session key survives the rollover
        (uint256 dep1,) = vault.seats(T1, players[1]);
        assertEq(dep1, 0);
        (PokerVault.Status status,, uint8 seated,,,,,, uint256 escrow,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Filling));
        assertEq(seated, 2);
        assertEq(escrow, 2060 * U);

        // a stayer can still leave, and a new player can join, in the gap between epochs
        vm.prank(players[2]);
        vault.leave(T1);
        assertEq(_tokenBal(players[2]), 1_000_000 * U - 1000 * U + 560 * U);
        vm.prank(players[1]);
        vault.deposit(T1, 200 * U, sessionKeys[1]);
        (,, seated,,,,,, escrow,,,) = vault.tables(T1);
        assertEq(seated, 2);
        assertEq(escrow, 1700 * U);
    }

    function test_settle_secondEpochRunsAndCumulativeRakeCarriesOver() public {
        _openAndStart(T1, 1000 * U);
        // epoch 1: everybody stays, 40 rake taken
        _settle(_state(T1, 5, true, _bal(1500 * U, 900 * U, 560 * U), _keep(true, true, true), 40 * U, 4000 * U));
        _start(T1);
        (,,,, uint64 nonce,,,,,,,) = vault.tables(T1);
        assertEq(nonce, 5);

        // epoch 2 escrow is 2960 (3000 less the 40 already paid). Nonces keep rising and rake is
        // cumulative, so only the 20 above the 40 already paid is taken now.
        PokerVault.State memory s2 = _final(T1, 9, _bal(1400 * U, 980 * U, 560 * U), 60 * U);
        _settle(s2);
        assertEq(_tokenBal(house), 60 * U);
        assertEq(_tokenBal(players[1]), 1_000_000 * U - 1000 * U + 980 * U);
        assertEq(vault.totalLocked(), 0);
    }

    function test_settle_rejectsNonFinalState() public {
        _openAndStart(T1, 1000 * U);
        _expectSettleRevert(_typical(3, false), abi.encodeWithSelector(PokerVault.NotFinal.selector));
    }

    function test_settle_rejectsWhenNotRunning() public {
        _create(T1);
        _expectSettleRevert(
            _typical(3, true), abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Filling)
        );
    }

    function test_settle_cannotRunTwice() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(7, true);
        _settle(s);
        _expectSettleRevert(s, abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Filling));
    }

    function test_settle_rejectsMissingOrWrongArbiterSignature() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(7, true);
        (, bytes[] memory ps) = _sign(s);
        // signed by a player's session key instead of the arbiter
        bytes memory fake = _sig(sessionPks[0], vault.stateDigest(s));
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, type(uint256).max));
        vault.settle(s, fake, ps);
    }

    function test_settle_rejectsPlayerSignedWithWalletInsteadOfSessionKey() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(7, true);
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        (, uint256 walletPk) = makeAddrAndKey("player1");
        // players[] is sorted, so find which index wallet "player1" ended up at
        uint256 idx;
        for (uint256 i; i < N; ++i) {
            if (players[i] == vm.addr(walletPk)) idx = i;
        }
        ps[idx] = _sig(walletPk, vault.stateDigest(s));
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, idx));
        vault.settle(s, arb, ps);
    }

    function test_settle_rejectsOneMissingPlayerSignature() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(7, true);
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        bytes[] memory short = new bytes[](2);
        (short[0], short[1]) = (ps[0], ps[1]);
        vm.expectRevert(PokerVault.BadLength.selector);
        vault.settle(s, arb, short);

        // the same signature twice instead of a third player's
        ps[2] = ps[0];
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, 2));
        vault.settle(s, arb, ps);
    }

    function test_settle_arbiterAloneCannotMoveFunds() public {
        _openAndStart(T1, 1000 * U);
        // The arbiter pays everything to player 0 and signs for all the session keys it does not hold.
        PokerVault.State memory s = _final(T1, 7, _bal(3000 * U, 0, 0), 0);
        bytes32 digest = vault.stateDigest(s);
        bytes memory arb = _sig(arbiterPk, digest);
        bytes[] memory ps = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            ps[i] = arb;
        }
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, 0));
        vault.settle(s, arb, ps);
    }

    function test_settle_playersAloneCannotMoveFunds() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _final(T1, 7, _bal(3000 * U, 0, 0), 0);
        (, bytes[] memory ps) = _sign(s);
        // all three players agree but the house never signed
        bytes memory notArbiter = _sig(sessionPks[0], vault.stateDigest(s));
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, type(uint256).max));
        vault.settle(s, notArbiter, ps);
    }

    function test_settle_rejectsTamperedState() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory signed = _typical(7, true);
        (bytes memory arb, bytes[] memory ps) = _sign(signed);

        // move 10 from one player to another after signing: sum still right, signatures not
        PokerVault.State memory tampered = _typical(7, true);
        tampered.balances = _bal(1510 * U, 890 * U, 560 * U);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, type(uint256).max));
        vault.settle(tampered, arb, ps);

        // flipping a keep flag is tampering too
        tampered = _typical(7, true);
        tampered.keep = _keep(true, false, false);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, type(uint256).max));
        vault.settle(tampered, arb, ps);
    }

    function test_settle_rejectsStaleOrRepeatedNonce() public {
        _openAndStart(T1, 1000 * U);
        // first push a higher-nonce state through the exit path to move the table nonce to 10
        _startExit(players[0], _typical(10, false));
        _expectSettleRevert(_typical(10, true), abi.encodeWithSelector(PokerVault.StaleNonce.selector, 10, 10));
        _expectSettleRevert(_typical(4, true), abi.encodeWithSelector(PokerVault.StaleNonce.selector, 4, 10));
        _settle(_typical(11, true)); // a final state with a higher nonce still resolves it at once
    }

    function test_settle_rejectsNonceZero() public {
        _openAndStart(T1, 1000 * U);
        _expectSettleRevert(_typical(0, true), abi.encodeWithSelector(PokerVault.StaleNonce.selector, 0, 0));
    }

    function test_settle_rejectsWrongRoster() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(7, true);
        (s.players[0], s.players[1]) = (s.players[1], s.players[0]);
        _expectSettleRevert(s, abi.encodeWithSelector(PokerVault.RosterMismatch.selector));

        s = _typical(7, true);
        s.players[2] = stranger;
        _expectSettleRevert(s, abi.encodeWithSelector(PokerVault.RosterMismatch.selector));

        s = _typical(7, true);
        s.players = new address[](2);
        s.players[0] = players[0];
        s.players[1] = players[1];
        _expectSettleRevert(s, abi.encodeWithSelector(PokerVault.BadLength.selector));
    }

    /// @dev The theft this must stop: two players and the arbiter sign a perfectly consistent state that
    ///      simply omits the third depositor and splits their money. Arrays are the same length, the totals
    ///      add up, every signature is valid. Only the roster check stands in the way.
    function _stateWithoutLastPlayer(uint64 nonce, bool isFinal) internal view returns (PokerVault.State memory s) {
        s.tableId = T1;
        s.nonce = nonce;
        s.isFinal = isFinal;
        s.players = new address[](2);
        (s.players[0], s.players[1]) = (players[0], players[1]);
        s.balances = new uint256[](2);
        (s.balances[0], s.balances[1]) = (1500 * U, 1500 * U); // the third player's 1000 is shared out
        s.keep = new bool[](2);
    }

    function test_settle_cannotLeaveOutADepositor() public {
        _openAndStart(T1, 1000 * U);
        _expectSettleRevert(
            _stateWithoutLastPlayer(7, true), abi.encodeWithSelector(PokerVault.RosterMismatch.selector)
        );
        assertEq(token.balanceOf(address(vault)), 3000 * U);
    }

    function test_exit_cannotLeaveOutADepositor() public {
        _openAndStart(T1, 1000 * U);
        _expectExitRevert(
            players[0], _stateWithoutLastPlayer(7, false), abi.encodeWithSelector(PokerVault.RosterMismatch.selector)
        );
    }

    function test_challenge_cannotLeaveOutADepositor() public {
        _openAndStart(T1, 1000 * U);
        _startExit(players[0], _typical(5, false));
        _expectChallengeRevert(
            _stateWithoutLastPlayer(9, false), abi.encodeWithSelector(PokerVault.RosterMismatch.selector)
        );
    }

    function test_settle_rejectsMoneyCreatedOrDestroyed() public {
        _openAndStart(T1, 1000 * U);
        // one unit too much
        _expectSettleRevert(
            _final(T1, 7, _bal(1500 * U + 1, 900 * U, 560 * U), 40 * U),
            abi.encodeWithSelector(PokerVault.NotConserved.selector, 3000 * U + 1, 3000 * U)
        );
        // one unit missing: it would be stranded in the vault, so that is refused as well
        _expectSettleRevert(
            _final(T1, 7, _bal(1500 * U - 1, 900 * U, 560 * U), 40 * U),
            abi.encodeWithSelector(PokerVault.NotConserved.selector, 3000 * U - 1, 3000 * U)
        );
    }

    function test_settle_rakeIsCappedByVolume() public {
        _openAndStart(T1, 1000 * U);
        // 5% of 800 = 40: exactly at the cap passes the check, one unit more of rake does not
        PokerVault.State memory ok =
            _state(T1, 7, true, _bal(1500 * U, 900 * U, 560 * U), _keep(false, false, false), 40 * U, 800 * U);
        PokerVault.State memory bad =
            _state(T1, 7, true, _bal(1500 * U, 900 * U, 560 * U - 1), _keep(false, false, false), 40 * U + 1, 800 * U);
        _expectSettleRevert(bad, abi.encodeWithSelector(PokerVault.RakeTooHigh.selector));
        _settle(ok);
    }

    function test_settle_rejectsRakeThatGoesDown() public {
        _openAndStart(T1, 1000 * U);
        _settle(_state(T1, 5, true, _bal(1500 * U, 900 * U, 560 * U), _keep(true, true, true), 40 * U, 4000 * U));
        _start(T1);
        _expectSettleRevert(
            _final(T1, 9, _bal(1500 * U, 900 * U, 600 * U), 0),
            abi.encodeWithSelector(PokerVault.RakeDecreased.selector)
        );
    }

    function test_settle_keepNeedsABalance() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _state(T1, 7, true, _bal(2000 * U, 1000 * U, 0), _keep(true, false, true), 0, 0);
        _expectSettleRevert(s, abi.encodeWithSelector(PokerVault.BadKeep.selector, 2));
    }

    function test_settle_whenBustedPlayerGetsNothingOthersStillPaid() public {
        _openAndStart(T1, 1000 * U);
        _settle(_final(T1, 7, _bal(3000 * U, 0, 0), 0));
        assertEq(_tokenBal(players[0]), 1_000_000 * U + 2000 * U);
        assertEq(_tokenBal(players[1]), 1_000_000 * U - 1000 * U);
        assertEq(vault.totalLocked(), 0);
    }

    // ------------------------------------------------------------------- exit

    function test_exit_oldStateCannotBeCashedInAtOnce() public {
        _openAndStart(T1, 1000 * U);
        // a losing player holds a perfectly valid, fully signed state from earlier, and tries to settle with it
        _expectSettleRevert(_typical(3, false), abi.encodeWithSelector(PokerVault.NotFinal.selector));
        // the exit path is the only way to use it, and it opens a window
        _startExit(players[2], _typical(3, false));
        assertEq(token.balanceOf(address(vault)), 3000 * U); // nothing moved
    }

    function test_exit_staleStateIsOverriddenByTheLatest() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory stale = _hand(T1, 3, _bal(1000 * U, 1000 * U, 1000 * U), 0);
        PokerVault.State memory latest = _typical(20, false);

        _startExit(players[2], stale); // the player who lost since then tries to roll back
        vm.warp(block.timestamp + WINDOW - 1);
        _challenge(stranger, latest); // anyone holding the latest state may answer
        vm.warp(block.timestamp + WINDOW + 1);
        vault.finalizeExit(latest);

        assertEq(_tokenBal(players[0]), 1_000_000 * U + 500 * U);
        assertEq(_tokenBal(players[1]), 1_000_000 * U - 100 * U);
        assertEq(_tokenBal(players[2]), 1_000_000 * U - 440 * U);
        assertEq(_tokenBal(house), 40 * U);
        assertEq(vault.totalLocked(), 0);
        (PokerVault.Status status,,,,,,,,,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Closed));
    }

    function test_exit_finalizeNeedsTheWindowToPass() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(20, false);
        _startExit(players[0], s);
        vm.expectRevert(PokerVault.ExitWindowOpen.selector);
        vault.finalizeExit(s);
        vm.warp(block.timestamp + WINDOW); // exactly at the deadline is still inside the window
        vm.expectRevert(PokerVault.ExitWindowOpen.selector);
        vault.finalizeExit(s);
        vm.warp(block.timestamp + 1);
        vault.finalizeExit(s);
    }

    function test_exit_finalizeNeedsTheExactState() public {
        _openAndStart(T1, 1000 * U);
        _startExit(players[0], _typical(20, false));
        vm.warp(block.timestamp + WINDOW + 1);
        // a different, equally valid-looking state does not match what the exit holds
        PokerVault.State memory other = _hand(T1, 20, _bal(3000 * U, 0, 0), 0);
        vm.expectRevert(PokerVault.DigestMismatch.selector);
        vault.finalizeExit(other);
    }

    function test_exit_challengeMustBeNewerAndInTime() public {
        _openAndStart(T1, 1000 * U);
        _startExit(players[0], _typical(20, false));

        _expectChallengeRevert(_typical(20, false), abi.encodeWithSelector(PokerVault.StaleNonce.selector, 20, 20));
        _expectChallengeRevert(
            _hand(T1, 19, _bal(1000 * U, 1000 * U, 1000 * U), 0),
            abi.encodeWithSelector(PokerVault.StaleNonce.selector, 19, 20)
        );

        vm.warp(block.timestamp + WINDOW + 1);
        _expectChallengeRevert(_typical(21, false), abi.encodeWithSelector(PokerVault.ExitWindowClosed.selector));
    }

    function test_exit_challengeRestartsTheWindow() public {
        _openAndStart(T1, 1000 * U);
        _startExit(players[0], _typical(20, false));
        vm.warp(block.timestamp + WINDOW - 10);
        PokerVault.State memory newer = _typical(21, false);
        _challenge(stranger, newer);
        vm.warp(block.timestamp + WINDOW - 1); // past the first deadline, inside the new one
        vm.expectRevert(PokerVault.ExitWindowOpen.selector);
        vault.finalizeExit(newer);
        vm.warp(block.timestamp + 2);
        vault.finalizeExit(newer);
    }

    function test_exit_challengeNeedsAnExit() public {
        _openAndStart(T1, 1000 * U);
        _expectChallengeRevert(
            _typical(5, false), abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Active)
        );
    }

    function test_exit_onlyMembersOrArbiterStartIt() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(5, false);
        _expectExitRevert(stranger, s, abi.encodeWithSelector(PokerVault.NotMember.selector));
        _startExit(arbiter, s);
    }

    function test_exit_onlyWhileActive() public {
        _create(T1);
        _expectExitRevert(
            players[0],
            _typical(5, false),
            abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Filling)
        );
    }

    function test_exit_rejectsInvalidStates() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(5, false);
        s.balances = _bal(1500 * U, 900 * U, 561 * U);
        _expectExitRevert(players[0], s, abi.encodeWithSelector(PokerVault.NotConserved.selector, 3001 * U, 3000 * U));
        // a bad state cannot be parked in the vault to freeze a table
        (PokerVault.Status status,,,,,,,,,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Active));
    }

    function test_exit_fromDepositsReturnsEveryStake() public {
        _openAndStart(T1, 1000 * U);
        vm.prank(players[1]);
        vault.startExitFromDeposits(T1, players);
        vm.warp(block.timestamp + WINDOW + 1);
        PokerVault.State memory initial = vault.depositState(T1, players);
        vault.finalizeExit(initial);
        for (uint256 i; i < N; ++i) {
            assertEq(_tokenBal(players[i]), 1_000_000 * U);
        }
        assertEq(vault.totalLocked(), 0);
    }

    function test_exit_fromDepositsCanBeChallengedByARealState() public {
        _openAndStart(T1, 1000 * U);
        vm.prank(players[2]);
        vault.startExitFromDeposits(T1, players);
        PokerVault.State memory latest = _typical(30, false);
        _challenge(arbiter, latest);
        vm.warp(block.timestamp + WINDOW + 1);
        vault.finalizeExit(latest);
        assertEq(_tokenBal(players[0]), 1_000_000 * U + 500 * U);
        assertEq(_tokenBal(house), 40 * U);
    }

    function test_exit_fromDepositsAfterRolloverUsesRolledBalances() public {
        _openAndStart(T1, 1000 * U);
        _settle(_state(T1, 5, true, _bal(1500 * U, 900 * U, 560 * U), _keep(true, true, true), 40 * U, 4000 * U));
        _start(T1);

        vm.prank(players[0]);
        vault.startExitFromDeposits(T1, players);
        // a state from the previous epoch cannot override it: its nonce is not higher than the epoch's start
        _expectChallengeRevert(
            _final(T1, 5, _bal(1500 * U, 900 * U, 560 * U), 40 * U),
            abi.encodeWithSelector(PokerVault.StaleNonce.selector, 5, 5)
        );
        vm.warp(block.timestamp + WINDOW + 1);
        PokerVault.State memory initial = vault.depositState(T1, players);
        vault.finalizeExit(initial);
        assertEq(_tokenBal(players[0]), 1_000_000 * U - 1000 * U + 1500 * U);
        assertEq(_tokenBal(players[1]), 1_000_000 * U - 1000 * U + 900 * U);
        assertEq(_tokenBal(players[2]), 1_000_000 * U - 1000 * U + 560 * U);
        assertEq(_tokenBal(house), 40 * U);
    }

    function test_exit_fromDepositsNeedsTheRoster() public {
        _openAndStart(T1, 1000 * U);
        address[] memory wrong = new address[](3);
        (wrong[0], wrong[1], wrong[2]) = (players[0], players[1], stranger);
        vm.prank(players[0]);
        vm.expectRevert(PokerVault.RosterMismatch.selector);
        vault.startExitFromDeposits(T1, wrong);
        vm.prank(stranger);
        vm.expectRevert(PokerVault.NotMember.selector);
        vault.startExitFromDeposits(T1, players);
    }

    function test_exit_finalStateResolvesAPendingExitAtOnce() public {
        _openAndStart(T1, 1000 * U);
        _startExit(players[2], _hand(T1, 3, _bal(1000 * U, 1000 * U, 1000 * U), 0));
        _settle(_typical(8, true));
        (PokerVault.Status status,,,,,,,,,,,) = vault.tables(T1);
        assertEq(uint8(status), uint8(PokerVault.Status.Filling));
        assertEq(_tokenBal(players[0]), 1_000_000 * U + 500 * U);

        // and the old exit's window no longer matters
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Filling));
        vault.finalizeExit(_hand(T1, 3, _bal(1000 * U, 1000 * U, 1000 * U), 0));
    }

    function test_exit_closedTableIsDone() public {
        _openAndStart(T1, 1000 * U);
        PokerVault.State memory s = _typical(20, false);
        _startExit(players[0], s);
        vm.warp(block.timestamp + WINDOW + 1);
        vault.finalizeExit(s);

        vm.prank(players[0]);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Closed));
        vault.deposit(T1, 100 * U, sessionKeys[0]);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.WrongStatus.selector, PokerVault.Status.Closed));
        vault.finalizeExit(s);
    }

    // --------------------------------------------------- failing payouts (USDC-style blacklist)

    function test_payout_blacklistedRecipientCannotBlockTheOthers() public {
        _openAndStart(T1, 1000 * U);
        token.setBlocked(players[1], true);
        _settle(_typical(7, true));

        // players 0, 2 and the house were paid, player 1's share is parked for them
        assertEq(_tokenBal(players[0]), 1_000_000 * U + 500 * U);
        assertEq(_tokenBal(players[2]), 1_000_000 * U - 440 * U);
        assertEq(_tokenBal(house), 40 * U);
        assertEq(vault.withdrawable(players[1]), 900 * U);
        assertEq(vault.totalLocked(), 900 * U);
        assertEq(token.balanceOf(address(vault)), 900 * U);

        // still blocked: withdrawing to the same address fails and keeps the credit
        vm.prank(players[1]);
        vm.expectRevert();
        vault.withdraw(players[1]);
        assertEq(vault.withdrawable(players[1]), 900 * U);

        // they may name another address
        address other = makeAddr("other");
        vm.prank(players[1]);
        vault.withdraw(other);
        assertEq(_tokenBal(other), 900 * U);
        assertEq(vault.withdrawable(players[1]), 0);
        assertEq(vault.totalLocked(), 0);
    }

    function test_payout_blacklistedHouseDoesNotBlockSettlement() public {
        _openAndStart(T1, 1000 * U);
        token.setBlocked(house, true);
        _settle(_typical(7, true));
        assertEq(vault.withdrawable(house), 40 * U);
        assertEq(vault.totalLocked(), 40 * U);
        token.setBlocked(house, false);
        vm.prank(house);
        vault.withdraw(house);
        assertEq(_tokenBal(house), 40 * U);
    }

    function test_payout_pausedTokenStillSettlesAndCreditsEveryone() public {
        _openAndStart(T1, 1000 * U);
        token.setPaused(true);
        _settle(_typical(7, true));
        assertEq(vault.totalLocked(), 3000 * U);
        token.setPaused(false);
        vm.prank(players[0]);
        vault.withdraw(players[0]);
        assertEq(_tokenBal(players[0]), 1_000_000 * U + 500 * U);
    }

    function test_payout_leaveToBlockedAddressIsCredited() public {
        _create(T1);
        vm.prank(players[0]);
        vault.deposit(T1, 100 * U, sessionKeys[0]);
        token.setBlocked(players[0], true);
        vm.prank(players[0]);
        vault.leave(T1);
        assertEq(vault.withdrawable(players[0]), 100 * U);
        vm.prank(players[0]);
        vm.expectRevert(bytes("blacklisted")); // the token still refuses this address
        vault.withdraw(players[0]);
        vm.prank(players[0]);
        vault.withdraw(stranger);
        assertEq(_tokenBal(stranger), 100 * U);
        assertEq(vault.totalLocked(), 0);
    }

    function test_withdraw_nothing() public {
        vm.prank(stranger);
        vm.expectRevert(PokerVault.NothingToWithdraw.selector);
        vault.withdraw(stranger);
    }

    // ------------------------------------------- re-entrancy by a contract player with a token hook

    /// @dev A vault on an ERC-777-style token, a table, one honest player and one hostile contract player.
    function _hostileSetup() internal returns (PokerVault v, HookToken hook, HostilePlayer evil) {
        hook = new HookToken();
        v = new PokerVault(hook, house, arbiter, owner, WINDOW, RAKE_BPS);
        evil = new HostilePlayer(v);
        vm.prank(arbiter);
        v.createTable(T1, 6, U, 10_000 * U);
        hook.mint(address(evil), 1_000 * U);
        hook.mint(players[0], 1_000 * U);
        evil.approveVault(hook);
        vm.prank(players[0]);
        hook.approve(address(v), type(uint256).max);
    }

    function _assertBlocked(PokerVault v, HookToken hook, HostilePlayer evil) internal view {
        assertTrue(evil.attempted(), "the attack never ran");
        assertFalse(evil.reentered(), "the vault let a payout re-enter it");
        assertEq(v.totalLocked(), hook.balanceOf(address(v)), "books no longer match the balance");
    }

    function test_reentrancy_leavePayoutCannotCallBackIn() public {
        (PokerVault v, HookToken hook, HostilePlayer evil) = _hostileSetup();
        evil.deposit(T1, 500 * U, address(evil));
        evil.arm(T1);
        evil.leave(T1);
        _assertBlocked(v, hook, evil);
        assertEq(hook.balanceOf(address(evil)), 1_000 * U);
    }

    function test_reentrancy_withdrawPayoutCannotCallBackIn() public {
        (PokerVault v, HookToken hook, HostilePlayer evil) = _hostileSetup();
        evil.deposit(T1, 500 * U, address(evil));
        hook.setBlocked(address(evil), true);
        evil.leave(T1); // the token refuses the push, so it is parked as a credit
        hook.setBlocked(address(evil), false);
        assertEq(v.withdrawable(address(evil)), 500 * U);
        evil.arm(T1);
        evil.withdraw();
        _assertBlocked(v, hook, evil);
        assertEq(hook.balanceOf(address(evil)), 1_000 * U);
    }

    function test_reentrancy_settlePayoutCannotCallBackIn() public {
        (PokerVault v, HookToken hook, HostilePlayer evil) = _hostileSetup();
        evil.deposit(T1, 500 * U, address(evil));
        vm.prank(players[0]);
        v.deposit(T1, 500 * U, sessionKeys[0]);

        // roster sorted by address; the session key of the contract player is the contract itself, which
        // cannot sign, so give it a real key instead: re-register before the table starts
        (address evilKey, uint256 evilPk) = makeAddrAndKey("evil-session");
        vm.prank(address(evil));
        v.setSessionKey(T1, evilKey);

        address[] memory roster = new address[](2);
        uint256[] memory pks = new uint256[](2);
        if (address(evil) < players[0]) {
            (roster[0], roster[1]) = (address(evil), players[0]);
            (pks[0], pks[1]) = (evilPk, sessionPks[0]);
        } else {
            (roster[0], roster[1]) = (players[0], address(evil));
            (pks[0], pks[1]) = (sessionPks[0], evilPk);
        }
        vm.prank(arbiter);
        v.start(T1, roster);

        PokerVault.State memory st;
        st.tableId = T1;
        st.nonce = 1;
        st.isFinal = true;
        st.players = roster;
        st.balances = new uint256[](2);
        st.balances[0] = 500 * U;
        st.balances[1] = 500 * U;
        st.keep = new bool[](2);
        bytes32 digest = v.stateDigest(st);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(pks[0], digest);
        sigs[1] = _sig(pks[1], digest);

        evil.arm(T1);
        v.settle(st, _sig(arbiterPk, digest), sigs);
        _assertBlocked(v, hook, evil);
        assertEq(hook.balanceOf(address(evil)), 1_000 * U);
        assertEq(hook.balanceOf(players[0]), 1_000 * U);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_blocksNewMoneyButNeverExits() public {
        _openAndStart(T1, 1000 * U);
        _create(keccak256("t2"));
        vm.prank(players[0]);
        vault.deposit(keccak256("t2"), 100 * U, sessionKeys[0]);

        vm.prank(owner);
        vault.pause();

        // new activity is blocked
        vm.prank(arbiter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.createTable(keccak256("t3"), 6, U, 10 * U);
        vm.prank(players[1]);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(keccak256("t2"), 100 * U, sessionKeys[1]);
        vm.prank(arbiter);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.start(keccak256("t2"), players);

        // everything that gets money out still works
        vm.prank(players[0]);
        vault.leave(keccak256("t2"));
        PokerVault.State memory s = _typical(20, false);
        _startExit(players[0], s);
        PokerVault.State memory newer = _typical(21, false);
        _challenge(stranger, newer);
        vm.warp(block.timestamp + WINDOW + 1);
        vault.finalizeExit(newer);
        assertEq(vault.totalLocked(), 0);

        vm.prank(owner);
        vault.unpause();
        _create(keccak256("t4"));
    }

    function test_pause_settleStillWorks() public {
        _openAndStart(T1, 1000 * U);
        vm.prank(owner);
        vault.pause();
        _settle(_typical(7, true));
        assertEq(vault.totalLocked(), 0);
    }

    // ----------------------------------------------------- the owner has no hands on funds

    function test_owner_hasNoWayToTakeFunds() public {
        _openAndStart(T1, 1000 * U);
        // owner and arbiter together still cannot settle without the players' session keys
        PokerVault.State memory s = _final(T1, 7, _bal(0, 0, 2960 * U), 40 * U);
        bytes32 digest = vault.stateDigest(s);
        (, uint256 ownerPk) = makeAddrAndKey("owner");
        bytes[] memory ps = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            ps[i] = _sig(ownerPk, digest);
        }
        vm.expectRevert(abi.encodeWithSelector(PokerVault.BadSignature.selector, 0));
        vault.settle(s, _sig(arbiterPk, digest), ps);
        assertEq(token.balanceOf(address(vault)), 3000 * U);
    }

    // ------------------------------------------------------------- fuzzing

    /// @dev Any split of the escrow that the signers agreed on is paid exactly, and nothing is left behind.
    function testFuzz_settle_paysExactlyWhatWasSigned(uint256 a, uint256 b, uint256 rakeCut) public {
        _openAndStart(T1, 1000 * U);
        uint256 escrow = 3000 * U;
        rakeCut = bound(rakeCut, 0, 150 * U); // <= 5% of 3000
        uint256 distributable = escrow - rakeCut;
        a = bound(a, 0, distributable);
        b = bound(b, 0, distributable - a);
        uint256 c = distributable - a - b;

        uint256[3] memory before_;
        for (uint256 i; i < N; ++i) {
            before_[i] = _tokenBal(players[i]);
        }
        _settle(_state(T1, 1, true, _bal(a, b, c), _keep(false, false, false), rakeCut, rakeCut * 20));
        assertEq(_tokenBal(players[0]), before_[0] + a);
        assertEq(_tokenBal(players[1]), before_[1] + b);
        assertEq(_tokenBal(players[2]), before_[2] + c);
        assertEq(_tokenBal(house), rakeCut);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalLocked(), 0);
    }

    /// @dev Whatever the amounts, a state that does not add up to the escrow is refused.
    function testFuzz_settle_rejectsAnythingThatDoesNotAddUp(uint256 a, uint256 b, uint256 c) public {
        _openAndStart(T1, 1000 * U);
        a = bound(a, 0, 10_000 * U);
        b = bound(b, 0, 10_000 * U);
        c = bound(c, 0, 10_000 * U);
        vm.assume(a + b + c != 3000 * U);
        PokerVault.State memory s = _final(T1, 1, _bal(a, b, c), 0);
        (bytes memory arb, bytes[] memory ps) = _sign(s);
        vm.expectRevert(abi.encodeWithSelector(PokerVault.NotConserved.selector, a + b + c, 3000 * U));
        vault.settle(s, arb, ps);
    }

    /// @dev Many players/limits: deposits always add up in the vault and in the books.
    function testFuzz_deposit_booksMatchBalance(uint256 a, uint256 b, uint256 c) public {
        _create(T1);
        a = bound(a, 100 * U, 10_000 * U);
        b = bound(b, 100 * U, 10_000 * U);
        c = bound(c, 100 * U, 10_000 * U);
        uint256[3] memory amounts = [a, b, c];
        for (uint256 i; i < N; ++i) {
            vm.prank(players[i]);
            vault.deposit(T1, amounts[i], sessionKeys[i]);
        }
        assertEq(token.balanceOf(address(vault)), a + b + c);
        assertEq(vault.totalLocked(), a + b + c);
        (,,,,,,,, uint256 escrow,,,) = vault.tables(T1);
        assertEq(escrow, a + b + c);
    }
}
