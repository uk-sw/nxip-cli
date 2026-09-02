import { overlapKind, parseIpv4Cidr, unionSize, type Ipv4Range, type OverlapKind } from './cidr.js';

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

export interface Overlap {
  kind: OverlapKind;
  a: { networkId: string; name: string | null; region: string; cidr: string };
  b: { networkId: string; name: string | null; region: string; cidr: string };
  /** How many addresses the two blocks share. */
  sharedAddresses: number;
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
  overlaps: Overlap[];
  totals: { networks: number; subnets: number; capacity: number; carved: number };
  /** CIDRs the analysis could not read, so the report can admit to gaps. */
  unparseable: string[];
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
export function analyseDiscovery(discovery: Discovery): ScanReport {
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
    rangesOf(network.cidrs, []).map((range) => ({ network, range }))
  );

  const overlaps: Overlap[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const left = blocks[i];
      const right = blocks[j];
      if (left.network.id === right.network.id) continue;

      const kind = overlapKind(left.range, right.range);
      if (!kind) continue;

      const sharedStart = Math.max(left.range.start, right.range.start);
      const sharedEnd = Math.min(left.range.end, right.range.end);

      overlaps.push({
        kind,
        a: { networkId: left.network.id, name: left.network.name, region: left.network.region, cidr: left.range.cidr },
        b: { networkId: right.network.id, name: right.network.name, region: right.network.region, cidr: right.range.cidr },
        sharedAddresses: sharedEnd - sharedStart + 1,
      });
    }
  }

  overlaps.sort((a, b) => b.sharedAddresses - a.sharedAddresses);

  return {
    discovery,
    summaries: summaries.sort((a, b) => b.capacity - a.capacity),
    overlaps,
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

  if (report.overlaps.length > 0) {
    lines.push(`Overlapping address space: ${report.overlaps.length} pair${report.overlaps.length === 1 ? '' : 's'}`);
    lines.push('');
    for (const overlap of report.overlaps) {
      lines.push(`  ${overlap.a.cidr} ${OVERLAP_PHRASING[overlap.kind]} ${overlap.b.cidr}`);
      lines.push(`    ${label(overlap.a.name, overlap.a.networkId)} in ${overlap.a.region}`);
      lines.push(`    ${label(overlap.b.name, overlap.b.networkId)} in ${overlap.b.region}`);
      lines.push(`    ${overlap.sharedAddresses.toLocaleString()} addresses in common`);
      lines.push('');
    }
    lines.push('  These VPCs cannot be peered or routed to each other without renumbering one side.');
    lines.push('');
  } else {
    lines.push('No overlapping VPC address space found.');
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
