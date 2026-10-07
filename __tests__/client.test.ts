import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSubnet,
  getSubnet,
  hasCustomerOrganizations,
  listPools,
  NxipApiError,
  previewSubnet,
  resolveClientOptions,
  resolveTargetLine,
  retryAfterMs,
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

describe('a 429 is waited out and retried (weft triage item 1)', () => {
  const options = { apiKey: 'k', baseUrl: 'https://example.test' };
  const limited = (retryAfter: string | null, message = 'Rate limit exceeded, retry in 2 seconds') =>
    new Response(JSON.stringify({ statusCode: 429, error: 'Error', message }), {
      status: 429,
      headers: retryAfter === null ? {} : { 'retry-after': retryAfter },
    });
  const created = () => new Response(JSON.stringify({ id: 'sub_1', cidr: '10.0.0.0/26' }), { status: 201 });
  const body = { family: 'IPV4' as const, prefixLength: 26, environment: 'production', region: 'us-east-1' };

  let logged: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits the Retry-After seconds, then retries the create and succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited('2')).mockResolvedValueOnce(created());
    vi.stubGlobal('fetch', fetchMock);

    const pending = createSubnet(options, body);
    await vi.advanceTimersByTimeAsync(1999);
    // Not a moment early: the API said two seconds.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ id: 'sub_1', cidr: '10.0.0.0/26' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The same create, sent again unchanged.
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(logged).toEqual([
      'nxip: rate limited by the API (HTTP 429). Waiting 2s before retrying POST /v1/subnets (retry 1 of 3).',
    ]);
  });

  it('honours Retry-After given as an HTTP date', async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const fetchMock = vi.fn().mockResolvedValueOnce(limited(at)).mockResolvedValueOnce(created());
    vi.stubGlobal('fetch', fetchMock);

    const pending = createSubnet(options, body);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ id: 'sub_1' });
    expect(logged[0]).toContain('Waiting 5s');
  });

  it('caps a long Retry-After at a minute', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited('3600')).mockResolvedValueOnce(created());
    vi.stubGlobal('fetch', fetchMock);

    const pending = createSubnet(options, body);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ id: 'sub_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after three retries with the 429\'s own message', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => limited('1', 'Rate limit exceeded, retry in 57 seconds'));
    vi.stubGlobal('fetch', fetchMock);

    const pending = createSubnet(options, body);
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await settled;

    expect(error).toBeInstanceOf(NxipApiError);
    expect((error as NxipApiError).status).toBe(429);
    expect((error as NxipApiError).message).toBe('Rate limit exceeded, retry in 57 seconds');
    // One first attempt plus three retries, and no more.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(logged).toHaveLength(3);
  });

  it('does not retry a 500, even on a GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const settled = getSubnet(options, 'sub_1').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await settled;

    expect((error as NxipApiError).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logged).toEqual([]);
  });

  it('does not retry a 500 on a create', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const settled = createSubnet(options, body).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(((await settled) as NxipApiError).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-07T12:00:00.000Z');
  it('reads whole seconds', () => expect(retryAfterMs('57', now)).toBe(57_000));
  it('reads an HTTP date', () => expect(retryAfterMs('Wed, 07 Oct 2026 12:00:09 GMT', now)).toBe(9_000));
  it('treats a date in the past as no wait', () => expect(retryAfterMs('Wed, 07 Oct 2026 11:00:00 GMT', now)).toBe(0));
  it('caps at a minute', () => expect(retryAfterMs('600', now)).toBe(60_000));
  it('waits the cap when the header is missing or unreadable', () => {
    expect(retryAfterMs(null, now)).toBe(60_000);
    expect(retryAfterMs('soon', now)).toBe(60_000);
  });
});
