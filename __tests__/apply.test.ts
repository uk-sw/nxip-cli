import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyManifest, formatApplyResults, type ApplyResult } from '../src/apply.js';

describe('formatApplyResults', () => {
  it('reports created, skipped, and failed subnets, with a correct total', () => {
    const results: ApplyResult[] = [
      { name: 'payments', kind: 'subnet' as const, outcome: 'created', detail: '10.0.4.0/24 (id sub_1)' },
      { name: 'overflow', kind: 'subnet' as const, outcome: 'skipped', detail: 'full: Pool is full' },
      { name: 'race-loser', kind: 'subnet' as const, outcome: 'failed', detail: 'CIDR was taken by a concurrent request' },
    ];

    const output = formatApplyResults(results);
    expect(output).toContain('+ payments: created at 10.0.4.0/24 (id sub_1)');
    expect(output).toContain('x overflow: skipped, full: Pool is full');
    expect(output).toContain('! race-loser: failed, CIDR was taken by a concurrent request');
    expect(output).toContain('Apply complete: 1 created, 0 already existed, 2 not created.');
  });

  it('reports zero created when every subnet was skipped', () => {
    const results: ApplyResult[] = [{ name: 'a', kind: 'subnet' as const, outcome: 'skipped', detail: 'full: Pool is full' }];
    expect(formatApplyResults(results)).toContain('Apply complete: 0 created, 0 already existed, 1 not created.');
  });
});

describe('re-applying something already imported', () => {
  const options = { apiKey: 'k', baseUrl: 'https://example.test' };
  afterEach(() => vi.unstubAllGlobals());

  // Serves the API as it looks after a successful first import: both the
  // network and the subnet inside it are already registered. Records every
  // create so the test can prove none happened.
  function importedEstate() {
    const creates: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/v1/subnets/preview')) {
        const existing = body.cidr === '10.61.0.0/20'
          ? { id: 'sub_vpc', cidr: '10.61.0.0/20', name: 'imported-vpc' }
          : body.cidr === '10.61.1.0/24' && body.parentSubnetId === 'sub_vpc'
            ? { id: 'sub_web', cidr: '10.61.1.0/24', name: 'imported-web' }
            : null;
        return new Response(JSON.stringify(existing
          ? { wouldSucceed: false, reason: 'already-exists', message: 'Already registered.', httpStatusIfAttempted: 409, existing }
          : { wouldSucceed: false, reason: 'no-pool', message: 'unexpected', httpStatusIfAttempted: 409 }), { status: 200 });
      }
      if (url.endsWith('/v1/subnets')) {
        creates.push(body);
        return new Response(JSON.stringify({ message: 'should not be called' }), { status: 409 });
      }
      return new Response('{}', { status: 404 });
    });
    return { fetchMock, creates };
  }

  const entries = [
    { name: 'imported-vpc', body: { family: 'IPV4', cidr: '10.61.0.0/20', environment: 'production', region: 'eu-west-1', kind: 'vpc' } },
    { name: 'imported-web', parent: 'imported-vpc', body: { family: 'IPV4', cidr: '10.61.1.0/24' } },
  ] as Parameters<typeof applyManifest>[1];

  it('reports both as existing and creates nothing', async () => {
    const { fetchMock, creates } = importedEstate();
    vi.stubGlobal('fetch', fetchMock);

    const results = await applyManifest(options, entries);

    expect(results.map((r) => [r.name, r.outcome])).toEqual([
      ['imported-vpc', 'existing'],
      ['imported-web', 'existing'],
    ]);
    expect(creates).toEqual([]);
  });

  // The failure this guards against. A child finds its parent through the ids
  // recorded earlier in the same run, so without recording an existing
  // parent's id, every subnet inside an already-imported network was skipped
  // as "parent was not created", even though the parent exists.
  it('nests a child under an existing parent rather than skipping it', async () => {
    const { fetchMock } = importedEstate();
    vi.stubGlobal('fetch', fetchMock);

    const results = await applyManifest(options, entries);
    const child = results.find((r) => r.name === 'imported-web');

    expect(child?.outcome).toBe('existing');
    expect(child?.detail).not.toContain('was not created');
  });

  it('reads as a success, not as failures', async () => {
    const { fetchMock } = importedEstate();
    vi.stubGlobal('fetch', fetchMock);

    const output = formatApplyResults(await applyManifest(options, entries));
    expect(output).toContain('= imported-vpc: already exists');
    expect(output).toContain('Apply complete: 0 created, 2 already existed, 0 not created.');
  });
});

/**
 * A small stateful stand-in for the API: subnets created through it are
 * listed by GET /v1/subnets on the next run, the way the real one behaves.
 * The preview answers prefix_length requests with the next free /26 and
 * knows nothing about names, exactly like the real preview, which is what
 * let a second apply allocate again (weft triage item 4a).
 */
