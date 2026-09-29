import { parseIpv4Cidr } from './cidr.js';
import { parseIpv6Cidr } from './ipv6.js';
import type { ArpEntry, DeviceIdentity, InterfaceAddress, RouteEntry, RouteOrigin, VrfInfo } from './cisco-types.js';

/**
 * Parsers for what NX-OS prints under `| json`. The output is the XML
 * data model rendered as JSON, with one quirk that every parser here has
 * to absorb: a table with one row renders ROW_x as an object, and a table
 * with several renders it as an array. `rows()` below turns both into an
 * array so nothing else has to care.
 *
 * Values arrive as strings even when they are numbers ("masklen": "24"),
 * and on some releases as numbers, so they are read through `text()`.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** TABLE_x.ROW_x as an array, whether NX-OS printed one row or many. */
export function rows(container: unknown, name: string): Json[] {
  const table = asObject(asObject(container)?.[`TABLE_${name}`]);
  const row = table?.[`ROW_${name}`];
  if (Array.isArray(row)) return row.map(asObject).filter((r): r is Json => r !== null);
  const single = asObject(row);
  return single ? [single] : [];
}

export class NxosJsonError extends Error {}

/**
 * `| json` output is one document, but a device with paging left on, or a
 * banner in the way, can wrap it. The document is found by its first and
 * last braces rather than trusting the whole buffer.
 */
