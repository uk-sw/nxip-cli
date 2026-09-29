import { describe, expect, it } from 'vitest';
import {
  classifyEstate,
  countHosts,
  dedupePrefixes,
  describePrefix,
  emptyDropCounts,
  findOverlappingVrfs,
  guessPools,
  parseHostSpec,
  prefixMetadata,
  readDevice,
  CiscoScanError,
  type DiscoveredPrefix,
} from '../src/cisco.js';
import type { ArpEntry, DeviceIdentity, DeviceTables, InterfaceAddress, RouteEntry } from '../src/cisco-types.js';
import { transcriptSession } from './cisco-fixtures.js';

/**
 * Classification, dedupe and pool sizing, on synthetic tables built here
 * rather than read off a device: each test says one rule and nothing else,
 * so a failure names the rule that broke. The fixtures cover the same code
 * end to end at the bottom of the file.
 */

function identity(hostname: string, serial = `SN-${hostname}`): DeviceIdentity {
  return { hostname, serial, platform: 'ios', version: '15.4', model: 'CISCO2911/K9' };
}

function address(iface: string, prefix: string, options: Partial<InterfaceAddress> = {}): InterfaceAddress {
  return {
    interface: iface,
    address: prefix.split('/')[0],
    prefix,
    family: prefix.includes(':') ? 'IPV6' : 'IPV4',
    vrf: 'default',
    secondary: false,
    ...options,
  };
}

function route(prefix: string, options: Partial<RouteEntry> = {}): RouteEntry {
  return {
    prefix,
    family: prefix.includes(':') ? 'IPV6' : 'IPV4',
    vrf: 'default',
    code: 'S',
    origin: 'static',
    protocol: null,
    nextHops: [],
    interfaces: [],
    summary: false,
    ...options,
  };
}

function tables(hostname: string, parts: Partial<DeviceTables> = {}): DeviceTables {
  return {
    identity: identity(hostname),
    vrfs: [],
    interfaces: [],
    routes: [],
    arp: [],
    refused: [],
    ...parts,
  };
}

/** One device's worth of classification, as classifyEstate does it. */
function classifyOne(parts: Partial<DeviceTables>, options: Parameters<typeof classifyEstate>[1] = {}) {
  return classifyEstate([{ host: 'device1.example', tables: tables('device1', parts) }], options);
}

