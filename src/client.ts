import type { NxipPool, NxipPoolBody, NxipSubnetBody, PreviewResult } from './types.js';

export interface NxipClientOptions {
  apiKey: string;
  baseUrl: string;
}

// x-api-key, not Authorization: Bearer. client.go in terraform-provider-nxip
// documents that this API was once authenticated with the wrong header
// until its own HTTP client got centralized - worth not repeating here.
const API_KEY_HEADER = 'x-api-key';

/**
 * Resolves API key/URL the same way terraform-provider-nxip's provider.go
 * and nxip-terraform-plan-action do: an explicit flag wins, falling back
 * to NXIP_API_KEY/NXIP_URL env vars, then https://nxip.dev - so a
 * NXIP_API_KEY already set for the Terraform provider works here too.
 */
export function resolveClientOptions(flagApiKey?: string, flagUrl?: string): NxipClientOptions {
  const apiKey = flagApiKey || process.env.NXIP_API_KEY || '';
  const baseUrl = (flagUrl || process.env.NXIP_URL || 'https://nxip.dev').replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

export class NxipApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NxipApiError';
  }
}

async function request<T>(
  options: NxipClientOptions,
  path: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST'
): Promise<T> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [API_KEY_HEADER]: options.apiKey,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : text || `nxip API returned unexpected status ${response.status}`;
    throw new NxipApiError(response.status, message);
  }

  return parsed as T;
}

/**
 * Calls POST /v1/subnets/preview. A non-200 here means the request itself
 * couldn't be evaluated (bad key, malformed body) - a genuine failure,
 * distinct from a 200 with wouldSucceed: false, which is a successfully
 * computed "no" (pool full, tier limit, etc).
 */
export function previewSubnet(options: NxipClientOptions, body: NxipSubnetBody): Promise<PreviewResult> {
  return request<PreviewResult>(options, '/v1/subnets/preview', body);
}

/** Calls the real POST /v1/subnets - only ever invoked after a preview came back wouldSucceed: true. */
export function createSubnet(options: NxipClientOptions, body: NxipSubnetBody): Promise<{ id: string; cidr: string }> {
  return request(options, '/v1/subnets', body);
}

/** Calls POST /v1/pools. Pools have no preview endpoint, unlike subnets. */
export function createPool(options: NxipClientOptions, body: NxipPoolBody): Promise<NxipPool> {
  return request(options, '/v1/pools', body);
}

/**
 * Lists existing pools so a plan can distinguish "will be created" from
 * "already there". There is no pool preview endpoint, so this read is the
 * only way to say anything truthful about a pool before applying it.
 */
export async function listPools(options: NxipClientOptions): Promise<NxipPool[]> {
  const page = await request<{ data: NxipPool[] }>(options, '/v1/pools?limit=100', undefined, 'GET');
  return page.data ?? [];
}
