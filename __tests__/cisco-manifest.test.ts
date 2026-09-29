import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCisco, BET_33_NOTE, WHAT_NXIP_NEVER_DOES, type CiscoDiscovery } from '../src/cisco.js';
import { analyseDiscovery, formatScanReport, mergeDiscoveries, renderDiscoveryManifests, type Discovery } from '../src/scan.js';
import { parseFullManifest } from '../src/manifest.js';
import { planManifest, planPools } from '../src/plan.js';
import { transcriptSession } from './cisco-fixtures.js';

/**
 * What the run writes: the manifest. It has to parse with the schema `plan`
 * and `apply` already use, carry landing_point false on every entry, and
 * split into one file per VRF when two VRFs overlap, because nxip refuses
 * overlap inside one organisation.
 */

const FIXTURES: Record<string, string> = {
  'core1.example': 'iosxe17-core1.txt',
  'edge1.example': 'ios15-edge1.txt',
  'leaf1.example': 'nxos10-leaf1.txt',
};

/** A real discoverCisco run, with the SSH session replaced by a transcript. */
function discover(hosts: string[], options: Partial<Parameters<typeof discoverCisco>[0]> = {}): Promise<CiscoDiscovery> {
  return discoverCisco({
    hosts,
    username: 'readonly',
    password: 'not-a-real-password',
    hostKeys: { knownHosts: [], onUnknown: async () => false },
    site: 'hq',
    environment: 'production',
    openSession: async (target) => transcriptSession(FIXTURES[target.host]),
    ...options,
  });
}

function manifestsFor(discovery: Discovery, cisco: { environment?: string; site?: string; pools?: string[] } = {}) {
  const report = analyseDiscovery(mergeDiscoveries([discovery]));
  return renderDiscoveryManifests(report, { cisco: { environment: 'production', site: 'hq', ...cisco } });
}