describe('kinds', () => {
  it('calls any connected /30 or /31 a transit link, whatever it is configured on', () => {
    // Size decides, not the interface: a /30 on an SVI is still a
    // point-to-point link between two routers, never a user VLAN.
    const estate = classifyOne({
      interfaces: [address('GigabitEthernet1', '10.0.0.0/30'), address('GigabitEthernet2', '10.0.1.0/31'), address('Vlan900', '10.0.2.0/30')],
    });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind])).toEqual([
      ['10.0.0.0/30', 'transit'],
      ['10.0.1.0/31', 'transit'],
      ['10.0.2.0/30', 'transit'],
    ]);
  });

  it('calls a connected /127 a transit link on IPv6', () => {
    const estate = classifyOne({ interfaces: [address('GigabitEthernet1', 'fd00::/127'), address('GigabitEthernet2', 'fd00:1::/126')] });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind])).toEqual([
      ['fd00::/127', 'transit'],
      ['fd00:1::/126', 'interface'],
    ]);
  });

  it('calls an SVI or a dot1q sub-interface a VLAN, and records the id and the gateway', () => {
    const estate = classifyOne({
      interfaces: [address('Vlan10', '10.1.10.0/24', { address: '10.1.10.1' }), address('GigabitEthernet0/1.100', '10.1.100.0/24', { address: '10.1.100.1' })],
    });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind, p.vlanId, p.gateway])).toEqual([
      ['10.1.10.0/24', 'vlan', '10', '10.1.10.1'],
      ['10.1.100.0/24', 'vlan', '100', '10.1.100.1'],
    ]);
  });

  it('calls any other connected prefix an interface', () => {
    const estate = classifyOne({ interfaces: [address('GigabitEthernet0/3', '10.5.0.0/24', { address: '10.5.0.1' })] });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind, p.vlanId])).toEqual([['10.5.0.0/24', 'interface', undefined]]);
  });

  it('calls a static route a route, with its next hop', () => {
    const estate = classifyOne({ routes: [route('10.9.0.0/24', { nextHops: ['10.0.0.1'] })] });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind, p.routeType, p.nextHop])).toEqual([['10.9.0.0/24', 'route', 'static', '10.0.0.1']]);
  });

  it('calls a learned route a route, with its protocol and no next hop', () => {
    const estate = classifyOne({
      routes: [
        route('10.10.0.0/24', { origin: 'learned', protocol: 'ospf', code: 'O', nextHops: ['10.0.0.1'] }),
        route('10.11.0.0/24', { origin: 'learned', protocol: 'bgp', code: 'B', nextHops: ['10.0.0.1'] }),
      ],
    });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind, p.routeType, p.protocol, p.nextHop])).toEqual([
      ['10.10.0.0/24', 'route', 'learned', 'ospf', undefined],
      ['10.11.0.0/24', 'route', 'learned', 'bgp', undefined],
    ]);
  });

  it('prefers the connected entry over a static route for the same prefix on the same device', () => {
    const estate = classifyOne({
      interfaces: [address('Vlan10', '10.1.10.0/24', { address: '10.1.10.1' })],
      routes: [route('10.1.10.0/24', { nextHops: ['10.0.0.1'] })],
    });
    expect(estate.prefixes).toHaveLength(1);
    expect(estate.prefixes[0].kind).toBe('vlan');
    expect(estate.prefixes[0].routeType).toBe('connected');
  });

  it('falls back to the routing table for a connected prefix when the interface table was refused', () => {
    const estate = classifyOne({ routes: [route('10.1.10.0/24', { origin: 'connected', code: 'C', interfaces: ['Vlan10'] })] });
    expect(estate.prefixes.map((p) => [p.cidr, p.kind, p.routeType, p.interface, p.gateway])).toEqual([
      // No gateway: the routing table names the interface but not its address.
      ['10.1.10.0/24', 'vlan', 'connected', 'Vlan10', undefined],
    ]);
  });
});

