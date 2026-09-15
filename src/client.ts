import type {
  AddressStatus,
  AddressFamily,
  ApiPage,
  NxipAddress,
  NxipAddressBody,
  NxipCreatedSubnet,
  NxipLookupResult,
  NxipPool,
  NxipPoolBody,
  NxipPoolDetail,
  NxipPoolForecast,
  NxipSearchResult,
  NxipSubnet,
  NxipSubnetBody,
  NxipUsage,
  PreviewResult,
} from './types.js';

export interface NxipClientOptions {
  apiKey: string;
  baseUrl: string;
  /**
   * The customer organization this run acts on, sent as x-nxip-organization
   * on every request (docs/specs/msp-tenancy-phase2.md Part C, mirroring
   * phase 1's ACTING_ON_BEHALF_HEADER in the API). Unset means the key's own
   * organization, exactly as before this option existed - request() below
   * only ever sends the header when this is set, never as an empty value.
   */
  organizationId?: string;
  /**
   * Abort a request that has not answered within this many milliseconds.
   * Unset means no limit, which is what plan and apply have always had. The
   * MCP server sets one: an agent waiting on a hung request has no Ctrl+C,
   * so a stalled network should come back as an error it can report.
   */
  timeoutMs?: number;
}

// x-api-key, not Authorization: Bearer. client.go in terraform-provider-nxip
// documents that this API was once authenticated with the wrong header
// until its own HTTP client got centralized - worth not repeating here.
const API_KEY_HEADER = 'x-api-key';

// Names the customer organization a request acts on behalf of. See
// ACTING_ON_BEHALF_HEADER in net-saas-monorepo apps/api/src/middleware/
// auth.ts: the API resolves and enforces it, this client only ever names
// a target.
const ORGANIZATION_HEADER = 'x-nxip-organization';

/**
 * Resolves API key/URL/organization the same way terraform-provider-nxip's
 * provider.go and nxip-terraform-plan-action resolve key/URL: an explicit
 * flag wins, falling back to NXIP_API_KEY/NXIP_URL/NXIP_ORGANIZATION env
 * vars, then https://nxip.dev for the URL - so a NXIP_API_KEY already set
 * for the Terraform provider works here too.
 *
 * The key is trimmed once, here. A key read with `$(cat key.txt)` or pasted
 * into a config file often carries a trailing newline; fetch strips that
 * from the header anyway, so trimming changes nothing on the wire. What it
 * does change is that the value sent and the value the MCP server scrubs
 * from its output are the same string, rather than differing by whitespace.
 * The organization id is trimmed for the same reason, though unlike the key
 * it is never a secret and is never scrubbed.
 *
 * organizationId is left off the returned object entirely when it resolves
 * to nothing (rather than set to undefined), so a plain object-equality
 * check on the result still sees just apiKey and baseUrl when no
 * organization was given, and so request() below can tell "set" from
 * "unset" with a single truthiness check.
 */
export function resolveClientOptions(flagApiKey?: string, flagUrl?: string, flagOrganization?: string): NxipClientOptions {
  const apiKey = (flagApiKey || process.env.NXIP_API_KEY || '').trim();
  const baseUrl = (flagUrl || process.env.NXIP_URL || 'https://nxip.dev').replace(/\/+$/, '');
  const organizationId = (flagOrganization || process.env.NXIP_ORGANIZATION || '').trim();
  return { apiKey, baseUrl, ...(organizationId ? { organizationId } : {}) };
}

export class NxipApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NxipApiError';
  }
}

/**
 * The API's schema-validation 400 says only "Payload validation failed." and
 * puts what actually failed in issues[] (see setErrorHandler in the API's
 * app.ts). Dropping issues[] leaves the caller, often an agent deciding what
 * to change, with nothing to act on, so they are folded into the message.
 */
