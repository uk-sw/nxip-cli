import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/mcp.js';

// A realistic key, long enough to be scrubbed, and distinctive enough that
// finding it anywhere in output can only mean it leaked.
const API_KEY = 'nxip_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const BASE_URL = 'https://nxip.test';
const OPTIONS = { apiKey: API_KEY, baseUrl: BASE_URL };

const TS = '2026-09-01T10:00:00.000Z';

const pool = {
  id: 'pool_1',
  organizationId: 'org_1',
  name: 'prod-eu',
  cidr: '10.20.0.0/16',
  family: 'IPV4',
  environment: 'production',
  region: 'eu-west-1',
  metadata: {},
  createdAt: TS,
  updatedAt: TS,
  utilization: { subnetCount: 2, usedAddresses: 512, capacity: 65536, percentageUsed: 0.78 },
};

const createdSubnet = {
  id: 'sub_1',
  cidr: '10.20.4.0/24',
  prefixLength: 24,
  family: 'IPV4',
  environment: 'production',
  region: 'eu-west-1',
  ipPoolId: 'pool_1',
  parentSubnetId: null,
  kind: null,
  name: 'payments',
  description: null,
  metadata: {},
  createdAt: TS,
};

const subnet = { ...createdSubnet, updatedAt: TS, utilization: { registeredAddresses: 3, capacity: 256, percentageUsed: 1.17 } };

const address = {
  id: 'addr_1',
  subnetId: 'sub_1',
  address: '10.20.4.17',
  family: 'IPV4',
  status: 'ACTIVE',
  hostname: 'db-1',
  metadata: {},
  createdAt: TS,
  updatedAt: TS,
};

const meta = (total: number) => ({ total, page: 1, limit: 50, totalPages: 1 });
const metric = (current: number, limit: number | null) => ({
  current,
  limit,
  percentageUsed: limit ? (current / limit) * 100 : 0,
  isUnlimited: limit === null,
  isOverLimit: false,
});

interface ToolCase {
  tool: string;
  args: Record<string, unknown>;
  method: 'GET' | 'POST';
  // Path plus query exactly as it should reach the API.
  url: string;
  body?: unknown;
  response: unknown;
  status?: number;
  summary: RegExp;
}

