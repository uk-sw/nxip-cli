import { describe, it, expect } from 'vitest';
import {
  analyseDiscovery,
  formatScanReport,
  mergeDiscoveries,
  redactDiscovery,
  renderDiscoveryManifest,
  type Discovery,
} from '../src/scan.js';

// Deliberately identifying values: a real-shaped AWS account id, an Azure
// subscription GUID, and names carrying a customer's identity.
const AWS_ACCOUNT = '123456789012';
const AZURE_SUB = '8f2a1c44-9b3e-4d7a-b512-6e0f9a3c1d88';
const SECRETS = [AWS_ACCOUNT, AZURE_SUB, 'acme-prod-payments', 'vpc-0aa1', 'rg-acme-hub', 'acme-hub', 'acme-prod-db'];

const aws: Discovery = {
  provider: 'aws',
  account: AWS_ACCOUNT,
  regions: ['eu-west-2'],
  networks: [{ id: 'vpc-0aa1', name: 'acme-prod-payments', region: 'eu-west-2', cidrs: ['10.0.0.0/16'] }],
  subnets: [{ id: 'subnet-a', name: 'acme-prod-db', networkId: 'vpc-0aa1', region: 'eu-west-2', cidr: '10.0.1.0/24' }],
};

const azure: Discovery = {
  provider: 'azure',
  account: AZURE_SUB,
  regions: ['uksouth'],
  networks: [{ id: 'rg-acme-hub/vnet-hub', name: 'acme-hub', region: 'uksouth', cidrs: ['10.0.0.0/16'] }],
  subnets: [
    { id: 'rg-acme-hub/vnet-hub/default', name: 'acme-default', networkId: 'rg-acme-hub/vnet-hub', region: 'uksouth', cidr: '10.0.2.0/24' },
  ],
};

const merged = () => mergeDiscoveries([aws, azure]);

describe('redactDiscovery', () => {
  it('leaks no identifier through the rendered report', () => {
    // The property that actually matters. Checked against the rendered text
    // rather than the structure, because the text is what gets shared.
    const output = formatScanReport(analyseDiscovery(redactDiscovery(merged())));
    for (const secret of SECRETS) {
      expect(output, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('leaks no identifier through the JSON output either', () => {
    const json = JSON.stringify(analyseDiscovery(redactDiscovery(merged())));
    for (const secret of SECRETS) {
      expect(json, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('leaks no identifier through an emitted manifest', () => {
    const manifest = renderDiscoveryManifest(analyseDiscovery(redactDiscovery(merged())));
    for (const secret of SECRETS) {
      expect(manifest, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('keeps the finding intact, which is the whole point of sharing it', () => {
    const plain = analyseDiscovery(merged());
    const hidden = analyseDiscovery(redactDiscovery(merged()));

    expect(hidden.clusters).toHaveLength(plain.clusters.length);
    expect(hidden.clusters[0].members).toHaveLength(2);
    expect(hidden.clusters[0].sharedAddresses).toBe(plain.clusters[0].sharedAddresses);
    // Address space survives: without it there is no finding left to show.
    expect(hidden.clusters[0].members.map((m) => m.cidr)).toEqual(['10.0.0.0/16', '10.0.0.0/16']);
    expect(hidden.totals).toEqual(plain.totals);
  });

  it('keeps which cloud and region each side of a conflict is in', () => {
    const report = analyseDiscovery(redactDiscovery(merged()));
    const providers = report.clusters[0].members.map((m) => m.provider).sort();
    expect(providers).toEqual(['aws', 'azure']);
    expect(report.clusters[0].members.map((m) => m.region).sort()).toEqual(['eu-west-2', 'uksouth']);
  });

  it('gives one network one pseudonym everywhere it appears', () => {
    // Blanking would make a conflict unreadable; the labels have to be
    // stable or "these two collide" cannot be expressed at all.
    const redacted = redactDiscovery(merged());
    const network = redacted.networks[0];
    const itsSubnet = redacted.subnets.find((s) => s.networkId === network.id);
    expect(itsSubnet, 'subnet lost its network').toBeDefined();
    expect(new Set(redacted.networks.map((n) => n.id)).size).toBe(2);
  });

  it('numbers pseudonyms per prefix, not across all of them', () => {
    const redacted = redactDiscovery(merged());
    // A global counter yields "azure-account-2" for the only Azure account.
    expect(redacted.sources.map((s) => s.account)).toEqual(['aws-account-1', 'azure-account-1']);
  });

  it('reuses one pseudonym for one account seen many times', () => {
    const twice = mergeDiscoveries([aws, { ...aws, networks: [{ ...aws.networks[0], id: 'vpc-0bb2' }] }]);
    const redacted = redactDiscovery(twice);
    expect(new Set(redacted.networks.map((n) => n.account)).size).toBe(1);
  });

  it('marks the report as redacted so a reader is not misled', () => {
    expect(formatScanReport(analyseDiscovery(redactDiscovery(merged())))).toContain('[redacted]');
    expect(formatScanReport(analyseDiscovery(merged()))).not.toContain('[redacted]');
  });

  it('changes nothing when not asked for', () => {
    const output = formatScanReport(analyseDiscovery(merged()));
    expect(output).toContain(AWS_ACCOUNT);
    expect(output).toContain('acme-prod-payments');
  });
});
