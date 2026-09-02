import { overlapKind, parseIpv4Cidr, unionSize, type Ipv4Range, type OverlapKind } from './cidr.js';
import { DEFAULT_SHARED_RANGES, isExpectedlyShared, type SharedRange } from './shared-ranges.js';

// What a discovery source hands back. Deliberately not AWS-shaped: the
// analysis below knows nothing about EC2, so a future Azure or GCP source
// only has to produce this same shape to reuse all of it.
export interface DiscoveredNetwork {
  /** Provider's own id, e.g. vpc-0a1b2c3d. */
  id: string;
  name: string | null;
  region: string;
  cidrs: string[];
  isDefault?: boolean;
}

export interface DiscoveredSubnet {
  id: string;
  name: string | null;
  networkId: string;
  region: string;
  cidr: string;
  availabilityZone?: string | null;
}

export interface Discovery {
  provider: 'aws';
  account: string | null;
  regions: string[];
  networks: DiscoveredNetwork[];
  subnets: DiscoveredSubnet[];
}

export interface OverlapMember {
  networkId: string;
  name: string | null;
  region: string;
  cidr: string;
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
  discovery: Discovery;
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
export function analyseDiscovery(discovery: Discovery, options: AnalyseOptions = {}): ScanReport {
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
      member: { networkId: network.id, name: network.name, region: network.region, cidr: range.cidr },
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

export function formatScanReport(report: ScanReport): string {
  const lines: string[] = [];
  const { totals, discovery } = report;

  lines.push('');
  lines.push(`nxip scan  ${discovery.provider.toUpperCase()}${discovery.account ? ` account ${discovery.account}` : ''}`);
  lines.push(`${discovery.regions.length} region${discovery.regions.length === 1 ? '' : 's'}: ${discovery.regions.join(', ')}`);
  lines.push('');

  if (totals.networks === 0) {
    lines.push('No VPCs found. Nothing to analyse.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Found ${totals.networks} VPC${totals.networks === 1 ? '' : 's'} and ${totals.subnets} subnet${totals.subnets === 1 ? '' : 's'}.`);
  lines.push('');

  for (const summary of report.summaries) {
    const { network } = summary;
    const suffix = network.isDefault ? '  [default VPC]' : '';
    lines.push(`  ${label(network.name, network.id)}  ${network.region}${suffix}`);
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
      `Overlapping address space: ${report.clusters.length} conflict${report.clusters.length === 1 ? '' : 's'} across ${affected} VPCs`
    );
    lines.push('');

    for (const cluster of report.clusters) {
      const cidrs = [...new Set(cluster.members.map((m) => m.cidr))];
      lines.push(
        cluster.identical
          ? `  ${cidrs[0]} claimed by ${cluster.members.length} VPCs`
          : `  ${cidrs.join(' / ')} overlap across ${cluster.members.length} VPCs`
      );
      for (const member of cluster.members) {
        lines.push(`    ${label(member.name, member.networkId).padEnd(34)} ${member.region.padEnd(14)} ${member.cidr}`);
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
export function renderDiscoveryManifest(report: ScanReport): string {
  const lines: string[] = [
    '# Generated by `nxip scan aws --emit-manifest`.',
    '#',
    '# Every subnet below uses the CIDR that is actually deployed, so applying',
    '# this registers your existing estate as-is rather than allocating new',
    '# space. Review it before applying: names come from AWS Name tags and may',
    '# not be what you want nxip to call them.',
    '#',
    '# You need a matching pool in nxip for each environment/region/family',
    '# combination below before `nxip apply` will succeed.',
    '',
    'subnets:',
  ];

  const used = new Set<string>();

  for (const subnet of report.discovery.subnets) {
    if (subnet.cidr.includes(':')) continue;

    const network = report.discovery.networks.find((n) => n.id === subnet.networkId);
    // Names must be unique within a manifest, and AWS Name tags frequently
    // are not - fall back to the subnet id, which always is.
    const base = subnet.name ?? subnet.id;
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}-${suffix++}`;
    used.add(name);

    lines.push(`  - name: ${JSON.stringify(name)}`);
    lines.push(`    family: IPV4`);
    lines.push(`    cidr: ${JSON.stringify(subnet.cidr)}`);
    lines.push(`    environment: production`);
    lines.push(`    region: ${JSON.stringify(subnet.region)}`);
    lines.push(`    metadata:`);
    lines.push(`      source: ${JSON.stringify(`${report.discovery.provider}-scan`)}`);
    lines.push(`      vpc_id: ${JSON.stringify(subnet.networkId)}`);
    if (network?.name) lines.push(`      vpc_name: ${JSON.stringify(network.name)}`);
    if (subnet.availabilityZone) lines.push(`      availability_zone: ${JSON.stringify(subnet.availabilityZone)}`);
    lines.push(`      aws_subnet_id: ${JSON.stringify(subnet.id)}`);
    lines.push('');
  }

  return lines.join('\n');
}