describe('the drop list', () => {
  const dropped = (parts: Partial<DeviceTables>, options: Parameters<typeof classifyEstate>[1] = {}) => classifyOne(parts, options).dropped;

  it('drops the default route on both families', () => {
    const estate = classifyOne({ routes: [route('0.0.0.0/0', { nextHops: ['10.0.0.1'] }), route('::/0', { nextHops: ['fd00::1'] })] });
    expect(estate.prefixes).toEqual([]);
    expect(estate.dropped.defaultRoute).toBe(2);
  });

  it('drops local host routes: /32 on IPv4 and /128 on IPv6', () => {
    const counts = dropped({
      routes: [
        route('10.0.0.2/32', { origin: 'local', code: 'L' }),
        route('fd00::2/128', { origin: 'local', code: 'L' }),
        // A static host route is a /32 too and is no more an address plan.
        route('10.9.9.9/32'),
      ],
    });
    expect(counts.hostRoute).toBe(3);
  });

  it('drops a summary or null route', () => {
    const counts = dropped({
      routes: [route('10.9.0.0/16', { interfaces: ['Null0'], summary: true }), route('10.8.0.0/16', { origin: 'learned', protocol: 'bgp', code: 'B', summary: true })],
    });
    expect(counts.summary).toBe(2);
  });

  it('drops link-local, loopback and multicast space', () => {
    const counts = dropped({
      routes: [route('169.254.0.0/16'), route('127.0.0.0/8'), route('224.0.0.0/4'), route('fe80::/64'), route('ff00::/8')],
    });
    expect(counts.linkLocal).toBe(5);
  });

  it('drops public space unless asked for it, on both families', () => {
    const parts = { routes: [route('203.0.113.0/29'), route('2001:db8::/64')] };
    expect(dropped(parts).public).toBe(2);
    expect(classifyOne(parts, { includePublic: true }).prefixes.map((p) => p.cidr)).toEqual(['203.0.113.0/29', '2001:db8::/64']);
  });

  it('keeps every RFC 1918 block and fc00::/7 without being asked', () => {
    const estate = classifyOne({ routes: [route('10.1.0.0/16'), route('172.16.5.0/24'), route('192.168.50.0/24'), route('fd00:1::/48')] });
    expect(estate.prefixes.map((p) => p.cidr)).toEqual(['10.1.0.0/16', '172.16.5.0/24', '192.168.50.0/24', 'fd00:1::/48']);
    expect(estate.dropped).toEqual(emptyDropCounts());
  });

  it('drops learned routes under static_only, and counts them separately', () => {
    const parts = {
      routes: [route('10.1.0.0/16'), route('10.2.0.0/16', { origin: 'learned' as const, protocol: 'ospf', code: 'O' })],
    };
    expect(classifyOne(parts).prefixes.map((p) => p.cidr)).toEqual(['10.1.0.0/16', '10.2.0.0/16']);
    const only = classifyOne(parts, { staticOnly: true });
    expect(only.prefixes.map((p) => p.cidr)).toEqual(['10.1.0.0/16']);
    expect(only.dropped.learned).toBe(1);
  });

  it('drops HSRP, NHRP and anything else nobody plans address space with', () => {
    const counts = dropped({ routes: [route('10.3.0.0/24', { origin: 'other', code: 'H' })] });
    expect(counts.other).toBe(1);
  });

  it('keeps only the named VRFs when a filter is given', () => {
    const parts = {
      interfaces: [address('Vlan10', '10.1.10.0/24'), address('Vlan20', '10.1.20.0/24', { vrf: 'CUST-A' })],
      routes: [route('10.9.0.0/24', { vrf: 'CUST-B' })],
    };
    const filtered = classifyOne(parts, { vrfs: ['default'] });
    expect(filtered.prefixes.map((p) => [p.cidr, p.vrf])).toEqual([['10.1.10.0/24', 'default']]);
    expect(filtered.dropped.vrfFiltered).toBe(2);
  });
});

describe('dedupe across devices', () => {
  const connected = (device: string, prefix: string, iface = 'Vlan10'): DiscoveredPrefix => ({
    cidr: prefix,
    family: 'IPV4',
    vrf: 'default',
    kind: 'vlan',
    routeType: 'connected',
    device,
    serial: `SN-${device}`,
    interface: iface,
    seenOn: [],
    hosts: 0,
  });
  const learned = (device: string, prefix: string): DiscoveredPrefix => ({
    cidr: prefix,
    family: 'IPV4',
    vrf: 'default',
    kind: 'route',
    routeType: 'learned',
    device,
    serial: `SN-${device}`,
    protocol: 'ospf',
    seenOn: [],
    hosts: 0,
  });

  it('collapses one prefix connected on one device and learned on two into a single subnet', () => {
    const merged = dedupePrefixes([[connected('core1', '10.1.10.0/24')], [learned('edge1', '10.1.10.0/24')], [learned('edge2', '10.1.10.0/24')]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].device).toBe('core1');
    expect(merged[0].kind).toBe('vlan');
    expect(merged[0].seenOn).toEqual(['edge1', 'edge2']);
  });

  it('gives the connected device the attribution even when a routing device was read first', () => {
    const merged = dedupePrefixes([[learned('edge1', '10.1.10.0/24')], [learned('edge2', '10.1.10.0/24')], [connected('core1', '10.1.10.0/24')]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].device).toBe('core1');
    expect(merged[0].routeType).toBe('connected');
    expect(merged[0].seenOn).toEqual(['edge1', 'edge2']);
  });

  it('keeps the first device when nobody has the prefix connected', () => {
    const merged = dedupePrefixes([[learned('edge1', '10.1.10.0/24')], [learned('edge2', '10.1.10.0/24')]]);
    expect(merged[0].device).toBe('edge1');
    expect(merged[0].seenOn).toEqual(['edge2']);
  });

  it('keeps the same prefix in two VRFs apart', () => {
    const a = connected('core1', '10.1.20.0/24');
    const b = { ...connected('edge1', '10.1.20.0/24'), vrf: 'CUST-A' };
    expect(dedupePrefixes([[a], [b]])).toHaveLength(2);
  });

  it('never lists a device in its own seen_on', () => {
    const merged = dedupePrefixes([[learned('core1', '10.1.10.0/24')], [connected('core1', '10.1.10.0/24')]]);
    expect(merged[0].seenOn).toEqual([]);
  });
});

