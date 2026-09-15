import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubnet,
  getSubnet,
  hasCustomerOrganizations,
  listPools,
  NxipApiError,
  previewSubnet,
  resolveClientOptions,
  resolveTargetLine,
} from '../src/client.js';

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

  // The value sent and the value the MCP server scrubs must be one string.
  it('trims whitespace from the key, from either source', () => {
    process.env.NXIP_API_KEY = '  env-key\n';
    expect(resolveClientOptions().apiKey).toBe('env-key');
    expect(resolveClientOptions('flag-key\n').apiKey).toBe('flag-key');
  });

  it('a whitespace-only key counts as missing', () => {
    process.env.NXIP_API_KEY = '\n';
    expect(resolveClientOptions().apiKey).toBe('');
  });

  it('defaults the URL to https://nxip.dev', () => {
    delete process.env.NXIP_URL;
    const options = resolveClientOptions('key');
    expect(options.baseUrl).toBe('https://nxip.dev');
  });

  // Done means 14: --organization and NXIP_ORGANIZATION, flag over env.
  it('leaves organizationId off entirely when neither flag nor env var is set', () => {
    delete process.env.NXIP_ORGANIZATION;
    const options = resolveClientOptions('key');
    expect(options).toEqual({ apiKey: 'key', baseUrl: 'https://nxip.dev' });
    expect(options.organizationId).toBeUndefined();
  });

  it('falls back to NXIP_ORGANIZATION when the flag is not given', () => {
    process.env.NXIP_ORGANIZATION = 'org_env';
    expect(resolveClientOptions('key').organizationId).toBe('org_env');
  });

  it('an explicit --organization flag wins over NXIP_ORGANIZATION', () => {
    process.env.NXIP_ORGANIZATION = 'org_env';
    expect(resolveClientOptions('key', undefined, 'org_flag').organizationId).toBe('org_flag');
  });

  it('trims whitespace from the organization id, from either source', () => {
    process.env.NXIP_ORGANIZATION = '  org_env\n';
    expect(resolveClientOptions('key').organizationId).toBe('org_env');
    expect(resolveClientOptions('key', undefined, 'org_flag\n').organizationId).toBe('org_flag');
  });

  it('a whitespace-only organization counts as unset', () => {
    process.env.NXIP_ORGANIZATION = '\n';
    expect(resolveClientOptions('key').organizationId).toBeUndefined();
  });
});

describe('the x-nxip-organization header (docs/specs/msp-tenancy-phase2.md Part C)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is sent when organizationId is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await previewSubnet({ apiKey: 'k', baseUrl: 'https://nxip.test', organizationId: 'org_customer' }, { family: 'IPV4', prefixLength: 24 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-nxip-organization']).toBe('org_customer');
  });

  // A caller's own organization is the default; nothing must ever be sent
  // that could be mistaken for an intentional (even empty) target.
  it('is absent, not sent as an empty string, when organizationId is unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await previewSubnet({ apiKey: 'k', baseUrl: 'https://nxip.test' }, { family: 'IPV4', prefixLength: 24 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect('x-nxip-organization' in (init.headers as Record<string, string>)).toBe(false);
  });

  it('is sent on a GET request too', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSubnet({ apiKey: 'k', baseUrl: 'https://nxip.test', organizationId: 'org_customer' }, 'sub_1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-nxip-organization']).toBe('org_customer');
  });
});

describe('hasCustomerOrganizations', () => {
  afterEach(() => vi.unstubAllGlobals());
  const options = { apiKey: 'k', baseUrl: 'https://nxip.test' };

  it('calls GET /v1/organizations/children?limit=1 and returns true when there is at least one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'org_child' }], meta: { limit: 1, nextCursor: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hasCustomerOrganizations(options)).resolves.toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://nxip.test/v1/organizations/children?limit=1');
  });

  it('returns false when data is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], meta: { limit: 1, nextCursor: null } }), { status: 200 })));
    await expect(hasCustomerOrganizations(options)).resolves.toBe(false);
  });

  it('never sends x-nxip-organization itself, even if somehow set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await hasCustomerOrganizations({ ...options, organizationId: 'org_x' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Not part of the contract (this is only ever called when organizationId
    // is unset), but proves the header logic in request() is what decides
    // this, not a separate check here.
    expect((init.headers as Record<string, string>)['x-nxip-organization']).toBe('org_x');
  });

  it('rejects on a non-2xx response, like any other request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })));
    await expect(hasCustomerOrganizations(options)).rejects.toBeInstanceOf(NxipApiError);
  });
});

describe('resolveTargetLine (Done means 14, 15a)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the organization directly when set, with no network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const line = await resolveTargetLine({ apiKey: 'k', baseUrl: 'https://nxip.test', organizationId: 'org_customer' });
    expect(line).toBe('Target: customer organization org_customer');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says "your own organization" when unset and the key\'s organization has customers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'org_child' }] }), { status: 200 })));
    const line = await resolveTargetLine({ apiKey: 'k', baseUrl: 'https://nxip.test' });
    expect(line).toBe('Target: your own organization. Pass --organization to manage a customer.');
  });

  it('prints nothing when unset and there are no customers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const line = await resolveTargetLine({ apiKey: 'k', baseUrl: 'https://nxip.test' });
    expect(line).toBeUndefined();
  });

  // Advisory only: a failed check must never block or throw.
  it('prints nothing, and does not throw, when the check call fails (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(resolveTargetLine({ apiKey: 'k', baseUrl: 'https://nxip.test' })).resolves.toBeUndefined();
  });

  it('prints nothing, and does not throw, when the check call returns an error status (for example a READ_ONLY key)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })));
    await expect(resolveTargetLine({ apiKey: 'k', baseUrl: 'https://nxip.test' })).resolves.toBeUndefined();
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

describe('request errors and paths', () => {
  const options = { apiKey: 'k', baseUrl: 'https://example.test' };
  afterEach(() => vi.unstubAllGlobals());

  // The API's validation 400 carries the useful part in issues[], not message.
  it("folds a 400's issues into the error message", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ statusCode: 400, error: 'Bad Request', message: 'Payload validation failed.', issues: [{ field: '/prefixLength', message: 'must be <= 32' }] }),
          { status: 400 }
        )
      )
    );
    const error = await previewSubnet(options, { family: 'IPV4', prefixLength: 24 }).catch((e) => e);
    expect(error).toBeInstanceOf(NxipApiError);
    expect(error.message).toBe('Payload validation failed: prefixLength: must be <= 32');
  });

  it('leaves a message without issues untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Pool is full.', issues: [] }), { status: 409 })));
    const error = await previewSubnet(options, { family: 'IPV4', prefixLength: 24 }).catch((e) => e);
    expect(error.message).toBe('Pool is full.');
  });

  it('encodes an id as one path segment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSubnet(options, 'a/b?c');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v1/subnets/a%2Fb%3Fc');
  });
});
