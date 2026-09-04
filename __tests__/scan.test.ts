import { describe, it, expect } from 'vitest';
import { analyseDiscovery, formatScanReport, renderDiscoveryManifest, proposePools, type Discovery } from '../src/scan.js';
import { parseSharedRanges, SharedRangeError, DEFAULT_SHARED_RANGES } from '../src/shared-ranges.js';
import { parseManifest, parseFullManifest } from '../src/manifest.js';

function discovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    provider: 'aws',
    account: '123456789012',
    regions: ['eu-west-2'],
    networks: [],
    subnets: [],
    ...overrides,
  };
}

describe('analyseDiscovery', () => {
  it('summarizes a VPC and how much of it is carved', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
        subnets: [
          { id: 'subnet-a', name: 'a', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' },
          { id: 'subnet-b', name: 'b', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.2.0/24' },
        ],
      })
    );

    const summary = report.summaries[0];
    expect(summary.capacity).toBe(65536);
    expect(summary.carved).toBe(512);
    expect(summary.unused).toBe(65024);
    expect(summary.percentageCarved).toBe(1);
    expect(summary.subnetCount).toBe(2);
  });

  it('finds an identical-CIDR collision between two VPCs', () => {
    const report = analyseDiscovery(
      discovery({
        regions: ['eu-west-2', 'us-east-1'],
        networks: [
          { id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-2', name: 'staging', region: 'us-east-1', cidrs: ['10.0.0.0/16'] },
        ],
      })
    );

    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0].kind).toBe('identical');
    expect(report.overlaps[0].sharedAddresses).toBe(65536);
  });

  it('finds a containment overlap and reports the shared size', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-1', name: 'big', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-2', name: 'small', region: 'eu-west-2', cidrs: ['10.0.5.0/24'] },
        ],
      })
    );

    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0].kind).toBe('contains');
    expect(report.overlaps[0].sharedAddresses).toBe(256);
  });

  it('never reports a VPC as overlapping itself across its own secondary blocks', () => {
    // A VPC with several associated CIDRs is normal and is not a collision.
    const report = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: 'multi', region: 'eu-west-2', cidrs: ['10.0.0.0/16', '10.1.0.0/16'] }],
      })
    );
    expect(report.overlaps).toEqual([]);
  });

  it('does not flag adjacent blocks', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-1', name: 'a', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-2', name: 'b', region: 'eu-west-2', cidrs: ['10.1.0.0/16'] },
        ],
      })
    );
    expect(report.overlaps).toEqual([]);
  });

  it('sorts overlaps by how much space they share', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-1', name: 'a', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-2', name: 'b', region: 'eu-west-2', cidrs: ['10.0.0.0/24'] },
          { id: 'vpc-3', name: 'c', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
        ],
      })
    );
    expect(report.overlaps[0].sharedAddresses).toBe(65536);
    expect(report.overlaps.at(-1)!.sharedAddresses).toBe(256);
  });

  it('skips IPv6 blocks rather than mis-parsing them', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: 'v6', region: 'eu-west-2', cidrs: ['10.0.0.0/16', '2600:1f18::/56'] }],
      })
    );
    expect(report.summaries[0].capacity).toBe(65536);
    // Skipped deliberately, so it must not show up as something unreadable.
    expect(report.unparseable).toEqual([]);
  });

  it('records genuinely unreadable blocks so the report can admit the gap', () => {
    const report = analyseDiscovery(
      discovery({ networks: [{ id: 'vpc-1', name: 'odd', region: 'eu-west-2', cidrs: ['not-a-cidr'] }] })
    );
    expect(report.unparseable).toEqual(['not-a-cidr']);
    expect(report.summaries[0].capacity).toBe(0);
  });

  it('does not divide by zero for a VPC with no readable capacity', () => {
    const report = analyseDiscovery(
      discovery({ networks: [{ id: 'vpc-1', name: 'empty', region: 'eu-west-2', cidrs: [] }] })
    );
    expect(report.summaries[0].percentageCarved).toBe(0);
  });
});

