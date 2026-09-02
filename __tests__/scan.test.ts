import { describe, it, expect } from 'vitest';
import { analyseDiscovery, formatScanReport, renderDiscoveryManifest, type Discovery } from '../src/scan.js';
import { parseManifest } from '../src/manifest.js';

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

describe('formatScanReport', () => {
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
    expect(output).toContain('Overlapping address space: 1 pair');
    expect(output).toContain('cannot be peered or routed');
  });

  it('handles an empty account without crashing', () => {
    expect(formatScanReport(analyseDiscovery(discovery()))).toContain('No VPCs found');
  });
});

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
    expect(entries).toHaveLength(2);
    expect(entries[0].body.cidr).toBe('10.0.1.0/24');
    expect(entries[0].body.prefixLength).toBeUndefined();
    expect(entries[0].body.region).toBe('eu-west-2');
  });

  it('preserves the real CIDRs rather than asking nxip to allocate new ones', () => {
    const manifest = renderDiscoveryManifest(report);
    expect(manifest).toContain('10.0.1.0/24');
    expect(manifest).toContain('10.0.2.0/24');
    expect(manifest).not.toContain('prefix_length');
  });

  it('carries provenance back to AWS in metadata', () => {
    const entries = parseManifest(renderDiscoveryManifest(report));
    expect(entries[0].body.metadata).toMatchObject({
      source: 'aws-scan',
      vpc_id: 'vpc-1',
      aws_subnet_id: 'subnet-a',
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
    const entries = parseManifest(renderDiscoveryManifest(duplicated));
    expect(entries.map((e) => e.name)).toEqual(['private', 'private-2']);
  });

  it('falls back to the subnet id when AWS has no Name tag', () => {
    const untagged = analyseDiscovery(
      discovery({
        networks: [{ id: 'vpc-1', name: null, region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
        subnets: [{ id: 'subnet-xyz', name: null, networkId: 'vpc-1', region: 'eu-west-2', cidr: '10.0.1.0/24' }],
      })
    );
    expect(parseManifest(renderDiscoveryManifest(untagged))[0].name).toBe('subnet-xyz');
  });
});
