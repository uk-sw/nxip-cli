import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest, parseFullManifest } from '../src/manifest.js';

describe('parseManifest', () => {
  it('parses a valid manifest into subnet entries', () => {
    const entries = parseManifest(`
subnets:
  - name: payments
    environment: production
    region: us-east-1
    family: IPV4
    prefix_length: 24
`);

    expect(entries).toEqual([
      {
        name: 'payments',
        body: {
          family: 'IPV4',
          prefixLength: 24,
          environment: 'production',
          region: 'us-east-1',
          parentSubnetId: undefined,
          kind: undefined,
          // Sent to the API now: an imported estate used to arrive as a set
          // of unnamed CIDRs because this was withheld as "CLI output only".
          name: 'payments',
          description: undefined,
          metadata: undefined,
        },
      },
    ]);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseManifest('subnets: [')).toThrow(ManifestError);
  });

  it('rejects a manifest with no subnets key', () => {
    expect(() => parseManifest('foo: bar')).toThrow(ManifestError);
  });

  it('rejects an empty subnets list', () => {
    expect(() => parseManifest('subnets: []')).toThrow(ManifestError);
  });

  it('rejects a subnet missing both parent_subnet_id and environment/region', () => {
    expect(() =>
      parseManifest(`
subnets:
  - name: orphan
    family: IPV4
    prefix_length: 24
`)
    ).toThrow(/parent_subnet_id, or both environment and region/);
  });

  it('accepts a subnet with parent_subnet_id instead of environment/region', () => {
    const entries = parseManifest(`
subnets:
  - name: nested
    parent_subnet_id: cabc123
    family: IPV4
    prefix_length: 27
`);
    expect(entries[0]?.body.parentSubnetId).toBe('cabc123');
  });

  it('rejects duplicate subnet names', () => {
    expect(() =>
      parseManifest(`
subnets:
  - name: payments
    environment: production
    region: us-east-1
    family: IPV4
    prefix_length: 24
  - name: payments
    environment: production
    region: us-east-1
    family: IPV4
    prefix_length: 25
`)
    ).toThrow(/Duplicate subnet name/);
  });

  it('rejects an invalid family value', () => {
    expect(() =>
      parseManifest(`
subnets:
  - name: payments
    environment: production
    region: us-east-1
    family: IPV5
    prefix_length: 24
`)
    ).toThrow(ManifestError);
  });
});

describe('parent references by name', () => {
  const yaml = (body: string) => `subnets:\n${body}`;

  it('carries a parent name through to the entry', () => {
    const m = parseFullManifest(
      yaml(`  - name: vnet-hub
    family: IPV4
    cidr: 10.20.0.0/16
    environment: production
    region: uksouth
    kind: vnet
  - name: web
    family: IPV4
    cidr: 10.20.1.0/24
    parent: vnet-hub
`)
    );
    expect(m.subnets.map((s) => [s.name, s.parent])).toEqual([
      ['vnet-hub', undefined],
      ['web', 'vnet-hub'],
    ]);
  });

  // Caught at parse time, because the alternative is discovering it after
  // half the estate has already been created.
  it('rejects a parent that is not declared in the file', () => {
    expect(() =>
      parseFullManifest(yaml(`  - name: web
    family: IPV4
    cidr: 10.20.1.0/24
    parent: nowhere
`))
    ).toThrow(/not declared in this file/);
  });

  it('rejects a circular parent chain', () => {
    expect(() =>
      parseFullManifest(yaml(`  - name: a
    family: IPV4
    cidr: 10.20.1.0/24
    parent: b
  - name: b
    family: IPV4
    cidr: 10.20.2.0/24
    parent: a
`))
    ).toThrow(/Circular parent reference/);
  });

  it('rejects a subnet that parents itself', () => {
    expect(() =>
      parseFullManifest(yaml(`  - name: a
    family: IPV4
    cidr: 10.20.1.0/24
    parent: a
`))
    ).toThrow(/its own parent/);
  });

  it('refuses both parent and parent_subnet_id, which would contradict', () => {
    expect(() =>
      parseFullManifest(yaml(`  - name: a
    family: IPV4
    cidr: 10.20.1.0/24
    parent: b
    parent_subnet_id: sub_123
  - name: b
    family: IPV4
    cidr: 10.20.2.0/24
    environment: production
    region: uksouth
`))
    ).toThrow(/not both/);
  });
});
