import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubnet, listPools, NxipApiError, previewSubnet, resolveClientOptions } from '../src/client.js';

describe('resolveClientOptions', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back to NXIP_API_KEY/NXIP_URL env vars', () => {
    process.env.NXIP_API_KEY = 'env-key';
    process.env.NXIP_URL = 'https://example.test/';
    const options = resolveClientOptions();
    expect(options).toEqual({ apiKey: 'env-key', baseUrl: 'https://example.test' });
  });

  it('an explicit flag wins over the env var', () => {
    process.env.NXIP_API_KEY = 'env-key';
    const options = resolveClientOptions('flag-key');
    expect(options.apiKey).toBe('flag-key');
  });

  it('defaults the URL to https://nxip.dev', () => {
    delete process.env.NXIP_URL;
    const options = resolveClientOptions('key');
    expect(options.baseUrl).toBe('https://nxip.dev');
  });
});

describe('previewSubnet / createSubnet', () => {
  const options = { apiKey: 'test-key', baseUrl: 'https://nxip.test' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends x-api-key, not Authorization: Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ wouldSucceed: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await previewSubnet(options, { family: 'IPV4', prefixLength: 24 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('returns a 200 body as-is, including wouldSucceed: false', async () => {
    const body = { wouldSucceed: false, reason: 'full', message: 'Pool is full', httpStatusIfAttempted: 402 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));

    const result = await previewSubnet(options, { family: 'IPV4', prefixLength: 24 });
    expect(result).toEqual(body);
  });

  it('throws NxipApiError on a non-2xx response, using the response message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: 'Missing API key' }), { status: 401 }))
    );

    const error = await previewSubnet(options, { family: 'IPV4', prefixLength: 24 }).catch((e) => e);
    expect(error).toBeInstanceOf(NxipApiError);
    expect(error.message).toBe('Missing API key');
  });

  it('createSubnet posts to /v1/subnets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'sub_1', cidr: '10.0.0.0/24' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const created = await createSubnet(options, { family: 'IPV4', prefixLength: 24 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://nxip.test/v1/subnets');
    expect(created).toEqual({ id: 'sub_1', cidr: '10.0.0.0/24' });
  });
});

describe('listPools pagination', () => {
  const options = { apiKey: 'k', baseUrl: 'https://example.test' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pagedFetch(totalPages: number) {
    return vi.fn().mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      return new Response(
        JSON.stringify({
          data: [{ id: `pool-${page}`, name: `pool-${page}`, cidr: '10.0.0.0/16' }],
          meta: { totalPages },
        }),
        { status: 200 }
      );
    });
  }

  // The bug this replaces: one read of limit=100, so pool 101 looked absent.
  // plan then reported "will create" for a pool that exists, apply failed on
  // the duplicate, and cross-pool overlap checks skipped everything past it.
  it('reads every page, not just the first', async () => {
    const fetchMock = pagedFetch(3);
    vi.stubGlobal('fetch', fetchMock);
    const pools = await listPools(options);
    expect(pools.map((p) => p.id)).toEqual(['pool-1', 'pool-2', 'pool-3']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops after the last page rather than paging forever', async () => {
    const fetchMock = pagedFetch(1);
    vi.stubGlobal('fetch', fetchMock);
    await listPools(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Truncating quietly is the one outcome plan and apply must never have,
  // so an absent totalPages must not silently become a single-page read.
  it('throws rather than truncating when the ceiling is reached', async () => {
    vi.stubGlobal('fetch', pagedFetch(500));
    await expect(listPools(options)).rejects.toThrow(/more than 10000 pools/);
  });
});
