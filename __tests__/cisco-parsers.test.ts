import { describe, expect, it } from 'vitest';
import {
  detectPlatform,
  parseIosArp,
  parseIosIpInterface,
  parseIosIpRoute,
  parseIosIpv6Interface,
  parseIosIpv6Route,
  parseIosVersion,
  parseIosVrfs,
} from '../src/cisco-ios.js';
import {
  parseNxosArp,
  parseNxosIpInterface,
  parseNxosIpv6Interface,
  parseNxosJson,
  parseNxosRoute,
  parseNxosVersion,
  parseNxosVrfs,
  rows,
  NxosJsonError,
} from '../src/cisco-nxos.js';
import { readDevice, CiscoScanError } from '../src/cisco.js';
import { loadTranscript, transcriptSession, TranscriptSession } from './cisco-fixtures.js';

/**
 * Every `show` command in the spec's table, on all three platforms, read
 * from the transcripts under test/fixtures/cisco. The assertions are exact
 * lists rather than counts or "contains": a parser that silently drops a
 * route line is the failure mode that matters here, and only a full list
 * catches it.
 *
 * The transcripts are synthetic, which their headers say. They are still
 * load-bearing: they are the formats the parsers claim to read, and a
 * change to a regex here fails them.
 */

const ios15 = loadTranscript('ios15-edge1.txt');
const iosxe17 = loadTranscript('iosxe17-core1.txt');
const nxos10 = loadTranscript('nxos10-leaf1.txt');

/** [prefix, vrf, code, origin, protocol, nextHops, interfaces, summary] per route, so one assertion covers a whole table. */
const routeRows = (routes: ReturnType<typeof parseIosIpRoute>) =>
  routes.map((r) => [r.prefix, r.vrf, r.code, r.origin, r.protocol, r.nextHops, r.interfaces, r.summary]);

const addressRows = (addresses: ReturnType<typeof parseIosIpInterface>) =>
  addresses.map((a) => [a.interface, a.prefix, a.address, a.vrf, a.secondary]);

const arpRows = (entries: ReturnType<typeof parseIosArp>) => entries.map((a) => [a.address, a.interface, a.vrf, a.own]);

