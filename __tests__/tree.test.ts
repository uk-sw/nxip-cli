import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTree, formatTree, selectPool, shouldUseColor, type TreePool } from '../src/tree.js';
import type { NxipPoolDetail, NxipSubnet } from '../src/types.js';

// Done means 8 (docs/specs/address-tree-and-editing.md): `nxip tree` prints
// the spec's example layout for a fixture, and --free, --depth, --pool,
// --json and NO_COLOR behave as specified, all offline against a fake API.

function pool(overrides: Partial<NxipPoolDetail> = {}): NxipPoolDetail {
  return {
    id: 'pool_use1',
    organizationId: 'org_1',
    name: 'Production US-East',
    cidr: '10.109.0.0/16',
    family: 'IPV4',
    environment: 'production',
    region: 'us-east-1',
    metadata: {},
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    utilization: { subnetCount: 1, usedAddresses: 4096, capacity: 65536, percentageUsed: 6.25 },
    ...overrides,
  };
}

function subnet(id: string, cidr: string, overrides: Partial<NxipSubnet> = {}): NxipSubnet {
  return {
    id,
    cidr,
    prefixLength: Number(cidr.split('/')[1]),
    family: 'IPV4',
    environment: 'production',
    region: 'us-east-1',
    ipPoolId: 'pool_use1',
    parentSubnetId: null,
    kind: null,
    name: null,
    description: null,
    metadata: {},
    createdAt: '2026-09-01T00:00:00.000Z',
    utilization: { registeredAddresses: 0 },
    ...overrides,
  };
}

// The layout in the spec's example. Deliberately in the API's own order,
// newest first, so AZ-a arrives before AZ-b and the tree has to sort by
// address to match the example.
const SUBNETS: NxipSubnet[] = [
  subnet('sub_aza', '10.109.0.32/27', { parentSubnetId: 'sub_pay', kind: 'az-subnet', name: 'Payments AZ-a' }),
  subnet('sub_azb', '10.109.0.0/27', { parentSubnetId: 'sub_pay', kind: 'az-subnet', name: 'Payments AZ-b' }),
  subnet('sub_pay', '10.109.0.0/24', { parentSubnetId: 'sub_region', name: 'Payments team' }),
  subnet('sub_region', '10.109.0.0/20', { kind: 'region', name: 'us-east-1 region block' }),
];

// The spec's example, verbatim.
const EXAMPLE = [
  'Production US-East  10.109.0.0/16  production / us-east-1  6% used',
  '└── 10.109.0.0/20  us-east-1 region block [region]',
  '    ├── 10.109.0.0/24  Payments team',
  '    │   ├── 10.109.0.0/27   Payments AZ-b [az-subnet]',
  '    │   ├── 10.109.0.32/27  Payments AZ-a [az-subnet]',
  '    │   └── free 10.109.0.64/26, 10.109.0.128/25',
  '    └── free 10.109.1.0/24, 10.109.2.0/23, 10.109.4.0/22, 10.109.8.0/21',
];

// With --free, the pool is a level too, so it gains the free line the
// example leaves out (see the builder's report: open question 1).
const EXAMPLE_WITH_POOL_FREE = [
  'Production US-East  10.109.0.0/16  production / us-east-1  6% used',
  '├── 10.109.0.0/20  us-east-1 region block [region]',
  '│   ├── 10.109.0.0/24  Payments team',
  '│   │   ├── 10.109.0.0/27   Payments AZ-b [az-subnet]',
  '│   │   ├── 10.109.0.32/27  Payments AZ-a [az-subnet]',
  '│   │   └── free 10.109.0.64/26, 10.109.0.128/25',
  '│   └── free 10.109.1.0/24, 10.109.2.0/23, 10.109.4.0/22, 10.109.8.0/21',
  '└── free 10.109.16.0/20, 10.109.32.0/19, 10.109.64.0/18, 10.109.128.0/17',
];

const text = (pools: TreePool[]) => formatTree(pools, { color: false });

