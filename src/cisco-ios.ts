import { parseIpv4Cidr } from './cidr.js';
import { parseIpv6Cidr } from './ipv6.js';
import type { ArpEntry, CiscoPlatform, DeviceIdentity, InterfaceAddress, RouteEntry, RouteOrigin, VrfInfo } from './cisco-types.js';

/**
 * Parsers for the text IOS and IOS-XE print. Every one takes the raw
 * output of one `show` command and returns the shape in cisco-types.ts,
 * throwing on nothing: a line that does not match is skipped, because a
 * routing table has decades of accumulated formats and the useful thing
 * is to read every line we recognise rather than refuse the whole table
 * over one we do not. What was skipped is the parser tests' business.
 *
 * The formats here are the ones IOS 15 and IOS-XE 17 print. Older
 * releases that omit the prefix length on subnetted entries are read
 * through the "is subnetted" header, which carries the mask for them.
 */

const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;

/**
 * Which operating system printed `show version`. NX-OS says so on its
 * first line; IOS XE names itself; anything else that says "IOS Software"
 * is classic IOS. Null means this is not a Cisco we know how to read.
 */
export function detectPlatform(showVersion: string): CiscoPlatform | null {
  if (/Cisco Nexus Operating System|\bNX-OS\b/i.test(showVersion)) return 'nxos';
  if (/IOS[ -]XE/i.test(showVersion)) return 'ios-xe';
  if (/Cisco IOS Software|IOS \(tm\)/i.test(showVersion)) return 'ios';
  return null;
}

export function parseIosVersion(text: string): DeviceIdentity {
  const platform = detectPlatform(text) ?? 'ios';
  // "router1 uptime is 3 weeks, 2 days": the hostname is the word before
  // "uptime is", and this is the only place show version prints it.
  const hostname = /^(\S+)\s+uptime is\s/m.exec(text)?.[1] ?? 'unknown';
  const serial = /^Processor board ID\s+(\S+)/m.exec(text)?.[1] ?? null;
  const version = /Version\s+([0-9][^\s,]*)/i.exec(text)?.[1] ?? null;
  // "cisco CISCO2911/K9 (revision 1.0)", "cisco CSR1000V (VXE) processor",
  // "Cisco IOSv (revision 1.0)": the model is the token after a leading
  // "cisco" on its own line.
  const model = /^[Cc]isco\s+(\S+)\s+\((?:revision|VXE|\S+)/m.exec(text)?.[1] ?? null;
  return { hostname, serial, platform, version, model };
}

/**
 * `show vrf`: a table whose first column is the name, continued onto
 * further lines when a VRF has more interfaces than fit. Continuation
 * lines start deep in the interface column, so a name is any line whose
 * first non-space character is in column 2 or 3.
 */
export function parseIosVrfs(text: string): VrfInfo[] {
  const vrfs: VrfInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Name\s+Default RD/.test(line)) continue;
    const match = /^\s{0,3}(\S+)\s+(<not set>|\S+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const [, name, , protocols] = match;
    const families: VrfInfo['families'] = [];
    if (/ipv4/i.test(protocols)) families.push('IPV4');
    if (/ipv6/i.test(protocols)) families.push('IPV6');
    vrfs.push({ name, families });
  }
  return vrfs;
}

/**
 * `show ip interface`, the long form. Each interface starts a block at
 * column 0; the block's addresses and its VRF, if any, are indented under
 * it. The VRF line reads "VPN Routing/Forwarding "NAME"" on IOS and IOS-XE.
 */
export function parseIosIpInterface(text: string): InterfaceAddress[] {
  const blocks = splitInterfaceBlocks(text);
  const addresses: InterfaceAddress[] = [];
  for (const block of blocks) {
    const vrf = vrfOfBlock(block.body);
    for (const line of block.body) {
      const primary = new RegExp(String.raw`^\s*Internet address is\s+(${IPV4})/(\d{1,2})`).exec(line);
      const secondary = new RegExp(String.raw`^\s*Secondary address\s+(${IPV4})/(\d{1,2})`).exec(line);
      const match = primary ?? secondary;
      if (!match) continue;
      const range = parseIpv4Cidr(`${match[1]}/${match[2]}`);
      if (!range) continue;
      addresses.push({
        interface: block.name,
        address: match[1],
        prefix: range.cidr,
        family: 'IPV4',
        vrf,
        secondary: secondary !== null,
      });
    }
  }
  return addresses;
}

/**
 * `show ipv6 interface`. Global addresses are listed under "Global unicast
 * address(es):" as "ADDRESS, subnet is PREFIX/LEN". Link-local is on its
 * own line and is deliberately not an address here: it is never an
 * address plan, and the drop list would only throw it away again.
 */
