// Regenerates src/abi.js from the compiled contract: `bun packages/vault/scripts/vault-abi.js`
// (run `forge build` in contracts/ first). The test in test/abi.test.js fails when the committed copy
// differs from contracts/out, so the library never drifts from the contract it talks to.
import { readFileSync, writeFileSync } from 'node:fs';

export const ARTIFACT = new URL(
  '../../../contracts/out/PokerVault.sol/PokerVault.json',
  import.meta.url,
);
export const TARGET = new URL('../src/abi.js', import.meta.url);

const HEADER = `// The PokerVault ABI, committed as data so the browser and the server share one copy and nothing has to
// read contracts/out at run time. GENERATED: \`bun packages/vault/scripts/vault-abi.js\` rewrites it from
// the forge artifact, and test/abi.test.js fails when it is out of date.
`;

export function renderAbiModule(abi) {
  return `${HEADER}export const pokerVaultAbi = ${JSON.stringify(abi, null, 2)};\n`;
}

if (import.meta.main) {
  const { abi } = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  writeFileSync(TARGET, renderAbiModule(abi));
  // Keep the file in the shape biome wants, so regenerating leaves no lint diff.
  const format = Bun.spawnSync(['bunx', 'biome', 'format', '--write', TARGET.pathname], {
    cwd: new URL('../../../', import.meta.url).pathname,
  });
  if (format.exitCode !== 0) console.warn('biome format failed; run `bun run format` by hand');
  console.log(`wrote ${TARGET.pathname} (${abi.length} entries)`);
}
