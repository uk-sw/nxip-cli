export type AddressFamily = 'IPV4' | 'IPV6';

// The request body POST /v1/pools accepts. A pool is the container a subnet
// routes into by environment/region/family, so nothing can be registered
// until one exists - which is why the manifest can declare them.
export interface NxipPoolBody {
  name: string;
  cidr: string;
  family: AddressFamily;
  environment: string;
  region: string;
  metadata?: Record<string, string>;
}

export interface NxipPool extends NxipPoolBody {
  id: string;
}

// The exact request body POST /v1/subnets and POST /v1/subnets/preview
// accept. v1 scope: top-level subnets only (auto-resolving by
// environment/region/family, or nesting under an already-existing
// subnet by real ID) - a subnet referencing another subnet declared
// later in the same file isn't resolved, see README "Known limitations".
export interface NxipSubnetBody {
  family: AddressFamily;
  prefixLength?: number;
  /**
   * Register this exact block instead of letting nxip pick one. The API
   * takes exactly one of `cidr` or `prefixLength` - see createSubnetSchema.
   * This is what lets a discovered estate be registered as it actually is,
   * rather than a parallel plan being invented alongside it.
   */
  cidr?: string;
  environment?: string;
  region?: string;
  parentSubnetId?: string;
  kind?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
}

// Mirrors apps/api/src/routes/subnets.ts's previewSubnetSchema response
// exactly - see net-saas-monorepo. Kept as one source of truth here so
// this can't silently drift from what the API actually returns.
export type TierLimitMetric = 'subnets' | 'ipv4Addresses';
export type OrgTier = 'FREE' | 'STARTER' | 'TEAM' | 'ENTERPRISE';

export interface PreviewContainer {
  type: 'pool' | 'subnet';
  id: string;
  name: string | null;
  cidr: string;
}

export interface ContainerUtilization {
  subnetCount: number;
  usedAddresses?: number;
  capacity?: number;
  percentageUsed?: number;
}

export interface PreviewSuccess {
  wouldSucceed: true;
  subnet: {
    cidr: string;
    prefixLength: number;
    family: AddressFamily;
    environment: string;
    region: string;
    ipPoolId: string;
    parentSubnetId: string | null;
    kind: string | null;
    name: string | null;
    description: string | null;
    metadata: Record<string, string>;
  };
  container: PreviewContainer;
  utilization: { before: ContainerUtilization; after: ContainerUtilization };
}

export type PreviewFailureReason =
  | 'no-pool'
  | 'parent-not-found'
  | 'parent-family-mismatch'
  | 'kind-conflict'
  | 'full'
  | 'invalid-cidr'
  | 'outside-pool'
  | 'overlaps-existing'
  | 'tier-limit'
  | 'leaf-subnet-too-large'
  | 'already-exists'
  | 'ambiguous-parent';

export interface PreviewFailure {
  wouldSucceed: false;
  reason: PreviewFailureReason;
  message: string;
  httpStatusIfAttempted: number;
  /**
   * Present only for already-exists. Carries the existing subnet's id because
   * a child declared in the same manifest has to nest under it, even though it
   * was not created in this run.
   */
  existing?: { id: string; cidr: string; name: string | null };
  tierLimit?: {
    metric: TierLimitMetric;
    tier: OrgTier;
    current: number;
    limit: number;
  };
}

export type PreviewResult = PreviewSuccess | PreviewFailure;

// One manifest entry, plus its computed preview outcome.
export interface PlannedSubnet {
  name: string;
  body: NxipSubnetBody;
  result: PreviewResult;
}

// Response shapes for the read endpoints the MCP server exposes. Each mirrors
// its route's Zod response schema in net-saas-monorepo/apps/api/src/routes,
// named in the comment above it, field for field. The MCP tools pass these
// bodies through untouched; the types exist so the one-line summaries read
// real fields rather than guessed ones.

// meta block shared by every paginated list route (pools, subnets, addresses).
export interface ApiPage<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// pools.ts poolWithUtilizationSchema.
export interface NxipPoolDetail {
  id: string;
  organizationId: string;
  name: string;
  cidr: string;
  family: AddressFamily;
  environment: string;
  region: string;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  utilization: ContainerUtilization;
}

// pools.ts getPoolForecastSchema.
export interface NxipPoolForecast {
  data: {
    poolId: string;
    poolName: string;
    runwayDays: number | null;
    exhaustsOn: string | null;
    burnPerDay: number | null;
    allocations: number;
    observedDays: number;
    freeAddresses: number | null;
    reason: 'not_measurable' | 'insufficient_history' | 'no_burn' | null;
  }[];
  meta: { windowDays: number; minAllocations: number; minSpanDays: number };
}

// subnets.ts createSubnetSchema 201 response.
export interface NxipCreatedSubnet {
  id: string;
  cidr: string;
  prefixLength: number;
  family: AddressFamily;
  environment: string;
  region: string;
  ipPoolId: string;
  parentSubnetId: string | null;
  kind: string | null;
  name: string | null;
  description: string | null;
  metadata: Record<string, string>;
  createdAt: string;
}

// subnets.ts getSubnetByIdSchema, and each item of getSubnetsSchema.
export interface NxipSubnet extends NxipCreatedSubnet {
  updatedAt?: string;
  utilization: { registeredAddresses: number; capacity?: number; percentageUsed?: number };
}

export type AddressStatus = 'ACTIVE' | 'RESERVED';

// addresses.ts createAddressSchema body.
export interface NxipAddressBody {
  address: string;
  status?: AddressStatus;
  hostname?: string;
  metadata?: Record<string, string>;
}

// addresses.ts addressResponse.
export interface NxipAddress {
  id: string;
  subnetId: string;
  address: string;
  family: AddressFamily;
  status: AddressStatus;
  hostname: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// lookup.ts lookupSchema 200 response.
export interface NxipLookupResult {
  ip: string;
  family: AddressFamily;
  matchType: 'address' | 'subnet' | 'pool';
  address?: { id: string; address: string; status: AddressStatus; hostname: string | null; subnetId: string };
  subnet?: { id: string; cidr: string; prefixLength: number; environment: string; region: string; ipPoolId: string };
  pool: { id: string; name: string; cidr: string; environment: string; region: string };
}

// search.ts searchSchema 200 response.
export interface NxipSearchResult {
  query: string;
  pools: { id: string; name: string; cidr: string; environment: string; region: string }[];
  subnets: { id: string; name: string | null; cidr: string; environment: string; region: string; ipPoolId: string }[];
  addresses: { id: string; address: string; hostname: string | null; status: AddressStatus; subnetId: string }[];
  truncated: boolean;
}

// organizations.ts metricUsageSchema and getUsageSchema.
export interface NxipMetricUsage {
  current: number;
  limit: number | null;
  percentageUsed: number;
  isUnlimited: boolean;
  isOverLimit: boolean;
}

export interface NxipUsage {
  organizationId: string;
  tier: OrgTier;
  rateLimitRpm: number;
  metrics: {
    pools: NxipMetricUsage;
    subnets: NxipMetricUsage;
    ipv4Addresses: NxipMetricUsage;
    addressRecords: NxipMetricUsage;
    seats: NxipMetricUsage;
  };
}
