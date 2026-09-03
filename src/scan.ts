import { overlapKind, parseIpv4Cidr, unionSize, type Ipv4Range, type OverlapKind } from './cidr.js';
import { DEFAULT_SHARED_RANGES, isExpectedlyShared, type SharedRange } from './shared-ranges.js';

// What a discovery source hands back. Deliberately not AWS-shaped: the
// analysis below knows nothing about EC2, so a future Azure or GCP source
// only has to produce this same shape to reuse all of it.
export type CloudProvider = 'aws' | 'azure';

export interface DiscoveredNetwork {
  /** Provider's own id, e.g. vpc-0a1b2c3d, or resourceGroup/vnet-name. */
  id: string;
  name: string | null;
  region: string;
  cidrs: string[];
  isDefault?: boolean;
  /** Account or subscription this came from. */
  account?: string | null;
  /**
   * Set during merge, not by the source modules. Carried per-network rather
   * than only on the Discovery so a cross-cloud finding can say which side
   * of it is AWS and which is Azure - the entire point of scanning both at
   * once.
   */
  provider?: CloudProvider;
}

export interface DiscoveredSubnet {
  id: string;
  name: string | null;
  networkId: string;
  region: string;
  cidr: string;
  availabilityZone?: string | null;
  account?: string | null;
  provider?: CloudProvider;
}

/** One provider/account pair that contributed to a scan. */
export interface DiscoverySource {
  provider: CloudProvider;
  account: string | null;
  regions: string[];
}

export interface Discovery {
  provider: CloudProvider;
  account: string | null;
  regions: string[];
  networks: DiscoveredNetwork[];
  subnets: DiscoveredSubnet[];
}

/**
 * Several providers analysed as one estate. This is where cross-cloud
 * findings come from: no cloud's own IPAM can see another's, so an AWS VPC
 * and an Azure VNet both claiming 10.0.0.0/16 is invisible to both vendors
 * and visible here.
 */
export interface MergedDiscovery {
  sources: DiscoverySource[];
  networks: DiscoveredNetwork[];
  subnets: DiscoveredSubnet[];
}

export function mergeDiscoveries(discoveries: Discovery[]): MergedDiscovery {
  return {
    sources: discoveries.map((d) => ({ provider: d.provider, account: d.account, regions: d.regions })),
    // Stamping the provider here rather than in each source module keeps the
    // scanners ignorant of whether they are running alone or alongside another.
    networks: discoveries.flatMap((d) => d.networks.map((n) => ({ ...n, provider: n.provider ?? d.provider }))),
    subnets: discoveries.flatMap((d) => d.subnets.map((s) => ({ ...s, provider: s.provider ?? d.provider }))),
  };
}

export interface OverlapMember {
  networkId: string;
  name: string | null;
  region: string;
  cidr: string;
  provider?: CloudProvider;
}

export interface Overlap {
  kind: OverlapKind;
  a: OverlapMember;
  b: OverlapMember;
  /** How many addresses the two blocks share. */
  sharedAddresses: number;
}

/**
 * A set of blocks that all transitively overlap each other, reported as one
 * finding instead of every pair.
 *
 * Pairwise output does not survive contact with a real estate: twenty VPCs
 * sharing a block is 190 pairs saying the same thing once each. A cluster
 * says it once, and grows linearly rather than quadratically.
 */
export interface OverlapCluster {
  members: OverlapMember[];
  /** Every member claims exactly the same block. The usual case, and the worst. */
  identical: boolean;
  /** Largest number of addresses any two members share. */
  sharedAddresses: number;
  /** Distinct relationships present, for a cluster that is not identical. */
  kinds: OverlapKind[];
}

export interface SuppressedOverlaps {
  /** How many pairs were hidden because they fall in an expected-shared range. */
  pairs: number;
  /** Which ranges did the hiding, so the report can name them. */
  ranges: SharedRange[];
}