describe('ARP host counting', () => {
  const arp = (address: string, vrf = 'default', own = false): ArpEntry => ({ address, interface: 'Vlan10', vrf, own });

  it('counts each address once into the most specific prefix of its VRF', () => {
    const prefixes: DiscoveredPrefix[] = [
      { cidr: '10.1.0.0/16', family: 'IPV4', vrf: 'default', kind: 'route', routeType: 'static', device: 'edge1', serial: null, seenOn: [], hosts: 0 },
      { cidr: '10.1.10.0/24', family: 'IPV4', vrf: 'default', kind: 'vlan', routeType: 'connected', device: 'core1', serial: null, seenOn: [], hosts: 0 },
    ];
    // Two devices see the same host on the VLAN; that is one host, and it
    // belongs to the /24, not the /16 that also contains it. The router's
    // own address is not a host.
    const total = countHosts(prefixes, [arp('10.1.10.11'), arp('10.1.10.11'), arp('10.1.10.1', 'default', true), arp('10.1.99.7')]);
    expect(total).toBe(2);
    expect(prefixes.find((p) => p.cidr === '10.1.10.0/24')!.hosts).toBe(1);
    expect(prefixes.find((p) => p.cidr === '10.1.0.0/16')!.hosts).toBe(1);
  });

  it('counts the same address in two VRFs as two hosts', () => {
    const prefixes: DiscoveredPrefix[] = [
      { cidr: '10.1.10.0/24', family: 'IPV4', vrf: 'default', kind: 'vlan', routeType: 'connected', device: 'core1', serial: null, seenOn: [], hosts: 0 },
      { cidr: '10.1.10.0/24', family: 'IPV4', vrf: 'CUST-A', kind: 'vlan', routeType: 'connected', device: 'edge1', serial: null, seenOn: [], hosts: 0 },
    ];
    expect(countHosts(prefixes, [arp('10.1.10.50'), arp('10.1.10.50', 'CUST-A')])).toBe(2);
  });
});

describe('overlapping VRFs', () => {
  const at = (cidr: string, vrf: string): DiscoveredPrefix => ({
    cidr,
    family: cidr.includes(':') ? 'IPV6' : 'IPV4',
    vrf,
    kind: 'vlan',
    routeType: 'connected',
    device: 'core1',
    serial: null,
    seenOn: [],
    hosts: 0,
  });

  it('names both VRFs when the same prefix is in each', () => {
    expect(findOverlappingVrfs([at('10.1.20.0/24', 'default'), at('10.1.20.0/24', 'CUST-A')])).toEqual(['CUST-A', 'default']);
  });

  it('names both VRFs when one prefix contains the other', () => {
    expect(findOverlappingVrfs([at('10.1.0.0/16', 'default'), at('10.1.20.0/24', 'CUST-A')])).toEqual(['CUST-A', 'default']);
  });

  it('names nothing when the VRFs are numbered apart', () => {
    expect(findOverlappingVrfs([at('10.1.0.0/16', 'default'), at('10.2.0.0/16', 'CUST-A')])).toEqual([]);
  });

  it('finds an IPv6 overlap too', () => {
    expect(findOverlappingVrfs([at('fd00:1::/48', 'default'), at('fd00:1:0:5::/64', 'CUST-A')])).toEqual(['CUST-A', 'default']);
  });
});

