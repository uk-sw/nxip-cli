import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp.js';

// Spec conformance tests for docs/specs/mcp-server.md, written by the tester
// independently of the builder's own suite. Every expectation below comes
// from the spec's Interface table and "Done means" list, or from the API
// route schemas in net-saas-monorepo/apps/api/src/routes/, never from
// src/mcp.ts. In particular the tool names are written out here rather than
// imported, so a tool silently added to or dropped from the implementation's
// own name lists cannot make these tests agree with it.

const API_KEY = 'nxip_live_conformance0a1b2c3d4e5f6a7b8c9d';
const BASE_URL = 'https://nxip.conformance.test';
const OPTIONS = { apiKey: API_KEY, baseUrl: BASE_URL };

// The spec's Interface table, verbatim.
const SPEC_TABLE = [
  { tool: 'list_pools', method: 'GET', path: '/v1/pools', kind: 'read' },
  { tool: 'get_pool', method: 'GET', path: '/v1/pools/:id', kind: 'read' },
  { tool: 'forecast_pools', method: 'GET', path: '/v1/pools/forecast', kind: 'read' },
  { tool: 'list_subnets', method: 'GET', path: '/v1/subnets', kind: 'read' },
  { tool: 'get_subnet', method: 'GET', path: '/v1/subnets/:id', kind: 'read' },
  { tool: 'list_addresses', method: 'GET', path: '/v1/subnets/:id/addresses', kind: 'read' },
  { tool: 'lookup_ip', method: 'GET', path: '/v1/lookup', kind: 'read' },
  { tool: 'search', method: 'GET', path: '/v1/search', kind: 'read' },
  { tool: 'get_usage', method: 'GET', path: '/v1/organizations/usage', kind: 'read' },
  { tool: 'preview_subnet', method: 'POST', path: '/v1/subnets/preview', kind: 'read' },
  { tool: 'create_pool', method: 'POST', path: '/v1/pools', kind: 'write' },
  { tool: 'create_subnet', method: 'POST', path: '/v1/subnets', kind: 'write' },
  { tool: 'allocate_address', method: 'POST', path: '/v1/subnets/:id/addresses', kind: 'write' },
] as const;

const ALL_TOOLS = SPEC_TABLE.map((row) => row.tool).sort();
const READ_TOOLS = SPEC_TABLE.filter((row) => row.kind === 'read').map((row) => row.tool).sort();
const WRITE_TOOLS = SPEC_TABLE.filter((row) => row.kind === 'write').map((row) => row.tool).sort();

// Every field each route's Zod schema accepts (querystring, body, and the
// :id path param where there is one). A tool input property outside its set
// is a field the API does not have. The two address routes take the subnet's
// id as `:id`; the spec does not name the tool input for it, and the tools
// call it `subnetId` (read from the tool list, a public interface). That is a
// rename of the same path parameter, not an invented field, so it is allowed.
const SUBNET_BODY_FIELDS = [
  'environment', 'region', 'metadata', 'cidr', 'parentSubnetId', 'kind', 'name', 'description', 'family', 'prefixLength',
];
const ROUTE_FIELDS: Record<string, string[]> = {
  list_pools: ['environment', 'region', 'family', 'page', 'limit'],
  get_pool: ['id'],
  forecast_pools: [],
  list_subnets: ['environment', 'region', 'family', 'page', 'limit'],
  get_subnet: ['id'],
  list_addresses: ['subnetId', 'status', 'page', 'limit'],
  lookup_ip: ['ip'],
  search: ['q', 'limit'],
  get_usage: [],
  preview_subnet: SUBNET_BODY_FIELDS,
  create_pool: ['name', 'cidr', 'family', 'environment', 'region', 'metadata'],
  create_subnet: SUBNET_BODY_FIELDS,
  allocate_address: ['subnetId', 'address', 'status', 'hostname', 'metadata'],
};

