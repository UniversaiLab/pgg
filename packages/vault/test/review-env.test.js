// Review of the package rules in README.md: browser-safe, deterministic, environment independent. Nothing in
// packages/vault/src may import node:, viem or a Buffer, read the clock, or call Math.random; the only
// randomness is crypto.getRandomValues inside newPrivateKey. Checked two ways: a scan of the source text
// (cheap, catches a future import) and a run in a child process where those APIs are booby-trapped.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
const code = (file) =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); // line comments (a quick pass is enough here)

describe('the source text', () => {
  test('there are source files to scan', () => {
    expect(files).toContain('index.js');
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  const forbidden = {
    'a node: import': /\bfrom\s+['"]node:|\brequire\(\s*['"]node:|\bimport\(\s*['"]node:/,
    'a bare node builtin':
      /\bfrom\s+['"](fs|path|os|crypto|buffer|util|stream|events|child_process|http|https|net|url)['"]/,
    viem: /\bfrom\s+['"]viem|\bfrom\s+['"]ethers|\bfrom\s+['"]@noble\/curves\/(?!secp256k1\.js)/,
    Buffer: /\bBuffer\b/,
    'the clock': /\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b|\bqueueMicrotask\b/,
    'Math.random': /\bMath\.random\b/,
    'process or Bun globals': /\bprocess\b|\bBun\b|\bDeno\b|\bglobalThis\.process\b/,
    'locale or Intl': /\btoLocale\w*|\blocaleCompare\b|\bIntl\b/,
    'the DOM': /\bwindow\b|\bdocument\b|\blocalStorage\b|\bnavigator\b|\bfetch\(/,
    'console output': /\bconsole\./,
    'environment variables': /\benv\./,
  };
  for (const [name, pattern] of Object.entries(forbidden)) {
    test(`no source file uses ${name}`, () => {
      const hits = files.filter((f) => f !== 'abi.js' && pattern.test(code(f)));
      expect(hits).toEqual([]);
    });
  }

  test('the only module that names the randomness source is sign.js, and it goes through noble', () => {
    for (const f of files) {
      const text = code(f);
      expect(/getRandomValues/.test(text), f).toBe(false); // noble's randomSecretKey is the one caller
    }
    expect(code('sign.js')).toMatch(/randomSecretKey/);
  });

  test('every import is a relative file, @pgg/protocol/vault, or one of the two declared @noble packages', () => {
    const allowed = [
      /^\.\/[\w-]+\.js$/,
      /^@pgg\/protocol\/vault$/,
      /^@noble\/curves\/secp256k1\.js$/,
      /^@noble\/hashes\/sha3\.js$/,
      /^@noble\/hashes\/utils\.js$/,
    ];
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    for (const f of files) {
      const imports = [
        ...readFileSync(join(SRC, f), 'utf8').matchAll(
          /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm,
        ),
      ].map((m) => m[1]);
      for (const spec of imports) {
        expect(
          allowed.some((re) => re.test(spec)),
          `${f} imports ${spec}`,
        ).toBe(true);
        if (!spec.startsWith('.')) {
          const name = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0];
          expect(
            Object.keys(pkg.dependencies ?? {}),
            `${spec} is not a declared dependency`,
          ).toContain(name);
        }
      }
    }
  });

  test('viem stays a dev dependency', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('viem');
  });

  test('every relative import resolves to a file that exists (no dangling re-export)', () => {
    for (const f of files) {
      for (const m of readFileSync(join(SRC, f), 'utf8').matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
        expect(files, `${f} -> ${m[1]}`).toContain(m[1].slice(2));
      }
    }
  });
});

describe('a child process where the clock, Math.random, Buffer and the locale are booby-trapped', () => {
  // Runs the worked example (every public function on a three-player table) plus a few more calls. Any
  // read of Date.now / new Date / Math.random / Buffer, or any use of toLocale*, throws.
  const script = `
    const trap = (name) => () => { throw new Error('forbidden: ' + name); };
    Math.random = trap('Math.random');
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct: trap('new Date'), apply: trap('Date()'),
      get: (t, k) => (k === 'now' ? trap('Date.now') : Reflect.get(t, k)),
    });
    for (const k of ['toLocaleLowerCase', 'toLocaleUpperCase', 'localeCompare']) String.prototype[k] = trap('String.' + k);
    Number.prototype.toLocaleString = trap('Number.toLocaleString');
    BigInt.prototype.toLocaleString = trap('BigInt.toLocaleString');
    Array.prototype.toLocaleString = trap('Array.toLocaleString');
    const RealBuffer = globalThis.Buffer;
    Object.defineProperty(globalThis, 'Buffer', { get: trap('Buffer'), configurable: true });
    const { main } = await import(${JSON.stringify(join(SRC, '..', 'scripts', 'example.js'))});
    const out = main();
    const V = await import(${JSON.stringify(join(SRC, 'index.js'))});
    const k = V.newPrivateKey();
    const ok = out.verified.ok === true && out.proposal.ok === true && out.mayDeal === true && /^0x[0-9a-f]{64}$/.test(k);
    process.stdout.write(JSON.stringify({ ok }));
  `;

  test('the worked example and newPrivateKey run without touching any of them', () => {
    const run = Bun.spawnSync([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' },
    });
    const stderr = new TextDecoder().decode(run.stderr);
    expect(stderr).not.toMatch(/forbidden/);
    expect(new TextDecoder().decode(run.stdout)).toBe('{"ok":true}');
    expect(run.exitCode).toBe(0);
  });

  test('the digest of a fixed state is the same under another locale and time zone', () => {
    const probe = `
      const V = await import(${JSON.stringify(join(SRC, 'index.js'))});
      const state = { tableId: '0x' + 'ab'.repeat(32), nonce: 7n, isFinal: true, players: ['0x' + '00'.repeat(19) + '01', '0x' + '00'.repeat(19) + '02'],
        balances: [10n, 20n], keep: [true, false], rake: 1n, volume: 100n };
      process.stdout.write(V.hashState(state, { chainId: 31337, verifyingContract: '0x' + '00'.repeat(19) + 'ff' }));
    `;
    const outputs = ['en_US.UTF-8', 'tr_TR.UTF-8', 'de_DE.UTF-8', 'C'].map((locale, i) => {
      const run = Bun.spawnSync([process.execPath, '-e', probe], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          LANG: locale,
          LC_ALL: locale,
          TZ: ['UTC', 'Asia/Kolkata', 'America/Sao_Paulo', 'Pacific/Kiritimati'][i],
        },
      });
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
      return new TextDecoder().decode(run.stdout);
    });
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