describe('the manifest round trip', () => {
  it('parses back through the schema plan and apply use', async () => {
    const manifests = manifestsFor(await discover(['leaf1.example']));
    expect(manifests).toHaveLength(1);
    const manifest = parseFullManifest(manifests[0].text);

    expect(manifest.pools.map((p) => [p.body.cidr, p.body.family, p.body.environment, p.body.region])).toEqual([
      ['10.0.0.0/12', 'IPV4', 'production', 'hq'],
      ['192.168.1.0/24', 'IPV4', 'production', 'hq'],
      ['fd00:2::/31', 'IPV6', 'production', 'hq'],
    ]);
    expect(manifest.subnets.map((s) => s.body.cidr)).toEqual([
      // Broadest first, so a nested entry can name the one above it.
      '10.4.0.0/16',
      '10.2.0.0/22',
      '10.2.4.0/24',
      '10.3.0.0/24',
      '10.5.0.0/24',
      '10.7.0.0/24',
      '10.8.0.0/24',
      '192.168.1.0/24',
      '10.0.2.0/31',
      'fd00:3::/48',
      'fd00:2::/64',
    ]);
  });

  it('writes landing_point false on every entry, and carries it through as landingPoint', async () => {
    // A discovered prefix records what is routed. If it became a placement
    // target, the next `plan` would allocate new space inside somebody's
    // existing VLAN.
    const manifests = manifestsFor(await discover(['leaf1.example']));
    expect(manifests[0].text).toContain('landing_point: false');

    const manifest = parseFullManifest(manifests[0].text);
    expect(manifest.subnets.length).toBeGreaterThan(0);
    for (const subnet of manifest.subnets) {
      expect(subnet.body.landingPoint).toBe(false);
    }
  });

  it('carries the kind and the metadata the spec names onto each entry', async () => {
    const manifest = parseFullManifest(manifestsFor(await discover(['leaf1.example']))[0].text);
    const byCidr = new Map(manifest.subnets.map((s) => [s.body.cidr, s]));

    const vlan = byCidr.get('10.2.0.0/22')!;
    expect(vlan.body.kind).toBe('vlan');
    expect(vlan.body.metadata).toEqual({
      source: 'nxip-agent',
      network_id: '9ABCDEF0123',
      device: 'dc-leaf1',
      vrf: 'default',
      route_type: 'connected',
      interface: 'Vlan100',
      vlan_id: '100',
      gateway: '10.2.0.1',
    });

    expect(byCidr.get('10.0.2.0/31')!.body.kind).toBe('transit');
    expect(byCidr.get('192.168.1.0/24')!.body.kind).toBe('interface');

    const staticRoute = byCidr.get('10.5.0.0/24')!;
    expect(staticRoute.body.kind).toBe('route');
    expect(staticRoute.body.metadata?.route_type).toBe('static');
    expect(staticRoute.body.metadata?.next_hop).toBe('10.0.2.0');

    const learned = byCidr.get('10.8.0.0/24')!;
    expect(learned.body.kind).toBe('route');
    expect(learned.body.metadata?.route_type).toBe('learned');
    expect(learned.body.metadata?.protocol).toBe('bgp');
  });

  it('nests a prefix under the broader discovered prefix that contains it', async () => {
    // nxip refuses overlapping siblings, and a routing table nests by
    // nature. Here edge1 has a static 10.1.0.0/16 towards the core and the
    // /24 VLANs live inside it, so each of those has to name it as parent
    // rather than sit beside it and collide.
    const manifest = parseFullManifest(manifestsFor(await discover(['core1.example', 'edge1.example']))[0].text);
    const parentOf = new Map(manifest.subnets.map((s) => [s.body.cidr, s.parent]));
    expect(parentOf.get('10.1.10.0/24')).toBe('edge1 static 10.1.0.0/16');
    expect(parentOf.get('10.1.100.0/24')).toBe('edge1 static 10.1.0.0/16');
    expect(parentOf.get('10.1.0.0/16')).toBeUndefined();
  });

  it('is accepted by plan: every standalone entry previews, and the pools are compared', async () => {
    const manifest = parseFullManifest(manifestsFor(await discover(['leaf1.example']))[0].text);
    const options = { apiKey: 'test-key', baseUrl: 'https://nxip.test' };
    const previewed: unknown[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        if (url.endsWith('/v1/subnets/preview')) {
          previewed.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ wouldSucceed: true, cidr: '10.0.0.0/24', poolId: 'pool_1' }), { status: 200 });
        }
        if (url.includes('/v1/pools')) {
          return new Response(JSON.stringify({ data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 1 } }), { status: 200 });
        }
        throw new Error(`unexpected request to ${url}`);
      })
    );

    const planned = await planManifest(options, manifest.subnets);
    expect(planned.every((p) => p.result.wouldSucceed)).toBe(true);
    // The bodies the API is asked about carry the discovery, not a guess.
    expect(previewed).toContainEqual(
      expect.objectContaining({ cidr: '10.0.2.0/31', kind: 'transit', landingPoint: false, environment: 'production', region: 'hq' })
    );

    const pools = await planPools(options, manifest.pools);
    expect(pools.every((p) => p.status === 'will-create')).toBe(true);
  });

  it('carries the trust wording verbatim in the header of the CLI help text', () => {
    // The same array feeds --help and the README, so this is the one place
    // the wording lives.
    expect(WHAT_NXIP_NEVER_DOES.join(' ')).toContain('It never probes an endpoint.');
    expect(WHAT_NXIP_NEVER_DOES.join(' ')).toContain('No ping sweeps, no port scans');
  });
});

describe('the per-VRF split', () => {
  it('writes one manifest per VRF when two VRFs overlap, each with the bet #33 note', async () => {
    // core1 has 10.1.20.0/24 on Vlan20 in the default VRF; edge1 has the
    // same prefix in CUST-A. One organisation cannot hold both.
    const manifests = manifestsFor(await discover(['core1.example', 'edge1.example']));
    expect(manifests.map((m) => m.vrf)).toEqual(['default', 'CUST-A', 'MGMT']);

    for (const manifest of manifests) {
      expect(manifest.text).toContain(`# VRF ${manifest.vrf} only.`);
      for (const line of BET_33_NOTE) expect(manifest.text).toContain(line);
      // Each file is a manifest in its own right.
      expect(parseFullManifest(manifest.text).subnets.length).toBeGreaterThan(0);
    }
  });

  it('puts each VRF\'s prefixes in its own file and nowhere else', async () => {
    const manifests = manifestsFor(await discover(['core1.example', 'edge1.example']));
    const vrfsIn = (text: string) => new Set(parseFullManifest(text).subnets.map((s) => s.body.metadata?.vrf));

    expect(vrfsIn(manifests[0].text)).toEqual(new Set(['default']));
    expect(vrfsIn(manifests[1].text)).toEqual(new Set(['CUST-A']));
    expect(vrfsIn(manifests[2].text)).toEqual(new Set(['MGMT']));
  });

  it('keeps every VLAN in its own VRF\'s file rather than commenting one out', async () => {
    // The two sides of a cross-VRF collision land in different files, so
    // neither can be "commented out in favour of the other side". Doing it
    // anyway silently dropped core1's Vlan20 and Vlan30 from the default
    // VRF's own manifest.
    const manifests = manifestsFor(await discover(['core1.example', 'edge1.example']));
    expect(manifests[0].text).not.toContain('COMMENTED OUT');
    expect(manifests[0].text).not.toContain('# WARNING:');

    const defaultVrf = parseFullManifest(manifests[0].text);
    expect(defaultVrf.subnets.map((s) => s.body.cidr)).toContain('10.1.20.0/24');
    expect(defaultVrf.subnets.map((s) => s.body.cidr)).toContain('10.1.30.0/24');
    expect(parseFullManifest(manifests[1].text).subnets.map((s) => s.body.cidr)).toContain('10.1.20.0/24');
  });

  it('writes one manifest and no note when no two VRFs overlap', async () => {
    const manifests = manifestsFor(await discover(['leaf1.example']));
    expect(manifests).toHaveLength(1);
    expect(manifests[0].vrf).toBeNull();
    expect(manifests[0].text).not.toContain(BET_33_NOTE[0]);
  });
});