// One case per tool. Endpoints, bodies and response shapes are taken from the
// route files in net-saas-monorepo/apps/api/src/routes.
const CASES: ToolCase[] = [
  {
    tool: 'list_pools',
    args: { environment: 'production', page: 2, limit: 10 },
    method: 'GET',
    url: '/v1/pools?environment=production&page=2&limit=10',
    response: { data: [pool], meta: meta(1) },
    summary: /^Found 1 pool;/,
  },
  {
    tool: 'get_pool',
    args: { id: 'pool_1' },
    method: 'GET',
    url: '/v1/pools/pool_1',
    response: pool,
    summary: /^Pool prod-eu: 10\.20\.0\.0\/16/,
  },
  {
    tool: 'forecast_pools',
    args: {},
    method: 'GET',
    url: '/v1/pools/forecast',
    response: {
      data: [
        { poolId: 'pool_1', poolName: 'prod-eu', runwayDays: 41.6, exhaustsOn: TS, burnPerDay: 12, allocations: 5, observedDays: 20, freeAddresses: 500, reason: null },
        { poolId: 'pool_2', poolName: 'v6', runwayDays: null, exhaustsOn: null, burnPerDay: null, allocations: 1, observedDays: 1, freeAddresses: null, reason: 'not_measurable' },
      ],
      meta: { windowDays: 90, minAllocations: 3, minSpanDays: 7 },
    },
    summary: /soonest to run out: prod-eu in about 42 days/,
  },
  {
    tool: 'list_subnets',
    args: { region: 'eu-west-1', family: 'IPV4' },
    method: 'GET',
    url: '/v1/subnets?region=eu-west-1&family=IPV4',
    response: { data: [subnet, subnet], meta: meta(2) },
    summary: /^Found 2 subnets;/,
  },
  {
    tool: 'get_subnet',
    args: { id: 'sub_1' },
    method: 'GET',
    url: '/v1/subnets/sub_1',
    response: subnet,
    summary: /^Subnet payments 10\.20\.4\.0\/24 .* in pool pool_1, 3 registered addresses\.$/,
  },
  {
    tool: 'list_addresses',
    args: { subnetId: 'sub_1', status: 'RESERVED' },
    method: 'GET',
    url: '/v1/subnets/sub_1/addresses?status=RESERVED',
    response: { data: [address], meta: meta(1) },
    summary: /^Found 1 address in subnet sub_1;/,
  },
  {
    tool: 'lookup_ip',
    args: { ip: '10.20.4.17' },
    method: 'GET',
    url: '/v1/lookup?ip=10.20.4.17',
    response: {
      ip: '10.20.4.17',
      family: 'IPV4',
      matchType: 'address',
      address: { id: 'addr_1', address: '10.20.4.17', status: 'ACTIVE', hostname: 'db-1', subnetId: 'sub_1' },
      subnet: { id: 'sub_1', cidr: '10.20.4.0/24', prefixLength: 24, environment: 'production', region: 'eu-west-1', ipPoolId: 'pool_1' },
      pool: { id: 'pool_1', name: 'prod-eu', cidr: '10.20.0.0/16', environment: 'production', region: 'eu-west-1' },
    },
    summary: /^10\.20\.4\.17 is registered as ACTIVE \(db-1\) in subnet 10\.20\.4\.0\/24/,
  },
  {
    tool: 'search',
    args: { q: 'vpc-0a1b', limit: 5 },
    method: 'GET',
    url: '/v1/search?q=vpc-0a1b&limit=5',
    response: { query: 'vpc-0a1b', pools: [], subnets: [], addresses: [], truncated: false },
    summary: /^Search "vpc-0a1b" matched 0 pools, 0 subnets and 0 addresses\.$/,
  },
  {
    tool: 'get_usage',
    args: {},
    method: 'GET',
    url: '/v1/organizations/usage',
    response: {
      organizationId: 'org_1',
      tier: 'FREE',
      rateLimitRpm: 60,
      metrics: {
        pools: metric(1, 3),
        subnets: metric(5, 10),
        ipv4Addresses: metric(512, 4096),
        addressRecords: metric(3, 100),
        seats: metric(1, null),
      },
    },
    summary: /^Tier FREE: pools 1\/3, subnets 5\/10, .*seats 1 \(unlimited\)\.$/,
  },
  {
    tool: 'preview_subnet',
    args: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' },
    method: 'POST',
    url: '/v1/subnets/preview',
    body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' },
    response: {
      wouldSucceed: true,
      subnet: { ...createdSubnet, id: undefined, createdAt: undefined },
      container: { type: 'pool', id: 'pool_1', name: 'prod-eu', cidr: '10.20.0.0/16' },
      utilization: { before: pool.utilization, after: pool.utilization },
    },
    summary: /^Would allocate 10\.20\.4\.0\/24 in pool prod-eu/,
  },
  {
    tool: 'create_pool',
    args: { name: 'prod-eu', cidr: '10.20.0.0/16', family: 'IPV4', environment: 'production', region: 'eu-west-1', metadata: { owner: 'net' } },
    method: 'POST',
    url: '/v1/pools',
    body: { name: 'prod-eu', cidr: '10.20.0.0/16', family: 'IPV4', environment: 'production', region: 'eu-west-1', metadata: { owner: 'net' } },
    response: { ...pool, utilization: undefined },
    status: 201,
    summary: /^Created pool prod-eu 10\.20\.0\.0\/16 .*id pool_1/,
  },
  {
    tool: 'create_subnet',
    args: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1', name: 'payments' },
    method: 'POST',
    url: '/v1/subnets',
    body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1', name: 'payments' },
    response: createdSubnet,
    status: 201,
    summary: /^Allocated 10\.20\.4\.0\/24 \(payments\) in pool pool_1, id sub_1\.$/,
  },
  {
    tool: 'allocate_address',
    args: { subnetId: 'sub_1', address: '10.20.4.17', hostname: 'db-1' },
    method: 'POST',
    url: '/v1/subnets/sub_1/addresses',
    body: { address: '10.20.4.17', hostname: 'db-1' },
    response: address,
    status: 201,
    summary: /^Registered 10\.20\.4\.17 as ACTIVE \(db-1\) in subnet sub_1, id addr_1\.$/,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function connect(readOnly = false, options: { apiKey: string; baseUrl: string; timeoutMs?: number } = OPTIONS) {
  const server = createMcpServer(options, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nxip-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function texts(result: CallToolResult): string[] {
  return result.content.map((c) => (c.type === 'text' ? c.text : ''));
}

describe('mcp server', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes exactly the 13 tools, with the right annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    expect(tools).toHaveLength(13);

    for (const tool of tools) {
      if ((READ_TOOL_NAMES as readonly string[]).includes(tool.name)) {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true });
      } else {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      }
    }
  });

  it('points create_subnet at preview_subnet', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'create_subnet')?.description).toMatch(/preview_subnet first/);
  });

  describe('--read-only', () => {
    it('lists only the 10 read tools', async () => {
      const client = await connect(true);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    });

    it.each(WRITE_TOOL_NAMES)('refuses a call to %s as a tool error, without any request', async (name) => {
      const client = await connect(true);
      const writeCase = CASES.find((c) => c.tool === name)!;
      const result = await call(client, name, writeCase.args);
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe.each(CASES)('$tool', (testCase) => {
    it('calls exactly its endpoint with the key in x-api-key, and returns the API response', async () => {
      fetchMock.mockResolvedValue(jsonResponse(testCase.response, testCase.status ?? 200));
      const client = await connect();

      const result = await call(client, testCase.tool, testCase.args);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}${testCase.url}`);
      expect(init.method).toBe(testCase.method);
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(API_KEY);
      if (testCase.body === undefined) {
        expect(init.body).toBeUndefined();
      } else {
        expect(JSON.parse(String(init.body))).toEqual(testCase.body);
      }

      expect(result.isError).toBeFalsy();
      const [summary, json] = texts(result);
      expect(summary).toMatch(testCase.summary);
      expect(summary).not.toContain('\n');
      // Compared through a JSON round trip, since undefined fields in the
      // fixture are dropped on the wire exactly as they are here.
      expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(testCase.response)));
    });
  });

  describe('API errors', () => {
    const statuses: [number, string][] = [
      [400, "'10.20.4.999' is not a valid IPV4 address."],
      [402, 'Your FREE plan allows 10 subnets.'],
      [403, 'Your API key does not have permission to perform this action.'],
      [404, "Subnet with ID 'sub_x' not found in your organization."],
      [409, 'Container has no available space.'],
    ];

    it.each(statuses)('a %i becomes a tool error carrying the API message, and the server keeps serving', async (status, message) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ statusCode: status, error: 'x', message }, status));
      const client = await connect();

      const result = await call(client, 'create_subnet', CASES.find((c) => c.tool === 'create_subnet')!.args);
      expect(result.isError).toBe(true);
      expect(texts(result).join('\n')).toContain(message);
      expect(texts(result).join('\n')).toContain(`(${status})`);

      // Still connected: a later call on the same client works.
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [], meta: meta(0) }));
      const next = await call(client, 'list_pools', {});
      expect(next.isError).toBeFalsy();
    });

    it("a 403 says the key's role does not allow it", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ statusCode: 403, error: 'Forbidden', message: 'Your API key does not have permission to perform this action.' }, 403)
      );
      const client = await connect();
      const result = await call(client, 'create_pool', CASES.find((c) => c.tool === 'create_pool')!.args);
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(/role does not allow this action/);
      expect(texts(result)[0]).toMatch(/ADMIN or MEMBER/);
    });

    it('a preview that would fail is a successful answer, not a tool error', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ wouldSucceed: false, reason: 'full', message: 'Pool prod-eu has no free /24.', httpStatusIfAttempted: 409 })
      );
      const client = await connect();
      const result = await call(client, 'preview_subnet', { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'eu-west-1' });
      expect(result.isError).toBeFalsy();
      expect(texts(result)[0]).toBe('Would not succeed (full): Pool prod-eu has no free /24. Nothing was created.');
    });
  });

  describe('network failures', () => {
    it('says nxip could not be reached, naming the URL', async () => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      const client = await connect();
      const result = await call(client, 'get_usage', {});
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toBe(`Could not reach nxip at ${BASE_URL}: ECONNREFUSED`);
    });

    it('times out a hung request instead of waiting forever', async () => {
      // Never answers; only the abort signal can end it.
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      );
      const client = await connect(false, { ...OPTIONS, timeoutMs: 50 });
      const result = await call(client, 'list_pools', {});
      expect(result.isError).toBe(true);
      expect(texts(result)[0]).toMatch(new RegExp(`^Could not reach nxip at ${BASE_URL}: no response within`));
    });
  });

  describe('input validation happens before any request', () => {
    const invalid: [string, string, Record<string, unknown>][] = [
      ['create_subnet', 'prefixLength 99 for IPV4', { family: 'IPV4', prefixLength: 99, environment: 'production', region: 'eu-west-1' }],
      ['preview_subnet', 'prefixLength 99 for IPV4', { family: 'IPV4', prefixLength: 99, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', 'prefixLength 20 for IPV6', { family: 'IPV6', prefixLength: 20, environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', 'neither cidr nor prefixLength', { family: 'IPV4', environment: 'production', region: 'eu-west-1' }],
      ['create_subnet', 'no route (no parent, no region)', { family: 'IPV4', prefixLength: 24, environment: 'production' }],
      ['create_subnet', 'an unknown family', { family: 'IPV5', prefixLength: 24, environment: 'production', region: 'eu-west-1' }],
      ['create_pool', 'an unknown field', { name: 'a', cidr: '10.0.0.0/8', family: 'IPV4', environment: 'p', region: 'r', size: 'huge' }],
      ['create_pool', 'too many metadata keys', {
        name: 'a', cidr: '10.0.0.0/8', family: 'IPV4', environment: 'p', region: 'r',
        metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])),
      }],
      ['allocate_address', 'a missing subnetId', { address: '10.0.0.1' }],
      ['search', 'a one-character query', { q: 'x' }],
      ['list_subnets', 'a limit over 100', { limit: 101 }],
      ['get_pool', 'an empty id', { id: '' }],
    ];

    it.each(invalid)('%s rejects %s', async (tool, _label, args) => {
      const client = await connect();
      const result = await call(client, tool, args);
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts an IPv6 prefix that would be invalid for IPv4', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ...createdSubnet, family: 'IPV6', cidr: 'fd00::/64', prefixLength: 64 }, 201));
      const client = await connect();
      const result = await call(client, 'create_subnet', { family: 'IPV6', prefixLength: 64, environment: 'production', region: 'eu-west-1' });
      expect(result.isError).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('nests with parentSubnetId alone, without environment or region', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ...createdSubnet, parentSubnetId: 'sub_parent' }, 201));
      const client = await connect();
      const result = await call(client, 'create_subnet', { family: 'IPV4', prefixLength: 26, parentSubnetId: 'sub_parent' });
      expect(result.isError).toBeFalsy();
      expect(texts(result)[0]).toMatch(/under subnet sub_parent/);
    });
  });

  it('encodes ids as a single path segment, so an id cannot reach another route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ statusCode: 404, error: 'Not Found', message: 'nope' }, 404));
    const client = await connect();
    await call(client, 'get_subnet', { id: '../organizations/usage' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/v1/subnets/..%2Forganizations%2Fusage`);
  });

  describe('the API key never appears in output', () => {
    let written: string[];

    beforeEach(() => {
      written = [];
      const capture = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
      vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
      for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(' '));
        });
      }
    });

    // Every way a result gets built: success, each API error status, an
    // error body that echoes the key back (a misbehaving proxy, say), a
    // non-JSON error body doing the same, and a network failure whose
    // message carries it.
    const failures: [string, () => Promise<Response>][] = [
      ['400', async () => jsonResponse({ message: 'bad' }, 400)],
      ['401 echoing the key', async () => jsonResponse({ message: `Invalid API key ${API_KEY}` }, 401)],
      ['402', async () => jsonResponse({ message: 'tier' }, 402)],
      ['403 echoing the key', async () => jsonResponse({ message: `key ${API_KEY} is READ_ONLY` }, 403)],
      ['404', async () => jsonResponse({ message: 'missing' }, 404)],
      ['409', async () => jsonResponse({ message: 'conflict' }, 409)],
      ['502 plain-text body echoing the key', async () => new Response(`<html>upstream saw x-api-key: ${API_KEY}</html>`, { status: 502 })],
      ['network failure echoing the key', async () => Promise.reject(new TypeError(`fetch failed for ${API_KEY}`))],
    ];

    it('across every tool and every failure path', async () => {
      const client = await connect();
      const results: CallToolResult[] = [];

      for (const testCase of CASES) {
        // A success whose body happens to contain the key (in metadata, say).
        fetchMock.mockResolvedValueOnce(
          jsonResponse(JSON.parse(JSON.stringify(testCase.response).replace('"metadata":{}', `"metadata":{"note":"${API_KEY}"}`)), testCase.status ?? 200)
        );
        results.push(await call(client, testCase.tool, testCase.args));

        for (const [, failure] of failures) {
          fetchMock.mockImplementationOnce(failure);
          results.push(await call(client, testCase.tool, testCase.args));
        }
      }

      expect(fetchMock).toHaveBeenCalledTimes(CASES.length * (failures.length + 1));
      expect(results.filter((r) => r.isError)).toHaveLength(CASES.length * failures.length);

      const everything = JSON.stringify(results) + written.join('');
      expect(everything).not.toContain(API_KEY);
      // And the scrub left a marker, so the leak paths above were really exercised.
      expect(everything).toContain('[redacted]');
    });
  });
});
