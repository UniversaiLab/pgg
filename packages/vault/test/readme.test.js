// The README's worked example is the real scripts/example.js, and it still gives the answers it claims.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { main } from '../scripts/example.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('README worked example', () => {
  test('README.md contains scripts/example.js verbatim', () => {
    const example = read('../scripts/example.js').trimEnd();
    expect(read('../README.md')).toContain(`\`\`\`js\n${example}\n\`\`\``);
  });

  test('it runs and every step does what the comments say', () => {
    const r = main();
    expect(r.proposal.ok).toBe(true);
    // every yes carries the digest the client computed, and it is the state's digest
    expect(r.verdicts).toEqual([1, 2, 3].map(() => ({ ok: true, digest: r.hashed })));
    expect(r.refused).toMatchObject({ ok: false, rule: 'C1c' });
    expect(r.decision).toBe('new');
    expect(r.again).toBe('repeat');
    expect(r.verified).toMatchObject({ ok: true });
    expect(r.contractView).toEqual({ ok: true, digest: r.verified.digest });
    expect(r.newer).toBe(true);
    expect(r.conflict).toBeNull();
    expect(r.mayDeal).toBe(true);
  });
});