describe('pool sizing', () => {
  const found = (cidr: string, vrf = 'default'): DiscoveredPrefix => ({
    cidr,
    family: cidr.includes(':') ? 'IPV6' : 'IPV4',
    vrf,
    kind: 'vlan',
    routeType: 'connected',
    device: 'core1',
    serial: null,
    seenOn: [],
    hosts: 0,
  });

  it('covers 10.1.0.0/16 and 10.2.0.0/16 with 10.0.0.0/14 and never with 10.0.0.0/8', () => {
    const pools = guessPools([found('10.1.0.0/16'), found('10.2.0.0/16')], { site: 'hq' });
    expect(pools).toEqual([{ name: 'hq 10.0.0.0/14', cidr: '10.0.0.0/14', family: 'IPV4', guessed: true }]);
    expect(pools[0].cidr).not.toBe('10.0.0.0/8');
  });

  it('gives one pool per RFC 1918 block touched, never one block spanning two', () => {
    // 10-space and 172.16-space are two plans. One covering block would be
    // 0.0.0.0/1, which is not an address plan anybody has.
    const pools = guessPools([found('10.1.0.0/16'), found('172.16.5.0/24'), found('192.168.50.0/24')], { site: 'hq' });
    expect(pools.map((p) => p.cidr)).toEqual(['10.1.0.0/16', '172.16.5.0/24', '192.168.50.0/24']);
  });

  it('never guesses wider than the RFC 1918 block it sits in', () => {
    const pools = guessPools([found('10.0.0.0/30'), found('10.255.255.0/24')], { site: 'hq' });
    expect(pools.map((p) => p.cidr)).toEqual(['10.0.0.0/8']);
  });

  it('lets a configured pool list replace the guess', () => {
    const pools = guessPools([found('10.1.0.0/16'), found('10.2.0.0/16')], { site: 'hq', pools: ['10.0.0.0/8'] });
    expect(pools).toEqual([{ name: 'hq 10.0.0.0/8', cidr: '10.0.0.0/8', family: 'IPV4', guessed: false }]);
  });

  it('normalises a configured pool whose host bits are set', () => {
    expect(guessPools([found('10.1.0.0/16')], { site: 'hq', pools: ['10.1.2.3/14'] })[0].cidr).toBe('10.0.0.0/14');
  });

  it('refuses a configured pool that is not a CIDR', () => {
    expect(() => guessPools([found('10.1.0.0/16')], { site: 'hq', pools: ['10.0.0.0'] })).toThrow(CiscoScanError);
  });

  it('groups IPv6 unique-local space into one pool', () => {
    const pools = guessPools([found('fd00:1:10::/64'), found('fd00:1:20::/64')], { site: 'hq' });
    expect(pools).toHaveLength(1);
    expect(pools[0].family).toBe('IPV6');
    expect(pools[0].guessed).toBe(true);
  });
});

