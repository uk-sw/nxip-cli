import { describe, expect, it } from 'vitest';
import { expandSiteSpec, renderManifest, SiteSpecError } from '../src/site.js';
import { parseManifest } from '../src/manifest.js';

describe('expandSiteSpec', () => {
  it('expands one subnet per environment x cloud pair', () => {
    const entries = expandSiteSpec(`
site: emea-fra-01
environments: [production, staging]
clouds:
  - provider: aws
    region: eu-central-1
  - provider: azure
    region: germanywestcentral
sizing:
  production: 24
  staging: 26
`);

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.name)).toEqual([
      'emea-fra-01-production-aws-eu-central-1',
      'emea-fra-01-production-azure-germanywestcentral',
      'emea-fra-01-staging-aws-eu-central-1',
      'emea-fra-01-staging-azure-germanywestcentral',
    ]);

    const prod = entries[0];
    expect(prod?.body).toEqual({
      family: 'IPV4',
      environment: 'production',
      region: 'aws-eu-central-1',
      prefixLength: 24,
    });

    const staging = entries[2];
    expect(staging?.body.prefixLength).toBe(26);
  });

  it('rejects a spec missing sizing for a declared environment', () => {
    expect(() =>
      expandSiteSpec(`
site: emea-fra-01
environments: [production, staging]
clouds:
  - provider: aws
    region: eu-central-1
sizing:
  production: 24
`)
    ).toThrow(/Missing sizing for environment\(s\): staging/);
  });

  it('rejects an unsupported cloud provider', () => {
    expect(() =>
      expandSiteSpec(`
site: emea-fra-01
environments: [production]
clouds:
  - provider: oracle
    region: us-1
sizing:
  production: 24
`)
    ).toThrow(SiteSpecError);
  });

  it('rejects malformed YAML', () => {
    expect(() => expandSiteSpec('site: [')).toThrow(SiteSpecError);
  });
});

describe('renderManifest', () => {
  it('renders expanded entries as a valid bet #8 manifest', () => {
    const entries = expandSiteSpec(`
site: fra
environments: [production]
clouds:
  - provider: gcp
    region: europe-west3
sizing:
  production: 22
`);

    const rendered = renderManifest(entries);
    expect(rendered).toContain('subnets:');
    expect(rendered).toContain('- name: fra-production-gcp-europe-west3');
    expect(rendered).toContain('environment: production');
    expect(rendered).toContain('region: gcp-europe-west3');
    expect(rendered).toContain('family: IPV4');
    expect(rendered).toContain('prefix_length: 22');
  });

  it('round-trips: rendered output is valid input to nxip plan/apply', () => {
    const entries = expandSiteSpec(`
site: fra
environments: [production, staging]
clouds:
  - provider: aws
    region: eu-central-1
  - provider: azure
    region: germanywestcentral
sizing:
  production: 24
  staging: 26
`);

    // The round trip now carries name through into the body as well, since
    // that is what reaches the API. Compared field by field rather than by
    // reconstructing the expected shape, so this stays a round-trip test.
    const reparsed = parseManifest(renderManifest(entries));
    expect(reparsed.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (const [i, entry] of entries.entries()) {
      expect(reparsed[i].body).toMatchObject({ ...entry.body, name: entry.name });
    }
  });
});