export interface NetworkSummary {
  network: DiscoveredNetwork;
  subnetCount: number;
  /** Addresses covered by the VPC's own blocks. */
  capacity: number;
  /** Addresses covered by its subnets, overlaps counted once. */
  carved: number;
  /** capacity - carved. */
  unused: number;
  percentageCarved: number;
}

export interface ScanReport {
  discovery: MergedDiscovery;
  summaries: NetworkSummary[];
  /** Reported findings, grouped. Empty when nothing genuinely collides. */
  clusters: OverlapCluster[];
  /** The underlying pairs behind `clusters`, for anything that wants them. */
  overlaps: Overlap[];
  suppressed: SuppressedOverlaps;
  totals: { networks: number; subnets: number; capacity: number; carved: number };
  /** CIDRs the analysis could not read, so the report can admit to gaps. */
  unparseable: string[];
}

export interface AnalyseOptions {
  /** Ranges where overlap is expected. Defaults to DEFAULT_SHARED_RANGES. */
  sharedRanges?: SharedRange[];
}

/**
 * Groups overlapping blocks into connected components: if A overlaps B and B
 * overlaps C, all three are one finding even when A and C do not touch.
 */
function clusterOverlaps(blocks: { key: string; member: OverlapMember; range: Ipv4Range }[], pairs: Overlap[]): OverlapCluster[] {
  const adjacency = new Map<string, Set<string>>();
  for (const block of blocks) adjacency.set(block.key, new Set());

  const pairShare = new Map<string, number>();
  for (const pair of pairs) {
    const a = `${pair.a.networkId}|${pair.a.cidr}`;
    const b = `${pair.b.networkId}|${pair.b.cidr}`;
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
    pairShare.set(`${a}::${b}`, pair.sharedAddresses);
  }

  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const seen = new Set<string>();
  const clusters: OverlapCluster[] = [];

  for (const block of blocks) {
    if (seen.has(block.key) || adjacency.get(block.key)!.size === 0) continue;

    // Breadth-first over the overlap graph, collecting one component.
    const component: string[] = [];
    const queue = [block.key];
    seen.add(block.key);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    const members = component.map((key) => byKey.get(key)!.member);
    const cidrs = new Set(members.map((m) => m.cidr));

    const relevant = pairs.filter(
      (p) => component.includes(`${p.a.networkId}|${p.a.cidr}`) && component.includes(`${p.b.networkId}|${p.b.cidr}`)
    );

    clusters.push({
      members: members.sort((a, b) => a.networkId.localeCompare(b.networkId)),
      identical: cidrs.size === 1,
      sharedAddresses: Math.max(...relevant.map((p) => p.sharedAddresses)),
      kinds: [...new Set(relevant.map((p) => p.kind))],
    });
  }

  return clusters.sort((a, b) => b.members.length - a.members.length || b.sharedAddresses - a.sharedAddresses);
}

function rangesOf(cidrs: string[], unparseable: string[]): Ipv4Range[] {
  const ranges: Ipv4Range[] = [];
  for (const cidr of cidrs) {
    // IPv6 blocks are skipped rather than mis-parsed. AWS allocates v6 from
    // its own globally unique space, so overlap between accounts is not the
    // problem there that it is for RFC1918 v4.
    if (cidr.includes(':')) continue;
    const range = parseIpv4Cidr(cidr);
    if (range) ranges.push(range);
    else unparseable.push(cidr);
  }
  return ranges;
}

/**
 * Turns raw discovery into the things worth telling someone: what they have,
 * which blocks collide, and how much space is sitting unused.
 */