describe('metadata on every entry', () => {
  it('carries source, network_id, device, vrf and route_type, plus what the kind adds', () => {
    const prefix: DiscoveredPrefix = {
      cidr: '10.1.10.0/24',
      family: 'IPV4',
      vrf: 'CUST-A',
      kind: 'vlan',
      routeType: 'connected',
      device: 'core1',
      serial: '9KXYZABCDEF',
      interface: 'Vlan10',
      vlanId: '10',
      gateway: '10.1.10.1',
      seenOn: ['edge1', 'edge2'],
      hosts: 3,
    };
    expect(prefixMetadata(prefix)).toEqual({
      source: 'nxip-agent',
      network_id: '9KXYZABCDEF',
      device: 'core1',
      vrf: 'CUST-A',
      route_type: 'connected',
      interface: 'Vlan10',
      vlan_id: '10',
      gateway: '10.1.10.1',
      seen_on: 'edge1,edge2',
    });
  });

  it('falls back to the hostname as network_id when the platform printed no serial', () => {
    const prefix: DiscoveredPrefix = {
      cidr: '10.9.0.0/24',
      family: 'IPV4',
      vrf: 'default',
      kind: 'route',
      routeType: 'static',
      device: 'edge1',
      serial: null,
      nextHop: '10.0.0.1',
      seenOn: [],
      hosts: 0,
    };
    expect(prefixMetadata(prefix)).toEqual({
      source: 'nxip-agent',
      network_id: 'edge1',
      device: 'edge1',
      vrf: 'default',
      route_type: 'static',
      next_hop: '10.0.0.1',
    });
  });

  it('truncates seen_on rather than losing the entry to the API\'s 256-character cap', () => {
    const prefix: DiscoveredPrefix = {
      cidr: '10.9.0.0/24',
      family: 'IPV4',
      vrf: 'default',
      kind: 'route',
      routeType: 'learned',
      device: 'edge1',
      serial: null,
      seenOn: Array.from({ length: 60 }, (_, i) => `core-switch-${i}`),
      hosts: 0,
    };
    const seenOn = prefixMetadata(prefix).seen_on;
    expect(seenOn.length).toBeLessThanOrEqual(256);
    expect(seenOn.endsWith('...')).toBe(true);
  });
});

