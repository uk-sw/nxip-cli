import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest } from '../src/manifest.js';

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