describe('pools in the manifest', () => {
  it('says the pools are a guess, and how to replace them', async () => {
    const text = manifestsFor(await discover(['leaf1.example']))[0].text;
    expect(text).toContain('# The pools below are a GUESS');
    expect(text).toContain('guessed: "true"');
  });

  it('uses a configured pool list instead, and stops calling it a guess', async () => {
    const text = manifestsFor(await discover(['leaf1.example']), { pools: ['10.0.0.0/14', '192.168.0.0/16', 'fd00::/16'] })[0].text;
    expect(text).not.toContain('# The pools below are a GUESS');
    expect(text).not.toContain('guessed: "true"');

    const manifest = parseFullManifest(text);
    expect(manifest.pools.map((p) => p.body.cidr)).toEqual(['10.0.0.0/14', '192.168.0.0/16', 'fd00::/16']);
  });

  it('lists prefixes that fall outside every given pool rather than dropping them silently', async () => {
    // 10.4.0.0/16, 10.5.0.0/24, 10.7.0.0/24 and 10.8.0.0/24 are all outside
    // a 10.0.0.0/14 pool. Losing them without a word is the failure that
    // would only be noticed months later.
    const text = manifestsFor(await discover(['leaf1.example']), { pools: ['10.0.0.0/14'] })[0].text;
    expect(text).toContain('# Left out: these prefixes fall outside every pool given.');
    expect(text).toContain('10.4.0.0/16');
    expect(text).toContain('10.8.0.0/24');

    const manifest = parseFullManifest(text);
    expect(manifest.subnets.map((s) => s.body.cidr)).not.toContain('10.4.0.0/16');
    expect(manifest.subnets.map((s) => s.body.cidr)).toContain('10.2.0.0/22');
  });
});

describe('the human report', () => {
  it('describes the devices, the prefixes by kind, the hosts and what was dropped', async () => {
    const report = analyseDiscovery(mergeDiscoveries([await discover(['core1.example', 'edge1.example'])]));
    const text = formatScanReport(report);

    expect(text).toContain('Cisco: 2 devices read at site hq');
    expect(text).toContain('core1  ios-xe 17.09.03a');
    expect(text).toContain('serial FTX1840A1B2');
    expect(text).toMatch(/routed prefixes: \d+ vlan, \d+ interface, \d+ transit, \d+ route/);
    expect(text).toContain('hosts in ARP');
    expect(text).toContain('Dropped ');
    expect(text).toContain('VRFs with overlapping address space: CUST-A, default.');
    // "Found 0 VPCs and 0 subnets" would be the only cloud-shaped line and
    // it says nothing true about a routing table.
    expect(text).not.toContain('Found 0 ');
  });

  it('records a device it could not read as a failure and keeps the rest of the run', async () => {
    const discovery = await discover(['core1.example', 'gone.example'], {
      openSession: async (target) => {
        if (target.host === 'gone.example') throw new Error('connect ETIMEDOUT');
        return transcriptSession(FIXTURES[target.host]);
      },
    });

    expect(discovery.cisco.devices.map((d) => d.hostname)).toEqual(['core1']);
    expect(discovery.cisco.failures).toEqual([{ host: 'gone.example', message: 'connect ETIMEDOUT' }]);
    expect(discovery.cisco.prefixes.length).toBeGreaterThan(0);
    // And the manifest says so where somebody reviewing it will see it.
    expect(manifestsFor(discovery)[0].text).toContain('#   gone.example: NOT READ, connect ETIMEDOUT');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