describe('IOS 15 (edge1)', () => {
  it('names the platform from show version', () => {
    expect(detectPlatform(ios15.get('show version')!)).toBe('ios');
  });

  it('reads the identity: hostname, serial, version and model', () => {
    expect(parseIosVersion(ios15.get('show version')!)).toEqual({
      hostname: 'edge1',
      serial: 'FTX1840A1B2',
      platform: 'ios',
      version: '15.4(3)M2',
      model: 'CISCO2911/K9',
    });
  });

  it('reads the VRF table and the families each VRF carries', () => {
    expect(parseIosVrfs(ios15.get('show vrf')!)).toEqual([{ name: 'CUST-A', families: ['IPV4'] }]);
  });

  it('reads every addressed interface, with the VRF the address sits in', () => {
    // Gi0/1 has "Internet protocol processing disabled" and no address, so
    // it must not appear at all.
    expect(addressRows(parseIosIpInterface(ios15.get('show ip interface')!))).toEqual([
      ['GigabitEthernet0/0', '10.0.0.0/30', '10.0.0.2', 'default', false],
      ['GigabitEthernet0/1.100', '10.1.100.0/24', '10.1.100.1', 'default', false],
      ['GigabitEthernet0/2', '10.1.20.0/24', '10.1.20.1', 'CUST-A', false],
      ['GigabitEthernet0/3', '203.0.113.0/29', '203.0.113.1', 'default', false],
      ['Loopback0', '10.255.0.1/32', '10.255.0.1', 'default', false],
    ]);
  });

  it('reads global IPv6 addresses and leaves link-local and joined groups out', () => {
    expect(addressRows(parseIosIpv6Interface(ios15.get('show ipv6 interface')!))).toEqual([
      ['GigabitEthernet0/0', '2001:db8:0:1::/64', '2001:db8:0:1::2', 'default', false],
      ['GigabitEthernet0/1.100', 'fd00:1:100::/64', 'fd00:1:100::1', 'default', false],
    ]);
  });

  it('reads the global routing table, including a mask inherited from an "is subnetted" header', () => {
    // 172.16.5.0 prints with no prefix length under "172.16.0.0/24 is
    // subnetted", which is the only place the /24 appears. A parser that
    // ignores the header either drops the route or calls it a /32.
    expect(routeRows(parseIosIpRoute(ios15.get('show ip route')!))).toEqual([
      ['0.0.0.0/0', 'default', 'S*', 'static', null, ['203.0.113.6'], [], false],
      ['10.0.0.0/30', 'default', 'C', 'connected', null, [], ['GigabitEthernet0/0'], false],
      ['10.0.0.2/32', 'default', 'L', 'local', null, [], ['GigabitEthernet0/0'], false],
      ['10.1.0.0/16', 'default', 'S', 'static', null, ['10.0.0.1'], [], false],
      ['10.1.10.0/24', 'default', 'O', 'learned', 'ospf', ['10.0.0.1'], ['GigabitEthernet0/0'], false],
      ['10.1.11.0/24', 'default', 'O', 'learned', 'ospf', ['10.0.0.1'], ['GigabitEthernet0/0'], false],
      ['10.1.100.0/24', 'default', 'C', 'connected', null, [], ['GigabitEthernet0/1.100'], false],
      ['10.1.100.1/32', 'default', 'L', 'local', null, [], ['GigabitEthernet0/1.100'], false],
      ['10.9.0.0/16', 'default', 'S', 'static', null, [], ['Null0'], true],
      ['10.255.0.1/32', 'default', 'C', 'connected', null, [], ['Loopback0'], false],
      ['172.16.5.0/24', 'default', 'S', 'static', null, ['10.0.0.1'], [], false],
      ['192.168.50.0/24', 'default', 'O E2', 'learned', 'ospf', ['10.0.0.1'], ['GigabitEthernet0/0'], false],
      ['203.0.113.0/29', 'default', 'C', 'connected', null, [], ['GigabitEthernet0/3'], false],
      ['203.0.113.1/32', 'default', 'L', 'local', null, [], ['GigabitEthernet0/3'], false],
    ]);
  });

  it('reads a per-VRF routing table and labels every row with that VRF', () => {
    expect(routeRows(parseIosIpRoute(ios15.get('show ip route vrf CUST-A')!, 'CUST-A'))).toEqual([
      ['10.1.20.0/24', 'CUST-A', 'C', 'connected', null, [], ['GigabitEthernet0/2'], false],
      ['10.1.20.1/32', 'CUST-A', 'L', 'local', null, [], ['GigabitEthernet0/2'], false],
      ['10.1.30.0/24', 'CUST-A', 'S', 'static', null, ['10.1.20.254'], [], false],
    ]);
  });

  it('reads the IPv6 routing table, its two-line entries and its Null0 discard', () => {
    expect(routeRows(parseIosIpv6Route(ios15.get('show ipv6 route')!))).toEqual([
      ['::/0', 'default', 'S', 'static', null, ['2001:db8:0:1::1'], [], false],
      ['2001:db8:0:1::/64', 'default', 'C', 'connected', null, [], ['GigabitEthernet0/0'], false],
      ['2001:db8:0:1::2/128', 'default', 'L', 'local', null, [], ['GigabitEthernet0/0'], false],
      ['fd00:1:100::/64', 'default', 'C', 'connected', null, [], ['GigabitEthernet0/1.100'], false],
      ['fd00:1:100::1/128', 'default', 'L', 'local', null, [], ['GigabitEthernet0/1.100'], false],
      ['fd00:1:200::/64', 'default', 'S', 'static', null, ['2001:db8:0:1::1'], [], false],
      ['ff00::/8', 'default', 'L', 'local', null, [], ['Null0'], true],
    ]);
  });

  it('reads ARP, marking the device\'s own addresses and skipping incomplete entries', () => {
    // 10.1.100.21 is Incomplete: an address ARP asked about and got no
    // answer for, which is not a host seen.
    expect(arpRows(parseIosArp(ios15.get('show ip arp')!))).toEqual([
      ['10.0.0.1', 'GigabitEthernet0/0', 'default', false],
      ['10.0.0.2', 'GigabitEthernet0/0', 'default', true],
      ['10.1.100.1', 'GigabitEthernet0/1.100', 'default', true],
      ['10.1.100.20', 'GigabitEthernet0/1.100', 'default', false],
      ['203.0.113.1', 'GigabitEthernet0/3', 'default', true],
      ['203.0.113.6', 'GigabitEthernet0/3', 'default', false],
    ]);
  });

  it('reads per-VRF ARP under that VRF', () => {
    expect(arpRows(parseIosArp(ios15.get('show ip arp vrf CUST-A')!, 'CUST-A'))).toEqual([
      ['10.1.20.1', 'GigabitEthernet0/2', 'CUST-A', true],
      ['10.1.20.50', 'GigabitEthernet0/2', 'CUST-A', false],
      ['10.1.20.254', 'GigabitEthernet0/2', 'CUST-A', false],
    ]);
  });
});