function withIssues(message: string, issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) return message;
  const details = issues
    .map((issue) => {
      const { field, message: issueMessage } = (issue ?? {}) as { field?: unknown; message?: unknown };
      // instancePath-style fields arrive as "/prefixLength"; the slash is noise.
      const name = typeof field === 'string' ? field.replace(/^\//, '') : '';
      const text = typeof issueMessage === 'string' ? issueMessage : 'invalid';
      return name && name !== 'unknown' ? `${name}: ${text}` : text;
    })
    .join('; ');
  return `${message.replace(/\.$/, '')}: ${details}`;
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
      // Sent only when a customer organization was actually resolved, never
      // as an empty string: an empty header would ask the API to act on
      // behalf of "" rather than leaving the caller's own organization alone.
      ...(options.organizationId ? { [ORGANIZATION_HEADER]: options.organizationId } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
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
        ? withIssues(String((parsed as { message: unknown }).message), (parsed as { issues?: unknown }).issues)
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
export function createSubnet(options: NxipClientOptions, body: NxipSubnetBody): Promise<NxipCreatedSubnet> {
  return request(options, '/v1/subnets', body);
}

/** Calls POST /v1/pools. Pools have no preview endpoint, unlike subnets. */
export function createPool(options: NxipClientOptions, body: NxipPoolBody): Promise<NxipPool> {
  return request(options, '/v1/pools', body);
}

// A ceiling that exists only so a paging bug cannot loop forever. It is far
// above any real estate; being told the limit was hit beats a truncated read.
const MAX_POOL_PAGES = 100;

/**
 * Lists existing pools so a plan can distinguish "will be created" from
 * "already there". There is no pool preview endpoint, so this read is the
 * only way to say anything truthful about a pool before applying it.
 */
export async function listPools(options: NxipClientOptions): Promise<NxipPool[]> {
  const pools: NxipPool[] = [];
  let page = 1;

  // Deliberately not the GUI's fetchAllPages, which stops silently at a
  // maxPages ceiling. A dashboard showing 1,000 of 1,200 pools is merely
  // incomplete; plan and apply reading 1,000 of 1,200 would report "will
  // create" for a pool that exists and skip overlap checks against the rest,
  // which is the failure this pagination is here to prevent. So the ceiling
  // throws rather than truncates: wrong loudly beats wrong quietly.
  while (page <= MAX_POOL_PAGES) {
    const response = await request<{ data: NxipPool[]; meta?: { totalPages?: number } }>(
      options,
      `/v1/pools?limit=100&page=${page}`,
      undefined,
      'GET'
    );
    pools.push(...(response.data ?? []));

    const totalPages = response.meta?.totalPages;
    // An API that stops reporting totalPages must not silently become a
    // single-page read again, which is the bug this replaces.
    if (typeof totalPages !== 'number') break;
    if (page >= totalPages) return pools;
    page += 1;
  }

  throw new NxipApiError(
    0,
    `This organization has more than ${MAX_POOL_PAGES * 100} pools, which nxip cannot read in one plan. ` +
      'Please open an issue: this limit is arbitrary and can be raised.'
  );
}

/**
 * Encodes a client-supplied id for use as one path segment. Without this an
 * id of `x/../../organizations/usage` would address a different route than
 * the one the caller asked for. The API would still authorise whatever it
 * reached, but a tool must only ever call the endpoint it names.
 *
 * Encoding alone is not enough: "." and ".." survive encodeURIComponent and
 * fetch then collapses them as dot segments. Ids that could do that are
 * refused earlier, by the MCP tool input schemas (see idSchema in mcp.ts),
 * so no request is made at all.
 */
function segment(id: string): string {
  return encodeURIComponent(id);
}

/** Appends only the query parameters actually given, so an absent filter is never sent as `?region=undefined`. */
function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

// The helpers below each call exactly one endpoint and return its body
// untouched. Unlike listPools above, they read one page at a time: paging is
// left to the caller, who can see meta.totalPages and ask for the next one.

export interface PageQuery {
  page?: number;
  limit?: number;
}

/**
 * GET /v1/pools, one page. `family` is deliberately not offered: the route's
 * query schema accepts it, but the handler never applies it, so passing it
 * would look like a filter while returning every family.
 */
export function listPoolsPage(
  options: NxipClientOptions,
  query: PageQuery & { environment?: string; region?: string } = {}
): Promise<ApiPage<NxipPoolDetail>> {
  return request(options, withQuery('/v1/pools', { ...query }), undefined, 'GET');
}

/** GET /v1/pools/:id */
export function getPool(options: NxipClientOptions, id: string): Promise<NxipPoolDetail> {
  return request(options, `/v1/pools/${segment(id)}`, undefined, 'GET');
}

/** GET /v1/pools/forecast */
export function forecastPools(options: NxipClientOptions): Promise<NxipPoolForecast> {
  return request(options, '/v1/pools/forecast', undefined, 'GET');
}

/** GET /v1/subnets, one page. */
export function listSubnets(
  options: NxipClientOptions,
  query: PageQuery & { environment?: string; region?: string; family?: AddressFamily } = {}
): Promise<ApiPage<NxipSubnet>> {
  return request(options, withQuery('/v1/subnets', { ...query }), undefined, 'GET');
}

/** GET /v1/subnets/:id */
export function getSubnet(options: NxipClientOptions, id: string): Promise<NxipSubnet> {
  return request(options, `/v1/subnets/${segment(id)}`, undefined, 'GET');
}

/** GET /v1/subnets/:id/addresses, one page. */
export function listAddresses(
  options: NxipClientOptions,
  subnetId: string,
  query: PageQuery & { status?: AddressStatus } = {}
): Promise<ApiPage<NxipAddress>> {
  return request(options, withQuery(`/v1/subnets/${segment(subnetId)}/addresses`, { ...query }), undefined, 'GET');
}

/** POST /v1/subnets/:id/addresses. Registers the address given; the API never picks one. */
export function createAddress(options: NxipClientOptions, subnetId: string, body: NxipAddressBody): Promise<NxipAddress> {
  return request(options, `/v1/subnets/${segment(subnetId)}/addresses`, body);
}

/** GET /v1/lookup */
export function lookupIp(options: NxipClientOptions, ip: string): Promise<NxipLookupResult> {
  return request(options, withQuery('/v1/lookup', { ip }), undefined, 'GET');
}

/** GET /v1/search */
export function search(options: NxipClientOptions, q: string, limit?: number): Promise<NxipSearchResult> {
  return request(options, withQuery('/v1/search', { q, limit }), undefined, 'GET');
}

/** GET /v1/organizations/usage */
export function getUsage(options: NxipClientOptions): Promise<NxipUsage> {
  return request(options, '/v1/organizations/usage', undefined, 'GET');
}

/**
 * True if the key's own organization has at least one customer, i.e. it
 * could act on behalf of someone if --organization/NXIP_ORGANIZATION were
 * set. `limit=1` is all this needs: it only ever asks "any at all?", never
 * "how many?" or "which ones?". Never opted in to x-nxip-organization on the
 * API side (docs/specs/msp-tenancy-phase1.md), which is fine here since this
 * is only ever called when organizationId is unset, so options never carries
 * a header for this call to send.
 *
 * Used only to decide whether to print the "Target: your own organization"
 * line (see resolveTargetLine below) - never to gate a request, since acting
 * on behalf is resolved by the API itself, not guessed at here.
 */
export async function hasCustomerOrganizations(options: NxipClientOptions): Promise<boolean> {
  const response = await request<{ data: unknown[] }>(options, '/v1/organizations/children?limit=1', undefined, 'GET');
  return (response.data ?? []).length > 0;
}

/**
 * The line plan, apply and mcp each print to say which organization a run
 * targets (docs/specs/msp-tenancy-phase2.md Part C). Centralized here
 * because all three need the exact same rule, not just the same words:
 *
 * - organizationId set: always names it, with no network call.
 * - organizationId unset: one best-effort call decides whether the key's
 *   own organization has customers. If it does, the line points at
 *   --organization; if it does not, or the call fails for any reason
 *   (wrong role, network error, timeout), undefined is returned and nothing
 *   is printed. This check is advisory only and must never block or fail a
 *   plan, apply or mcp startup - hence the blanket catch.
 */
export async function resolveTargetLine(options: NxipClientOptions): Promise<string | undefined> {
  if (options.organizationId) {
    return `Target: customer organization ${options.organizationId}`;
  }
  try {
    if (await hasCustomerOrganizations(options)) {
      return 'Target: your own organization. Pass --organization to manage a customer.';
    }
  } catch {
    // Advisory only: a failed check prints nothing, same as no customers.
  }
  return undefined;
}