// Fields the routes cannot do without (non-optional in their Zod schemas).
const ROUTE_REQUIRED: Record<string, string[]> = {
  get_pool: ['id'],
  get_subnet: ['id'],
  list_addresses: ['subnetId'],
  lookup_ip: ['ip'],
  search: ['q'],
  preview_subnet: ['family'],
  create_subnet: ['family'],
  create_pool: ['name', 'cidr', 'family', 'environment', 'region'],
  allocate_address: ['subnetId', 'address'],
};

const TS = '2026-09-01T10:00:00.000Z';
const subnetRecord = {
  id: 'sub_42', cidr: '10.20.4.0/24', prefixLength: 24, family: 'IPV4', environment: 'production', region: 'eu-west-1',
  ipPoolId: 'pool_7', parentSubnetId: null, kind: null, name: 'payments', description: null, metadata: {}, createdAt: TS,
};
const poolRecord = {
  id: 'pool_7', organizationId: 'org_1', name: 'prod-eu', cidr: '10.20.0.0/16', family: 'IPV4', environment: 'production',
  region: 'eu-west-1', metadata: {}, createdAt: TS, updatedAt: TS,
};
const addressRecord = {
  id: 'addr_9', subnetId: 'sub_42', address: '10.20.4.17', family: 'IPV4', status: 'ACTIVE', hostname: 'db-1',
  metadata: {}, createdAt: TS, updatedAt: TS,
};
const page = { total: 1, page: 1, limit: 20, totalPages: 1 };
const metric = { current: 1, limit: 10, percentageUsed: 10, isUnlimited: false, isOverLimit: false };

interface Case {
  tool: string;
  args: Record<string, unknown>;
  // The concrete request the spec table and route files say this call makes.
  method: string;
  pathname: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  status: number;
  response: unknown;
}