describe('IOS-XE 17 (core1)', () => {
  it('tells IOS-XE apart from classic IOS', () => {
    expect(detectPlatform(iosxe17.get('show version')!)).toBe('ios-xe');
  });

  it('reads the identity', () => {
    expect(parseIosVersion(iosxe17.get('show version')!)).toEqual({
      hostname: 'core1',
      serial: '9KXYZABCDEF',
      platform: 'ios-xe',
      version: '17.09.03a',
      model: 'CSR1000V',
    });
  });

  it('reads a VRF whose route distinguisher is <not set>', () => {
    expect(parseIosVrfs(iosxe17.get('show vrf')!)).toEqual([{ name: 'MGMT', families: ['IPV4'] }]);
  });

  it('reads SVIs, a secondary address and a /31 interface address', () => {
    expect(addressRows(parseIosIpInterface(iosxe17.get('show ip interface')!))).toEqual([
      ['GigabitEthernet1', '10.0.0.0/30', '10.0.0.1', 'default', false],
      ['GigabitEthernet2', '10.0.1.0/31', '10.0.1.0', 'default', false],
      ['GigabitEthernet3', '192.168.0.0/24', '192.168.0.1', 'MGMT', false],
      ['Loopback0', '10.255.0.2/32', '10.255.0.2', 'default', false],
      ['Vlan10', '10.1.10.0/24', '10.1.10.1', 'default', false],
      ['Vlan10', '10.1.11.0/24', '10.1.11.1', 'default', true],
      ['Vlan20', '10.1.20.0/24', '10.1.20.1', 'default', false],
      ['Vlan30', '10.1.30.0/24', '10.1.30.1', 'default', false],
    ]);
  });

  it('reads every VRF from one `show ip route vrf *`, switching VRF on the Routing Table line', () => {
    const routes = parseIosIpRoute(iosxe17.get('show ip route vrf *')!);
    expect(routeRows(routes)).toEqual([
      ['0.0.0.0/0', 'default', 'S*', 'static', null, ['10.0.0.2'], [], false],
      ['10.0.0.0/30', 'default', 'C', 'connected', null, [], ['GigabitEthernet1'], false],
      ['10.0.0.1/32', 'default', 'L', 'local', null, [], ['GigabitEthernet1'], false],
      ['10.0.1.0/31', 'default', 'C', 'connected', null, [], ['GigabitEthernet2'], false],
      ['10.0.1.0/32', 'default', 'L', 'local', null, [], ['GigabitEthernet2'], false],
      ['10.1.10.0/24', 'default', 'C', 'connected', null, [], ['Vlan10'], false],
      ['10.1.10.1/32', 'default', 'L', 'local', null, [], ['Vlan10'], false],
      ['10.1.11.0/24', 'default', 'C', 'connected', null, [], ['Vlan10'], false],
      ['10.1.11.1/32', 'default', 'L', 'local', null, [], ['Vlan10'], false],
      ['10.1.20.0/24', 'default', 'C', 'connected', null, [], ['Vlan20'], false],
      ['10.1.20.1/32', 'default', 'L', 'local', null, [], ['Vlan20'], false],
      ['10.1.30.0/24', 'default', 'C', 'connected', null, [], ['Vlan30'], false],
      ['10.1.30.1/32', 'default', 'L', 'local', null, [], ['Vlan30'], false],
      ['10.1.100.0/24', 'default', 'S', 'static', null, ['10.0.0.2'], [], false],
      ['10.200.0.0/16', 'default', 'B', 'learned', 'bgp', ['10.0.1.1'], [], false],
      ['10.201.0.0/24', 'default', 'D EX', 'learned', 'eigrp', ['10.0.1.1'], ['GigabitEthernet2'], false],
      ['10.255.0.2/32', 'default', 'C', 'connected', null, [], ['Loopback0'], false],
      ['192.168.0.0/24', 'MGMT', 'C', 'connected', null, [], ['GigabitEthernet3'], false],
      ['192.168.0.1/32', 'MGMT', 'L', 'local', null, [], ['GigabitEthernet3'], false],
    ]);
    // The MGMT table's rows really did come from the second section.
    expect(routes.filter((r) => r.vrf === 'MGMT')).toHaveLength(2);
  });

  it('reads an IPv6 route whose code carries a digit (OE2)', () => {
    // OE1, OE2, ON1, ON2, I1 and I2 all end in a digit. A code pattern
    // without it skipped the line and then attached its `via` to the entry
    // above, losing one route and corrupting another.
    expect(routeRows(parseIosIpv6Route(iosxe17.get('show ipv6 route')!))).toEqual([
      ['2001:db8:0:1::/64', 'default', 'C', 'connected', null, [], ['GigabitEthernet1'], false],
      ['2001:db8:0:1::1/128', 'default', 'L', 'local', null, [], ['GigabitEthernet1'], false],
      ['fd00:1:10::/64', 'default', 'C', 'connected', null, [], ['Vlan10'], false],
      ['fd00:1:10::1/128', 'default', 'L', 'local', null, [], ['Vlan10'], false],
      ['fd00:1:100::/64', 'default', 'OE2', 'learned', 'ospf', ['fe80::1'], ['GigabitEthernet1'], false],
      ['ff00::/8', 'default', 'L', 'local', null, [], ['Null0'], true],
    ]);
  });

  it('reads ARP across several VLANs', () => {
    const entries = parseIosArp(iosxe17.get('show ip arp')!);
    expect(entries.filter((e) => !e.own).map((e) => e.address)).toEqual([
      '10.0.0.2',
      '10.0.1.1',
      '10.1.10.11',
      '10.1.10.12',
      '10.1.10.13',
      '10.1.20.50',
      '10.1.20.51',
    ]);
    expect(arpRows(parseIosArp(iosxe17.get('show ip arp vrf MGMT')!, 'MGMT'))).toEqual([
      ['192.168.0.1', 'GigabitEthernet3', 'MGMT', true],
      ['192.168.0.9', 'GigabitEthernet3', 'MGMT', false],
    ]);
  });
});

