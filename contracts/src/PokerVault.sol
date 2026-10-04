// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PokerVault
/// @notice Non-custodial escrow for off-chain poker tables. Players lock tokens at a table; the game runs
///         off-chain and every hand produces a new EIP-712 `State` signed by the arbiter (the game server)
///         AND by every player's session key. Funds leave the vault only through a state all of them signed
///         (`settle`), through the challenge window (`startExit` -> `challenge` -> `finalizeExit`), or back
///         to the depositor while a table is still filling (`leave`). Neither the owner nor the arbiter can
///         move a player's funds on their own.
///
/// @dev Table life cycle ("epochs"):
///
///        createTable -> Filling --start--> Active --settle (final state)--> Filling (stayers roll over)
///                         ^                  |
///                         |                  +--startExit--> Exiting --finalizeExit--> Closed
///                         +-- deposit / leave
///
///      The roster is fixed while a table is Active. Joining, leaving and topping up happen between epochs:
///      the arbiter asks everyone to sign a `final` state in which each player says whether they `keep`
///      their chips at the table; leavers are paid, stayers carry their balance into the next epoch.
///
///      Only a state marked `isFinal` pays out immediately. An ordinary per-hand state can only be used
///      through the challenge window, so a player holding an old state cannot cash it in on the spot.
///
///      See docs/trust-model.md for the assumptions, and what the contract cannot protect against.
contract PokerVault is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum Status {
        None,
        Filling,
        Active,
        Exiting,
        Closed
    }

    /// @dev The signed object. `players` must equal the table's roster (strictly ascending addresses).
    ///      `rake` and `volume` are cumulative since the table was created. `keep` is only read by `settle`.
    struct State {
        bytes32 tableId;
        uint64 nonce;
        bool isFinal;
        address[] players;
        uint256[] balances;
        bool[] keep;
        uint256 rake;
        uint256 volume;
    }

    struct Table {
        Status status;
        uint8 maxPlayers;
        uint8 seated;
        address arbiter; // fixed when the table is created, so rotating the global arbiter never strands a table
        uint64 nonce; // highest state nonce accepted so far
        uint64 exitDeadline;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint256 escrow; // tokens locked for this table that are not yet paid out or credited
        uint256 rakePaid; // cumulative rake already paid to HOUSE
        bytes32 rosterHash; // keccak256(abi.encodePacked(players)) while Active / Exiting
        bytes32 exitDigest; // EIP-712 digest of the state an exit would pay out
    }

    struct Seat {
        uint256 deposit; // what this player has locked for the current epoch
        address sessionKey; // key allowed to sign states on this player's behalf at this table
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint8 public constant MAX_PLAYERS = 10;
    uint16 public constant RAKE_BPS_CEILING = 500; // 5%, matches packages/engine MAX_RAKE_BPS
    uint32 public constant MIN_EXIT_WINDOW = 1 hours;
    uint32 public constant MAX_EXIT_WINDOW = 30 days;

    bytes32 public constant STATE_TYPEHASH = keccak256(
        "State(bytes32 tableId,uint64 nonce,bool isFinal,address[] players,uint256[] balances,bool[] keep,uint256 rake,uint256 volume)"
    );

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable TOKEN;
    address public immutable HOUSE; // receives the rake
    uint32 public immutable EXIT_WINDOW; // seconds a challenge stays open
    uint16 public immutable MAX_RAKE_BPS; // cumulative rake / cumulative volume ceiling

    address public arbiter; // arbiter for tables created from now on
    uint256 public totalLocked; // every token the vault owes: sum(table escrow) + sum(withdrawable)

    mapping(bytes32 tableId => Table) public tables;
    mapping(bytes32 tableId => mapping(address player => Seat)) public seats;
    mapping(address account => uint256) public withdrawable; // payouts the token refused to push

    /*//////////////////////////////////////////////////////////////
                           EVENTS AND ERRORS
    //////////////////////////////////////////////////////////////*/

    event ArbiterChanged(address indexed arbiter);
    event TableCreated(
        bytes32 indexed tableId, address indexed arbiter, uint8 maxPlayers, uint256 minDeposit, uint256 maxDeposit
    );
    event Deposited(bytes32 indexed tableId, address indexed player, uint256 amount, uint256 total, address sessionKey);
    event SessionKeySet(bytes32 indexed tableId, address indexed player, address sessionKey);
    event Left(bytes32 indexed tableId, address indexed player, uint256 amount);
    event Started(bytes32 indexed tableId, address[] players);
    event Settled(bytes32 indexed tableId, uint64 nonce, uint256 rakePaid, uint256 rakeDelta, uint8 stayers);
    event ExitStarted(bytes32 indexed tableId, address indexed by, uint64 nonce, bytes32 digest, uint64 deadline);
    event Challenged(bytes32 indexed tableId, address indexed by, uint64 nonce, bytes32 digest, uint64 deadline);
    event ExitFinalized(bytes32 indexed tableId, uint64 nonce, uint256 rakePaid, uint256 rakeDelta);
    /// @dev `pushed` is false when the token refused the transfer and the amount became `withdrawable`.
    event Payout(bytes32 indexed tableId, address indexed to, uint256 amount, bool pushed);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    error BadConfig();
    error NotArbiter();
    error NotMember();
    error WrongStatus(Status actual);
    error TableExists();
    error BadTableParams();
    error ZeroAmount();
    error BadSessionKey();
    error DepositOutOfRange();
    error TableFull();
    error NoSeat();
    error TransferMismatch();
    error BadRoster();
    error BadLength();
    error StaleNonce(uint64 given, uint64 current);
    error NotFinal();
    error BadKeep(uint256 index);
    error RosterMismatch();
    error RakeDecreased();
    error RakeTooHigh();
    error NotConserved(uint256 claimed, uint256 escrow);
    error BadSignature(uint256 index); // type(uint256).max means the arbiter
    error ExitWindowClosed();
    error ExitWindowOpen();
    error DigestMismatch();
    error NothingToWithdraw();
    error RenounceDisabled();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param token_ The one ERC-20 this deployment escrows (Polygon USDC, BSC USDT, ...).
    /// @param house_ Where the rake goes.
    /// @param arbiter_ The game server's signing key.
    /// @param owner_ Admin that can pause deposits and rotate the arbiter. Use a multisig.
    /// @param exitWindow_ Seconds a dispute stays open (an hour at minimum, 30 days at most).
    /// @param maxRakeBps_ Cap on cumulative rake as a share of cumulative volume, at most 500.
    constructor(IERC20 token_, address house_, address arbiter_, address owner_, uint32 exitWindow_, uint16 maxRakeBps_)
        EIP712("PGG PokerVault", "1")
        Ownable(owner_)
    {
        if (address(token_).code.length == 0 || house_ == address(0) || arbiter_ == address(0)) revert BadConfig();
        if (exitWindow_ < MIN_EXIT_WINDOW || exitWindow_ > MAX_EXIT_WINDOW) revert BadConfig();
        if (maxRakeBps_ > RAKE_BPS_CEILING) revert BadConfig();
        TOKEN = token_;
        HOUSE = house_;
        EXIT_WINDOW = exitWindow_;
        MAX_RAKE_BPS = maxRakeBps_;
        arbiter = arbiter_;
        emit ArbiterChanged(arbiter_);
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Stops new tables, deposits and epoch starts. Settlement, exits, leaving and withdrawing
    ///         are never paused, so pausing cannot trap anyone's funds.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rotates the arbiter for tables created after this call. Existing tables keep theirs.
    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert BadConfig();
        arbiter = newArbiter;
        emit ArbiterChanged(newArbiter);
    }

    /// @dev Renouncing while paused would leave deposits paused forever.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /*//////////////////////////////////////////////////////////////
                         TABLE SET-UP (FILLING)
    //////////////////////////////////////////////////////////////*/

    /// @notice Opens a table in the Filling state. Only the current arbiter, so ids cannot be squatted.
    function createTable(bytes32 tableId, uint8 maxPlayers, uint256 minDeposit, uint256 maxDeposit)
        external
        whenNotPaused
    {
        if (msg.sender != arbiter) revert NotArbiter();
        Table storage t = tables[tableId];
        if (t.status != Status.None) revert TableExists();
        if (tableId == bytes32(0) || maxPlayers < 2 || maxPlayers > MAX_PLAYERS) revert BadTableParams();
        if (minDeposit == 0 || minDeposit > maxDeposit) revert BadTableParams();
        t.status = Status.Filling;
        t.arbiter = msg.sender;
        t.maxPlayers = maxPlayers;
        t.minDeposit = minDeposit;
        t.maxDeposit = maxDeposit;
        emit TableCreated(tableId, msg.sender, maxPlayers, minDeposit, maxDeposit);
    }

    /// @notice Locks `amount` for the caller at a table that is still filling. Calling again tops up.
    /// @param sessionKey Key that will sign states for this seat. Generate it fresh in the browser.
    function deposit(bytes32 tableId, uint256 amount, address sessionKey) external nonReentrant whenNotPaused {
        Table storage t = tables[tableId];
        if (t.status != Status.Filling) revert WrongStatus(t.status);
        if (amount == 0) revert ZeroAmount();
        if (sessionKey == address(0)) revert BadSessionKey();

        Seat storage seat = seats[tableId][msg.sender];
        uint256 total = seat.deposit + amount;
        if (total < t.minDeposit || total > t.maxDeposit) revert DepositOutOfRange();
        if (seat.deposit == 0) {
            if (t.seated >= t.maxPlayers) revert TableFull();
            t.seated += 1;
        }
        seat.deposit = total;
        seat.sessionKey = sessionKey;
        t.escrow += amount;
        totalLocked += amount;

        // Reject fee-on-transfer and other tokens that credit less than they were asked to move.
        uint256 balanceBefore = TOKEN.balanceOf(address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        if (TOKEN.balanceOf(address(this)) - balanceBefore != amount) revert TransferMismatch();

        emit Deposited(tableId, msg.sender, amount, total, sessionKey);
    }

    /// @notice Replaces the caller's session key while the table is still filling.
    function setSessionKey(bytes32 tableId, address sessionKey) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.status != Status.Filling) revert WrongStatus(t.status);
        if (sessionKey == address(0)) revert BadSessionKey();
        Seat storage seat = seats[tableId][msg.sender];
        if (seat.deposit == 0) revert NoSeat();
        seat.sessionKey = sessionKey;
        emit SessionKeySet(tableId, msg.sender, sessionKey);
    }

    /// @notice Takes the caller's whole stake back while the table is not running. Never paused.
    function leave(bytes32 tableId) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.status != Status.Filling) revert WrongStatus(t.status);
        uint256 amount = seats[tableId][msg.sender].deposit;
        if (amount == 0) revert NoSeat();

        delete seats[tableId][msg.sender];
        t.seated -= 1;
        t.escrow -= amount;

        emit Left(tableId, msg.sender, amount);
        _payout(tableId, msg.sender, amount);
    }

    /// @notice Freezes the roster and starts an epoch. `players` must be exactly the seated players, sorted
    ///         by address. Only the table's arbiter. Anyone who does not want to play can `leave` first.
    function start(bytes32 tableId, address[] calldata players) external whenNotPaused {
        Table storage t = tables[tableId];
        if (msg.sender != t.arbiter) revert NotArbiter();
        if (t.status != Status.Filling) revert WrongStatus(t.status);
        uint256 n = players.length;
        if (n < 2 || n != t.seated) revert BadRoster();
        address previous;
        for (uint256 i; i < n; ++i) {
            address p = players[i];
            // Strictly ascending means distinct. Distinct, funded and as many as the table has seated
            // means this is exactly the set of seated players.
            if (p <= previous || seats[tableId][p].deposit == 0) revert BadRoster();
            previous = p;
        }
        t.rosterHash = keccak256(abi.encodePacked(players));
        t.status = Status.Active;
        emit Started(tableId, players);
    }

    /*//////////////////////////////////////////////////////////////
                         COOPERATIVE CLOSE (ACTIVE)
    //////////////////////////////////////////////////////////////*/

    /// @notice Ends the epoch with a FINAL state signed by the arbiter and every player. Leavers are paid
    ///         now; players with `keep` set carry their balance into the next epoch. Anyone may submit it.
    ///         Honest signers sign at most one final state per epoch and nothing with a higher nonce after.
    function settle(State calldata s, bytes calldata arbiterSig, bytes[] calldata playerSigs) external nonReentrant {
        if (!s.isFinal) revert NotFinal();
        Table storage t = tables[s.tableId];
        if (t.status != Status.Active && t.status != Status.Exiting) revert WrongStatus(t.status);
        _verify(t, s, arbiterSig, playerSigs);

        uint256 rakeDelta = s.rake - t.rakePaid;
        t.nonce = s.nonce;
        t.rakePaid = s.rake;
        t.status = Status.Filling;
        t.rosterHash = bytes32(0);
        t.exitDigest = bytes32(0);
        t.exitDeadline = 0;

        uint256 n = s.players.length;
        uint256 kept;
        uint8 stayers;
        for (uint256 i; i < n; ++i) {
            Seat storage seat = seats[s.tableId][s.players[i]];
            if (s.keep[i]) {
                if (s.balances[i] == 0) revert BadKeep(i);
                seat.deposit = s.balances[i];
                kept += s.balances[i];
                stayers += 1;
            } else {
                delete seats[s.tableId][s.players[i]];
            }
        }
        t.escrow = kept;
        t.seated = stayers;

        emit Settled(s.tableId, s.nonce, s.rake, rakeDelta, stayers);
        for (uint256 i; i < n; ++i) {
            if (!s.keep[i]) _payout(s.tableId, s.players[i], s.balances[i]);
        }
        _payout(s.tableId, HOUSE, rakeDelta);
    }

    /*//////////////////////////////////////////////////////////////
                         DISPUTES (ACTIVE / EXITING)
    //////////////////////////////////////////////////////////////*/

    /// @notice Starts a unilateral exit from any state signed by the arbiter and every player. It becomes
    ///         final after EXIT_WINDOW unless someone submits a higher-nonce state with `challenge`.
    ///         Callable by a player at the table or the arbiter.
    function startExit(State calldata s, bytes calldata arbiterSig, bytes[] calldata playerSigs) external nonReentrant {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Active) revert WrongStatus(t.status);
        _requireMemberOrArbiter(t, s.tableId);
        bytes32 digest = _verify(t, s, arbiterSig, playerSigs);

        t.status = Status.Exiting;
        t.nonce = s.nonce;
        t.exitDigest = digest;
        uint64 deadline = uint64(block.timestamp + EXIT_WINDOW);
        t.exitDeadline = deadline;
        emit ExitStarted(s.tableId, msg.sender, s.nonce, digest, deadline);
    }

    /// @notice Starts an exit that returns every player's epoch deposit. For when no state was ever
    ///         signed in this epoch, or the signers vanished. Anyone holding a signed state with a higher
    ///         nonce can still `challenge` it. `players` is the roster, as in `Started`.
    function startExitFromDeposits(bytes32 tableId, address[] calldata players) external nonReentrant {
        Table storage t = tables[tableId];
        if (t.status != Status.Active) revert WrongStatus(t.status);
        _requireMemberOrArbiter(t, tableId);
        if (keccak256(abi.encodePacked(players)) != t.rosterHash) revert RosterMismatch();

        bytes32 digest = _hashState(_depositState(tableId, t, players));
        t.status = Status.Exiting;
        t.exitDigest = digest;
        uint64 deadline = uint64(block.timestamp + EXIT_WINDOW);
        t.exitDeadline = deadline;
        emit ExitStarted(tableId, msg.sender, t.nonce, digest, deadline);
    }

    /// @notice Replaces the pending exit with a state that has a higher nonce. Anyone may call, since the
    ///         signatures are the authority. Each challenge restarts the window so the other side can answer.
    function challenge(State calldata s, bytes calldata arbiterSig, bytes[] calldata playerSigs) external nonReentrant {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Exiting) revert WrongStatus(t.status);
        if (block.timestamp > t.exitDeadline) revert ExitWindowClosed();
        bytes32 digest = _verify(t, s, arbiterSig, playerSigs);

        t.nonce = s.nonce;
        t.exitDigest = digest;
        uint64 deadline = uint64(block.timestamp + EXIT_WINDOW);
        t.exitDeadline = deadline;
        emit Challenged(s.tableId, msg.sender, s.nonce, digest, deadline);
    }

    /// @notice Pays out the state the exit settled on and closes the table. Anyone may call once the
    ///         window has passed. `s` must be the state the exit holds (see `exitDigest`).
    function finalizeExit(State calldata s) external nonReentrant {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Exiting) revert WrongStatus(t.status);
        if (block.timestamp <= t.exitDeadline) revert ExitWindowOpen();
        if (_hashState(s) != t.exitDigest) revert DigestMismatch();

        uint256 n = s.players.length;
        if (s.balances.length != n) revert BadLength();
        if (s.rake < t.rakePaid) revert RakeDecreased();
        uint256 rakeDelta = s.rake - t.rakePaid;
        uint256 sum = rakeDelta;
        for (uint256 i; i < n; ++i) {
            sum += s.balances[i];
        }
        if (sum != t.escrow) revert NotConserved(sum, t.escrow); // already checked on entry; cheap to repeat

        t.status = Status.Closed;
        t.rakePaid = s.rake;
        t.escrow = 0;
        t.seated = 0;
        t.rosterHash = bytes32(0);
        t.exitDigest = bytes32(0);
        t.exitDeadline = 0;
        for (uint256 i; i < n; ++i) {
            delete seats[s.tableId][s.players[i]];
        }

        emit ExitFinalized(s.tableId, s.nonce, s.rake, rakeDelta);
        for (uint256 i; i < n; ++i) {
            _payout(s.tableId, s.players[i], s.balances[i]);
        }
        _payout(s.tableId, HOUSE, rakeDelta);
    }

    /*//////////////////////////////////////////////////////////////
                               WITHDRAWALS
    //////////////////////////////////////////////////////////////*/

    /// @notice Collects payouts the token refused to push (a blacklisted recipient, for instance).
    ///         Never paused.
    function withdraw(address to) external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        totalLocked -= amount;
        TOKEN.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                   VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The digest that the arbiter and every player sign for `s`.
    function stateDigest(State calldata s) external view returns (bytes32) {
        return _hashState(s);
    }

    /// @notice The state that `startExitFromDeposits` would put up, to pass to `finalizeExit` later.
    function depositState(bytes32 tableId, address[] calldata players) external view returns (State memory) {
        Table storage t = tables[tableId];
        if (keccak256(abi.encodePacked(players)) != t.rosterHash) revert RosterMismatch();
        return _depositState(tableId, t, players);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _requireMemberOrArbiter(Table storage t, bytes32 tableId) private view {
        if (msg.sender != t.arbiter && seats[tableId][msg.sender].deposit == 0) revert NotMember();
    }

    /// @dev Everything a state must satisfy before the vault will act on it. Returns its digest.
    function _verify(Table storage t, State calldata s, bytes calldata arbiterSig, bytes[] calldata playerSigs)
        private
        view
        returns (bytes32 digest)
    {
        if (s.nonce <= t.nonce) revert StaleNonce(s.nonce, t.nonce);
        uint256 n = s.players.length;
        if (s.balances.length != n || s.keep.length != n || playerSigs.length != n) revert BadLength();
        if (keccak256(abi.encodePacked(s.players)) != t.rosterHash) revert RosterMismatch();

        if (s.rake < t.rakePaid) revert RakeDecreased();
        if (s.rake * 10_000 > uint256(MAX_RAKE_BPS) * s.volume) revert RakeTooHigh();
        uint256 claimed = s.rake - t.rakePaid;
        for (uint256 i; i < n; ++i) {
            claimed += s.balances[i];
        }
        if (claimed != t.escrow) revert NotConserved(claimed, t.escrow);

        digest = _hashState(s);
        if (ECDSA.recoverCalldata(digest, arbiterSig) != t.arbiter) revert BadSignature(type(uint256).max);
        for (uint256 i; i < n; ++i) {
            if (ECDSA.recoverCalldata(digest, playerSigs[i]) != seats[s.tableId][s.players[i]].sessionKey) {
                revert BadSignature(i);
            }
        }
    }

    function _depositState(bytes32 tableId, Table storage t, address[] calldata players)
        private
        view
        returns (State memory s)
    {
        uint256 n = players.length;
        s.tableId = tableId;
        s.nonce = t.nonce;
        s.players = players;
        s.balances = new uint256[](n);
        s.keep = new bool[](n);
        s.rake = t.rakePaid;
        for (uint256 i; i < n; ++i) {
            s.balances[i] = seats[tableId][players[i]].deposit;
        }
    }

    function _hashState(State memory s) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STATE_TYPEHASH,
                    s.tableId,
                    s.nonce,
                    s.isFinal,
                    keccak256(abi.encodePacked(s.players)),
                    keccak256(abi.encodePacked(s.balances)),
                    keccak256(abi.encodePacked(s.keep)),
                    s.rake,
                    s.volume
                )
            )
        );
    }

    /// @dev Tries to send the tokens; if the token refuses (a blacklisted address, a paused token) the
    ///      amount is credited to `withdrawable` instead, so one bad recipient cannot block a settlement.
    function _payout(bytes32 tableId, address to, uint256 amount) private {
        if (amount == 0) return;
        bool pushed = TOKEN.trySafeTransfer(to, amount);
        if (pushed) {
            totalLocked -= amount;
        } else {
            withdrawable[to] += amount;
        }
        emit Payout(tableId, to, amount, pushed);
    }
}