export function parseNxosJson(output: string): Json {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new NxosJsonError('No JSON document in the output.');
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    const object = asObject(parsed);
    if (!object) throw new NxosJsonError('JSON output is not an object.');
    return object;
  } catch (error) {
    if (error instanceof NxosJsonError) throw error;
    throw new NxosJsonError(`Could not parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseNxosVersion(output: string): DeviceIdentity {
  const doc = parseNxosJson(output);
  return {
    hostname: text(doc.host_name) ?? 'unknown',
    serial: text(doc.proc_board_id) ?? null,
    platform: 'nxos',
    version: text(doc.nxos_ver_str) ?? text(doc.kickstart_ver_str) ?? text(doc.sys_ver_str) ?? null,
    model: text(doc.chassis_id) ?? null,
  };
}

/** `show vrf all | json`. NX-OS does not say which families a VRF carries here. */
export function parseNxosVrfs(output: string): VrfInfo[] {
  const doc = parseNxosJson(output);
  return rows(doc, 'vrf')
    .map((row) => text(row.vrf_name) ?? text(row['vrf-name-out']))
    .filter((name): name is string => name !== null)
    .map((name) => ({ name, families: [] }));
}

/**
 * `show ip interface vrf all | json`. The primary address is `prefix` with
 * `masklen`; secondaries sit in TABLE_secondary_address with the same
 * fields suffixed 1. An interface with no address has no `prefix`.
 */
export function parseNxosIpInterface(output: string): InterfaceAddress[] {
  const doc = parseNxosJson(output);
  const addresses: InterfaceAddress[] = [];
  for (const row of rows(doc, 'intf')) {
    const name = text(row['intf-name']);
    if (!name) continue;
    const vrf = text(row['vrf-name-out']) ?? 'default';
    const push = (address: string | null, masklen: string | null, secondary: boolean) => {
      if (!address || !masklen) return;
      const range = parseIpv4Cidr(`${address}/${masklen}`);
      if (!range) return;
      addresses.push({ interface: name, address, prefix: range.cidr, family: 'IPV4', vrf, secondary });
    };
    push(text(row.prefix), text(row.masklen), false);
    for (const secondary of rows(row, 'secondary_address')) {
      push(text(secondary.prefix1), text(secondary.masklen1), true);
    }
  }
  return addresses;
}

/**
 * `show ipv6 interface vrf all | json`. Global addresses are rows of
 * TABLE_addr, each carrying the address with its prefix length. The
 * link-local address is a separate field and is left out on purpose.
 */
export function parseNxosIpv6Interface(output: string): InterfaceAddress[] {
  const doc = parseNxosJson(output);
  const addresses: InterfaceAddress[] = [];
  for (const row of rows(doc, 'intf')) {
    const name = text(row['intf-name']);
    if (!name) continue;
    const vrf = text(row['vrf-name-out']) ?? 'default';
    let first = true;
    for (const addr of rows(row, 'addr')) {
      const value = text(addr.addr);
      if (!value) continue;
      const range = parseIpv6Cidr(value);
      if (!range) continue;
      addresses.push({ interface: name, address: value.split('/')[0].toLowerCase(), prefix: range.cidr, family: 'IPV6', vrf, secondary: !first });
      first = false;
    }
  }
  return addresses;
}

/**
 * NX-OS names the client that installed a route rather than printing a
 * code: direct, local, static, ospf-1, bgp-65000, eigrp-1, isis-1, rip-1.
 * The instance suffix is dropped for the protocol name.
 */
function originOfClient(client: string): { origin: RouteOrigin; protocol: string | null } {
  const name = client.toLowerCase().replace(/-.*$/, '');
  switch (name) {
    case 'direct':
      return { origin: 'connected', protocol: null };
    case 'local':
    case 'broadcast':
      return { origin: 'local', protocol: null };
    case 'static':
      return { origin: 'static', protocol: null };
    case 'ospf':
    case 'ospfv3':
      return { origin: 'learned', protocol: 'ospf' };
    case 'eigrp':
      return { origin: 'learned', protocol: 'eigrp' };
    case 'bgp':
      return { origin: 'learned', protocol: 'bgp' };
    case 'isis':
      return { origin: 'learned', protocol: 'isis' };
    case 'rip':
      return { origin: 'learned', protocol: 'rip' };
    default:
      // am (adjacency manager host routes), hsrp, vrrp, and anything else.
      return { origin: 'other', protocol: null };
  }
}

/**
 * `show ip route vrf all | json` and its ipv6 twin: VRF rows, each holding
 * address-family rows, each holding prefix rows, each holding path rows.
 * One RouteEntry per prefix, with every path's next hop and interface.
 */
export function parseNxosRoute(output: string, family: 'IPV4' | 'IPV6'): RouteEntry[] {
  const doc = parseNxosJson(output);
  const routes: RouteEntry[] = [];
  for (const vrfRow of rows(doc, 'vrf')) {
    const vrf = text(vrfRow['vrf-name-out']) ?? 'default';
    for (const addrf of rows(vrfRow, 'addrf')) {
      for (const prefixRow of rows(addrf, 'prefix')) {
        const printed = text(prefixRow.ipprefix);
        if (!printed) continue;
        const range = family === 'IPV4' ? parseIpv4Cidr(printed) : parseIpv6Cidr(printed);
        if (!range) continue;

        const paths = rows(prefixRow, 'path');
        const nextHops: string[] = [];
        const interfaces: string[] = [];
        let client: string | null = null;
        for (const path of paths) {
          const hop = text(path.ipnexthop);
          const ifname = text(path.ifname);
          if (hop) nextHops.push(family === 'IPV6' ? hop.toLowerCase() : hop);
          if (ifname) interfaces.push(ifname);
          client ??= text(path.clientname);
        }
        // Connected routes list the interface's own address as the next
        // hop, which is not a next hop in the sense a static route has.
        const { origin, protocol } = originOfClient(client ?? '');
        routes.push({
          prefix: range.cidr,
          family,
          vrf,
          code: client ?? 'unknown',
          origin,
          protocol,
          nextHops: origin === 'connected' ? [] : nextHops,
          interfaces,
          summary: interfaces.some((name) => /^Null0$/i.test(name)),
        });
      }
    }
  }
  return routes;
}

/** `show ip arp vrf all | json`. NX-OS does not list the device's own addresses here. */
export function parseNxosArp(output: string): ArpEntry[] {
  const doc = parseNxosJson(output);
  const entries: ArpEntry[] = [];
  for (const vrfRow of rows(doc, 'vrf')) {
    const vrf = text(vrfRow['vrf-name-out']) ?? 'default';
    for (const adj of rows(vrfRow, 'adj')) {
      const address = text(adj['ip-addr-out']);
      const mac = text(adj.mac);
      if (!address || !mac || /incomplete/i.test(mac)) continue;
      entries.push({ address, interface: text(adj['intf-out']), vrf, own: false });
    }
  }
  return entries;
}
