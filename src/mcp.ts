import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createAddress,
  createPool,
  createSubnet,
  forecastPools,
  getPool,
  getSubnet,
  getUsage,
  listAddresses,
  listPoolsPage,
  listSubnets,
  lookupIp,
  NxipApiError,
  previewSubnet,
  search,
  type NxipClientOptions,
} from './client.js';
import type { ApiPage, NxipMetricUsage } from './types.js';
import { readVersion } from './version.js';

/*
 * The MCP server is a thin adapter, on purpose. Every tool calls exactly one
 * existing API endpoint and hands back what it said. Nothing here checks a
 * role, an overlap or a tier limit, because the API already does all three
 * and a second copy would drift from the real rules. That is the whole
 * claim: an agent using these tools is held to the same refusals as
 * Terraform, because it goes through the same door.
 */

// Long enough for a slow search across a large organisation, short enough
// that an agent gets an error it can report before its client gives up on
// the call (commonly 60 seconds) and the user is left with nothing.
const REQUEST_TIMEOUT_MS = 30_000;

// ==========================================
// Input schemas, mirroring the API's own
// ==========================================
// Each mirrors the Zod schema of the route it feeds, in
// net-saas-monorepo/apps/api/src/routes. Validating here as well is not a
// second source of truth for the rules: it exists so an obviously malformed
// call (prefixLength 99 for IPv4) never becomes an HTTP request, and so the
// model sees the bounds in the tool's JSON Schema before it guesses.

// lib/metadataSchema.ts: 20 keys, 128-char keys, 256-char values.
const metadataSchema = z
  .record(z.string().max(128), z.string().max(256))
  .refine((obj) => Object.keys(obj).length <= 20, { message: 'Metadata cannot have more than 20 keys' })
  .describe('String key/value pairs. At most 20 keys, keys up to 128 characters, values up to 256.');

const family = z.enum(['IPV4', 'IPV6']);

// The list routes take page/limit as query strings and clamp limit to 100.
// Offered as numbers here, since that is what they mean, with the same bounds.
const page = z.number().int().min(1).optional().describe('Page number, starting at 1. Defaults to 1.');
const limit = z.number().int().min(1).max(100).optional().describe('Results per page, 1 to 100. Defaults to 50.');

// subnets.ts createSubnetSchema.body, which preview reuses verbatim. The API
// expresses the per-family prefix bounds as a discriminated union; MCP tool
// schemas must be a single object to be listed as JSON Schema, so the same
// bounds are enforced as a refinement instead.
const subnetRequest = z
  .object({
    family: family.describe('Address family of the subnet.'),
    prefixLength: z
      .number()
      .int()
      .min(8)
      .max(127)
      .optional()
      .describe('Size of the block for nxip to pick. IPV4: 8 to 31. IPV6: 32 to 127. Give this or cidr, not both.'),
    cidr: z
      .string()
      .min(1)
      .optional()
      .describe('Register this exact, already-in-use block instead of letting nxip pick one. Give this or prefixLength, not both.'),
    environment: z
      .string()
      .min(1)
      .optional()
      .describe('With region, routes the request to the pool for this environment/region/family. Required unless parentSubnetId is given.'),
    region: z.string().min(1).optional().describe('With environment, routes the request to a pool. Required unless parentSubnetId is given.'),
    parentSubnetId: z
      .string()
      .min(1)
      .optional()
      .describe('Nest directly under this existing subnet instead of routing by environment/region. Environment and region are inherited from it.'),
    kind: z
      .string()
      .min(1)
      .optional()
      .describe('Free-text label for a structural level ("region", "vpc", "site"). Only meaningful on a top-level subnet: it makes the subnet a landing point for later requests with the same environment/region/family.'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: metadataSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.prefixLength !== undefined) {
      const [min, max] = body.family === 'IPV4' ? [8, 31] : [32, 127];
      if (body.prefixLength < min || body.prefixLength > max) {
        ctx.addIssue({
          code: 'custom',
          path: ['prefixLength'],
          message: `prefixLength for ${body.family} must be between ${min} and ${max}.`,
        });
      }
    }
    if (body.cidr === undefined && body.prefixLength === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either `cidr` (to register an existing subnet) or `prefixLength` (to auto-allocate one) is required.',
      });
    }
    if (body.parentSubnetId === undefined && (body.environment === undefined || body.region === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either `parentSubnetId` (to nest under an existing subnet) or both `environment` and `region` (to route to a pool) are required.',
      });
    }
  });

// ==========================================
// Results
// ==========================================