export function parseIosIpv6Interface(text: string): InterfaceAddress[] {
  const addresses: InterfaceAddress[] = [];
  for (const block of splitInterfaceBlocks(text)) {
    const vrf = vrfOfBlock(block.body);
    let first = true;
    for (const line of block.body) {
      const match = /^\s+([0-9A-Fa-f:.]+),\s+subnet is\s+([0-9A-Fa-f:.]+\/\d{1,3})/.exec(line);
      if (!match) continue;
      const range = parseIpv6Cidr(match[2]);
      if (!range) continue;
      addresses.push({ interface: block.name, address: match[1].toLowerCase(), prefix: range.cidr, family: 'IPV6', vrf, secondary: !first });
      first = false;
    }
  }
  return addresses;
}

interface InterfaceBlock {
  name: string;
  body: string[];
}

function splitInterfaceBlocks(text: string): InterfaceBlock[] {
  const blocks: InterfaceBlock[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^(\S+) is (?:up|down|administratively down|deleted|reset)/.exec(line);
    if (header) {
      blocks.push({ name: header[1], body: [] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].body.push(line);
    }
  }
  return blocks;
}

function vrfOfBlock(body: string[]): string {
  for (const line of body) {
    const match = /VPN Routing\/Forwarding\s+"([^"]+)"|^\s*VRF(?::|\s+is)?\s+"?([^"\s]+)"?/.exec(line);
    if (match) return match[1] ?? match[2];
  }
  return 'default';
}

/** Which protocol a routing-table code stands for, and whether it is learned at all. */
function originOfCode(code: string): { origin: RouteOrigin; protocol: string | null } {
  const first = code.replace(/[*+%&p]/g, '').trim().split(/\s+/)[0] ?? '';
  switch (first) {
    case 'C':
      return { origin: 'connected', protocol: null };
    case 'L':
      return { origin: 'local', protocol: null };
    case 'S':
    case 'U':
    case 'P':
      return { origin: 'static', protocol: null };
    case 'O':
      return { origin: 'learned', protocol: 'ospf' };
    case 'D':
      return { origin: 'learned', protocol: 'eigrp' };
    case 'B':
      return { origin: 'learned', protocol: 'bgp' };
    case 'i':
      return { origin: 'learned', protocol: 'isis' };
    case 'R':
      return { origin: 'learned', protocol: 'rip' };
    case 'o':
      return { origin: 'learned', protocol: 'odr' };
    case 'M':
      return { origin: 'learned', protocol: 'mobile' };
    default:
      // H (NHRP), l (LISP), a (application), + (replicated), and anything
      // newer than this list: recorded as a route, never as a plan.
      return { origin: 'other', protocol: null };
  }
}

/**
 * `show ip route`, one VRF or every VRF (`vrf *`, which prints a
 * "Routing Table: NAME" line before each table after the global one).
 * `defaultVrf` names the table the first section belongs to.
 *
 * The one piece of state is the "is subnetted" header. Classic IOS prints
 * a classful parent line, then its subnets beneath it, and when every
 * subnet has the same mask the parent line carries it and the children
 * omit it. "is variably subnetted" means each child has its own.
 */
export function parseIosIpRoute(text: string, defaultVrf = 'default'): RouteEntry[] {
  const routes: RouteEntry[] = [];
  let vrf = defaultVrf;
  let inheritedMask: number | null = null;

  // Code plus optional qualifier ("O E2", "D EX", "i L1", "S*"), then an
  // IPv4 prefix with or without its length, then the rest of the line.
  const entry = new RegExp(String.raw`^([A-Za-z][A-Za-z*+%&]?(?:\s+[A-Za-z][A-Za-z0-9]{0,2})?)\s+(${IPV4})(?:/(\d{1,2}))?\s+(.*)$`);
  const subnetted = new RegExp(String.raw`^\s+(${IPV4})/(\d{1,2}) is (variably )?subnetted`);

  for (const line of text.split(/\r?\n/)) {
    const table = /^Routing Table:\s+(\S+)/.exec(line);
    if (table) {
      vrf = table[1];
      inheritedMask = null;
      continue;
    }

    const header = subnetted.exec(line);
    if (header) {
      inheritedMask = header[3] ? null : Number(header[2]);
      continue;
    }

    const match = entry.exec(line);
    if (!match) continue;
    const [, rawCode, address, length, rest] = match;
    const code = rawCode.replace(/\s+/g, ' ').trim();
    const prefixLength = length !== undefined ? Number(length) : inheritedMask;
    if (prefixLength === null) continue;
    const range = parseIpv4Cidr(`${address}/${prefixLength}`);
    if (!range) continue;

    routes.push({ prefix: range.cidr, family: 'IPV4', vrf, code, ...originOfCode(code), ...parseIosPath(rest) });
  }
  return routes;
}

/**
 * The tail of a route line: "[1/0] via 10.0.0.2", "is directly connected,
 * Vlan10", "is a summary, 00:00:01, Null0". Everything after the prefix.
 */
function parseIosPath(rest: string): Pick<RouteEntry, 'nextHops' | 'interfaces' | 'summary'> {
  const nextHops: string[] = [];
  const interfaces: string[] = [];
  let summary = /is a summary/.test(rest);

  const via = new RegExp(String.raw`via (${IPV4})`, 'g');
  for (const hit of rest.matchAll(via)) nextHops.push(hit[1]);

  // The interface is the last comma-separated token when it is not a time
  // or a next hop: "via 10.0.0.2, 00:10:12, GigabitEthernet0/0".
  const tokens = rest.split(',').map((t) => t.trim());
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last && !/^\d+:\d+:\d+$|^\d+[wdh]/.test(last) && !new RegExp(`^via `).test(last)) {
    interfaces.push(last);
  } else if (/is directly connected, (\S+)/.test(rest)) {
    interfaces.push(/is directly connected, (\S+)/.exec(rest)![1]);
  }
  if (interfaces.some((name) => /^Null0$/i.test(name))) summary = true;

  return { nextHops, interfaces, summary };
}

