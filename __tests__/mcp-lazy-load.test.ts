import { afterEach, describe, expect, it, vi } from 'vitest';

// index.ts runs main() as soon as it is imported, so each test sets argv,
// imports it fresh, and waits for main to finish. mcp.js is replaced by a
// mock whose factory records that it was loaded: the factory only runs if
// something actually imports the module.
const loaded = vi.hoisted(() => ({ mcp: false, run: vi.fn(async () => {}) }));
vi.mock('../src/mcp.js', () => {
  loaded.mcp = true;
  return { runMcpServer: loaded.run };
});

describe('the MCP SDK is only loaded by the mcp command', () => {
  const originalArgv = process.argv;
  const originalKey = process.env.NXIP_API_KEY;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalKey === undefined) delete process.env.NXIP_API_KEY;
    else process.env.NXIP_API_KEY = originalKey;
    process.exitCode = undefined;
    loaded.mcp = false;
    loaded.run.mockClear();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runIndex(args: string[]) {
    process.argv = ['node', 'nxip', ...args];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/index.js');
    // main() is not exported; give its promise chain time to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('--version does not import mcp.js', async () => {
    await runIndex(['--version']);
    expect(console.log).toHaveBeenCalled();
    expect(loaded.mcp).toBe(false);
  });

  it('plan without a key does not import mcp.js', async () => {
    delete process.env.NXIP_API_KEY;
    await runIndex(['plan', '-f', 'x.yaml']);
    expect(loaded.mcp).toBe(false);
  });

  // The control: proves the check above can see a load when one happens.
  it('mcp does import it, and runs the server', async () => {
    process.env.NXIP_API_KEY = 'nxip_live_lazyloadtest';
    await runIndex(['mcp', '--read-only']);
    expect(loaded.mcp).toBe(true);
    expect(loaded.run).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'nxip_live_lazyloadtest' }), { readOnly: true });
  });

  it('mcp with an unknown flag exits 1 without starting the server', async () => {
    process.env.NXIP_API_KEY = 'nxip_live_lazyloadtest';
    await runIndex(['mcp', '--readonly']);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Unknown argument "--readonly" for mcp\./));
    expect(loaded.run).not.toHaveBeenCalled();
  });
});