describe('formatTree', () => {
  it('prints the example layout, without free lines when --free is not given', () => {
    // The example less its free lines, so each level's last subnet is now
    // the last line at that level and takes the closing connector.
    expect(text(buildTree([pool()], SUBNETS, { free: false })).trimEnd().split('\n')).toEqual([
      'Production US-East  10.109.0.0/16  production / us-east-1  6% used',
      '└── 10.109.0.0/20  us-east-1 region block [region]',
      '    └── 10.109.0.0/24  Payments team',
      '        ├── 10.109.0.0/27   Payments AZ-b [az-subnet]',
      '        └── 10.109.0.32/27  Payments AZ-a [az-subnet]',
    ]);
  });

  it('prints the example layout with --free, lines under the pool exactly as the spec shows them', () => {
    const output = text(buildTree([pool()], SUBNETS, { free: true }));
    expect(output.trimEnd().split('\n')).toEqual(EXAMPLE_WITH_POOL_FREE);
    // Everything beneath the region block is character for character the
    // spec's example, only shifted by the one extra pool-level line.
    const underRegion = EXAMPLE_WITH_POOL_FREE.slice(2, 7).map((line) => line.slice(4));
    expect(underRegion).toEqual(EXAMPLE.slice(2, 7).map((line) => line.slice(4)));
  });

  it('caps a free line at 8 blocks, then says how many more', () => {
    // Ten /30s spaced every eight addresses leave far more than eight gaps.
    const children = Array.from({ length: 10 }, (_, i) =>
      subnet(`s${i}`, `10.109.0.${i * 8}/30`, { parentSubnetId: 'sub_pay' })
    );
    const tree = buildTree([pool()], [subnet('sub_pay', '10.109.0.0/24', { name: 'Payments team' }), ...children], {
      free: true,
    });
    const free = tree[0].subnets[0].free!;
    expect(free.length).toBeGreaterThan(8);
    const line = text(tree).split('\n').find((l) => l.includes('free 10.109.0.4/30'))!;
    expect(line).toContain(`, +${free.length - 8} more`);
    expect(line.split(', ').filter((part) => /\d+\/\d+/.test(part))).toHaveLength(8);
  });

  it('says "free none" for a level with no room left', () => {
    const tree = buildTree(
      [pool({ cidr: '10.109.0.0/24' })],
      [subnet('a', '10.109.0.0/25'), subnet('b', '10.109.0.128/25')],
      { free: true }
    );
    expect(text(tree)).toContain('└── free none');
  });

  it('leaves usage off an IPv6 pool rather than printing a fake percentage', () => {
    const v6 = pool({ cidr: '2001:db8::/32', family: 'IPV6', utilization: { subnetCount: 0 } });
    expect(text(buildTree([v6], [], { free: false }))).toBe('Production US-East  2001:db8::/32  production / us-east-1\n');
  });

  it('never rounds a used pool down to 0% or a part-free one up to 100%', () => {
    const tiny = pool({ utilization: { subnetCount: 1, percentageUsed: 0.02 } });
    const nearly = pool({ utilization: { subnetCount: 1, percentageUsed: 99.8 } });
    expect(text(buildTree([tiny], [], { free: false }))).toContain('<1% used');
    expect(text(buildTree([nearly], [], { free: false }))).toContain('>99% used');
  });

  it('separates pools with a blank line', () => {
    const tree = buildTree([pool(), pool({ id: 'pool_2', name: 'Staging', cidr: '10.110.0.0/16' })], [], { free: false });
    expect(text(tree)).toContain('6% used\n\nStaging');
  });

  it('adds colour and a usage bar only when asked to', () => {
    const tree = buildTree([pool()], SUBNETS, { free: true });
    const plain = text(tree);
    const coloured = formatTree(tree, { color: true });
    expect(plain).not.toContain('\x1b[');
    expect(plain).not.toContain('█');
    expect(coloured).toContain('\x1b[');
    expect(coloured).toContain('█');
    // Stripped of escapes and the bar, the coloured form says the same thing.
    const stripped = coloured.replace(/\x1b\[\d+m/g, '').replace(/[█░]+ /, '');
    expect(stripped).toBe(plain);
  });
});

describe('buildTree', () => {
  it('counts only direct children at each level', () => {
    const [root] = buildTree([pool()], SUBNETS, { free: true });
    // The /27s sit inside the /24, so the region block's free space is the
    // /20 minus the /24 alone, not minus the /27s as well.
    expect(root.subnets[0].free).toEqual(['10.109.1.0/24', '10.109.2.0/23', '10.109.4.0/22', '10.109.8.0/21']);
  });

  it('places a subnet by its pool id, not by environment and region', () => {
    const other = pool({ id: 'pool_other', name: 'Other', cidr: '10.200.0.0/16' });
    const stray = subnet('sub_other', '10.200.0.0/24', { ipPoolId: 'pool_other' });
    const tree = buildTree([pool(), other], [...SUBNETS, stray], { free: false });
    expect(tree[0].subnets.map((s) => s.id)).toEqual(['sub_region']);
    expect(tree[1].subnets.map((s) => s.id)).toEqual(['sub_other']);
  });

  it('keeps a subnet whose parent is missing, at the top of its pool', () => {
    const orphan = subnet('orphan', '10.109.16.0/24', { parentSubnetId: 'gone' });
    const tree = buildTree([pool()], [...SUBNETS, orphan], { free: false });
    expect(tree[0].subnets.map((s) => s.id)).toEqual(['sub_region', 'orphan']);
  });

  it('--depth limits the levels shown, and free space with them', () => {
    const depth0 = buildTree([pool()], SUBNETS, { free: true, depth: 0 });
    expect(depth0[0].subnets).toEqual([]);
    expect(depth0[0].free).toBeUndefined();

    const depth1 = buildTree([pool()], SUBNETS, { free: true, depth: 1 });
    expect(depth1[0].subnets.map((s) => s.cidr)).toEqual(['10.109.0.0/20']);
    expect(depth1[0].subnets[0].subnets).toEqual([]);
    expect(depth1[0].subnets[0].free).toBeUndefined();

    const depth2 = buildTree([pool()], SUBNETS, { free: false, depth: 2 });
    expect(depth2[0].subnets[0].subnets.map((s) => s.cidr)).toEqual(['10.109.0.0/24']);
    expect(depth2[0].subnets[0].subnets[0].subnets).toEqual([]);
  });
});

describe('selectPool', () => {
  const pools = [pool(), pool({ id: 'pool_b', name: 'Shared' }), pool({ id: 'pool_c', name: 'Shared' })];

  it('matches an id', () => {
    expect(selectPool(pools, 'pool_b').id).toBe('pool_b');
  });

  it('matches an exact name', () => {
    expect(selectPool(pools, 'Production US-East').id).toBe('pool_use1');
    expect(() => selectPool(pools, 'production us-east')).toThrow(/No pool/);
  });

  it('refuses an ambiguous name and lists the ids', () => {
    expect(() => selectPool(pools, 'Shared')).toThrow('More than one pool is named "Shared": pool_b, pool_c.');
  });
});

describe('shouldUseColor', () => {
  it('colours a terminal only, and never with NO_COLOR set', () => {
    expect(shouldUseColor(true, {})).toBe(true);
    expect(shouldUseColor(false, {})).toBe(false);
    expect(shouldUseColor(undefined, {})).toBe(false);
    expect(shouldUseColor(true, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor(true, { NO_COLOR: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The command end to end, against a fake API: the real src/index.ts with
// argv and fetch mocked, as target-line.test.ts does for plan and apply.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Serves pools and subnets one item per page, so a tree that read only the
 * first page would be visibly missing most of the example.
 */
function fakeApi(pools: NxipPoolDetail[], subnets: NxipSubnet[], hasCustomers = false) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page') ?? '1');
    const paged = <T>(items: T[]) =>
      jsonResponse({ data: items.slice(page - 1, page), meta: { total: items.length, page, limit: 1, totalPages: items.length } });
    void init;
    if (url.pathname === '/v1/organizations/children') return jsonResponse({ data: hasCustomers ? [{ id: 'c' }] : [] });
    if (url.pathname === '/v1/pools') return paged(pools);
    if (url.pathname === '/v1/subnets') return paged(subnets);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('nxip tree', () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    process.exitCode = undefined;
    process.stdout.isTTY = originalIsTTY;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function run(args: string[], env: Record<string, string | undefined> = {}) {
    process.argv = ['node', 'nxip', 'tree', ...args];
    process.env.NXIP_API_KEY = 'nxip_live_treetest';
    process.env.NXIP_URL = 'https://api.example.test';
    delete process.env.NXIP_ORGANIZATION;
    delete process.env.NO_COLOR;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(`${String(line)}\n`));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(`${String(line)}\n`));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    await import('../src/index.js');
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { stdout: out.join(''), stderr: err.join(''), exitCode: process.exitCode };
  }

  it('prints the example tree, reading every page of pools and subnets', async () => {
    const fetchMock = fakeApi([pool()], SUBNETS);
    const { stdout, exitCode } = await run(['--free']);
    expect(exitCode).toBeUndefined();
    expect(stdout).toBe(`${EXAMPLE_WITH_POOL_FREE.join('\n')}\n`);
    // Four subnet pages, one pool page, and the customers check.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/subnets'))).toHaveLength(4);
  });

  it('is plain when piped, even with a colour-capable terminal elsewhere', async () => {
    fakeApi([pool()], SUBNETS);
    process.stdout.isTTY = false;
    const { stdout } = await run([]);
    expect(stdout).not.toContain('\x1b[');
  });

  it('colours a terminal, and NO_COLOR turns it off', async () => {
    fakeApi([pool()], SUBNETS);
    process.stdout.isTTY = true;
    expect((await run([])).stdout).toContain('\x1b[');

    vi.restoreAllMocks();
    vi.resetModules();
    fakeApi([pool()], SUBNETS);
    process.stdout.isTTY = true;
    expect((await run([], { NO_COLOR: '1' })).stdout).not.toContain('\x1b[');
  });

  it('--json emits the nested structure with every free block, uncapped', async () => {
    const children = Array.from({ length: 10 }, (_, i) =>
      subnet(`s${i}`, `10.109.0.${i * 8}/30`, { parentSubnetId: 'sub_pay' })
    );
    fakeApi([pool()], [subnet('sub_pay', '10.109.0.0/24'), ...children]);
    const { stdout } = await run(['--json', '--free']);
    const parsed = JSON.parse(stdout) as { pools: TreePool[] };
    const pay = parsed.pools[0].subnets[0];
    expect(pay.id).toBe('sub_pay');
    expect(pay.subnets).toHaveLength(10);
    expect(pay.free!.length).toBeGreaterThan(8);
    expect(pay.free).toContain('10.109.0.4/30');
    expect(pay.free).toContain('10.109.0.128/25');
  });

  it('--json without --free carries no free blocks', async () => {
    fakeApi([pool()], SUBNETS);
    const { stdout } = await run(['--json']);
    expect(stdout).not.toContain('"free"');
  });

  it('--pool by id shows that pool alone', async () => {
    fakeApi([pool(), pool({ id: 'pool_2', name: 'Staging', cidr: '10.110.0.0/16' })], SUBNETS);
    const { stdout } = await run(['--pool', 'pool_2']);
    expect(stdout).toBe('Staging  10.110.0.0/16  production / us-east-1  6% used\n');
  });

  it('--pool by exact name shows that pool alone', async () => {
    fakeApi([pool(), pool({ id: 'pool_2', name: 'Staging', cidr: '10.110.0.0/16' })], SUBNETS);
    const { stdout } = await run(['--pool', 'Production US-East']);
    expect(stdout.split('\n')[0]).toBe(EXAMPLE[0]);
    expect(stdout).not.toContain('Staging');
  });

  it('--pool with an ambiguous name fails and lists the ids', async () => {
    fakeApi([pool({ id: 'pool_a', name: 'Shared' }), pool({ id: 'pool_b', name: 'Shared', cidr: '10.110.0.0/16' })], []);
    const { stdout, stderr, exitCode } = await run(['--pool', 'Shared']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('pool_a, pool_b');
    expect(stdout).toBe('');
  });

  it('--depth 1 stops at the top-level subnets', async () => {
    fakeApi([pool()], SUBNETS);
    const { stdout } = await run(['--depth', '1']);
    expect(stdout).toBe(`${EXAMPLE[0]}\n${EXAMPLE[1]}\n`);
  });

  it('rejects a --depth that is not a whole number, before reading anything', async () => {
    const fetchMock = fakeApi([pool()], SUBNETS);
    const { stderr, exitCode } = await run(['--depth', 'two']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--depth needs a whole number');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends --organization and prints the target line first', async () => {
    const fetchMock = fakeApi([pool()], SUBNETS);
    const { stdout } = await run(['--organization', 'org_customer']);
    expect(stdout.split('\n')[0]).toBe('Target: customer organization org_customer');
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>)['x-nxip-organization']).toBe('org_customer');
    }
  });

  it('with --json, puts the target line on stderr so stdout stays parseable', async () => {
    fakeApi([pool()], SUBNETS, true);
    const { stdout, stderr } = await run(['--json']);
    expect(stderr).toContain('Target: your own organization. Pass --organization to manage a customer.');
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('asks for an API key like plan does', async () => {
    fakeApi([pool()], SUBNETS);
    const { stderr, exitCode } = await run([], { NXIP_API_KEY: '' });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Missing API key');
  });
});