// Real keys are `nxip_live_` plus a long random tail. The floor only stops a
// placeholder like "x" from shredding every result it happens to appear in.
const MIN_SCRUBBABLE_KEY_LENGTH = 8;

/**
 * The key must never reach the model, whatever path the text took to get
 * here. Nothing in this server puts it in a result on purpose, but an API
 * error body is someone else's text: a misbehaving proxy or a future error
 * message echoing a header would otherwise carry the key straight into a
 * conversation transcript. So every result is scrubbed on the way out.
 */
function scrub(text: string, apiKey: string): string {
  if (apiKey.length < MIN_SCRUBBABLE_KEY_LENGTH) return text;
  return text.split(apiKey).join('[redacted]');
}

function textResult(options: NxipClientOptions, parts: string[], isError = false): CallToolResult {
  return {
    content: parts.map((text) => ({ type: 'text' as const, text: scrub(text, options.apiKey) })),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Turns anything a request can throw into a tool error the model can act
 * on. Returned, never thrown: a thrown error would still be caught by the
 * SDK, but with its own wording, and the 403 explanation below would be lost.
 */
function errorResult(options: NxipClientOptions, error: unknown): CallToolResult {
  if (error instanceof NxipApiError) {
    if (error.status === 403) {
      // Explains the refusal after the fact rather than predicting it before
      // the call. The role names come from the routes' requireRole lists.
      return textResult(
        options,
        [
          `nxip refused this request (403): ${error.message} ` +
            "The API key's role does not allow this action. Creating pools, subnets and addresses needs a key " +
            'with the ADMIN or MEMBER role; a READ_ONLY key can only read and preview.',
        ],
        true
      );
    }
    return textResult(options, [`nxip returned an error (${error.status}): ${error.message}`], true);
  }

  // Anything else came from fetch itself: DNS, a refused connection, TLS, or
  // the timeout. The URL is named because "which nxip" is the first question
  // when NXIP_URL points somewhere unexpected. The key is never included.
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  const reason =
    err?.name === 'TimeoutError'
      ? `no response within ${REQUEST_TIMEOUT_MS / 1000} seconds`
      : err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(error);
  return textResult(options, [`Could not reach nxip at ${options.baseUrl}: ${reason}`], true);
}

/**
 * Makes one API call and returns a one-line summary followed by the API's
 * own JSON. The JSON is the answer; the summary exists so a person reading
 * the transcript can see what happened without parsing it.
 */
async function respond<T>(
  options: NxipClientOptions,
  call: () => Promise<T>,
  summarize: (body: T) => string
): Promise<CallToolResult> {
  let body: T;
  try {
    body = await call();
  } catch (error) {
    return errorResult(options, error);
  }

  // A summary that cannot be built (an unexpected body shape) must not turn
  // a request that succeeded into a reported failure.
  let summary: string;
  try {
    summary = summarize(body);
  } catch {
    summary = 'nxip returned a response in an unexpected shape; the raw response follows.';
  }
  return textResult(options, [summary, JSON.stringify(body ?? null, null, 2)]);
}

function plural(count: number, noun: string): string {
  if (count === 1) return `${count} ${noun}`;
  return `${count} ${noun}${noun.endsWith('s') ? 'es' : 's'}`;
}

function pageSummary(noun: string, body: ApiPage<unknown>, suffix = ''): string {
  const { meta } = body;
  return `Found ${plural(meta.total, noun)}${suffix}; showing page ${meta.page} of ${Math.max(meta.totalPages, 1)} (${body.data.length} on this page).`;
}

function metricSummary(name: string, metric: NxipMetricUsage): string {
  return metric.isUnlimited || metric.limit === null
    ? `${name} ${metric.current} (unlimited)`
    : `${name} ${metric.current}/${metric.limit}${metric.isOverLimit ? ' (over limit)' : ''}`;
}

// ==========================================
// Tool annotations
// ==========================================
// Hints only: clients use them to decide what to confirm with the user. They
// grant nothing and restrict nothing, the API key's role does that.
const READ = { readOnlyHint: true } as const;
// A create adds a record and never removes one, so it is not destructive,
// but calling it twice allocates twice, so it is not idempotent either.
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

export interface McpServerOptions {
  /** Register only the read tools, whatever the key's role would allow. */
  readOnly: boolean;
}

export const READ_TOOL_NAMES = [
  'list_pools',
  'get_pool',
  'forecast_pools',
  'list_subnets',
  'get_subnet',
  'list_addresses',
  'lookup_ip',
  'search',
  'get_usage',
  'preview_subnet',
] as const;

export const WRITE_TOOL_NAMES = ['create_pool', 'create_subnet', 'allocate_address'] as const;

/**
 * Builds the server with its tools registered but no transport attached, so
 * tests can drive it through an in-memory transport exactly as a real client
 * would over stdio.
 */
export function createMcpServer(client: NxipClientOptions, { readOnly }: McpServerOptions): McpServer {
  const options: NxipClientOptions = { ...client, timeoutMs: client.timeoutMs ?? REQUEST_TIMEOUT_MS };
  const server = new McpServer({ name: 'nxip', version: readVersion() });

  // ---------- Reads ----------

  server.registerTool(
    'list_pools',
    {
      title: 'List IP pools',
      description:
        "List the organization's IP pools, one page at a time, each with its utilization. A pool is the " +
        'top-level address block for one environment/region/family, and every subnet is carved from one. ' +
        'Use this to see what address space exists before allocating. Works with any API key role.',
      inputSchema: z.object({
        environment: z.string().optional().describe('Only pools in this environment.'),
        region: z.string().optional().describe('Only pools in this region.'),
        page,
        limit,
      }),
      annotations: READ,
    },
    (args) => respond(options, () => listPoolsPage(options, args), (body) => pageSummary('pool', body))
  );

  server.registerTool(
    'get_pool',
    {
      title: 'Get an IP pool',
      description: 'Get one IP pool by id, with its utilization. Works with any API key role.',
      inputSchema: z.object({ id: z.string().min(1).describe('The pool id.') }),
      annotations: READ,
    },
    ({ id }) =>
      respond(
        options,
        () => getPool(options, id),
        (pool) =>
          `Pool ${pool.name}: ${pool.cidr} (${pool.family}, ${pool.environment} / ${pool.region}), ` +
          `${plural(pool.utilization.subnetCount, 'top-level subnet')}` +
          (pool.utilization.percentageUsed !== undefined ? `, ${pool.utilization.percentageUsed}% used.` : '.')
      )
  );

  server.registerTool(
    'forecast_pools',
    {
      title: 'Forecast pool exhaustion',
      description:
        'Project when each pool runs out of address space, from the organization\'s own allocation history. ' +
        'runwayDays is null when a projection would be dishonest, and reason says why: not_measurable (IPv6), ' +
        'insufficient_history, or no_burn. Use this to answer "when do we run out". Works with any API key role.',
      annotations: READ,
    },
    () =>
      respond(
        options,
        () => forecastPools(options),
        (body) => {
          const projected = body.data
            .filter((p) => p.runwayDays !== null)
            .sort((a, b) => (a.runwayDays ?? 0) - (b.runwayDays ?? 0));
          const soonest = projected[0];
          return soonest
            ? `Forecast for ${plural(body.data.length, 'pool')}; soonest to run out: ${soonest.poolName} in about ${Math.round(soonest.runwayDays ?? 0)} days.`
            : `Forecast for ${plural(body.data.length, 'pool')}; none has a projected exhaustion date.`;
        }
      )
  );

  server.registerTool(
    'list_subnets',
    {
      title: 'List subnets',
      description:
        "List the organization's subnets, one page at a time, newest first, each with how many addresses are " +
        'registered in it. Filter by environment, region or family. Works with any API key role.',
      inputSchema: z.object({
        environment: z.string().optional().describe('Only subnets in this environment.'),
        region: z.string().optional().describe('Only subnets in this region.'),
        family: family.optional().describe('Only subnets of this address family.'),
        page,
        limit,
      }),
      annotations: READ,
    },
    (args) => respond(options, () => listSubnets(options, args), (body) => pageSummary('subnet', body))
  );

  server.registerTool(
    'get_subnet',
    {
      title: 'Get a subnet',
      description: 'Get one subnet by id, including its pool, parent subnet if nested, and address utilization. Works with any API key role.',
      inputSchema: z.object({ id: z.string().min(1).describe('The subnet id.') }),
      annotations: READ,
    },
    ({ id }) =>
      respond(
        options,
        () => getSubnet(options, id),
        (subnet) =>
          `Subnet ${subnet.name ? `${subnet.name} ` : ''}${subnet.cidr} (${subnet.environment} / ${subnet.region}) ` +
          `${subnet.parentSubnetId ? `under subnet ${subnet.parentSubnetId}` : `in pool ${subnet.ipPoolId}`}, ` +
          `${plural(subnet.utilization.registeredAddresses, 'registered address')}.`
      )
  );

  server.registerTool(
    'list_addresses',
    {
      title: 'List addresses in a subnet',
      description:
        'List the individual IP addresses registered in one subnet, one page at a time, optionally only ACTIVE ' +
        'or only RESERVED ones. Works with any API key role.',
      inputSchema: z.object({
        subnetId: z.string().min(1).describe('The subnet id.'),
        status: z.enum(['ACTIVE', 'RESERVED']).optional().describe('Only addresses with this status.'),
        page,
        limit,
      }),
      annotations: READ,
    },
    ({ subnetId, ...query }) =>
      respond(
        options,
        () => listAddresses(options, subnetId, query),
        (body) => pageSummary('address', body, ` in subnet ${subnetId}`)
      )
  );

  server.registerTool(
    'lookup_ip',
    {
      title: 'Find what owns an IP address',
      description:
        'Given one IP address, return the most specific thing in nxip that contains it: the registered address ' +
        'record, else the subnet it falls in, else the pool. A "not within any registered pool" error means nxip ' +
        'has no record of that space at all, not that the address is unused on the network. Works with any API key role.',
      inputSchema: z.object({ ip: z.string().min(1).describe('An IPv4 or IPv6 address, for example 10.20.4.17.') }),
      annotations: READ,
    },
    ({ ip }) =>
      respond(
        options,
        () => lookupIp(options, ip),
        (body) => {
          const pool = `pool ${body.pool.name} (${body.pool.cidr})`;
          if (body.matchType === 'address' && body.address) {
            return `${body.ip} is registered as ${body.address.status}${body.address.hostname ? ` (${body.address.hostname})` : ''} in subnet ${body.subnet?.cidr}, ${pool}.`;
          }
          if (body.matchType === 'subnet' && body.subnet) {
            return `${body.ip} falls in subnet ${body.subnet.cidr} in ${pool}, but is not registered as an individual address.`;
          }
          return `${body.ip} is inside ${pool}, but not in any allocated subnet.`;
        }
      )
  );

  server.registerTool(
    'search',
    {
      title: 'Search pools, subnets and addresses',
      description:
        'Free-text search across pools, subnets and addresses at once. Matches names, CIDRs, addresses, hostnames, ' +
        'environments, regions and metadata values, which is where scanned cloud identifiers such as a VPC id live. ' +
        'Use this when you have a name or identifier rather than an nxip id. Works with any API key role.',
      inputSchema: z.object({
        q: z.string().min(2).describe('Search text, at least 2 characters.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results per group, 1 to 50. Defaults to 20.'),
      }),
      annotations: READ,
    },
    ({ q, limit: max }) =>
      respond(
        options,
        () => search(options, q, max),
        (body) =>
          `Search "${body.query}" matched ${plural(body.pools.length, 'pool')}, ${plural(body.subnets.length, 'subnet')} ` +
          `and ${plural(body.addresses.length, 'address')}` +
          (body.truncated ? ' (some groups were capped at the limit).' : '.')
      )
  );

  server.registerTool(
    'get_usage',
    {
      title: 'Get organization usage and limits',
      description:
        "Get the organization's tier and its usage against each limit: pools, subnets, IPv4 address space, " +
        'address records and seats. Use this to explain a 402 tier-limit refusal, or before a large allocation. ' +
        'Works with any API key role.',
      annotations: READ,
    },
    () =>
      respond(
        options,
        () => getUsage(options),
        (usage) =>
          `Tier ${usage.tier}: ` +
          [
            metricSummary('pools', usage.metrics.pools),
            metricSummary('subnets', usage.metrics.subnets),
            metricSummary('IPv4 addresses', usage.metrics.ipv4Addresses),
            metricSummary('address records', usage.metrics.addressRecords),
            metricSummary('seats', usage.metrics.seats),
          ].join(', ') +
          '.'
      )
  );

  server.registerTool(
    'preview_subnet',
    {
      title: 'Preview a subnet allocation',
      description:
        'Predict exactly what create_subnet would do with the same arguments, without creating or reserving ' +
        'anything. Returns wouldSucceed: true with the CIDR it would get and the container utilization before ' +
        'and after, or wouldSucceed: false with a named reason (full, overlaps-existing, tier-limit, no-pool, ' +
        'and others) and a message. A wouldSucceed: false is a successful prediction, not an error. The ' +
        'prediction is not a reservation: a concurrent allocation can land first. Works with any API key role.',
      inputSchema: subnetRequest,
      annotations: READ,
    },
    (body) =>
      respond(
        options,
        () => previewSubnet(options, body),
        (result) =>
          result.wouldSucceed
            ? `Would allocate ${result.subnet.cidr} in ${result.container.type} ${result.container.name ?? result.container.id} (${result.container.cidr}). Nothing was created.`
            : `Would not succeed (${result.reason}): ${result.message} Nothing was created.`
      )
  );

  if (readOnly) return server;

  // ---------- Writes ----------
  // Not registered at all under --read-only, rather than registered and
  // refusing: a tool the model cannot see is one it will not try to plan
  // around, and a call to it by name is refused by the SDK as unknown.

  server.registerTool(
    'create_pool',
    {
      title: 'Create an IP pool',
      description:
        'Create a top-level IP pool: the address block every subnet for one environment/region/family is carved ' +
        'from. nxip refuses a pool whose CIDR overlaps any existing pool of the same family (whatever its ' +
        'environment or region), a second pool for the same environment/region/family, and a pool over the ' +
        "tier's limit. Check list_pools first. Requires an API key with the ADMIN or MEMBER role.",
      inputSchema: z
        .object({
          name: z.string().min(1).describe('Human-readable pool name.'),
          cidr: z.string().min(1).describe('The pool block, for example 10.20.0.0/16.'),
          family: family.describe('Address family; must match the CIDR.'),
          environment: z.string().min(1).describe('Environment this pool serves, for example production.'),
          region: z.string().min(1).describe('Region this pool serves, for example eu-west-1.'),
          metadata: metadataSchema.optional(),
        })
        .strict(),
      annotations: CREATE,
    },
    (body) =>
      respond(
        options,
        () => createPool(options, body),
        (pool) => `Created pool ${pool.name} ${pool.cidr} (${pool.environment} / ${pool.region}, id ${pool.id}).`
      )
  );

  server.registerTool(
    'create_subnet',
    {
      title: 'Allocate a subnet',
      description:
        'Allocate a subnet. Give prefixLength and nxip picks the next free block, so never invent a CIDR; give cidr ' +
        'only to register a block that is already in use. Route it with environment and region (nxip finds the ' +
        'matching pool) or nest it with parentSubnetId. nxip refuses overlaps, a full container and tier limits. ' +
        'When unsure whether it will succeed or which CIDR it will get, call preview_subnet first with the same ' +
        'arguments. Each successful call allocates a new block. Requires an API key with the ADMIN or MEMBER role.',
      inputSchema: subnetRequest,
      annotations: CREATE,
    },
    (body) =>
      respond(
        options,
        () => createSubnet(options, body),
        (subnet) =>
          `Allocated ${subnet.cidr}${subnet.name ? ` (${subnet.name})` : ''} ` +
          `${subnet.parentSubnetId ? `under subnet ${subnet.parentSubnetId}` : `in pool ${subnet.ipPoolId}`}, id ${subnet.id}.`
      )
  );

  server.registerTool(
    'allocate_address',
    {
      title: 'Register an IP address',
      description:
        'Record one specific IP address inside an existing subnet as ACTIVE (in use) or RESERVED (held for later). ' +
        'nxip does not pick the address: you supply it, and nxip refuses one outside the subnet, one already ' +
        'registered, or one over the tier\'s address-record limit. Use lookup_ip or list_addresses first to check ' +
        'it is free in nxip. Requires an API key with the ADMIN or MEMBER role.',
      inputSchema: z
        .object({
          subnetId: z.string().min(1).describe('The subnet the address belongs to.'),
          address: z.string().min(1).describe('The IP address, for example 10.20.4.17.'),
          status: z.enum(['ACTIVE', 'RESERVED']).optional().describe('ACTIVE (in use) or RESERVED. Defaults to ACTIVE.'),
          hostname: z.string().min(1).optional().describe('Hostname of the machine using this address.'),
          metadata: metadataSchema.optional(),
        })
        .strict(),
      annotations: CREATE,
    },
    ({ subnetId, ...body }) =>
      respond(
        options,
        () => createAddress(options, subnetId, body),
        (address) =>
          `Registered ${address.address} as ${address.status}${address.hostname ? ` (${address.hostname})` : ''} in subnet ${address.subnetId}, id ${address.id}.`
      )
  );

  return server;
}

/**
 * Runs the server over stdio until the client disconnects.
 *
 * stdout belongs to the protocol from here on: a single stray line on it
 * corrupts the JSON-RPC stream and the client drops the connection. The SDK
 * writes to process.stdout directly, so the console methods that would
 * otherwise print there are pointed at stderr, which is where every
 * diagnostic belongs anyway.
 */
export async function runMcpServer(client: NxipClientOptions, serverOptions: McpServerOptions): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = createMcpServer(client, serverOptions);
  await server.connect(new StdioServerTransport());
  console.error(
    `nxip MCP server running on stdio against ${client.baseUrl}${serverOptions.readOnly ? ' (read-only: write tools not registered)' : ''}.`
  );
}