describe('renderDiscoveryManifest and shared ranges', () => {
  const fleet = () => ({
    provider: 'aws' as const,
    account: '123456789012',
    regions: ['eu-west-2'],
    networks: [
      { id: 'vpc-prod', name: 'prod', region: 'eu-west-2', cidrs: ['10.20.0.0/16'] },
      { id: 'vpc-eks', name: 'eks-pods', region: 'eu-west-2', cidrs: ['100.64.0.0/16'] },
    ],
    subnets: [],
  });

  const render = (includeShared: boolean) =>
    renderDiscoveryManifest(
      analyseDiscovery(discovery(fleet()), { sharedRanges: includeShared ? [] : DEFAULT_SHARED_RANGES }),
      { sharedRanges: DEFAULT_SHARED_RANGES, includeShared }
    );

  it('holds shared-range space back by default, but shows what it held', () => {
    const out = render(false);
    // The routable network is registered.
    expect(out).toContain('cidr: "10.20.0.0/16"');
    // The CGNAT one is present only behind comment markers.
    expect(out).toContain('Discovered, but NOT registered');
    expect(out).toContain('#     cidr: "100.64.0.0/16"');
    expect(out).not.toContain('\n    cidr: "100.64.0.0/16"');
  });

  it('registers shared-range space when asked, still labelling it', () => {
    const out = render(true);
    expect(out).toContain('    cidr: "100.64.0.0/16"');
    expect(out).toContain('a range expected to be shared');
    expect(out).not.toContain('Discovered, but NOT registered');
  });

  // Holding a network back must happen before environments are
  // disambiguated. Otherwise the survivor keeps a name derived to avoid a
  // collision with a network that is no longer in the file.
  it('does not derive environments to avoid a network it held back', () => {
    const out = render(false);
    expect(out).toContain('environment: "production"');
    expect(out).not.toContain('environment: "prod"');
    expect(out).not.toContain('Some environments were derived');
  });
});