const CASES: Case[] = [
  {
    tool: 'list_pools', args: {}, method: 'GET', pathname: '/v1/pools', status: 200,
    response: { data: [{ ...poolRecord, utilization: { subnetCount: 0 } }], meta: page },
  },
  {
    tool: 'get_pool', args: { id: 'pool_7' }, method: 'GET', pathname: '/v1/pools/pool_7', status: 200,
    response: { ...poolRecord, utilization: { subnetCount: 0 } },
  },
  {
    tool: 'forecast_pools', args: {}, method: 'GET', pathname: '/v1/pools/forecast', status: 200,
    response: {
      data: [{ poolId: 'pool_7', poolName: 'prod-eu', runwayDays: null, exhaustsOn: null, burnPerDay: null, allocations: 0, observedDays: 0, freeAddresses: 65536, reason: 'insufficient_history' }],
      meta: { windowDays: 90, minAllocations: 3, minSpanDays: 7 },
    },
  },
  {
    tool: 'list_subnets', args: {}, method: 'GET', pathname: '/v1/subnets', status: 200,
    response: { data: [{ ...subnetRecord, updatedAt: TS }], meta: page },
  },
  {
    tool: 'get_subnet', args: { id: 'sub_42' }, method: 'GET', pathname: '/v1/subnets/sub_42', status: 200,
    response: { ...subnetRecord, updatedAt: TS },
  },
  {
    tool: 'list_addresses', args: { subnetId: 'sub_42' }, method: 'GET', pathname: '/v1/subnets/sub_42/addresses', status: 200,
    response: { data: [addressRecord], meta: page },
  },
  {
    tool: 'lookup_ip', args: { ip: '10.20.4.17' }, method: 'GET', pathname: '/v1/lookup', query: { ip: '10.20.4.17' }, status: 200,
    response: {
      ip: '10.20.4.17', family: 'IPV4', matchType: 'address',
      address: { id: 'addr_9', address: '10.20.4.17', status: 'ACTIVE', hostname: 'db-1', subnetId: 'sub_42' },
      pool: { id: 'pool_7', name: 'prod-eu', cidr: '10.20.0.0/16', environment: 'production', region: 'eu-west-1' },
    },
  },
  {
    tool: 'search', args: { q: 'payments' }, method: 'GET', pathname: '/v1/search', query: { q: 'payments' }, status: 200,
    response: { query: 'payments', pools: [], subnets: [], addresses: [], truncated: false },
  },
  {
    tool: 'get_usage', args: {}, method: 'GET', pathname: '/v1/organizations/usage', status: 200,
    response: {
      organizationId: 'org_1', tier: 'FREE', rateLimitRpm: 60,
      metrics: { pools: metric, subnets: metric, ipv4Addresses: metric, addressRecords: metric, seats: metric },
    },
  },
  {
    tool: 'preview_subnet',
    args: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' },
    method: 'POST', pathname: '/v1/subnets/preview',
    body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' },
    status: 200,
    response: {
      wouldSucceed: true,
      subnet: { cidr: '10.20.4.0/24', prefixLength: 24, family: 'IPV4', environment: 'production', region: 'eu-west-1', ipPoolId: 'pool_7', parentSubnetId: null, kind: null, name: null, description: null, metadata: {} },
      container: { type: 'pool', id: 'pool_7', name: 'prod-eu', cidr: '10.20.0.0/16' },
      utilization: { before: { subnetCount: 0 }, after: { subnetCount: 1 } },
    },
  },
  {
    tool: 'create_pool',
    args: { name: 'prod-eu', cidr: '10.20.0.0/16', family: 'IPV4', environment: 'production', region: 'eu-west-1' },
    method: 'POST', pathname: '/v1/pools',
    body: { name: 'prod-eu', cidr: '10.20.0.0/16', family: 'IPV4', environment: 'production', region: 'eu-west-1' },
    status: 201, response: poolRecord,
  },
  {
    tool: 'create_subnet',
    args: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1', name: 'payments' },
    method: 'POST', pathname: '/v1/subnets',
    body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1', name: 'payments' },
    status: 201, response: subnetRecord,
  },
  {
    tool: 'allocate_address',
    args: { subnetId: 'sub_42', address: '10.20.4.17', hostname: 'db-1' },
    method: 'POST', pathname: '/v1/subnets/sub_42/addresses',
    body: { address: '10.20.4.17', hostname: 'db-1' },
    status: 201, response: addressRecord,
  },
];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function connect(readOnly = false): Promise<Client> {
  const server = createMcpServer(OPTIONS, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'spec-conformance', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function allText(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
}

// "Returns the API's JSON response as text content": some part of the text,
// once the one-line summary is set aside, must parse to exactly that JSON.
function containsJson(result: CallToolResult, expected: unknown): boolean {
  const candidates: string[] = [];
  for (const c of result.content) {
    if (c.type !== 'text') continue;
    candidates.push(c.text);
    const newline = c.text.indexOf('\n');
    if (newline >= 0) candidates.push(c.text.slice(newline + 1));
  }
  return candidates.some((text) => {
    try {
      expect(JSON.parse(text)).toEqual(expected);
      return true;
    } catch {
      return false;
    }
  });
}

describe('MCP server conformance to docs/specs/mcp-server.md', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const written: string[] = [];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    written.length = 0;
    // Capture everything the process would print, so the key-leak tests can
    // look at stdout and stderr as well as the tool results.
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => void written.push(parts.map(String).join(' ')));
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function requestsMade(): { method: string; url: URL; headers: Headers; body: unknown }[] {
    return fetchMock.mock.calls.map(([input, init]) => {
      const reqInit = (init ?? {}) as RequestInit;
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (reqInit.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const rawBody = reqInit.body;
      return {
        method,
        url,
        headers: new Headers(reqInit.headers ?? (input instanceof Request ? input.headers : undefined)),
        body: typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
      };
    });
  }

  it('the cases below cover every row of the spec table, once', () => {
    expect(CASES.map((c) => c.tool).sort()).toEqual(ALL_TOOLS);
  });

  describe('Done means 1: exactly the 13 tools', () => {
    it('lists exactly the spec table names and nothing else', async () => {
      const { tools } = await (await connect()).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
      expect(tools).toHaveLength(13);
    });

    it('exposes no delete, update or release tool of any name', async () => {
      const { tools } = await (await connect()).listTools();
      for (const tool of tools) expect(tool.name).not.toMatch(/delete|remove|update|patch|release|put|edit/i);
    });
  });

  describe('Done means 2: --read-only', () => {
    it('lists exactly the 10 read tools', async () => {
      const { tools } = await (await connect(true)).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
      expect(tools).toHaveLength(10);
    });

    it('still lists preview_subnet, which is a read even though it is a POST', async () => {
      const { tools } = await (await connect(true)).listTools();
      expect(tools.map((t) => t.name)).toContain('preview_subnet');
    });

    it.each(WRITE_TOOLS)('calling %s is a tool error and makes no request', async (tool) => {
      const client = await connect(true);
      const writeCase = CASES.find((c) => c.tool === tool)!;
      const result = await call(client, tool, writeCase.args);
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      // The session survives the refusal.
      fetchMock.mockResolvedValue(jsonResponse(CASES[0].response, 200));
      expect((await call(client, 'list_pools', {})).isError).toBeFalsy();
    });

    it('read tools still work under --read-only', async () => {
      const client = await connect(true);
      fetchMock.mockResolvedValue(jsonResponse(CASES[0].response, 200));
      const result = await call(client, 'list_pools', {});
      expect(result.isError).toBeFalsy();
      expect(requestsMade()[0].method).toBe('GET');
    });
  });

  describe('Annotations (In scope)', () => {
    let tools: Tool[];
    beforeEach(async () => {
      tools = (await (await connect()).listTools()).tools;
    });

    it.each(READ_TOOLS)('%s carries readOnlyHint: true', (name) => {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    });

    it.each(WRITE_TOOLS)('%s is not read-only, and says destructiveHint: false and idempotentHint: false', (name) => {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations?.readOnlyHint).not.toBe(true);
      // Explicitly false: the MCP default for destructiveHint is true, so
      // leaving it out would tell a client a create is destructive.
      expect(annotations?.destructiveHint).toBe(false);
      expect(annotations?.idempotentHint).toBe(false);
    });

    it('create_subnet tells the model to call preview_subnet first when unsure', () => {
      expect(tools.find((t) => t.name === 'create_subnet')?.description).toMatch(/preview_subnet/);
    });
  });

  describe('Done means 3: each tool calls exactly its endpoint, with the key, and returns the response', () => {
    it.each(CASES)('$tool -> $method $pathname', async (testCase) => {
      fetchMock.mockResolvedValue(jsonResponse(testCase.response, testCase.status));
      const result = await call(await connect(), testCase.tool, testCase.args);

      expect(result.isError).toBeFalsy();
      const requests = requestsMade();
      expect(requests).toHaveLength(1);
      const [req] = requests;
      expect(req.method).toBe(testCase.method);
      expect(req.url.origin).toBe(BASE_URL);
      expect(req.url.pathname).toBe(testCase.pathname);
      expect(Object.fromEntries(req.url.searchParams)).toEqual(testCase.query ?? {});
      expect(req.headers.get('x-api-key')).toBe(API_KEY);
      if (testCase.method === 'POST') expect(req.body).toEqual(testCase.body);

      // One-line human summary first, then the API's JSON.
      const first = result.content[0];
      expect(first.type).toBe('text');
      const summary = (first as { text: string }).text.split('\n')[0];
      expect(summary.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(summary)).toThrow();
      expect(containsJson(result, testCase.response)).toBe(true);
    });

    it('list_subnets passes through every filter the route accepts', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: page }, 200));
      await call(await connect(), 'list_subnets', { environment: 'staging', region: 'us-east-1', family: 'IPV6', page: 2, limit: 5 });
      const [req] = requestsMade();
      expect(req.url.pathname).toBe('/v1/subnets');
      expect(Object.fromEntries(req.url.searchParams)).toEqual({ environment: 'staging', region: 'us-east-1', family: 'IPV6', page: '2', limit: '5' });
    });

    // GET /v1/pools declares `family` in its querystring schema but the
    // handler never reads it, so a tool that leaves it out is not missing a
    // working filter. environment, region, page and limit are all honoured.
    it('list_pools passes through the filters its route honours', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: page }, 200));
      await call(await connect(), 'list_pools', { environment: 'staging', region: 'us-east-1', page: 3, limit: 10 });
      const [req] = requestsMade();
      expect(req.url.pathname).toBe('/v1/pools');
      expect(Object.fromEntries(req.url.searchParams)).toEqual({ environment: 'staging', region: 'us-east-1', page: '3', limit: '10' });
    });

    it('list_addresses passes status through, and search passes limit', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: page }, 200));
      const client = await connect();
      await call(client, 'list_addresses', { subnetId: 'sub_42', status: 'RESERVED' });
      fetchMock.mockResolvedValue(jsonResponse({ query: '10.20', pools: [], subnets: [], addresses: [], truncated: false }, 200));
      await call(client, 'search', { q: '10.20', limit: 50 });
      const [addresses, searchReq] = requestsMade();
      expect(addresses.url.pathname).toBe('/v1/subnets/sub_42/addresses');
      expect(Object.fromEntries(addresses.url.searchParams)).toEqual({ status: 'RESERVED' });
      expect(searchReq.url.pathname).toBe('/v1/search');
      expect(Object.fromEntries(searchReq.url.searchParams)).toEqual({ q: '10.20', limit: '50' });
    });

    it('create_subnet forwards the nesting fields the route accepts (cidr, parentSubnetId, kind, description, metadata)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(subnetRecord, 201));
      const args = { family: 'IPV4', cidr: '10.20.4.0/24', parentSubnetId: 'sub_1', kind: 'vpc', description: 'd', metadata: { team: 'pay' } };
      await call(await connect(), 'create_subnet', args);
      expect(requestsMade()[0].body).toEqual(args);
    });

    it('an id cannot steer a tool to a different endpoint', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ statusCode: 404, error: 'Not Found', message: 'Pool not found' }, 404));
      const client = await connect();
      // Changed by the builder in the review fix round: ids that could alter
      // the path are now refused by the input schema, so no request is made
      // at all, rather than being sent encoded.
      const getResult = await call(client, 'get_pool', { id: '../organizations/usage' });
      const allocResult = await call(client, 'allocate_address', { subnetId: '../../pools', address: '10.0.0.1' });
      expect(getResult.isError).toBe(true);
      expect(allocResult.isError).toBe(true);
      expect(requestsMade()).toHaveLength(0);
    });

    it('no tool call ever issues a DELETE, PATCH or PUT', async () => {
      const client = await connect();
      for (const testCase of CASES) {
        fetchMock.mockResolvedValueOnce(jsonResponse(testCase.response, testCase.status));
        await call(client, testCase.tool, testCase.args);
      }
      expect(requestsMade().map((r) => r.method).filter((m) => !['GET', 'POST'].includes(m))).toEqual([]);
    });

    it('an unknown tool name, such as delete_subnet, is a tool error with no request', async () => {
      const client = await connect();
      let isError: boolean | undefined;
      try {
        isError = (await call(client, 'delete_subnet', { id: 'sub_42' })).isError;
      } catch {
        // A JSON-RPC error is an acceptable refusal too.
        isError = true;
      }
      expect(isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Done means 4: API errors become isError results carrying the API message', () => {
    const ERRORS: { status: number; message: string }[] = [
      { status: 400, message: 'Address 10.99.0.1 is not within subnet 10.20.4.0/24' },
      { status: 402, message: 'Your FREE tier allows 3 subnets. Upgrade to add more.' },
      { status: 403, message: 'This action requires the ADMIN or MEMBER role' },
      { status: 404, message: 'Subnet not found' },
      { status: 409, message: 'CIDR 10.20.4.0/24 overlaps existing subnet sub_1' },
    ];

    describe.each(ERRORS)('HTTP $status', ({ status, message }) => {
      it.each(CASES)('$tool returns isError with the API message, and the server keeps answering', async (testCase) => {
        const client = await connect();
        fetchMock.mockResolvedValueOnce(jsonResponse({ statusCode: status, error: 'Error', message }, status));
        const result = await call(client, testCase.tool, testCase.args);
        expect(result.isError).toBe(true);
        expect(allText(result)).toContain(message);

        fetchMock.mockResolvedValueOnce(jsonResponse(CASES[0].response, 200));
        const after = await call(client, 'list_pools', {});
        expect(after.isError).toBeFalsy();
        expect(containsJson(after, CASES[0].response)).toBe(true);
      });
    });

    it('a 403 makes clear the key role does not allow the action, even when the API message does not say so', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' }, 403));
      const result = await call(await connect(), 'create_pool', CASES.find((c) => c.tool === 'create_pool')!.args);
      expect(result.isError).toBe(true);
      expect(allText(result)).toMatch(/role/i);
    });
  });

  describe('Security: network failure and timeout', () => {
    it('a network failure is a tool error naming the URL and saying nxip could not be reached', async () => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      const client = await connect();
      const result = await call(client, 'get_usage', {});
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain(BASE_URL);
      expect(allText(result)).toMatch(/reach/i);
      fetchMock.mockResolvedValue(jsonResponse(CASES[0].response, 200));
      expect((await call(client, 'list_pools', {})).isError).toBeFalsy();
    });

    it('a timeout is a tool error naming the URL', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      const result = await call(await connect(), 'list_pools', {});
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain(BASE_URL);
    });
  });

  describe('Done means 7: the API key never appears anywhere', () => {
    const failures: [string, () => Promise<Response>][] = [
      ['success', async () => new Response('{}', { status: 200 })],
      ...[400, 401, 402, 403, 404, 409, 500].map((status): [string, () => Promise<Response>] => [
        `HTTP ${status} echoing the key`,
        async () => jsonResponse({ statusCode: status, error: 'Error', message: `bad key ${API_KEY} for request` }, status),
      ]),
      ['HTTP 502 with a non-JSON body echoing the key', async () => new Response(`<html>upstream ${API_KEY}</html>`, { status: 502 })],
      ['network error whose message echoes the key', async () => Promise.reject(new TypeError(`fetch failed x-api-key=${API_KEY}`))],
      ['network error whose cause echoes the key', async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: new Error(`header ${API_KEY}`) }))],
      ['timeout', async () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
    ];

    it.each(CASES)('$tool leaks the key in no result, stdout or stderr, on any path', async (testCase) => {
      const client = await connect();
      for (const [label, respond] of failures) {
        fetchMock.mockImplementationOnce(label === 'success' ? async () => jsonResponse(testCase.response, testCase.status) : respond);
        const result = await call(client, testCase.tool, testCase.args);
        expect(JSON.stringify(result), `${testCase.tool}: ${label}`).not.toContain(API_KEY);
      }
      // Invalid input path too.
      const invalid = await call(client, testCase.tool, { ...testCase.args, family: 'NOT_A_FAMILY', id: 42, q: 'x', ip: 7 });
      expect(JSON.stringify(invalid)).not.toContain(API_KEY);
      expect(written.join('\n')).not.toContain(API_KEY);
    });
  });

  describe('Done means 6: input is validated before any request', () => {
    const REJECT: [string, Record<string, unknown>][] = [
      ['create_subnet', { family: 'IPV4', prefixLength: 99, environment: 'production', region: 'eu-west-1' }],
      ['preview_subnet', { family: 'IPV4', prefixLength: 99, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 7, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 32, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 24.5, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV6', prefixLength: 31, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV6', prefixLength: 128, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV5', prefixLength: 24, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { prefixLength: 24, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 24, environment: '', region: 'eu-west-1' }],
      ['create_pool', { cidr: '10.0.0.0/8', family: 'IPV4', environment: 'production', region: 'eu-west-1' }],
      ['create_pool', { name: '', cidr: '10.0.0.0/8', family: 'IPV4', environment: 'production', region: 'eu-west-1' }],
      ['allocate_address', { subnetId: 'sub_42' }],
      ['allocate_address', { subnetId: 'sub_42', address: '10.20.4.17', status: 'FREE' }],
      ['list_subnets', { family: 'ipv4' }],
      ['list_addresses', { subnetId: 'sub_42', status: 'USED' }],
      ['list_addresses', {}],
      ['get_pool', {}],
      ['lookup_ip', {}],
      ['search', { q: 'x' }],
      ['search', { q: '10.20', limit: 51 }],
      ['search', { q: '10.20', limit: 0 }],
    ];

    it.each(REJECT)('%s rejects %j without a request', async (tool, args) => {
      const client = await connect();
      let isError: boolean | undefined;
      try {
        isError = (await call(client, tool, args)).isError;
      } catch {
        isError = true;
      }
      expect(isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    const ACCEPT: [string, Record<string, unknown>][] = [
      ['create_subnet', { family: 'IPV4', prefixLength: 8, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 31, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV6', prefixLength: 32, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV6', prefixLength: 127, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', { family: 'IPV4', prefixLength: 24, parentSubnetId: 'sub_1' }],
      ['search', { q: '10', limit: 1 }],
    ];

    it.each(ACCEPT)('%s accepts the boundary input %j and makes the request', async (tool, args) => {
      fetchMock.mockResolvedValue(jsonResponse(subnetRecord, 201));
      const result = await call(await connect(), tool, args);
      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The route's refine() rules: one of cidr/prefixLength, and either
    // parentSubnetId or both environment and region.
    it.each([
      ['neither cidr nor prefixLength', { family: 'IPV4', environment: 'production', region: 'eu-west-1' }],
      ['no parentSubnetId and no region', { family: 'IPV4', prefixLength: 24, environment: 'production' }],
    ])('create_subnet with %s is rejected before any request', async (_label, args) => {
      const client = await connect();
      let isError: boolean | undefined;
      try {
        isError = (await call(client, 'create_subnet', args)).isError;
      } catch {
        isError = true;
      }
      expect(isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Interface: input schemas mirror the route schemas and invent no fields', () => {
    let tools: Tool[];
    beforeEach(async () => {
      tools = (await (await connect()).listTools()).tools;
    });

    it.each(ALL_TOOLS)('%s has no property the API route does not accept', (name) => {
      const tool = tools.find((t) => t.name === name)!;
      const props = Object.keys(tool.inputSchema.properties ?? {});
      const invented = props.filter((p) => !ROUTE_FIELDS[name].includes(p));
      expect(invented).toEqual([]);
    });

    it.each(Object.keys(ROUTE_REQUIRED))('%s requires what the route requires', (name) => {
      const tool = tools.find((t) => t.name === name)!;
      expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(expect.arrayContaining([...ROUTE_REQUIRED[name]].sort()));
    });

    it('list_subnets exposes every filter the route accepts (the spec says pass them through)', () => {
      const props = Object.keys(tools.find((t) => t.name === 'list_subnets')!.inputSchema.properties ?? {});
      expect(props.sort()).toEqual(['environment', 'family', 'limit', 'page', 'region']);
    });

    it('an extra field such as organizationId is never forwarded to the API', async () => {
      fetchMock.mockResolvedValue(jsonResponse(poolRecord, 201));
      const client = await connect();
      await call(client, 'create_pool', { ...CASES.find((c) => c.tool === 'create_pool')!.args, organizationId: 'org_other' });
      await call(client, 'list_subnets', { organizationId: 'org_other' });
      for (const req of requestsMade()) {
        expect(JSON.stringify(req.body ?? {})).not.toContain('org_other');
        expect(req.url.search).not.toContain('org_other');
      }
    });
  });
});

// ============================================================
// The real process over stdio (Done means 5 and 8)
// ============================================================

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STDIO_KEY = 'nxip_live_stdioconformance9z8y7x6w5v4u3t';

function runCli(args: string[], env: Record<string, string>, lines: string[], expectedResponses: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NXIP_API_KEY;
    delete cleanEnv.NXIP_URL;
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
    if (expectedResponses === 0) child.stdin.end();
  });
}

const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const INIT = [
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '0' } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
];

describe('stdio process', () => {
  let api: Server;
  let apiUrl: string;

  beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pools') {
        res.end(JSON.stringify({ data: [], meta: page }));
      } else if (req.url === '/v1/organizations/usage') {
        res.statusCode = 403;
        res.end(JSON.stringify({ statusCode: 403, error: 'Forbidden', message: `key ${req.headers['x-api-key']} lacks role` }));
      } else {
        res.statusCode = 500;
        res.end(`plain text failure for ${req.headers['x-api-key']}`);
      }
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
  });

  it('Done means 5: a missing NXIP_API_KEY exits non-zero with one stderr line naming the variable, and nothing on stdout', async () => {
    const { code, stdout, stderr } = await runCli(['mcp'], {}, [], 0);
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(stdout).toBe('');
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).toContain('NXIP_API_KEY');
  }, 30_000);

  it('Done means 8 and 7: stdout carries only JSON-RPC messages, and neither stream shows the key, across success, API error, plain-text error and bad input', async () => {
    const lines = [
      ...INIT,
      rpc(2, 'tools/list'),
      rpc(3, 'tools/call', { name: 'list_pools', arguments: {} }),
      rpc(4, 'tools/call', { name: 'get_usage', arguments: {} }),
      rpc(5, 'tools/call', { name: 'get_subnet', arguments: { id: 'sub_42' } }),
      rpc(6, 'tools/call', { name: 'create_subnet', arguments: { family: 'IPV4', prefixLength: 99, environment: 'p', region: 'r' } }),
      rpc(7, 'tools/call', { name: 'list_pools', arguments: {} }),
    ];
    const { stdout, stderr } = await runCli(['mcp'], { NXIP_API_KEY: STDIO_KEY, NXIP_URL: apiUrl }, lines, 7);

    const outLines = stdout.split('\n').filter((l) => l.length > 0);
    expect(outLines).toHaveLength(7);
    const messages = outLines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number; result?: { isError?: boolean; tools?: unknown[] } });
    for (const m of messages) expect(m.jsonrpc).toBe('2.0');
    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(byId.get(2)?.result?.tools).toHaveLength(13);
    expect(byId.get(3)?.result?.isError).toBeFalsy();
    expect(byId.get(4)?.result?.isError).toBe(true);
    expect(byId.get(5)?.result?.isError).toBe(true);
    expect(byId.get(6)?.result?.isError ?? true).toBe(true);
    expect(byId.get(7)?.result?.isError).toBeFalsy();

    expect(stdout).not.toContain(STDIO_KEY);
    expect(stderr).not.toContain(STDIO_KEY);
  }, 30_000);

  it('--read-only over stdio lists 10 tools, and a network failure names the URL but not the key', async () => {
    // A port nothing listens on: bind, read the port, close.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise((resolve) => probe.close(resolve));

    const lines = [...INIT, rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'lookup_ip', arguments: { ip: '10.0.0.1' } })];
    const { stdout, stderr } = await runCli(['mcp', '--read-only'], { NXIP_API_KEY: STDIO_KEY, NXIP_URL: deadUrl }, lines, 3);
    const messages = stdout.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const list = messages.find((m) => m.id === 2);
    expect(list.result.tools.map((t: Tool) => t.name).sort()).toEqual(READ_TOOLS);
    const failure = messages.find((m) => m.id === 3);
    expect(failure.result.isError).toBe(true);
    expect(JSON.stringify(failure)).toContain(deadUrl);
    expect(stdout + stderr).not.toContain(STDIO_KEY);
  }, 30_000);
});