export function analyseDiscovery(
  input: Discovery | Discovery[] | MergedDiscovery,
  options: AnalyseOptions = {}
): ScanReport {
  const discovery: MergedDiscovery = Array.isArray(input)
    ? mergeDiscoveries(input)
    : 'sources' in input
      ? input
      : mergeDiscoveries([input]);
  const sharedRanges = options.sharedRanges ?? DEFAULT_SHARED_RANGES;
  const unparseable: string[] = [];

  const summaries: NetworkSummary[] = discovery.networks.map((network) => {
    const capacityRanges = rangesOf(network.cidrs, unparseable);
    const subnets = discovery.subnets.filter((s) => s.networkId === network.id);
    const carvedRanges = rangesOf(
      subnets.map((s) => s.cidr),
      unparseable
    );

    const capacity = unionSize(capacityRanges);
    const carved = unionSize(carvedRanges);

    return {
      network,
      subnetCount: subnets.length,
      capacity,
      carved,
      unused: Math.max(0, capacity - carved),
      percentageCarved: capacity === 0 ? 0 : Math.round((carved / capacity) * 100),
    };
  });

  // Every VPC block against every other, across regions and accounts. This
  // is the finding that matters: two VPCs sharing address space cannot be
  // peered or routed together without renumbering one of them, and nobody
  // discovers that until the day they try.
  const blocks = discovery.networks.flatMap((network) =>
    rangesOf(network.cidrs, []).map((range) => ({
      key: `${network.id}|${range.cidr}`,
      member: { networkId: network.id, name: network.name, region: network.region, cidr: range.cidr, provider: network.provider },
      range,
      networkId: network.id,
    }))
  );

  const overlaps: Overlap[] = [];
  let suppressedPairs = 0;
  const suppressedBy = new Map<string, SharedRange>();

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const left = blocks[i];
      const right = blocks[j];
      if (left.networkId === right.networkId) continue;

      const kind = overlapKind(left.range, right.range);
      if (!kind) continue;

      const sharedStart = Math.max(left.range.start, right.range.start);
      const sharedEnd = Math.min(left.range.end, right.range.end);

      // Overlap inside a range that is meant to be shared is a design
      // decision, not a finding. Counted so the report can say how many it
      // set aside, rather than silently deciding on the reader's behalf.
      const shared = isExpectedlyShared(sharedStart, sharedEnd, sharedRanges);
      if (shared) {
        suppressedPairs += 1;
        suppressedBy.set(shared.cidr, shared);
        continue;
      }

      overlaps.push({
        kind,
        a: left.member,
        b: right.member,
        sharedAddresses: sharedEnd - sharedStart + 1,
      });
    }
  }

  overlaps.sort((a, b) => b.sharedAddresses - a.sharedAddresses);

  return {
    discovery,
    summaries: summaries.sort((a, b) => b.capacity - a.capacity),
    clusters: clusterOverlaps(blocks, overlaps),
    overlaps,
    suppressed: { pairs: suppressedPairs, ranges: [...suppressedBy.values()] },
    totals: {
      networks: discovery.networks.length,
      subnets: discovery.subnets.length,
      capacity: summaries.reduce((sum, s) => sum + s.capacity, 0),
      carved: summaries.reduce((sum, s) => sum + s.carved, 0),
    },
    unparseable: [...new Set(unparseable)],
  };
}

const OVERLAP_PHRASING: Record<OverlapKind, string> = {
  identical: 'identical block',
  contains: 'contains',
  'contained-by': 'sits inside',
  partial: 'partially overlaps',
};

function label(name: string | null, id: string): string {
  return name ? `${name} (${id})` : id;
}

/** AWS calls them VPCs, Azure calls them VNets. Say whichever fits. */
function networkNoun(report: ScanReport, plural = false): string {
  const providers = new Set(report.discovery.sources.map((s) => s.provider));
  if (providers.size === 1 && providers.has('aws')) return plural ? 'VPCs' : 'VPC';
  if (providers.size === 1 && providers.has('azure')) return plural ? 'VNets' : 'VNet';
  return plural ? 'networks' : 'network';
}