describe('formatScanReport', () => {
  // Regression: an empty subscription rendered "0 regions: " with a trailing
  // colon and nothing after it. This is the first thing a stranger sees if
  // they point the scan at the wrong subscription or a fresh account, which
  // is exactly when a sloppy line costs the most trust.
  it('does not leave a dangling colon when an account has no regions', () => {
    const output = formatScanReport(
      analyseDiscovery(discovery({ provider: 'azure', regions: [], networks: [] }))
    );
    expect(output).toContain('no regions');
    expect(output).not.toContain('0 regions:');
  });

  // Regression: this line hardcoded "VPC" while every sibling line used the
  // provider-aware noun, so an Azure-only scan announced "No overlapping VPC
  // address space found" as its headline result.
  it('uses the provider noun when reporting no overlaps', () => {
    const azure = formatScanReport(
      analyseDiscovery(
        discovery({
          provider: 'azure',
          networks: [{ id: 'vnet-1', name: 'solo', region: 'eastus', cidrs: ['10.100.1.0/24'] }],
        })
      )
    );
    expect(azure).toContain('No overlapping VNet address space found.');
    expect(azure).not.toContain('VPC');
  });

  // Regression: IPv6 capacity is deliberately not computed, so a v6-only
  // network reported "0% carved, 0 addresses unused" against a /32, which
  // reads as a broken measurement rather than an intentional omission.
  it('says IPv6 is not measured rather than reporting zero capacity', () => {
    const output = formatScanReport(
      analyseDiscovery(
        discovery({
          provider: 'azure',
          regions: ['westus3'],
          networks: [{ id: 'vnet-v6', name: 'v6only', region: 'westus3', cidrs: ['fd00:100::/32'] }],
        })
      )
    );
    expect(output).toContain('IPv6 capacity not measured');
    expect(output).not.toContain('0 addresses unused');
  });

  it('says so plainly when nothing overlaps', () => {
    const output = formatScanReport(
      analyseDiscovery(
        discovery({ networks: [{ id: 'vpc-1', name: 'solo', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }] })
      )
    );
    expect(output).toContain('No overlapping VPC address space found.');
  });

  it('leads with the consequence when blocks collide', () => {
    const output = formatScanReport(
      analyseDiscovery(
        discovery({
          networks: [
            { id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
            { id: 'vpc-2', name: 'staging', region: 'us-east-1', cidrs: ['10.0.0.0/16'] },
          ],
        })
      )
    );
    expect(output).toContain('Overlapping address space: 1 conflict across 2 VPCs');
    expect(output).toContain('cannot be peered or routed');
  });

  it('handles an empty account without crashing', () => {
    expect(formatScanReport(analyseDiscovery(discovery()))).toContain('No VPCs found');
  });
});

// The manifest now declares networks and their subnets in one list, the
// networks being the structural parents. Most assertions care about the
// cloud subnets, so pull them out by their parent link.
const childrenOf = (entries: { parent?: string }[]) => entries.filter((e) => e.parent);

describe('renderDiscoveryManifest', () => {
  const report = analyseDiscovery(
    discovery({
      networks: [{ id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
      subnets: [
        { id: 'subnet-a', name: 'web', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24', availabilityZone: 'eu-west-2a' },
        { id: 'subnet-b', name: 'db', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.2.0/24', availabilityZone: 'eu-west-2b' },
      ],
    })
  );

  it('produces a manifest the CLI can actually parse', () => {
    // The whole point of the bridge: if this does not round-trip through
    // parseManifest, `nxip plan -f` on the output fails and the bridge is a
    // dead end.
    const entries = parseManifest(renderDiscoveryManifest(report));
    // One structural network plus its two subnets.
    expect(entries).toHaveLength(3);
    const children = childrenOf(entries);
    expect(children).toHaveLength(2);
    expect(children[0].body.cidr).toBe('10.0.1.0/24');
    expect(children[0].body.prefixLength).toBeUndefined();
    // Region is inherited from the parent rather than repeated per subnet.
    expect(children[0].parent).toBe('prod');
  });

  it('preserves the real CIDRs rather than asking nxip to allocate new ones', () => {
    const manifest = renderDiscoveryManifest(report);
    expect(manifest).toContain('10.0.1.0/24');
    expect(manifest).toContain('10.0.2.0/24');
    expect(manifest).not.toContain('prefix_length');
  });

  it('carries provenance back to the source cloud in metadata', () => {
    const entries = childrenOf(parseManifest(renderDiscoveryManifest(report)));
    // Keys are provider-neutral now that Azure exists: a manifest may mix
    // clouds, so "vpc_id" would be a lie for half of it.
    expect(entries[0].body.metadata).toMatchObject({
      source: 'aws-scan',
      network_id: 'vpc-1',
      source_subnet_id: 'subnet-a',
      availability_zone: 'eu-west-2a',
    });
  });

  it('de-duplicates names, since AWS Name tags are not unique', () => {
    const duplicated = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
        subnets: [
          { id: 'subnet-a', name: 'private', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' },
          { id: 'subnet-b', name: 'private', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.2.0/24' },
        ],
      })
    );
    // parseManifest rejects duplicate names outright, so this would throw if
    // the de-duplication were missing.
    const entries = childrenOf(parseManifest(renderDiscoveryManifest(duplicated)));
    expect(entries.map((e) => e.name)).toEqual(['private', 'private-2']);
  });

  it('falls back to the subnet id when AWS has no Name tag', () => {
    const untagged = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: null, region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
        subnets: [{ id: 'subnet-xyz', name: null, networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' }],
      })
    );
    expect(childrenOf(parseManifest(renderDiscoveryManifest(untagged)))[0].name).toBe('subnet-xyz');
  });
});

describe('expected-shared ranges', () => {
  // The scenario that makes or breaks the first run: AWS recommends carving
  // EKS pod subnets from 100.64.0.0/10 precisely so they do not consume
  // RFC1918, which means a fleet of clusters is supposed to reuse the same
  // block everywhere. Reporting each as a collision would bury the real ones.
  function eksFleet(count: number) {
    return discovery({
      networks: Array.from({ length: count }, (_, i) => ({
        id: `vpc-eks-${i}`,
        name: `eks-${i}`,
        region: 'eu-west-2',
        cidrs: [`10.${i}.0.0/16`, '100.64.0.0/16'],
      })),
    });
  }

  it('does not report CGNAT pod ranges shared across a cluster fleet', () => {
    const report = analyseDiscovery(eksFleet(10));
    expect(report.clusters).toEqual([]);
    // 10 VPCs sharing one block is 45 pairs, all deliberate.
    expect(report.suppressed.pairs).toBe(45);
    expect(report.suppressed.ranges.map((r) => r.cidr)).toContain('100.64.0.0/10');
  });

  it('still reports a routable collision on a VPC that also carries a shared secondary', () => {
    // The subtlety that matters: suppression is judged on the overlapping
    // region, not the VPC. A VPC with a 100.64 secondary must not become
    // immune to collisions on its routable primary.
    const fleet = eksFleet(3);
    fleet.networks[1].cidrs = ['10.0.0.0/16', '100.64.0.0/16'];
    const report = analyseDiscovery(fleet);

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members.map((m) => m.cidr)).toEqual(['10.0.0.0/16', '10.0.0.0/16']);
    expect(report.suppressed.pairs).toBeGreaterThan(0);
  });

  it('reports everything when shared ranges are turned off', () => {
    const report = analyseDiscovery(eksFleet(10), { sharedRanges: [] });
    expect(report.suppressed.pairs).toBe(0);
    expect(report.overlaps).toHaveLength(45);
    // Still one finding, not 45 - clustering carries the scale on its own.
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members).toHaveLength(10);
  });

  it('suppresses 198.19.0.0/16 and link-local too', () => {
    for (const shared of ['198.19.0.0/16', '169.254.0.0/16']) {
      const report = analyseDiscovery(
        discovery({
          networks: [
            { id: 'vpc-1', name: 'a', region: 'eu-west-2', cidrs: [shared] },
            { id: 'vpc-2', name: 'b', region: 'eu-west-2', cidrs: [shared] },
          ],
        })
      );
      expect(report.clusters, shared).toEqual([]);
    }
  });

  it('never suppresses RFC1918, which is the whole point of the scan', () => {
    for (const routable of ['10.0.0.0/16', '172.16.0.0/16', '192.168.0.0/16']) {
      const report = analyseDiscovery(
        discovery({
          networks: [
            { id: 'vpc-1', name: 'a', region: 'eu-west-2', cidrs: [routable] },
            { id: 'vpc-2', name: 'b', region: 'eu-west-2', cidrs: [routable] },
          ],
        })
      );
      expect(report.clusters, routable).toHaveLength(1);
    }
  });

  it('accepts caller-supplied ranges for org-specific conventions', () => {
    const base = discovery({
      networks: [
        { id: 'vpc-1', name: 'a', region: 'eu-west-2', cidrs: ['192.168.0.0/16'] },
        { id: 'vpc-2', name: 'b', region: 'eu-west-2', cidrs: ['192.168.0.0/16'] },
      ],
    });
    expect(analyseDiscovery(base).clusters).toHaveLength(1);

    const excluded = analyseDiscovery(base, { sharedRanges: parseSharedRanges(['192.168.0.0/16']) });
    expect(excluded.clusters).toEqual([]);
    expect(excluded.suppressed.pairs).toBe(1);
  });
});

describe('overlap clustering', () => {
  it('groups a whole set into one finding rather than every pair', () => {
    const report = analyseDiscovery(
      discovery({
        networks: Array.from({ length: 20 }, (_, i) => ({
          id: `vpc-${i}`,
          name: `net-${i}`,
          region: 'eu-west-2',
          cidrs: ['10.0.0.0/16'],
        })),
      })
    );
    // 20 VPCs is 190 pairs saying the same thing. One cluster says it once.
    expect(report.overlaps).toHaveLength(190);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members).toHaveLength(20);
    expect(report.clusters[0].identical).toBe(true);
  });

  it('groups transitively, so a chain is one finding', () => {
    // A contains B, B overlaps C, A and C do not touch - still one problem.
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-a', name: 'a', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-b', name: 'b', region: 'eu-west-2', cidrs: ['10.0.0.0/8'] },
          { id: 'vpc-c', name: 'c', region: 'eu-west-2', cidrs: ['10.200.0.0/16'] },
        ],
      })
    );
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members).toHaveLength(3);
    expect(report.clusters[0].identical).toBe(false);
  });

  it('keeps genuinely separate conflicts separate', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-a', name: 'a', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-b', name: 'b', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-c', name: 'c', region: 'eu-west-2', cidrs: ['172.16.0.0/16'] },
          { id: 'vpc-d', name: 'd', region: 'eu-west-2', cidrs: ['172.16.0.0/16'] },
        ],
      })
    );
    expect(report.clusters).toHaveLength(2);
    expect(report.clusters.every((c) => c.members.length === 2)).toBe(true);
  });

  it('leaves a VPC with no overlap out of every cluster', () => {
    const report = analyseDiscovery(
      discovery({
        networks: [
          { id: 'vpc-a', name: 'a', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-b', name: 'b', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
          { id: 'vpc-lonely', name: 'lonely', region: 'eu-west-2', cidrs: ['10.99.0.0/16'] },
        ],
      })
    );
    expect(report.clusters.flatMap((c) => c.members.map((m) => m.networkId))).not.toContain('vpc-lonely');
  });
});