describe('host specs and names', () => {
  it('splits host, host:port and a bracketed IPv6 address', () => {
    expect(parseHostSpec('core1.example')).toEqual({ host: 'core1.example', port: 22 });
    expect(parseHostSpec('core1.example:2222')).toEqual({ host: 'core1.example', port: 2222 });
    expect(parseHostSpec('[2001:db8::1]:2222')).toEqual({ host: '2001:db8::1', port: 2222 });
    expect(parseHostSpec('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 22 });
  });

  it('names a prefix by how it was found', () => {
    const base = { cidr: '10.1.10.0/24', family: 'IPV4' as const, vrf: 'default', device: 'core1', serial: null, seenOn: [], hosts: 0 };
    expect(describePrefix({ ...base, kind: 'vlan', routeType: 'connected', interface: 'Vlan10' })).toBe('core1 Vlan10');
    expect(describePrefix({ ...base, kind: 'route', routeType: 'static' })).toBe('core1 static 10.1.10.0/24');
    expect(describePrefix({ ...base, kind: 'route', routeType: 'learned', protocol: 'ospf' })).toBe('core1 ospf 10.1.10.0/24');
  });
});

describe('the whole estate, from the fixtures', () => {
  it('classifies two IOS devices into one set of prefixes with the right kinds and seen_on', async () => {
    const core1 = await readDevice(transcriptSession('iosxe17-core1.txt'), 'core1.example');
    const edge1 = await readDevice(transcriptSession('ios15-edge1.txt'), 'edge1.example');
    const estate = classifyEstate([
      { host: 'core1.example', tables: core1 },
      { host: 'edge1.example', tables: edge1 },
    ]);

    expect(estate.prefixes.map((p) => [p.cidr, p.vrf, p.kind, p.routeType, p.device, p.seenOn])).toEqual([
      ['10.0.0.0/30', 'default', 'transit', 'connected', 'core1', ['edge1']],
      ['10.0.1.0/31', 'default', 'transit', 'connected', 'core1', []],
      ['192.168.0.0/24', 'MGMT', 'interface', 'connected', 'core1', []],
      ['10.1.10.0/24', 'default', 'vlan', 'connected', 'core1', ['edge1']],
      ['10.1.11.0/24', 'default', 'vlan', 'connected', 'core1', ['edge1']],
      ['10.1.20.0/24', 'default', 'vlan', 'connected', 'core1', []],
      ['10.1.30.0/24', 'default', 'vlan', 'connected', 'core1', []],
      ['fd00:1:10::/64', 'default', 'vlan', 'connected', 'core1', []],
      // Connected on edge1, static on core1: the connected side wins even
      // though core1 was read first.
      ['10.1.100.0/24', 'default', 'vlan', 'connected', 'edge1', ['core1']],
      ['10.200.0.0/16', 'default', 'route', 'learned', 'core1', []],
      ['10.201.0.0/24', 'default', 'route', 'learned', 'core1', []],
      ['fd00:1:100::/64', 'default', 'vlan', 'connected', 'edge1', ['core1']],
      ['10.1.20.0/24', 'CUST-A', 'interface', 'connected', 'edge1', []],
      ['10.1.0.0/16', 'default', 'route', 'static', 'edge1', []],
      ['172.16.5.0/24', 'default', 'route', 'static', 'edge1', []],
      ['192.168.50.0/24', 'default', 'route', 'learned', 'edge1', []],
      ['10.1.30.0/24', 'CUST-A', 'route', 'static', 'edge1', []],
      ['fd00:1:200::/64', 'default', 'route', 'static', 'edge1', []],
    ]);

    // The loopback /32s, the two default routes and the Null0 static are
    // all off the list, and the public /29 and the 2001:db8 space with them.
    expect(estate.dropped.hostRoute).toBe(21);
    expect(estate.dropped.defaultRoute).toBe(3);
    expect(estate.dropped.summary).toBe(1);
    expect(estate.dropped.public).toBeGreaterThan(0);
    expect(estate.prefixes.some((p) => p.cidr.startsWith('203.0.113'))).toBe(false);
    expect(estate.prefixes.some((p) => p.cidr.endsWith('/32'))).toBe(false);

    // 10.1.20.0/24 is in the default VRF on core1 and in CUST-A on edge1.
    expect(estate.overlappingVrfs).toEqual(['CUST-A', 'default']);

    // ARP: 203.0.113.6 has no home prefix once public space is dropped.
    expect(estate.hosts).toBe(12);
    expect(estate.prefixes.find((p) => p.cidr === '10.1.10.0/24')!.hosts).toBe(3);
  });

  it('classifies an NX-OS device, dropping its BGP discard route', async () => {
    const leaf1 = await readDevice(transcriptSession('nxos10-leaf1.txt'), 'leaf1.example');
    const estate = classifyEstate([{ host: 'leaf1.example', tables: leaf1 }]);

    expect(estate.prefixes.map((p) => [p.cidr, p.vrf, p.kind, p.routeType])).toEqual([
      ['10.2.0.0/22', 'default', 'vlan', 'connected'],
      ['10.2.4.0/24', 'default', 'vlan', 'connected'],
      ['10.0.2.0/31', 'default', 'transit', 'connected'],
      ['192.168.1.0/24', 'management', 'interface', 'connected'],
      ['10.3.0.0/24', 'TENANT-B', 'vlan', 'connected'],
      ['fd00:2::/64', 'default', 'vlan', 'connected'],
      ['10.7.0.0/24', 'TENANT-B', 'route', 'static'],
      ['10.4.0.0/16', 'default', 'route', 'learned'],
      ['10.5.0.0/24', 'default', 'route', 'static'],
      ['10.8.0.0/24', 'default', 'route', 'learned'],
      ['fd00:3::/48', 'default', 'route', 'static'],
    ]);
    expect(estate.prefixes.some((p) => p.cidr === '10.6.0.0/16')).toBe(false);
    expect(estate.dropped.summary).toBe(1);
    expect(estate.overlappingVrfs).toEqual([]);
  });
});