/**
 * `show ipv6 route`. Each entry is two or more lines: the prefix with its
 * distance and metric, then one "via" line per path indented beneath it.
 */
export function parseIosIpv6Route(text: string, vrf = 'default'): RouteEntry[] {
  const routes: RouteEntry[] = [];
  let current: RouteEntry | null = null;

  for (const line of text.split(/\r?\n/)) {
    const table = /^IPv6 Routing Table - (\S+) -/.exec(line);
    if (table) {
      vrf = table[1];
      continue;
    }

    const entry = /^([A-Za-z]{1,3}\*?|ND\w*)\s+([0-9A-Fa-f:.]+\/\d{1,3})\s+\[(\d+)\/(\d+)\]/.exec(line);
    if (entry) {
      const range = parseIpv6Cidr(entry[2]);
      current = null;
      if (!range) continue;
      const code = entry[1];
      const { origin, protocol } = originOfCode(ipv6CodeToIos(code));
      current = { prefix: range.cidr, family: 'IPV6', vrf, code, origin, protocol, nextHops: [], interfaces: [], summary: false };
      routes.push(current);
      continue;
    }

    const via = /^\s+via\s+(.+)$/.exec(line);
    if (via && current) {
      const parts = via[1].split(',').map((p) => p.trim());
      for (const part of parts) {
        if (/^[0-9A-Fa-f:.]+$/.test(part) && part.includes(':')) current.nextHops.push(part.toLowerCase());
        else if (/^[A-Za-z]/.test(part) && !/directly connected|receive/.test(part)) current.interfaces.push(part);
      }
      if (current.interfaces.some((name) => /^Null0$/i.test(name))) current.summary = true;
    }
  }
  return routes;
}

/**
 * IPv6 tables print "OE2" where IPv4 prints "O E2", and "I1" for IS-IS
 * level 1. Reduced to the IPv4 first letter so one code table serves both.
 */
function ipv6CodeToIos(code: string): string {
  const bare = code.replace('*', '');
  if (/^O/.test(bare)) return 'O';
  if (/^I[12AS]?$/.test(bare) || /^i/.test(bare)) return 'i';
  if (/^EX$/.test(bare) || /^D/.test(bare)) return 'D';
  if (/^ND/.test(bare)) return 'H';
  return bare.slice(0, 1);
}

/**
 * `show ip arp`. The device's own addresses print with age "-", and are
 * not hosts on the network: they are the router. Everything else with a
 * hardware address is one host seen.
 */
export function parseIosArp(text: string, vrf = 'default'): ArpEntry[] {
  const entries: ArpEntry[] = [];
  const row = new RegExp(String.raw`^Internet\s+(${IPV4})\s+(-|\d+)\s+(\S+)\s+\S+(?:\s+(\S+))?`);
  for (const line of text.split(/\r?\n/)) {
    const match = row.exec(line);
    if (!match) continue;
    if (/incomplete/i.test(match[3])) continue;
    entries.push({ address: match[1], interface: match[4] ?? null, vrf, own: match[2] === '-' });
  }
  return entries;
}