describe('parseSharedRanges', () => {
  it('rejects an unreadable CIDR rather than silently ignoring it', () => {
    expect(() => parseSharedRanges(['not-a-cidr'])).toThrow(SharedRangeError);
    expect(() => parseSharedRanges(['10.0.0.0/33'])).toThrow(SharedRangeError);
  });

  it('normalizes host bits away', () => {
    expect(parseSharedRanges(['10.0.5.7/16'])[0].cidr).toBe('10.0.0.0/16');
  });
});

describe('cross-cloud analysis', () => {
  const aws: Discovery = {
    provider: 'aws',
    account: '123456789012',
    regions: ['eu-west-2'],
    networks: [{ id: 'vpc-0aa1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
    subnets: [{ id: 'subnet-a', name: 'web', networkId: 'vpc-0aa1', region: 'eu-west-2', cidr: '10.0.1.0/24' }],
  };

  const azure: Discovery = {
    provider: 'azure',
    account: '00000000-1111-2222-3333-444444444444',
    regions: ['uksouth'],
    networks: [{ id: 'rg-hub/vnet-hub', name: 'vnet-hub', region: 'uksouth', cidrs: ['10.0.0.0/16'] }],
    subnets: [{ id: 'rg-hub/vnet-hub/default', name: 'default', networkId: 'rg-hub/vnet-hub', region: 'uksouth', cidr: '10.0.2.0/24' }],
  };

  it('finds a collision between an AWS VPC and an Azure VNet', () => {
    // The finding neither cloud can produce: AWS IPAM cannot see Azure, and
    // Azure cannot see AWS. Scanning them apart finds nothing at all.
    expect(analyseDiscovery(aws).clusters).toEqual([]);
    expect(analyseDiscovery(azure).clusters).toEqual([]);

    const report = analyseDiscovery([aws, azure]);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].members.map((m) => m.provider).sort()).toEqual(['aws', 'azure']);
  });

  it('records every source that contributed', () => {
    const report = analyseDiscovery([aws, azure]);
    expect(report.discovery.sources.map((s) => s.provider)).toEqual(['aws', 'azure']);
    expect(report.discovery.sources[1].account).toBe('00000000-1111-2222-3333-444444444444');
  });

  it('stamps each network and subnet with the cloud it came from', () => {
    const report = analyseDiscovery([aws, azure]);
    expect(report.discovery.networks.map((n) => n.provider)).toEqual(['aws', 'azure']);
    expect(report.discovery.subnets.every((s) => s.provider)).toBe(true);
  });

  it('names both clouds in the report when the estate spans them', () => {
    const output = formatScanReport(analyseDiscovery([aws, azure]));
    expect(output).toContain('AWS + AZURE');
    // Provider-neutral noun once more than one cloud is involved: calling an
    // Azure VNet a VPC would be wrong.
    expect(output).toContain('networks');
    expect(output).not.toContain('VPCs and');
  });

  it('uses each cloud its own noun when only one is present', () => {
    expect(formatScanReport(analyseDiscovery(aws))).toContain('VPC');
    expect(formatScanReport(analyseDiscovery(azure))).toContain('VNet');
  });

  it('still suppresses expected-shared ranges across clouds', () => {
    // A shared range is shared regardless of which cloud it turns up in.
    const awsCgnat: Discovery = { ...aws, networks: [{ ...aws.networks[0], cidrs: ['100.64.0.0/16'] }] };
    const azureCgnat: Discovery = { ...azure, networks: [{ ...azure.networks[0], cidrs: ['100.64.0.0/16'] }] };
    const report = analyseDiscovery([awsCgnat, azureCgnat]);
    expect(report.clusters).toEqual([]);
    expect(report.suppressed.pairs).toBe(1);
  });

  it('emits one manifest covering both clouds', () => {
    const entries = childrenOf(parseManifest(renderDiscoveryManifest(analyseDiscovery([aws, azure]))));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.body.metadata?.source).sort()).toEqual(['aws-scan', 'azure-scan']);
  });
});

