import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubnet, NxipApiError, previewSubnet, resolveClientOptions } from '../src/client.js';

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
