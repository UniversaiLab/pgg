// What the table screen says about the vault, as pure functions of the public table state (TableState.vault:
// the server's epoch phase and whom it waits for) and of this device's signer (state.vault, from lib/vault.js).
// No @pgg/vault import: this ships in the eager bundle, the signer does not.

// Plain words for the rules a refused proposal broke (docs/trust-model.md, packages/vault rules.js).
const RULE_WORDS = {
  C1a: 'it was out of order with what you already signed',
  C1b: 'its chips do not match what happened at the table',
  C1c: 'its chips do not add up',
  C1d: 'it was for another table or another chain',
  C1e: 'it took more rake than the table allows',
  C2: 'it broke the rules for ending the table (you asked to leave, or it came after the final)',
  LEDGER: "the table's own accounts of the hand disagree",
  'STALE-EPOCH': 'it belonged to an earlier round of the table',
  STORAGE: 'this device could not save the signature first',
  MALFORMED: 'it was not a valid state',
  VIEW: 'this device could not check it',
};

const EPOCH_WORDS = {
  'FINAL-LATCHED': 'the last round of this table is not settled on chain yet',
  'NO-KEY': 'this device holds no key for this table',
  UNPINNED: 'this app cannot check the chain',
  'CHAIN-READ': 'the chain could not be reached (it will be checked again)',
  DOMAIN: 'it is for another chain or vault',
  TABLE: 'it is for another table',
};

const ruleWords = (rule) => RULE_WORDS[rule] ?? 'it broke a rule';
const nameAt = (table, seat) => table?.seats?.[seat]?.name ?? `seat ${seat + 1}`;

/** "m:ss" for a number of milliseconds (never negative). */
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the action bar says between hands at a vault table, or null (then it shows its usual text):
 * "Waiting for signatures (2/3)" while a signing round is open, "Waiting for NAME to reconnect" while the next
 * hand waits for an absent member.
 */
export function waitingText(table, now = Date.now()) {
  const v = table?.vault;
  if (!v || table.inHand) return null;
  const members = table.seats.filter((s) => s?.address).length;
  if (v.phase === 'settling') return 'Settling on chain…';
  if (v.phase === 'exiting') return 'The table is closing on chain';
  if (v.phase === 'filling' || v.phase === 'starting') return 'Waiting for the table to start';
  if (v.deadline !== null && v.deadline !== undefined) {
    const signed = Math.max(0, members - v.awaiting.length);
    const late = now > v.deadline;
    if (v.awaiting.length === 1 && late)
      return `Waiting for ${nameAt(table, v.awaiting[0])} to sign`;
    return `Waiting for signatures (${signed}/${members})${late ? '' : ` · ${clock(v.deadline - now)}`}`;
  }
  if (v.awaiting.length === 1) return `Waiting for ${nameAt(table, v.awaiting[0])} to reconnect`;
  if (v.awaiting.length > 1) return `Waiting for ${v.awaiting.length} players to reconnect`;
  return null;
}

/**
 * The persistent banner at a vault table (never a toast: these stay until the cause is gone), or null.
 * { tone: 'red' | 'white' | 'muted', title, body }. A failure of this device's signer comes first, then
 * what the table is doing.
 */
export function bannerFor(table, vault) {
  const phase = table?.vault?.phase ?? null;
  if (vault) {
    const f = vault.failure;
    if (vault.keyLost || (vault.hasKey === false && phase !== null)) {
      return {
        tone: 'red',
        title: 'This device has no key for this table',
        body: 'It cannot sign. Your money is safe: the table will exit on chain and pay everyone the last state all players signed.',
      };
    }
    if (f?.blocking) {
      const why =
        f.kind === 'equivocation'
          ? 'The table asked you to sign two different results for the same hand.'
          : f.kind === 'bundle-conflict'
            ? 'Two different fully signed results exist for the same hand.'
            : 'The record on this device cannot be read.';
      return {
        tone: 'red',
        title: 'Signing stopped at this table',
        body: `${why} Nothing more is signed here. The last state everyone signed stays valid and pays out on chain.`,
      };
    }
    if (vault.noChainView) {
      return {
        tone: 'red',
        title: 'Signing is off in this app',
        body: 'This version of the app cannot check the table against the chain, so it signs nothing.',
      };
    }
    if (vault.refused) {
      return {
        tone: 'red',
        title: 'A result was not signed',
        body: `The table proposed a result this device refused: ${ruleWords(vault.refused.rule)}.`,
      };
    }
    if (vault.epochProblem && vault.epochProblem.rule !== 'CHAIN-READ') {
      return {
        tone: 'red',
        title: 'The table could not be checked',
        body: `This device did not accept the table's starting balances: ${EPOCH_WORDS[vault.epochProblem.rule] ?? 'they do not match the chain'}.`,
      };
    }
    if (vault.waiting === 'storage') {
      return {
        tone: 'red',
        title: "This device's storage is unavailable",
        body: 'Nothing is signed until it can be saved first. Free some space or leave private browsing.',
      };
    }
    if (vault.waiting === 'other-tab') {
      return {
        tone: 'muted',
        title: 'Signing in another tab',
        body: 'Keep that tab open, or close it to sign here.',
      };
    }
    if (vault.unpinned) {
      return {
        tone: 'white',
        title: 'Development mode',
        body: 'This table was not checked against the chain.',
      };
    }
  }
  if (phase === 'stalled') {
    return {
      tone: 'white',
      title: 'Waiting for a player',
      body: 'If they do not come back, the table exits on chain and everyone is paid from the last signed state.',
    };
  }
  if (phase === 'exiting') {
    return {
      tone: 'white',
      title: 'The table is closing on chain',
      body: 'Everyone is paid from the last state all players signed. A newer signed state still counts until the window ends.',
    };
  }
  if (phase === 'halted') {
    return {
      tone: 'muted',
      title: 'The table is paused',
      body: 'No hands are dealt until it resumes.',
    };
  }
  return null;
}

/** "Signed state #n" for the fairness sheet, or null. */
export function signedLabel(vault) {
  const n = vault?.bundleNonce ?? null;
  return n === null ? null : `Signed state #${n}`;
}

/** The shield turns red when this device's signer is in trouble (the proofsBad precedent). */
export function vaultAlarm(vault) {
  return Boolean(
    vault && (vault.failure?.blocking || vault.keyLost || vault.refused || vault.noChainView),
  );
}