describe('pool proposal (--emit-manifest)', () => {
  // The constraint that makes this hard: nxip allows one pool per
  // (environment, region, family), and real accounts put several networks
  // in one region.
  const crowded = discovery({
    networks: [
      { id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
      { id: 'vpc-2', name: 'staging', region: 'eu-west-2', cidrs: ['10.1.0.0/16'] },
      { id: 'vpc-3', name: 'data', region: 'us-east-1', cidrs: ['10.2.0.0/16'] },
    ],
    subnets: [
      { id: 's1', name: 'prod-web', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' },
      { id: 's2', name: 'stg-web', networkId: 'vpc-2', region: 'eu-west-2', cidr: '10.1.1.0/24' },
      { id: 's3', name: 'data-a', networkId: 'vpc-3', region: 'us-east-1', cidr: '10.2.1.0/24' },
    ],
  });

  it('proposes one pool per network block', () => {
    const pools = proposePools(analyseDiscovery(crowded));
    expect(pools).toHaveLength(3);
    expect(pools.map((p) => p.cidr).sort()).toEqual(['10.0.0.0/16', '10.1.0.0/16', '10.2.0.0/16']);
  });

  it('keeps environments unique where a region holds several networks', () => {
    const pools = proposePools(analyseDiscovery(crowded));
    const euw2 = pools.filter((p) => p.region === 'eu-west-2');
    expect(euw2).toHaveLength(2);
    // Same region, same family - so these must differ or the second collides.
    expect(new Set(euw2.map((p) => p.environment)).size).toBe(2);
    expect(euw2.every((p) => p.derivedEnvironment)).toBe(true);
  });

  it('leaves a region with one network on the production default', () => {
    const pools = proposePools(analyseDiscovery(crowded));
    const solo = pools.find((p) => p.region === 'us-east-1')!;
    expect(solo.environment).toBe('production');
    expect(solo.derivedEnvironment).toBe(false);
  });

  it('produces no colliding (environment, region, family) key anywhere', () => {
    // The property the whole design exists to guarantee. If this fails, the
    // emitted file cannot be applied.
    const pools = proposePools(analyseDiscovery(crowded));
    const keys = pools.map((p) => `${p.environment}|${p.region}|IPV4`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('disambiguates networks that share a Name tag', () => {
    const duplicated = discovery({
      networks: [
        { id: 'vpc-1', name: 'app', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] },
        { id: 'vpc-2', name: 'app', region: 'eu-west-2', cidrs: ['10.1.0.0/16'] },
      ],
    });
    const pools = proposePools(analyseDiscovery(duplicated));
    expect(new Set(pools.map((p) => p.environment)).size).toBe(2);
  });

  // A cloud network is not a pool: a pool is the block you carve space out
  // of, and a VPC is itself carved out of that. So the manifest declares no
  // pools at all, and every cloud subnet nests under its own network.
  it('emits no pools, and nests each subnet under its own network', () => {
    const manifest = parseFullManifest(renderDiscoveryManifest(analyseDiscovery(crowded)));
    expect(manifest.pools).toHaveLength(0);

    const networks = manifest.subnets.filter((s) => !s.parent);
    const children = manifest.subnets.filter((s) => s.parent);
    expect(networks).toHaveLength(3);
    expect(children).toHaveLength(3);

    for (const child of children) {
      const parent = networks.find((n) => n.name === child.parent);
      expect(parent, `no parent for ${child.name}`).toBeDefined();
    }
  });

  it('registers exact blocks rather than asking for a size', () => {
    const manifest = parseFullManifest(renderDiscoveryManifest(analyseDiscovery(crowded)));
    expect(manifest.subnets[0].body.cidr).toBeDefined();
    expect(manifest.subnets[0].body.prefixLength).toBeUndefined();
  });

  it('tags each network structurally, so its subnets can nest beneath it', () => {
    const manifest = parseFullManifest(renderDiscoveryManifest(analyseDiscovery(crowded)));
    for (const network of manifest.subnets.filter((s) => !s.parent)) {
      expect(network.body.kind).toBeTruthy();
    }
  });

  it('attributes a subnet to the most specific containing block', () => {
    const nested = discovery({
      networks: [{ id: 'vpc-1', name: 'multi', region: 'eu-west-2', cidrs: ['10.0.0.0/8', '10.0.0.0/16'] }],
      subnets: [{ id: 's1', name: 'inner', networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' }],
    });
    const manifest = parseFullManifest(renderDiscoveryManifest(analyseDiscovery(nested)));
    const child = manifest.subnets.find((s) => s.parent)!;
    const parent = manifest.subnets.find((s) => s.name === child.parent)!;
    expect(parent.body.cidr).toBe('10.0.0.0/16');
  });

  it('comments out a subnet that falls outside every block its network declares', () => {
    const orphaned = discovery({
      networks: [{ id: 'vpc-1', name: 'prod', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
      subnets: [{ id: 's1', name: 'stray', networkId: 'vpc-1', region: 'eu-west-2', cidr: '192.168.5.0/24' }],
    });
    const rendered = renderDiscoveryManifest(analyseDiscovery(orphaned));
    expect(rendered).toContain('Left out');
    expect(rendered).toContain('192.168.5.0/24');
    // Left out rather than emitted broken: it would fail to route anyway.
    // The network itself still stands; only the stray subnet is dropped.
    expect(childrenOf(parseFullManifest(rendered).subnets)).toHaveLength(0);
  });

  it('says why an environment was derived, so the guess is visible', () => {
    expect(renderDiscoveryManifest(analyseDiscovery(crowded))).toContain('derived from network names');
    const solo = discovery({ networks: [{ id: 'v', name: 'only', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }] });
    expect(renderDiscoveryManifest(analyseDiscovery(solo))).not.toContain('derived from network names');
  });
});