export function formatScanReport(report: ScanReport): string {
  const lines: string[] = [];
  const { totals, discovery } = report;

  const allRegions = [...new Set(discovery.sources.flatMap((s) => s.regions))];

  // A reader cannot tell a pseudonym from a real name, so the report says
  // which it is rather than leaving them to guess.
  const redacted = discovery.networks.some((n) => n.id.startsWith('network-') && n.name === null);

  lines.push('');
  lines.push(
    `nxip scan  ${discovery.sources.map((s) => s.provider.toUpperCase()).join(' + ') || 'no sources'}` +
      (redacted ? '   [redacted]' : '')
  );
  for (const source of discovery.sources) {
    lines.push(
      `  ${source.provider.padEnd(6)} ${source.account ?? 'unknown account'}  ` +
        `${source.regions.length} region${source.regions.length === 1 ? '' : 's'}: ${source.regions.join(', ')}`
    );
  }
  if (redacted) {
    lines.push('  Identifiers replaced with stable pseudonyms. Address space, regions');
    lines.push('  and every finding are unchanged.');
  }
  lines.push('');

  if (totals.networks === 0) {
    lines.push(`No ${networkNoun(report, true)} found. Nothing to analyse.`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Found ${totals.networks} ${networkNoun(report, totals.networks !== 1)} and ${totals.subnets} subnet${totals.subnets === 1 ? '' : 's'}.`);
  lines.push('');

  for (const summary of report.summaries) {
    const { network } = summary;
    const suffix = network.isDefault ? '  [default]' : '';
    const cloud = discovery.sources.length > 1 && network.provider ? `${network.provider}  ` : '';
    lines.push(`  ${cloud}${label(network.name, network.id)}  ${network.region}${suffix}`);
    lines.push(`    ${network.cidrs.join(', ')}`);
    lines.push(
      `    ${summary.subnetCount} subnet${summary.subnetCount === 1 ? '' : 's'}, ` +
        `${summary.percentageCarved}% carved, ${summary.unused.toLocaleString()} addresses unused`
    );
    lines.push('');
  }

  if (report.clusters.length > 0) {
    const affected = new Set(report.clusters.flatMap((c) => c.members.map((m) => m.networkId))).size;
    lines.push(
      `Overlapping address space: ${report.clusters.length} conflict${report.clusters.length === 1 ? '' : 's'} across ${affected} ${networkNoun(report, affected !== 1)}`
    );
    lines.push('');

    for (const cluster of report.clusters) {
      const cidrs = [...new Set(cluster.members.map((m) => m.cidr))];
      lines.push(
        cluster.identical
          ? `  ${cidrs[0]} claimed by ${cluster.members.length} ${networkNoun(report, true)}`
          : `  ${cidrs.join(' / ')} overlap across ${cluster.members.length} ${networkNoun(report, true)}`
      );
      for (const member of cluster.members) {
        const cloud = member.provider ? `${member.provider.padEnd(6)} ` : '';
        lines.push(`    ${cloud}${label(member.name, member.networkId).padEnd(34)} ${member.region.padEnd(14)} ${member.cidr}`);
      }
      lines.push(`    ${cluster.sharedAddresses.toLocaleString()} addresses in common at most`);
      lines.push('');
    }
    lines.push('  These cannot be peered or routed to each other without renumbering one side.');
    lines.push('');
  } else {
    lines.push('No overlapping VPC address space found.');
    lines.push('');
  }

  // Said out loud rather than silently applied. Someone whose architecture
  // deliberately reuses a range needs to know it was recognized, and someone
  // who thinks it should not be shared needs to know how to see it.
  if (report.suppressed.pairs > 0) {
    lines.push(
      `Ignored ${report.suppressed.pairs.toLocaleString()} overlap${report.suppressed.pairs === 1 ? '' : 's'} in ranges that are expected to be shared:`
    );
    for (const range of report.suppressed.ranges) {
      lines.push(`  ${range.cidr.padEnd(18)} ${range.why}`);
    }
    lines.push('  Pass --include-shared to see them, or --exclude to add your own ranges.');
    lines.push('');
  }

  const wastedPercent = totals.capacity === 0 ? 0 : Math.round(((totals.capacity - totals.carved) / totals.capacity) * 100);
  lines.push(
    `Across everything: ${totals.capacity.toLocaleString()} addresses reserved, ` +
      `${totals.carved.toLocaleString()} carved into subnets, ${wastedPercent}% never allocated.`
  );

  if (report.unparseable.length > 0) {
    lines.push('');
    lines.push(`Skipped ${report.unparseable.length} block${report.unparseable.length === 1 ? '' : 's'} this version could not read: ${report.unparseable.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Renders what was found as an nxip manifest, using the real CIDRs rather
 * than asking nxip to allocate new ones - the point is to register what
 * already exists, not to invent a parallel address plan.
 */
/** One pool the scan proposes, plus the subnets that route into it. */
interface ProposedPool {
  name: string;
  cidr: string;
  environment: string;
  region: string;
  networkId: string;
  provider?: CloudProvider;
  account?: string | null;
  range: Ipv4Range;
  /** True when the environment had to be derived rather than defaulted. */
  derivedEnvironment: boolean;
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unnamed';
}

/**
 * Works out the pools a discovered estate needs.
 *
 * The whole difficulty is one constraint: nxip allows a single pool per
 * (environment, region, family). A real account routinely has several
 * networks in one region, so they cannot all take the real region name with
 * the same environment - the second one would collide on apply.
 *
 * So where a region holds exactly one network block, environment defaults to
 * "production" and the operator is told to change it if that is wrong. Where
 * it holds several, environment is derived from each network's own name,
 * which keeps them distinct and applies cleanly. Either way the result is a
 * proposal to review, not a claim about what the estate means - a scan
 * cannot know which VPC is staging.
 */
export function proposePools(report: ScanReport): ProposedPool[] {
  const proposals: ProposedPool[] = [];

  for (const network of report.discovery.networks) {
    for (const cidr of network.cidrs) {
      if (cidr.includes(':')) continue;
      const range = parseIpv4Cidr(cidr);
      if (!range) continue;
      proposals.push({
        name: network.name ?? network.id,
        cidr: range.cidr,
        environment: 'production',
        region: network.region,
        networkId: network.id,
        provider: network.provider,
        account: network.account,
        range,
        derivedEnvironment: false,
      });
    }
  }

  // Anything sharing a (region, family) key needs distinguishing, since
  // IPv4 is the only family emitted here.
  const byRegion = new Map<string, ProposedPool[]>();
  for (const pool of proposals) {
    const list = byRegion.get(pool.region) ?? [];
    list.push(pool);
    byRegion.set(pool.region, list);
  }

  for (const group of byRegion.values()) {
    if (group.length === 1) continue;

    const used = new Set<string>();
    for (const pool of group) {
      let candidate = sanitize(pool.name);
      // A network with several blocks would still collide with itself, and
      // two networks can share a Name tag, so uniqueness is enforced rather
      // than assumed.
      let suffix = 2;
      while (used.has(candidate)) candidate = `${sanitize(pool.name)}-${suffix++}`;
      used.add(candidate);
      pool.environment = candidate;
      pool.derivedEnvironment = true;
    }
  }

  // Names must be unique across the whole manifest, and two sources of
  // collision are routine: a network with several CIDR blocks produces one
  // pool per block all carrying the network's name, and two networks can
  // simply share a Name tag. Qualify with the CIDR, which is unique by
  // definition, rather than an opaque index.
  const usedNames = new Set<string>();
  for (const pool of proposals) {
    if (!usedNames.has(pool.name)) {
      usedNames.add(pool.name);
      continue;
    }
    let candidate = `${pool.name} ${pool.cidr}`;
    let suffix = 2;
    while (usedNames.has(candidate)) candidate = `${pool.name} ${pool.cidr} (${suffix++})`;
    pool.name = candidate;
    usedNames.add(candidate);
  }

  // Longest prefix first, so a subnet inside a nested block is attributed to
  // the most specific pool that contains it rather than an outer one.
  return proposals.sort((a, b) => b.range.prefixLength - a.range.prefixLength);
}

/**
 * Renders what was found as an nxip manifest: the pools it needs, then the
 * subnets that route into them, using the CIDRs that are actually deployed
 * rather than asking nxip to allocate new ones. The point is to register
 * what already exists, not to invent a parallel address plan.
 *
 * Each subnet takes the environment of the pool that actually contains it,
 * so the file applies as one unit instead of needing the two halves
 * reconciled by hand.
 */
export function renderDiscoveryManifest(report: ScanReport): string {
  const pools = proposePools(report);
  const derived = pools.some((p) => p.derivedEnvironment);

  const lines: string[] = [
    '# Generated by `nxip scan --emit-manifest`.',
    '#',
    '# Review before applying. Two things a scan cannot know:',
    '#',
    "#   environment  A scan cannot tell which network is staging, so it is a",
    '#                guess. Change it to match how you actually label things.',
    '#   name         Taken from cloud Name tags, which are often duplicated',
    '#                and not always what you want nxip to call the resource.',
    '#',
  ];

  if (derived) {
    lines.push(
      '# Some environments were derived from network names rather than',
      '# defaulted to "production". nxip allows one pool per',
      '# environment/region/family, and those regions hold more than one',
      '# network, so they need distinguishing to apply at all.',
      '#'
    );
  }

  lines.push(
    '# Apply with:  nxip plan -f <this file>   then   nxip apply -f <this file>',
    '# Pools are created before subnets, so this loads in one step.',
    '',
    'pools:'
  );

  for (const pool of pools) {
    lines.push(`  - name: ${JSON.stringify(pool.name)}`);
    lines.push(`    cidr: ${JSON.stringify(pool.cidr)}`);
    lines.push(`    family: IPV4`);
    lines.push(`    environment: ${JSON.stringify(pool.environment)}`);
    lines.push(`    region: ${JSON.stringify(pool.region)}`);
    lines.push(`    metadata:`);
    lines.push(`      source: ${JSON.stringify(`${pool.provider ?? 'cloud'}-scan`)}`);
    lines.push(`      network_id: ${JSON.stringify(pool.networkId)}`);
    if (pool.account) lines.push(`      account: ${JSON.stringify(pool.account)}`);
    lines.push('');
  }

  const subnetLines: string[] = [];
  const used = new Set<string>();
  const orphans: string[] = [];

  for (const subnet of report.discovery.subnets) {
    if (subnet.cidr.includes(':')) continue;
    const range = parseIpv4Cidr(subnet.cidr);
    if (!range) continue;

    // The subnet must land in a pool from its own network, and that pool
    // decides its environment. Without this the two halves of the file
    // would disagree and every subnet would fail to route.
    const pool = pools.find(
      (p) => p.networkId === subnet.networkId && range.start >= p.range.start && range.end <= p.range.end
    );
    if (!pool) {
      orphans.push(`${subnet.cidr} in ${subnet.networkId}`);
      continue;
    }

    const base = subnet.name ?? subnet.id;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}-${suffix++}`;
    used.add(name);

    subnetLines.push(`  - name: ${JSON.stringify(name)}`);
    subnetLines.push(`    family: IPV4`);
    subnetLines.push(`    cidr: ${JSON.stringify(subnet.cidr)}`);
    subnetLines.push(`    environment: ${JSON.stringify(pool.environment)}`);
    subnetLines.push(`    region: ${JSON.stringify(subnet.region)}`);
    subnetLines.push(`    metadata:`);
    subnetLines.push(`      source: ${JSON.stringify(`${subnet.provider ?? 'cloud'}-scan`)}`);
    subnetLines.push(`      network_id: ${JSON.stringify(subnet.networkId)}`);
    if (subnet.account) subnetLines.push(`      account: ${JSON.stringify(subnet.account)}`);
    if (subnet.availabilityZone) subnetLines.push(`      availability_zone: ${JSON.stringify(subnet.availabilityZone)}`);
    subnetLines.push(`      source_subnet_id: ${JSON.stringify(subnet.id)}`);
    subnetLines.push('');
  }

  // A bare `subnets:` with nothing under it parses as null, not an empty
  // list, so the key is omitted entirely when there is nothing to put in it.
  if (subnetLines.length > 0) {
    lines.push('subnets:');
    lines.push(...subnetLines);
  }

  if (orphans.length > 0) {
    lines.push('# Left out: these subnets fall outside every block their own network');
    lines.push('# declares, which usually means the network has a CIDR association');
    lines.push('# this scan could not read. Worth checking directly.');
    for (const orphan of orphans) lines.push(`#   ${orphan}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Replaces identifying fields with stable pseudonyms, so a report can be
 * shared without handing over an inventory of the estate that produced it.
 *
 * This is a structural transform over the discovery data, deliberately not a
 * regex pass over the rendered text. Scrubbing output after the fact means
 * guessing what an identifier looks like: a twelve-digit number might be an
 * account id or an address count, and a network named after a customer is
 * invisible to any pattern. Here the fields are known because this codebase
 * defines them, so nothing is guessed and nothing is missed.
 *
 * Pseudonyms are stable within a run rather than blanked. Replacing every id
 * with "REDACTED" would destroy the only thing worth sharing: a conflict is
 * the statement that *these two* networks collide, and that is unreadable if
 * both are called the same thing.
 *
 * What is kept, and why: CIDRs, regions and families all survive, because
 * without them there is no finding left to show. Private address space is
 * also weakly identifying at best - a great many organizations use
 * 10.0.0.0/16 - whereas an account id identifies exactly one. If an estate
 * carries publicly routable ranges in its networks, that reasoning does not
 * hold, and the report is worth reading before sharing regardless.
 */
export function redactDiscovery(discovery: MergedDiscovery): MergedDiscovery {
  const accounts = new Map<string, string>();
  const networks = new Map<string, string>();
  const subnets = new Map<string, string>();

  // Counted per prefix, not per map: sharing one counter across providers
  // produces "azure-account-2" for the only Azure account in the report,
  // which reads like a missing account-1.
  const counters = new Map<string, number>();
  const pseudonym = (map: Map<string, string>, key: string, prefix: string): string => {
    const existing = map.get(key);
    if (existing) return existing;
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    const label = `${prefix}-${next}`;
    map.set(key, label);
    return label;
  };

  const accountFor = (provider: CloudProvider | undefined, account: string | null | undefined): string | null => {
    if (!account) return null;
    return pseudonym(accounts, account, `${provider ?? 'cloud'}-account`);
  };

  return {
    sources: discovery.sources.map((source) => ({
      provider: source.provider,
      account: accountFor(source.provider, source.account),
      regions: source.regions,
    })),
    networks: discovery.networks.map((network) => ({
      ...network,
      id: pseudonym(networks, network.id, 'network'),
      // Dropped rather than pseudonymised: the id already carries a stable
      // label, and a second one adds nothing but noise.
      name: null,
      account: accountFor(network.provider, network.account),
    })),
    subnets: discovery.subnets.map((subnet) => ({
      ...subnet,
      id: pseudonym(subnets, subnet.id, 'subnet'),
      name: null,
      // Must use the same map as the networks above, or a subnet would point
      // at a network id that appears nowhere in the report.
      networkId: pseudonym(networks, subnet.networkId, 'network'),
      account: accountFor(subnet.provider, subnet.account),
    })),
  };
}
