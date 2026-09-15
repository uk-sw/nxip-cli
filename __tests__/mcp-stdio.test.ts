import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

// These run the real CLI entry point as a child process, the way an MCP
// client launches it, because the two things they guard only exist at that
// level: what the process writes to stdout, and how it exits. The "API" is a
// local HTTP server on 127.0.0.1, so nothing leaves the machine.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_KEY = 'nxip_live_stdio0test1key2never3printed4';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Run from source through tsx, so this does not depend on a prior build (CI
// runs the tests before `npm run build`).
function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  stdinLines: string[] = [],
  expectedResponses = 0
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NXIP_API_KEY;
    delete cleanEnv.NXIP_URL;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: REPO_ROOT,
      env: { ...cleanEnv, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    // Everything is written at once, but stdin stays open until every
    // expected response has arrived: closing it early would end the session
    // before slower tool calls (real HTTP round trips) had answered.
    for (const line of stdinLines) child.stdin.write(`${line}\n`);
    const check = () => {
      if (stdout.split('\n').filter((l) => l.trim()).length >= expectedResponses) child.stdin.end();
    };
    child.stdout.on('data', check);
    check();
  });
}

describe('nxip mcp over stdio', () => {
  let api: Server;
  let apiUrl: string;
  const seenKeys: string[] = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      seenKeys.push(String(req.headers['x-api-key']));
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pools') {
        res.end(JSON.stringify({ data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ statusCode: 404, error: 'Not Found', message: `Nothing at ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
  });

  it('exits non-zero with one line on stderr naming NXIP_API_KEY when the key is missing', async () => {
    const result = await runCli(['mcp'], {});
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NXIP_API_KEY');
  }, 20_000);

  it('writes nothing but JSON-RPC to stdout, and never prints the key', async () => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pools', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_pool', arguments: { id: 'pool_missing' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_subnet', arguments: { family: 'IPV4', prefixLength: 99, environment: 'p', region: 'r' } } },
    ].map((m) => JSON.stringify(m));
    // Six messages, five responses: the initialized notification gets none.
    const result = await runCli(['mcp'], { NXIP_API_KEY: API_KEY, NXIP_URL: apiUrl }, messages, 5);

    const stdoutLines = result.stdout.split('\n').filter((l) => l.length > 0);
    expect(stdoutLines.length).toBe(5);
    for (const line of stdoutLines) {
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe('2.0');
    }

    const byId = new Map(stdoutLines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId.get(2).result.tools).toHaveLength(13);
    expect(byId.get(3).result.isError).toBeFalsy();
    expect(byId.get(4).result.isError).toBe(true);
    expect(byId.get(4).result.content[0].text).toContain("Nothing at /v1/pools/pool_missing");
    expect(byId.get(5).result.isError).toBe(true);

    // Exactly two requests reached the API (the invalid create never did),
    // both carrying the key, which then appears nowhere the process wrote.
    expect(seenKeys).toEqual([API_KEY, API_KEY]);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
    // Diagnostics did happen, on stderr.
    expect(result.stderr).toContain('nxip MCP server running on stdio');
  }, 20_000);
});