describe('NX-OS 10 (dc-leaf1)', () => {
  it('tells NX-OS apart from the plain-text show version', () => {
    expect(detectPlatform(nxos10.get('show version')!)).toBe('nxos');
  });

  it('reads the identity from show version | json', () => {
    expect(parseNxosVersion(nxos10.get('show version | json')!)).toEqual({
      hostname: 'dc-leaf1',
      serial: '9ABCDEF0123',
      platform: 'nxos',
      version: '10.3(1)',
      model: 'Nexus9000 C9300v Chassis',
    });
  });

  it('reads every VRF, including default and management', () => {
    expect(parseNxosVrfs(nxos10.get('show vrf all | json')!)).toEqual([
      { name: 'TENANT-B', families: [] },
      { name: 'default', families: [] },
      { name: 'management', families: [] },
    ]);
  });

  it('reads interface addresses across VRFs, with a secondary address', () => {
    expect(addressRows(parseNxosIpInterface(nxos10.get('show ip interface vrf all | json')!))).toEqual([
      ['Vlan100', '10.2.0.0/22', '10.2.0.1', 'default', false],
      ['Vlan100', '10.2.4.0/24', '10.2.4.1', 'default', true],
      ['Ethernet1/1', '10.0.2.0/31', '10.0.2.1', 'default', false],
      ['loopback0', '10.255.0.3/32', '10.255.0.3', 'default', false],
      ['mgmt0', '192.168.1.0/24', '192.168.1.10', 'management', false],
      ['Vlan200', '10.3.0.0/24', '10.3.0.1', 'TENANT-B', false],
    ]);
  });

  it('reads an IPv6 interface table that NX-OS rendered as a single object, not an array', () => {
    expect(addressRows(parseNxosIpv6Interface(nxos10.get('show ipv6 interface vrf all | json')!))).toEqual([
      ['Vlan100', 'fd00:2::/64', 'fd00:2::1', 'default', false],
    ]);
  });

  it('reads every VRF\'s routes, the client names, the ECMP paths and the discard route', () => {
    expect(routeRows(parseNxosRoute(nxos10.get('show ip route vrf all | json')!, 'IPV4'))).toEqual([
      ['10.3.0.0/24', 'TENANT-B', 'direct', 'connected', null, [], ['Vlan200'], false],
      ['10.3.0.1/32', 'TENANT-B', 'local', 'local', null, ['10.3.0.1'], ['Vlan200'], false],
      ['10.7.0.0/24', 'TENANT-B', 'static', 'static', null, ['10.3.0.254'], [], false],
      ['0.0.0.0/0', 'default', 'static', 'static', null, ['10.0.2.0'], [], false],
      ['10.0.2.0/31', 'default', 'direct', 'connected', null, [], ['Eth1/1'], false],
      ['10.0.2.1/32', 'default', 'local', 'local', null, ['10.0.2.1'], ['Eth1/1'], false],
      ['10.2.0.0/22', 'default', 'direct', 'connected', null, [], ['Vlan100'], false],
      ['10.2.0.1/32', 'default', 'local', 'local', null, ['10.2.0.1'], ['Vlan100'], false],
      ['10.2.4.0/24', 'default', 'direct', 'connected', null, [], ['Vlan100'], false],
      ['10.4.0.0/16', 'default', 'ospf-1', 'learned', 'ospf', ['10.0.2.0'], ['Eth1/1'], false],
      ['10.5.0.0/24', 'default', 'static', 'static', null, ['10.0.2.0'], [], false],
      // A BGP discard route to Null0: space claimed that leads nowhere.
      ['10.6.0.0/16', 'default', 'bgp-65000', 'learned', 'bgp', ['0.0.0.0'], ['Null0'], true],
      ['10.8.0.0/24', 'default', 'bgp-65000', 'learned', 'bgp', ['10.0.2.0', '10.2.0.9'], ['Eth1/1', 'Vlan100'], false],
      ['10.255.0.3/32', 'default', 'local', 'local', null, ['10.255.0.3'], ['Lo0'], false],
      ['0.0.0.0/0', 'management', 'static', 'static', null, ['192.168.1.1'], [], false],
      ['192.168.1.0/24', 'management', 'direct', 'connected', null, [], ['mgmt0'], false],
      ['192.168.1.10/32', 'management', 'local', 'local', null, ['192.168.1.10'], ['mgmt0'], false],
    ]);
  });

  it('reads the IPv6 routing table', () => {
    expect(routeRows(parseNxosRoute(nxos10.get('show ipv6 route vrf all | json')!, 'IPV6'))).toEqual([
      ['fd00:2::/64', 'default', 'direct', 'connected', null, [], ['Vlan100'], false],
      ['fd00:2::1/128', 'default', 'local', 'local', null, ['fd00:2::1'], ['Vlan100'], false],
      ['fd00:3::/48', 'default', 'static', 'static', null, ['fd00:2::2'], [], false],
    ]);
  });

  it('reads ARP across VRFs and skips the INCOMPLETE adjacency', () => {
    expect(arpRows(parseNxosArp(nxos10.get('show ip arp vrf all | json')!))).toEqual([
      ['10.2.0.9', 'Vlan100', 'default', false],
      ['10.2.1.40', 'Vlan100', 'default', false],
      ['10.0.2.0', 'Ethernet1/1', 'default', false],
      ['10.3.0.77', 'Vlan200', 'TENANT-B', false],
    ]);
  });

  it('reads a one-row table and a many-row table the same way', () => {
    expect(rows({ TABLE_x: { ROW_x: { a: 1 } } }, 'x')).toEqual([{ a: 1 }]);
    expect(rows({ TABLE_x: { ROW_x: [{ a: 1 }, { a: 2 }] } }, 'x')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(rows({}, 'x')).toEqual([]);
  });

  it('finds the JSON document inside whatever else the device printed', () => {
    expect(parseNxosJson('banner text\n{"host_name": "leaf"}\nmore')).toEqual({ host_name: 'leaf' });
    expect(() => parseNxosJson('no json here')).toThrow(NxosJsonError);
  });
});

describe('readDevice', () => {
  it('sends terminal length 0 first and runs the IOS command set', async () => {
    const session = transcriptSession('ios15-edge1.txt');
    const tables = await readDevice(session, 'edge1.example');

    expect(session.commands[0]).toBe('terminal length 0');
    expect(session.commands).toEqual([
      'terminal length 0',
      'show version',
      'show vrf',
      'show ip interface',
      'show ipv6 interface',
      // `vrf *` is refused on this release, so the fallback asks for the
      // global table and then each VRF by name.
      'show ip route vrf *',
      'show ip route',
      'show ip route vrf CUST-A',
      'show ipv6 route',
      'show ip arp',
      'show ip arp vrf CUST-A',
    ]);
    expect(tables.identity.hostname).toBe('edge1');
    expect(tables.refused.map((r) => r.command)).toEqual(['show ip route vrf *']);
    expect(tables.refused[0].message).toBe("% Invalid input detected at '^' marker.");
    // The fallback really produced both tables.
    expect(tables.routes.some((r) => r.vrf === 'CUST-A')).toBe(true);
    expect(tables.routes.some((r) => r.vrf === 'default')).toBe(true);
  });

  it('asks IOS-XE for `vrf *` once and does not fall back when it answers', async () => {
    const session = transcriptSession('iosxe17-core1.txt');
    const tables = await readDevice(session, 'core1.example');

    expect(session.commands).toEqual([
      'terminal length 0',
      'show version',
      'show vrf',
      'show ip interface',
      'show ipv6 interface',
      'show ip route vrf *',
      'show ipv6 route',
      'show ip arp',
      'show ip arp vrf MGMT',
    ]);
    expect(session.commands).not.toContain('show ip route');
    expect(tables.refused).toEqual([]);
    expect(tables.identity.platform).toBe('ios-xe');
  });

  it('runs the NX-OS JSON command set', async () => {
    const session = transcriptSession('nxos10-leaf1.txt');
    const tables = await readDevice(session, 'leaf1.example');

    expect(session.commands).toEqual([
      'terminal length 0',
      'show version',
      'show version | json',
      'show vrf all | json',
      'show ip interface vrf all | json',
      'show ipv6 interface vrf all | json',
      'show ip route vrf all | json',
      'show ipv6 route vrf all | json',
      'show ip arp vrf all | json',
    ]);
    expect(tables.identity).toEqual({
      hostname: 'dc-leaf1',
      serial: '9ABCDEF0123',
      platform: 'nxos',
      version: '10.3(1)',
      model: 'Nexus9000 C9300v Chassis',
    });
    expect(tables.vrfs.map((v) => v.name)).toEqual(['TENANT-B', 'default', 'management']);
  });

  it('records a refused command and keeps reading the device', async () => {
    const outputs = loadTranscript('ios15-edge1.txt');
    outputs.delete('show ip arp');
    const session = new TranscriptSession(outputs, '% Permission denied for the role');
    const tables = await readDevice(session, 'edge1.example');

    expect(tables.refused.map((r) => r.command)).toContain('show ip arp');
    expect(tables.arp.filter((a) => a.vrf === 'default')).toEqual([]);
    // Everything after the refusal was still asked and still parsed.
    expect(tables.arp.map((a) => a.vrf)).toEqual(['CUST-A', 'CUST-A', 'CUST-A']);
    expect(tables.routes.length).toBeGreaterThan(10);
  });

  it('refuses a device it cannot identify rather than guessing a command set', async () => {
    const session = new TranscriptSession(new Map([['show version', 'Juniper Networks, Inc. mx204']]));
    await expect(readDevice(session, 'not-a-cisco')).rejects.toThrow(CiscoScanError);
    await expect(readDevice(session, 'not-a-cisco')).rejects.toThrow(/could not tell IOS, IOS-XE or NX-OS apart/);
  });
});
