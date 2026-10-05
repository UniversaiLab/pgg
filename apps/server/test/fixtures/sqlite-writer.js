// The child of the SIGKILL test: opens a file store, reserves one state after another as fast as the disk
// allows, and reports each nonce on stdout only AFTER reserve() has returned. The test kills this process
// at a random moment; whatever was reported must then be in the database.
//
//   bun sqlite-writer.js <database path>
//   bun sqlite-writer.js <database path> <phase> <n>
//
// The second form makes the child kill ITSELF with SIGKILL in the middle of a transaction, which a timer in
// the parent can almost never hit (the commit's fsync is slow, but a kill during it is harmless): during the
// n-th reserve of this run, after its 1st or 2nd write and before the commit (phase reserve:1, reserve:2),
// during the n-th attach of the arbiter signature (attach:1), or during the transaction the coordinator runs
// when the last signature of the n-th round arrives (settle:k, after its k-th write). That round is a final
// state, and the transaction is saveBundle + phase 'settling' + the settle job, all or nothing. The phase
// settle:done lets that transaction commit and then kills the child, so the test can see the other side.
//
// It continues from the store's high-water mark, so several runs on one file make one growing history.
import { writeSync } from 'node:fs';
import { SqliteStore } from '../../src/vault/sqlite-store.js';
import { makeWorld } from './store-world.js';

// fd 1 is a pipe the parent reads continuously. A synchronous write means the line is in the kernel
// before the next reserve starts, so a SIGKILL cannot swallow a line that was already "reported".
function say(line) {
  for (;;) {
    try {
      writeSync(1, `${line}\n`);
      return;
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

const [path, phase, at] = process.argv.slice(2);
const dieAt = phase ? Number(at) : null;
const dieAfterWrite = phase ? Number(phase.split(':')[1]) : null;
const suicide = () => process.kill(process.pid, 'SIGKILL');

const world = makeWorld();
const store = new SqliteStore(path);
if (!store.loadTable(world.tableKey)) store.saveTable(world.record());
say('ready');

let nonce = store.loadTable(world.tableKey).nonceHw + 1n;
for (let run = 1; ; run++) {
  const settling = phase?.startsWith('settle:') && run === dieAt;
  const state = world.stateAt(
    nonce,
    settling ? { isFinal: true, keep: world.players.map(() => true) } : {},
  );
  const digest = world.digestOf(state);
  if (phase?.startsWith('reserve:') && run === dieAt) store.failAfterWrites(dieAfterWrite, suicide);
  store.reserve(world.tableKey, state, digest);
  say(`${nonce} ${digest}`);
  if (phase === 'attach:1' && run === dieAt) store.failAfterWrites(1, suicide);
  store.attachArbiterSig(world.tableKey, nonce, world.arbiterSigFor(state));
  if (settling) {
    // the last player signature arrives: complete the round and queue the settle in one transaction
    if (phase !== 'settle:done') store.failAfterWrites(dieAfterWrite, suicide);
    store.transaction(() => {
      store.saveBundle(world.tableKey, world.bundleFor(state), world.verifyCtx());
      store.saveTable(world.record({ phase: 'settling' }));
      store.enqueueJob({
        key: `chain-action:${world.tableKey}`,
        kind: 'settle',
        tableKey: world.tableKey,
        priority: 5,
      });
    });
    say('committed'); // reached only if the kill did not land inside the transaction
    suicide();
  }
  nonce += 1n;
}