function fakeSubnetApi(seed: Array<{ id: string; name: string; cidr: string; parentSubnetId?: string | null }> = []) {
  const shape = (s: { id: string; name: string; cidr: string; parentSubnetId?: string | null }) => ({
    id: s.id,
    name: s.name,
    cidr: s.cidr,
    prefixLength: Number(s.cidr.split('/')[1]),
    family: 'IPV4',
    environment: 'production',
    region: 'us-east-1',
    ipPoolId: 'pool_1',
    parentSubnetId: s.parentSubnetId ?? null,
    kind: null,
    description: null,
    metadata: {},
    createdAt: '2026-10-07T00:00:00.000Z',
    utilization: { registeredAddresses: 0 },
  });
  const subnets = seed.map(shape);
  let next = subnets.length;
  const creates: Array<Record<string, unknown>> = [];
  const nextCidr = () => `10.240.${Math.floor(next / 4)}.${(next % 4) * 64}/26`;

  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('/v1/subnets/preview')) {
      return new Response(JSON.stringify({
        wouldSucceed: true,
        subnet: { cidr: nextCidr(), prefixLength: 26, family: 'IPV4', environment: 'production', region: 'us-east-1' },
        container: { type: 'pool', id: 'pool_1', name: 'core' },
        utilization: { before: {}, after: {} },
      }), { status: 200 });
    }
    if (url.includes('/v1/subnets') && method === 'GET') {
      return new Response(JSON.stringify({ data: subnets, meta: { total: subnets.length, page: 1, limit: 100, totalPages: 1 } }), { status: 200 });
    }
    if (url.endsWith('/v1/subnets') && method === 'POST') {
      creates.push(body);
      const created = shape({ id: `sub_${next}`, name: body.name, cidr: nextCidr(), parentSubnetId: body.parentSubnetId ?? null });
      next++;
      subnets.push(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  });
  return { fetchMock, subnets, creates };
}

describe('re-applying a prefix_length manifest (weft triage item 4a)', () => {
  const options = { apiKey: 'k', baseUrl: 'https://example.test' };
  afterEach(() => vi.unstubAllGlobals());

  const twoEntries = [
    { name: 'app-a', body: { family: 'IPV4', prefixLength: 26, environment: 'production', region: 'us-east-1', name: 'app-a' } },
    { name: 'app-b', body: { family: 'IPV4', prefixLength: 26, environment: 'production', region: 'us-east-1', name: 'app-b' } },
  ] as Parameters<typeof applyManifest>[1];

  it('creates exactly two subnets across two applies, and the second run reports both as existing', async () => {
    const { fetchMock, subnets } = fakeSubnetApi();
    vi.stubGlobal('fetch', fetchMock);

    const first = await applyManifest(options, twoEntries);
    expect(first.map((r) => r.outcome)).toEqual(['created', 'created']);

    const second = await applyManifest(options, twoEntries);
    expect(second.map((r) => [r.name, r.outcome])).toEqual([
      ['app-a', 'existing'],
      ['app-b', 'existing'],
    ]);
    expect(subnets).toHaveLength(2);
    expect(formatApplyResults(second)).toContain('= app-a: already exists at 10.240.0.0/26 (id sub_0)');
  });

  it('does not match a same-named subnet in a different region', async () => {
    const { fetchMock, subnets } = fakeSubnetApi([{ id: 'sub_x', name: 'app-a', cidr: '10.9.0.0/26' }]);
    subnets[0].region = 'eu-west-2';
    vi.stubGlobal('fetch', fetchMock);

    const results = await applyManifest(options, [twoEntries[0]]);
    expect(results[0].outcome).toBe('created');
  });

  it('fails an entry whose name matches two subnets, naming both, and creates nothing for it', async () => {
    const { fetchMock, creates } = fakeSubnetApi([
      { id: 'sub_old', name: 'app-a', cidr: '10.240.0.0/26' },
      { id: 'sub_dup', name: 'app-a', cidr: '10.240.0.128/26' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await applyManifest(options, [twoEntries[0]]);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('ambiguous-name');
    expect(result.detail).toContain('10.240.0.0/26 (id sub_old)');
    expect(result.detail).toContain('10.240.0.128/26 (id sub_dup)');
    expect(creates).toEqual([]);
  });

  it('recognises a sized child under its parent on the second run', async () => {
    const { fetchMock, subnets } = fakeSubnetApi();
    vi.stubGlobal('fetch', fetchMock);
    const nested = [
      twoEntries[0],
      { name: 'app-a-web', parent: 'app-a', body: { family: 'IPV4', prefixLength: 28, name: 'app-a-web' } },
    ] as Parameters<typeof applyManifest>[1];

    await applyManifest(options, nested);
    const second = await applyManifest(options, nested);
    expect(second.map((r) => r.outcome)).toEqual(['existing', 'existing']);
    expect(subnets).toHaveLength(2);
  });

  it('fails a sized child whose name matches two subnets under the same parent', async () => {
    const { fetchMock, creates } = fakeSubnetApi([
      { id: 'sub_p', name: 'app-a', cidr: '10.240.0.0/26' },
      { id: 'sub_c1', name: 'web', cidr: '10.240.0.0/28', parentSubnetId: 'sub_p' },
      { id: 'sub_c2', name: 'web', cidr: '10.240.0.16/28', parentSubnetId: 'sub_p' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const results = await applyManifest(options, [
      twoEntries[0],
      { name: 'web', parent: 'app-a', body: { family: 'IPV4', prefixLength: 28, name: 'web' } },
    ] as Parameters<typeof applyManifest>[1]);
    expect(results.map((r) => r.outcome)).toEqual(['existing', 'failed']);
    expect(results[1].detail).toContain('sub_c1');
    expect(results[1].detail).toContain('sub_c2');
    expect(creates).toEqual([]);
  });
});
