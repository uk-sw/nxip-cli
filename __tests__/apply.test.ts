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
