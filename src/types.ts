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
  | 'leaf-subnet-too-large';

export interface PreviewFailure {
  wouldSucceed: false;
  reason: PreviewFailureReason;
  message: string;
  httpStatusIfAttempted: number;
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
