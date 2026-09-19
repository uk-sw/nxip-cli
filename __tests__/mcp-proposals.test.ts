import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { approvalLocation, createMcpServer, PROPOSAL_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/mcp.js';
import { describeKey } from '../src/client.js';

// Agent change proposals (docs/specs/agent-change-proposals.md), the MCP
// half: Done means 11 and 19. Offline, like the rest of the MCP tests: fetch
// is mocked for the in-memory server, and the stdio test talks to a local
// HTTP server on 127.0.0.1.

const API_KEY = 'nxip_live_proposals0a1b2c3d4e5f6a7b8c9d0e';
const BASE_URL = 'https://nxip.test';
const OPTIONS = { apiKey: API_KEY, baseUrl: BASE_URL };
const TS = '2026-09-19T10:00:00.000Z';

const proposal = {
  id: 'prop_1',
  organizationId: 'org_1',
  status: 'PENDING',
  reason: 'A subnet for the payments service',
  operations: [
    {
      type: 'create_subnet',
      input: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' },
      preview: {
        wouldSucceed: true,
        subnet: { cidr: '10.20.4.0/24' },
        container: { type: 'pool', id: 'pool_1', name: 'prod-eu', cidr: '10.20.0.0/16' },
      },
      result: null,
    },
    {
      type: 'allocate_address',
      input: { subnetId: 'sub_1', address: '10.20.4.10' },
      preview: { address: { address: '10.20.4.10', subnetId: 'sub_1' }, subnet: { id: 'sub_1', cidr: '10.20.4.0/24', name: 'app' } },
      result: null,
    },
  ],
  proposedBy: { organizationId: null, organizationName: null, label: 'agent', apiKeyId: 'key_1' },
  decidedBy: null,
  decisionNote: null,
  failure: null,
  expiresAt: TS,
  createdAt: TS,
  decidedAt: null,
};

const PROPOSE_ARGS = {
  reason: 'A subnet for the payments service',
  operations: [
    { type: 'create_subnet', input: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' } },
    { type: 'allocate_address', input: { subnetId: 'sub_1', address: '10.20.4.10' } },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function connect(serverOptions: { readOnly: boolean; proposalOnly?: boolean }, options: Record<string, unknown> = OPTIONS) {
  const server = createMcpServer(options as typeof OPTIONS, serverOptions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proposals-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function texts(result: CallToolResult): string[] {
  return result.content.map((c) => (c.type === 'text' ? c.text : ''));
}

describe('mcp server with change proposals', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('a proposal-only key', () => {
    it('lists the reads and propose_changes, and none of the direct write tools', async () => {
      const { tools } = await (await connect({ readOnly: false, proposalOnly: true })).listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...READ_TOOL_NAMES, ...PROPOSAL_TOOL_NAMES].sort());
      for (const write of WRITE_TOOL_NAMES) expect(names).not.toContain(write);
    });

    it.each(WRITE_TOOL_NAMES)('a call to %s is refused as an unknown tool, with no request', async (name) => {
      const client = await connect({ readOnly: false, proposalOnly: true });
      const result = await call(client, name, { name: 'x', cidr: '10.0.0.0/8', family: 'IPV4', environment: 'p', region: 'r' });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('under --read-only as well, only the reads remain', async () => {
      const { tools } = await (await connect({ readOnly: true, proposalOnly: true })).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    });
  });

  it('an ordinary key keeps every tool, propose_changes included', async () => {
    const { tools } = await (await connect({ readOnly: false })).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES, ...PROPOSAL_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
  });

  it('propose_changes tells the agent to give a reason and where the user approves', async () => {
    const { tools } = await (await connect({ readOnly: false, proposalOnly: true })).listTools();
    const description = tools.find((t) => t.name === 'propose_changes')?.description ?? '';
    expect(description).toMatch(/give a reason/i);
    // A test API, not production, so the dashboard is named rather than linked.
    expect(description).toContain('the Proposals page of your nxip dashboard');
    expect(description).not.toContain('app.nx-ip.com');
    expect(tools.find((t) => t.name === 'propose_changes')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('propose_changes round-trips: POST /v1/proposals with the reason and operations, and a summary naming where to approve', async () => {
    fetchMock.mockResolvedValue(jsonResponse(proposal, 201));
    const client = await connect({ readOnly: false, proposalOnly: true });

    const result = await call(client, 'propose_changes', PROPOSE_ARGS);

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/proposals`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(PROPOSE_ARGS);

    const [summary, json] = texts(result);
    expect(summary).toBe(
      'Proposed 2 changes as proposal prop_1: create subnet 10.20.4.0/24 in pool prod-eu; allocate 10.20.4.10 in subnet app. ' +
        `Nothing has changed yet. A person must approve it at the Proposals page of your nxip dashboard before ${TS}.`
    );
    expect(JSON.parse(json)).toEqual(proposal);
  });

  it('propose_changes requires a reason and validates each operation before any request', async () => {
    const client = await connect({ readOnly: false, proposalOnly: true });
    const invalid = [
      { operations: PROPOSE_ARGS.operations },
      { reason: 'x', operations: [] },
      { reason: 'x', operations: [{ type: 'delete_subnet', input: { id: 'sub_1' } }] },
      { reason: 'x', operations: [{ type: 'create_subnet', input: { family: 'IPV4', prefixLength: 99, environment: 'p', region: 'r' } }] },
      { reason: 'x', operations: [{ type: 'allocate_address', input: { subnetId: '../pools', address: '10.0.0.1' } }] },
      { reason: 'x', operations: Array.from({ length: 21 }, () => PROPOSE_ARGS.operations[0]) },
    ];
    for (const args of invalid) {
      const result = await call(client, 'propose_changes', args);
      expect(result.isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 422 names each operation that would fail and why', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: '1 of 2 operations would not succeed, so nothing was proposed. See each operation for why.',
          operations: [
            { index: 0, type: 'create_subnet', wouldSucceed: true, preview: {} },
            { index: 1, type: 'allocate_address', wouldSucceed: false, reason: 'outside-subnet', message: "'10.99.0.1' does not fall within subnet '10.20.4.0/24'." },
          ],
        },
        422
      )
    );
    const client = await connect({ readOnly: false, proposalOnly: true });
    const result = await call(client, 'propose_changes', PROPOSE_ARGS);
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("operation 2 (allocate_address): outside-subnet: '10.99.0.1' does not fall within subnet '10.20.4.0/24'.");
    expect(texts(result)[0]).not.toContain('operation 1 (');
  });

  it('get_proposal and list_proposals read their endpoints', async () => {
    const client = await connect({ readOnly: false, proposalOnly: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...proposal, status: 'FAILED', failure: { message: '10.20.4.0/24 was taken. Nothing was applied.' } }));
    const one = await call(client, 'get_proposal', { id: 'prop_1' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/v1/proposals/prop_1`);
    expect(texts(one)[0]).toBe(
      'Proposal prop_1 is FAILED: create subnet 10.20.4.0/24 in pool prod-eu; allocate 10.20.4.10 in subnet app. 10.20.4.0/24 was taken. Nothing was applied.'
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [proposal], meta: { total: 1, page: 1, limit: 50, totalPages: 1 } }));
    const list = await call(client, 'list_proposals', { status: 'PENDING' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/v1/proposals?status=PENDING`);
    expect(texts(list)[0]).toMatch(/^Found 1 proposal;/);
  });

  it('the proposal tools send x-nxip-organization when an organization is set', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(proposal, 201));
    const client = await connect({ readOnly: false, proposalOnly: true }, { ...OPTIONS, organizationId: 'org_customer' });
    await call(client, 'propose_changes', PROPOSE_ARGS);
    await call(client, 'get_proposal', { id: 'prop_1' });
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)['x-nxip-organization']).toBe('org_customer');
    }
  });

  it('describeKey never sends x-nxip-organization, even when an organization is set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'agent', keyPrefix: 'nxip_live_pr', role: 'MEMBER', proposalOnly: true }));
    const self = await describeKey({ ...OPTIONS, organizationId: 'org_customer' });
    expect(self.proposalOnly).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/api-keys/self`);
    expect(init.method).toBe('GET');
    expect(init.headers as Record<string, string>).not.toHaveProperty('x-nxip-organization');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(API_KEY);
  });
});

// ==========================================
// Done means 19, end to end over stdio
// ==========================================
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function runCli(args: string[], env: Record<string, string>, lines: string[], expectedResponses: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NXIP_API_KEY;
    delete cleanEnv.NXIP_URL;
    delete cleanEnv.NXIP_ORGANIZATION;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], { cwd: REPO_ROOT, env: { ...cleanEnv, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.split('\n').filter((l) => l.trim()).length >= expectedResponses) child.stdin.end();
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    for (const line of lines) child.stdin.write(`${line}\n`);
  });
}

const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const INIT = [
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proposals', version: '0' } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
];

describe('nxip mcp --organization with a proposal-only key, over stdio', () => {
  let api: Server;
  let apiUrl: string;
  const seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    // A fake API that behaves like the real one on the two points that
    // matter here: /v1/api-keys/self refuses the organization header (400,
    // amendment 4 of the spec), and a proposal lands in whichever
    // organization the header names.
    api = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        const organization = req.headers['x-nxip-organization'];
        if (req.url === '/v1/api-keys/self') {
          if (organization) {
            res.statusCode = 400;
            res.end(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'This endpoint cannot be used on behalf of another organization.' }));
            return;
          }
          res.end(JSON.stringify({ name: 'agent', keyPrefix: 'nxip_live_st', role: 'MEMBER', proposalOnly: true }));
        } else if (req.url === '/v1/proposals' && req.method === 'POST') {
          res.statusCode = 201;
          res.end(JSON.stringify({ ...proposal, organizationId: organization ?? 'own_org' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ statusCode: 404, error: 'Not Found', message: `Nothing at ${req.url}` }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
  });

  it('hides the direct write tools, and propose_changes lands in the customer', async () => {
    const lines = [
      ...INIT,
      rpc(2, 'tools/list'),
      rpc(3, 'tools/call', { name: 'propose_changes', arguments: PROPOSE_ARGS }),
      rpc(4, 'tools/call', { name: 'create_subnet', arguments: PROPOSE_ARGS.operations[0].input }),
    ];
    const { stdout, stderr } = await runCli(
      ['mcp', '--organization', 'org_customer'],
      { NXIP_API_KEY: 'nxip_live_stdio_proposals_key_0123456789', NXIP_URL: apiUrl },
      lines,
      4
    );
    const byId = new Map(stdout.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l)).map((m) => [m.id, m]));

    const names = byId.get(2).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('propose_changes');
    for (const write of WRITE_TOOL_NAMES) expect(names).not.toContain(write);

    expect(byId.get(3).result.isError).toBeFalsy();
    expect(JSON.parse(byId.get(3).result.content[1].text).organizationId).toBe('org_customer');
    // The hidden tool is unknown to the server: an error, and no request.
    expect(byId.get(4).result?.isError ?? byId.get(4).error).toBeTruthy();

    const self = seen.find((r) => r.url === '/v1/api-keys/self');
    expect(self?.headers['x-nxip-organization']).toBeUndefined();
    const proposed = seen.filter((r) => r.url === '/v1/proposals');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].headers['x-nxip-organization']).toBe('org_customer');
    expect(JSON.parse(proposed[0].body)).toEqual(PROPOSE_ARGS);
    expect(seen.some((r) => r.url === '/v1/subnets')).toBe(false);

    expect(stderr).toContain('proposal-only key: direct write tools not registered');
  }, 30_000);
});

