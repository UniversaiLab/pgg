import { describe, expect, test } from 'bun:test';

const run = async (file) => {
  const child = Bun.spawn(['bun', new URL(`./fixtures/${file}`, import.meta.url).pathname], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exited = await Promise.race([
    child.exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
  ]);
  if (exited === 'timeout') child.kill('SIGKILL');
  return {
    exited,
    signal: child.signalCode,
    out: await new Response(child.stdout).text(),
    err: await new Response(child.stderr).text(),
  };
};

describe('watchdog', () => {
  test('kills a process whose event loop is stuck', async () => {
    const result = await run('stall.js');
    expect(result.out).toContain('freezing');
    expect(result.exited).not.toBe('timeout'); // it did not hang forever
    expect(result.signal).toBe('SIGKILL');
    expect(result.err).toContain('watchdog');
  }, 15_000);

  test('leaves a busy but responsive process alone', async () => {
    const result = await run('healthy.js');
    expect(result.out).toContain('finished');
    expect(result.signal).toBeNull();
    expect(result.exited).toBe(0);
  }, 15_000);
});
