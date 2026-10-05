// The child of the SIGKILL test: opens a file store, reserves one state after another as fast as the disk
// allows, and reports each nonce on stdout only AFTER reserve() has returned. The test kills this process
// at a random moment; whatever was reported must then be in the database.
//
//   bun sqlite-writer.js <database path>
//   bun sqlite-writer.js <database path> <phase> <n>
//
// The second form makes the child kill ITSELF with SIGKILL in the middle of a transaction, which a timer in
// the parent can almost never hit (the commit's fsync is slow, but a kill during it is harmless): during the
// n-th reserve of this run, after its 1st or 2nd write and before the commit (phase reserve:1, reserve:2), or
// during the n-th attach of the arbiter signature (attach:1).
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
  const state = world.stateAt(nonce);
  const digest = world.digestOf(state);
  if (phase?.startsWith('reserve:') && run === dieAt) store.failAfterWrites(dieAfterWrite, suicide);
  store.reserve(world.tableKey, state, digest);
  say(`${nonce} ${digest}`);
  if (phase === 'attach:1' && run === dieAt) store.failAfterWrites(1, suicide);
  store.attachArbiterSig(world.tableKey, nonce, world.arbiterSigFor(state));
  nonce += 1n;
}