describe('approvalLocation', () => {
  it('links app.nx-ip.com only for the production API', () => {
    expect(approvalLocation({ baseUrl: 'https://nxip.dev' })).toBe('https://app.nx-ip.com/proposals');
    expect(approvalLocation({ baseUrl: 'http://localhost:3000' })).toBe('the Proposals page of your nxip dashboard');
  });

  it('tells the user to switch to the customer when acting for one', () => {
    expect(approvalLocation({ baseUrl: 'https://nxip.dev', organizationId: 'org_customer' })).toBe(
      'https://app.nx-ip.com/proposals (after switching to acting for customer organization org_customer, since the proposal is in that organization)'
    );
  });
});

describe('propose_changes summary: kind, description and metadata (amendment 9)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('names a kind-tagged subnet as such, with its description and metadata, and the production link', async () => {
    const structural = {
      ...proposal,
      operations: [
        {
          type: 'create_subnet',
          input: {},
          preview: {
            subnet: { cidr: '10.20.8.0/22', kind: 'vpc', description: 'Shared services', metadata: { team: 'net' } },
            container: { type: 'pool', name: 'prod-eu', cidr: '10.20.0.0/16' },
          },
          result: null,
        },
        {
          type: 'create_pool',
          input: {},
          preview: { pool: { cidr: '10.30.0.0/16', name: 'prod-us', metadata: { owner: 'ops' } } },
          result: null,
        },
      ],
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(structural, 201));
    const client = await connect({ readOnly: false, proposalOnly: true }, { apiKey: API_KEY, baseUrl: 'https://nxip.dev' });
    const result = await call(client, 'propose_changes', PROPOSE_ARGS);
    expect(texts(result)[0]).toBe(
      'Proposed 2 changes as proposal prop_1: create vpc subnet 10.20.8.0/22 in pool prod-eu [kind vpc; description "Shared services"; metadata team=net]; ' +
        'create pool 10.30.0.0/16 (prod-us) [metadata owner=ops]. ' +
        `Nothing has changed yet. A person must approve it at https://app.nx-ip.com/proposals before ${TS}.`
    );
  });
});
