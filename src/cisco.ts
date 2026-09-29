import { contains, coveringIpv4Block, parseIpv4Cidr, rangesOverlap, rfc1918BlockOf, type Ipv4Range } from './cidr.js';
import { coveringIpv6Block, isIpv6LinkLocal, isIpv6UniqueLocal, parseIpv6Cidr, type Ipv6Range } from './ipv6.js';
import { detectPlatform, parseIosArp, parseIosIpInterface, parseIosIpRoute, parseIosIpv6Interface, parseIosIpv6Route, parseIosVersion, parseIosVrfs } from './cisco-ios.js';
import { parseNxosArp, parseNxosIpInterface, parseNxosIpv6Interface, parseNxosRoute, parseNxosVersion, parseNxosVrfs } from './cisco-nxos.js';
import { refusalOf, type ArpEntry, type DeviceTables, type InterfaceAddress, type RouteEntry } from './cisco-types.js';
import { openShellSession, type DeviceSession, type HostKeyPolicy, type SshTarget } from './ssh.js';
import type { Discovery } from './scan.js';

/**
 * The Cisco source: signs in to named devices with a read-only credential
 * and reads their tables. It never probes an endpoint. No ping sweeps, no
 * port scans, no traffic to any address it has not been given a credential
 * for. Every command here is a `show`; nothing enters configure mode and
 * nothing needs enable.
 *
 * The output is the same Discovery shape the cloud scanners produce, so a
 * run that names cisco alongside aws or azure is analysed as one estate
 * through the same merge and collision report. On top of that shape sits
 * `cisco`, the routed prefixes with their kinds and metadata, which is
 * what the manifest is rendered from.
 */

export class CiscoScanError extends Error {}

export type PrefixKind = 'vlan' | 'interface' | 'transit' | 'route';
export type PrefixRouteType = 'connected' | 'static' | 'learned';

export interface DiscoveredPrefix {
  cidr: string;
  family: 'IPV4' | 'IPV6';
  vrf: string;
  kind: PrefixKind;
  routeType: PrefixRouteType;
  /** Hostname of the device this prefix is attributed to. */
  device: string;
  /** That device's serial, the `network_id` of every entry it produces. */
  serial: string | null;
  interface?: string;
  vlanId?: string;
  gateway?: string;
  nextHop?: string;
  protocol?: string;
  /** Other devices that also listed this prefix, in the order they were read. */
  seenOn: string[];
  /** ARP entries inside this prefix, counted across devices without double counting. */
  hosts: number;
}

/** Why a routed prefix was left out, counted so the report can say so. */
export interface DropCounts {
  defaultRoute: number;
  hostRoute: number;
  summary: number;
  linkLocal: number;
  public: number;
  learned: number;
  other: number;
  vrfFiltered: number;
}

export interface CiscoDevice {
  host: string;
  hostname: string;
  serial: string | null;
  platform: string;
  version: string | null;
  model: string | null;
  vrfs: string[];
  refused: { command: string; message: string }[];
}

export interface CiscoDeviceFailure {
  host: string;
  message: string;
}

/** What the Cisco source knows beyond the cloud-shaped Discovery. */
export interface CiscoDetails {
  site: string;
  environment: string;
  devices: CiscoDevice[];
  failures: CiscoDeviceFailure[];
  prefixes: DiscoveredPrefix[];
  dropped: DropCounts;
  /** Total distinct ARP hosts counted across the estate. */
  hosts: number;
  /** VRF names whose prefixes overlap another VRF's, which forces one manifest per VRF. */
  overlappingVrfs: string[];
}

export interface CiscoDiscovery extends Discovery {
  provider: 'cisco';
  cisco: CiscoDetails;
}

export interface ClassifyOptions {
  /** Only these VRFs. Unset means every VRF the device has. */
  vrfs?: string[];
  /** Drop routes learned from a routing protocol, keeping connected and static. */
  staticOnly?: boolean;
  /** Keep prefixes outside RFC 1918 and fc00::/7. */
  includePublic?: boolean;
}

export interface CiscoSourceOptions extends ClassifyOptions {
  /** host or host:port. */
  hosts: string[];
  username: string;
  password?: string;
  privateKey?: Buffer;
  hostKeys: HostKeyPolicy;
  site: string;
  environment: string;
  /** Replaced in tests with a fake session; the default opens SSH. */
  openSession?: (target: SshTarget) => Promise<DeviceSession>;
  onProgress?: (message: string) => void;
}

/** "core1.example:2222" and "[2001:db8::1]:22" both split into host and port. */
export function parseHostSpec(spec: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(spec);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : 22 };
  const plain = /^([^:]+)(?::(\d+))?$/.exec(spec);
  if (plain) return { host: plain[1], port: plain[2] ? Number(plain[2]) : 22 };
  // A bare IPv6 address with no port.
  return { host: spec, port: 22 };
}

/**
 * Runs one command and separates "the device answered" from "the device
 * refused". A refusal is recorded and the device continues: a privilege-1
 * user on a locked-down IOS may be denied `show ip arp` and still be able
 * to give every route, which is most of the value.
 */
async function ask(session: DeviceSession, command: string, tables: Pick<DeviceTables, 'refused'>): Promise<string | null> {
  const output = await session.run(command);
  const refusal = refusalOf(output);
  if (refusal) {
    tables.refused.push({ command, message: refusal });
    return null;
  }
  return output;
}

/**
 * Reads every table one device can give. `terminal length 0` goes first so
 * nothing below is paged. The platform decides the command set: NX-OS
 * answers `| json`, IOS and IOS-XE answer text, and the parsers for each
 * live in their own modules.
 */
export async function readDevice(session: DeviceSession, host: string): Promise<DeviceTables> {
  const refused: DeviceTables['refused'] = [];
  const scratch = { refused };

  await session.run('terminal length 0');

  const versionText = await session.run('show version');
  const platform = detectPlatform(versionText);
  if (!platform) {
    throw new CiscoScanError(`${host}: could not tell IOS, IOS-XE or NX-OS apart from \`show version\`. Its first lines were: ${versionText.split('\n').slice(0, 2).join(' / ').trim()}`);
  }

  if (platform === 'nxos') {
    const versionJson = await ask(session, 'show version | json', scratch);
    const identity = versionJson ? parseNxosVersion(versionJson) : { ...parseIosVersion(versionText), platform: 'nxos' as const };
    const vrfsJson = await ask(session, 'show vrf all | json', scratch);
    const vrfs = vrfsJson ? parseNxosVrfs(vrfsJson) : [{ name: 'default', families: [] }];

    const interfaces: InterfaceAddress[] = [];
    const v4Interfaces = await ask(session, 'show ip interface vrf all | json', scratch);
    if (v4Interfaces) interfaces.push(...parseNxosIpInterface(v4Interfaces));
    const v6Interfaces = await ask(session, 'show ipv6 interface vrf all | json', scratch);
    if (v6Interfaces) interfaces.push(...parseNxosIpv6Interface(v6Interfaces));

    const routes: RouteEntry[] = [];
    const v4Routes = await ask(session, 'show ip route vrf all | json', scratch);
    if (v4Routes) routes.push(...parseNxosRoute(v4Routes, 'IPV4'));
    const v6Routes = await ask(session, 'show ipv6 route vrf all | json', scratch);
    if (v6Routes) routes.push(...parseNxosRoute(v6Routes, 'IPV6'));

    const arp: ArpEntry[] = [];
    const arpJson = await ask(session, 'show ip arp vrf all | json', scratch);
    if (arpJson) arp.push(...parseNxosArp(arpJson));

    return { identity, vrfs, interfaces, routes, arp, refused };
  }

  const identity = parseIosVersion(versionText);
  const vrfText = await ask(session, 'show vrf', scratch);
  const vrfs = vrfText ? parseIosVrfs(vrfText) : [];
  const vrfNames = vrfs.map((v) => v.name);

  const interfaces: InterfaceAddress[] = [];
  const v4Interfaces = await ask(session, 'show ip interface', scratch);
  if (v4Interfaces) interfaces.push(...parseIosIpInterface(v4Interfaces));
  const v6Interfaces = await ask(session, 'show ipv6 interface', scratch);
  if (v6Interfaces) interfaces.push(...parseIosIpv6Interface(v6Interfaces));

  const routes: RouteEntry[] = [];
  // `vrf *` prints every table in one go on IOS-XE and recent IOS. A
  // release without it refuses, and the fallback is the global table plus
  // one command per VRF, which reads the same rows in more round trips.
  const allRoutes = await ask(session, 'show ip route vrf *', scratch);
  if (allRoutes) {
    routes.push(...parseIosIpRoute(allRoutes));
  } else {
    const globalRoutes = await ask(session, 'show ip route', scratch);
    if (globalRoutes) routes.push(...parseIosIpRoute(globalRoutes));
    for (const vrf of vrfNames) {
      const perVrf = await ask(session, `show ip route vrf ${vrf}`, scratch);
      if (perVrf) routes.push(...parseIosIpRoute(perVrf, vrf));
    }
  }
  const v6Routes = await ask(session, 'show ipv6 route', scratch);
  if (v6Routes) routes.push(...parseIosIpv6Route(v6Routes));
  for (const vrf of vrfs.filter((v) => v.families.includes('IPV6'))) {
    const perVrf = await ask(session, `show ipv6 route vrf ${vrf.name}`, scratch);
    if (perVrf) routes.push(...parseIosIpv6Route(perVrf, vrf.name));
  }

  const arp: ArpEntry[] = [];
  const arpText = await ask(session, 'show ip arp', scratch);
  if (arpText) arp.push(...parseIosArp(arpText));
  for (const vrf of vrfNames) {
    const perVrf = await ask(session, `show ip arp vrf ${vrf}`, scratch);
    if (perVrf) arp.push(...parseIosArp(perVrf, vrf));
  }

  return { identity, vrfs, interfaces, routes, arp, refused };
}

const DEFAULT_ROUTES = new Set(['0.0.0.0/0', '::/0']);
const LINK_LOCAL_V4 = parseIpv4Cidr('169.254.0.0/16')!;
const LOOPBACK_V4 = parseIpv4Cidr('127.0.0.0/8')!;
const MULTICAST_V4 = parseIpv4Cidr('224.0.0.0/4')!;

type Bucket = keyof DropCounts;

/**
 * The drop list from the spec: the default route, host routes, summaries
 * and null routes, link-local, and public space unless asked for. Returns
 * which bucket a prefix falls in, or null when it is part of the plan.
 */
function dropReason(prefix: string, family: 'IPV4' | 'IPV6', summary: boolean, includePublic: boolean): Bucket | null {
  if (DEFAULT_ROUTES.has(prefix)) return 'defaultRoute';
  if (family === 'IPV4') {
    const range = parseIpv4Cidr(prefix);
    if (!range) return 'other';
    if (range.prefixLength === 32) return 'hostRoute';
    if (summary) return 'summary';
    if (contains(LINK_LOCAL_V4, range) || contains(LOOPBACK_V4, range) || contains(MULTICAST_V4, range)) return 'linkLocal';
    if (!rfc1918BlockOf(range) && !includePublic) return 'public';
    return null;
  }
  const range = parseIpv6Cidr(prefix);
  if (!range) return 'other';
  if (range.prefixLength === 128) return 'hostRoute';
  if (summary) return 'summary';
  // ff00::/8 multicast sits above fe80::/10 and is caught by the same test.
  if (isIpv6LinkLocal(range) || range.start >= 0xff00n << 112n) return 'linkLocal';
  if (!isIpv6UniqueLocal(range) && !includePublic) return 'public';
  return null;
}

/** "Vlan10" and "GigabitEthernet0/1.100" are both VLAN-shaped; the id is the number. */
function vlanIdOf(name: string): string | null {
  const svi = /^Vlan(\d+)$/i.exec(name);
  if (svi) return svi[1];
  const sub = /\.(\d+)$/.exec(name);
  return sub ? sub[1] : null;
}

function isTransit(prefix: string, family: 'IPV4' | 'IPV6'): boolean {
  const length = Number(prefix.split('/')[1]);
  return family === 'IPV4' ? length === 30 || length === 31 : length === 127;
}

/**
 * Turns one device's tables into candidate prefixes, before dedupe.
 * Connected prefixes come from the interface table, which knows the
 * interface and the gateway; the routing table adds the static and learned
 * ones, and stands in for the interface table when that was refused.
 */
function classifyDevice(tables: DeviceTables, host: string, options: ClassifyOptions, dropped: DropCounts): DiscoveredPrefix[] {
  const device = tables.identity.hostname === 'unknown' ? host : tables.identity.hostname;
  const serial = tables.identity.serial;
  const includePublic = options.includePublic ?? false;
  const wanted = options.vrfs ? new Set(options.vrfs) : null;
  const out: DiscoveredPrefix[] = [];
  const connected = new Set<string>();

  const keep = (vrf: string, prefix: string, family: 'IPV4' | 'IPV6', summary: boolean): boolean => {
    if (wanted && !wanted.has(vrf)) {
      dropped.vrfFiltered += 1;
      return false;
    }
    const reason = dropReason(prefix, family, summary, includePublic);
    if (reason) {
      dropped[reason] += 1;
      return false;
    }
    return true;
  };

  const connect = (vrf: string, prefix: string, family: 'IPV4' | 'IPV6', iface: string, gateway: string | undefined) => {
    const key = `${vrf}|${prefix}`;
    if (connected.has(key)) return;
    if (!keep(vrf, prefix, family, false)) return;
    connected.add(key);
    const vlanId = vlanIdOf(iface);
    const kind: PrefixKind = isTransit(prefix, family) ? 'transit' : vlanId ? 'vlan' : 'interface';
    out.push({
      cidr: prefix,
      family,
      vrf,
      kind,
      routeType: 'connected',
      device,
      serial,
      interface: iface,
      ...(vlanId && kind === 'vlan' ? { vlanId } : {}),
      ...(gateway ? { gateway } : {}),
      seenOn: [],
      hosts: 0,
    });
  };

  for (const address of tables.interfaces) {
    connect(address.vrf, address.prefix, address.family, address.interface, address.address);
  }

  for (const route of tables.routes) {
    if (route.origin === 'local') {
      // The device's own address as a /32 or /128. Counted as a host route
      // unless the prefix was filtered out by VRF first.
      if (wanted && !wanted.has(route.vrf)) dropped.vrfFiltered += 1;
      else dropped.hostRoute += 1;
      continue;
    }
    if (route.origin === 'connected') {
      // Already known from the interface table in the normal case. When
      // that table was refused, the route says which interface it is on
      // but not the address, so there is no gateway to record.
      if (!connected.has(`${route.vrf}|${route.prefix}`)) {
        connect(route.vrf, route.prefix, route.family, route.interfaces[0] ?? 'unknown', undefined);
      }
      continue;
    }
    if (route.origin === 'other') {
      if (wanted && !wanted.has(route.vrf)) dropped.vrfFiltered += 1;
      else dropped.other += 1;
      continue;
    }
    if (route.origin === 'learned' && options.staticOnly) {
      if (wanted && !wanted.has(route.vrf)) dropped.vrfFiltered += 1;
      else dropped.learned += 1;
      continue;
    }
    if (!keep(route.vrf, route.prefix, route.family, route.summary)) continue;
    // A static route for a prefix this same device has connected is the
    // connected entry, not a second one.
    if (connected.has(`${route.vrf}|${route.prefix}`)) continue;

    const nextHop = route.nextHops[0] ?? route.interfaces[0];
    out.push({
      cidr: route.prefix,
      family: route.family,
      vrf: route.vrf,
      kind: 'route',
      routeType: route.origin === 'static' ? 'static' : 'learned',
      device,
      serial,
      ...(route.origin === 'static' && nextHop ? { nextHop } : {}),
      ...(route.origin === 'learned' && route.protocol ? { protocol: route.protocol } : {}),
      seenOn: [],
      hosts: 0,
    });
  }

  return out;
}

/**
 * One subnet per distinct prefix across the run. The entry is attributed
 * to the device where the prefix is connected, else the first device that
 * listed it, and every other device that listed it goes in `seenOn`.
 */
export function dedupePrefixes(perDevice: DiscoveredPrefix[][]): DiscoveredPrefix[] {
  const byKey = new Map<string, DiscoveredPrefix>();
  for (const prefixes of perDevice) {
    for (const prefix of prefixes) {
      const key = `${prefix.vrf}|${prefix.cidr}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...prefix, seenOn: [...prefix.seenOn] });
        continue;
      }
      if (existing.device === prefix.device) continue;
      if (existing.routeType !== 'connected' && prefix.routeType === 'connected') {
        // The connected side wins the attribution; the previous holder
        // joins the list of devices that merely route to it.
        byKey.set(key, { ...prefix, seenOn: [existing.device, ...existing.seenOn.filter((d) => d !== prefix.device)] });
      } else if (!existing.seenOn.includes(prefix.device)) {
        existing.seenOn.push(prefix.device);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Several source blocks' worth of Cisco discovery as one estate.
 *
 * Deduplication is the whole of it. Prefixes are deduped inside one
 * discoverCisco call, so a prefix routed by devices in two `sources:`
 * blocks arrived at the merge twice and nothing downstream looked again:
 * the manifest declared the same CIDR twice, and scheduled mode filed two
 * create_subnet operations for it in one proposal. The API refuses
 * colliding operations, so the run threw, filed nothing, and did the same
 * again the next night, and the night after.
 */
export function mergeCiscoDetails(parts: CiscoDetails[]): CiscoDetails | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];

  const prefixes = dedupePrefixes(parts.map((part) => part.prefixes));

  // `hosts` is a count rather than an attribute of whichever side won the
  // attribution, so it cannot simply come along with the winner. Two blocks
  // that both saw the prefix each counted the ARP entries their own devices
  // held for it, and those are mostly the same hosts counted twice. The
  // larger of the two is as close to the union as this can get: countHosts
  // keeps no addresses, only a total, so adding them would double-count
  // every host both blocks saw. Understating a host count is the safe
  // direction, and the number is reported, never written anywhere.
  //
  // The estate total is then the sum of what survived, not the sum of the
  // parts, which counted a shared prefix's hosts once per block.
  const mostHosts = new Map<string, number>();
  for (const part of parts) {
    for (const prefix of part.prefixes) {
      const key = `${prefix.vrf}|${prefix.cidr}`;
      mostHosts.set(key, Math.max(mostHosts.get(key) ?? 0, prefix.hosts));
    }
  }
  for (const prefix of prefixes) prefix.hosts = mostHosts.get(`${prefix.vrf}|${prefix.cidr}`) ?? prefix.hosts;

  // Summed, not taken from the first part. A second block's dropped routes
  // used to vanish, so the report understated what it had left out, which
  // is the one number that tells an operator whether --include-public or
  // --static-only is hiding their address space.
  const dropped = emptyDropCounts();
  for (const part of parts) {
    for (const bucket of Object.keys(dropped) as (keyof DropCounts)[]) dropped[bucket] += part.dropped[bucket];
  }

  return {
    ...parts[0],
    devices: parts.flatMap((part) => part.devices),
    failures: parts.flatMap((part) => part.failures),
    prefixes,
    dropped,
    hosts: prefixes.reduce((sum, prefix) => sum + prefix.hosts, 0),
    overlappingVrfs: [...new Set(parts.flatMap((part) => part.overlappingVrfs))].sort(),
  };
}

/**
 * ARP entries counted per subnet: each distinct address lands in the most
 * specific prefix of its VRF that contains it. A host two routers both
 * see on one VLAN is one host, so addresses are deduplicated across
 * devices before counting. Nothing here is written anywhere; the manifest
 * has no address section (roadmap bet #3, phase 6).
 */
export function countHosts(prefixes: DiscoveredPrefix[], arp: ArpEntry[]): number {
  const seen = new Set<string>();
  const v4 = prefixes
    .map((p) => ({ prefix: p, range: p.family === 'IPV4' ? parseIpv4Cidr(p.cidr) : null }))
    .filter((x): x is { prefix: DiscoveredPrefix; range: Ipv4Range } => x.range !== null)
    .sort((a, b) => b.range.prefixLength - a.range.prefixLength);
  let total = 0;
  for (const entry of arp) {
    if (entry.own) continue;
    const key = `${entry.vrf}|${entry.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = parseIpv4Cidr(`${entry.address}/32`);
    if (!value) continue;
    const home = v4.find((x) => x.prefix.vrf === entry.vrf && contains(x.range, value));
    if (home) {
      home.prefix.hosts += 1;
      total += 1;
    }
  }
  return total;
}

function v4Range(prefix: DiscoveredPrefix): Ipv4Range | null {
  return prefix.family === 'IPV4' ? parseIpv4Cidr(prefix.cidr) : null;
}

function v6Range(prefix: DiscoveredPrefix): Ipv6Range | null {
  return prefix.family === 'IPV6' ? parseIpv6Cidr(prefix.cidr) : null;
}

function v6Overlap(a: Ipv6Range, b: Ipv6Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * VRFs whose address space overlaps another VRF's. nxip refuses overlap
 * inside one organisation, so these cannot land in one manifest: each
 * gets its own, with the bet #33 note (one organisation per routing
 * domain until routing domains exist).
 */
export function findOverlappingVrfs(prefixes: DiscoveredPrefix[]): string[] {
  const overlapping = new Set<string>();
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      const a = prefixes[i];
      const b = prefixes[j];
      if (a.vrf === b.vrf || a.family !== b.family) continue;
      const hit =
        a.family === 'IPV4'
          ? (() => {
              const ra = v4Range(a);
              const rb = v4Range(b);
              return ra !== null && rb !== null && rangesOverlap(ra, rb);
            })()
          : (() => {
              const ra = v6Range(a);
              const rb = v6Range(b);
              return ra !== null && rb !== null && v6Overlap(ra, rb);
            })();
      if (hit) {
        overlapping.add(a.vrf);
        overlapping.add(b.vrf);
      }
    }
  }
  return [...overlapping].sort();
}

export interface ClassifiedEstate {
  prefixes: DiscoveredPrefix[];
  dropped: DropCounts;
  hosts: number;
  overlappingVrfs: string[];
}

export function emptyDropCounts(): DropCounts {
  return { defaultRoute: 0, hostRoute: 0, summary: 0, linkLocal: 0, public: 0, learned: 0, other: 0, vrfFiltered: 0 };
}

/** Classification, dedupe and host counting over every device read. */
export function classifyEstate(devices: { host: string; tables: DeviceTables }[], options: ClassifyOptions = {}): ClassifiedEstate {
  const dropped = emptyDropCounts();
  const perDevice = devices.map((d) => classifyDevice(d.tables, d.host, options, dropped));
  const prefixes = dedupePrefixes(perDevice);
  const hosts = countHosts(prefixes, devices.flatMap((d) => d.tables.arp));
  return { prefixes, dropped, hosts, overlappingVrfs: findOverlappingVrfs(prefixes) };
}

/**
 * Signs in to every host in turn and assembles the discovery. A device
 * that cannot be reached or read is recorded as a failure and the run
 * continues with the rest: a scan of nine devices out of ten is worth
 * having, and the report says which one is missing.
 */
export async function discoverCisco(options: CiscoSourceOptions): Promise<CiscoDiscovery> {
  if (options.hosts.length === 0) throw new CiscoScanError('No hosts given. Pass --host, or list hosts under the cisco source in the config.');
  if (!options.username) throw new CiscoScanError('No SSH user. Set NXIP_SSH_USER or pass --user.');
  if (options.password === undefined && options.privateKey === undefined) {
    throw new CiscoScanError('No credential. Set NXIP_SSH_PASSWORD, or point --key-file at a private key.');
  }

  const open = options.openSession ?? ((target: SshTarget) => openShellSession(target, options.hostKeys, { onProgress: options.onProgress }));
  const devices: CiscoDevice[] = [];
  const failures: CiscoDeviceFailure[] = [];
  const read: { host: string; tables: DeviceTables }[] = [];

  for (const spec of options.hosts) {
    const { host, port } = parseHostSpec(spec);
    options.onProgress?.(`${host}: connecting`);
    let session: DeviceSession | null = null;
    try {
      session = await open({ host, port, username: options.username, password: options.password, privateKey: options.privateKey });
      const tables = await readDevice(session, host);
      read.push({ host, tables });
      devices.push({
        host: spec,
        hostname: tables.identity.hostname,
        serial: tables.identity.serial,
        platform: tables.identity.platform,
        version: tables.identity.version,
        model: tables.identity.model,
        vrfs: tables.vrfs.map((v) => v.name),
        refused: tables.refused,
      });
      options.onProgress?.(`${host}: ${tables.identity.hostname} (${tables.identity.platform}), ${tables.routes.length} routes, ${tables.interfaces.length} addresses`);
    } catch (error) {
      failures.push({ host: spec, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  const estate = classifyEstate(read, options);
  return {
    provider: 'cisco',
    account: `${devices.length} device${devices.length === 1 ? '' : 's'}`,
    regions: [options.site],
    // One network per prefix, so the existing collision analysis compares
    // every routed prefix against every cloud network in the same run.
    networks: estate.prefixes.map((prefix) => ({
      id: `${prefix.vrf}/${prefix.cidr}`,
      uid: null,
      name: describePrefix(prefix),
      region: options.site,
      cidrs: [prefix.cidr],
    })),
    subnets: [],
    cisco: {
      site: options.site,
      environment: options.environment,
      devices,
      failures,
      prefixes: estate.prefixes,
      dropped: estate.dropped,
      hosts: estate.hosts,
      overlappingVrfs: estate.overlappingVrfs,
    },
  };
}

/** "core1 Vlan10", "core1 route via 10.0.0.2": the name a prefix gets. */
export function describePrefix(prefix: DiscoveredPrefix): string {
  if (prefix.routeType === 'connected') return `${prefix.device} ${prefix.interface ?? prefix.cidr}`;
  if (prefix.routeType === 'static') return `${prefix.device} static ${prefix.cidr}`;
  return `${prefix.device} ${prefix.protocol ?? 'learned'} ${prefix.cidr}`;
}

// ---------------------------------------------------------------------------
// Pools and the manifest
// ---------------------------------------------------------------------------

export interface GuessedPool {
  name: string;
  cidr: string;
  family: 'IPV4' | 'IPV6';
  /** True when guessed from what was discovered rather than given. */
  guessed: boolean;
}

export interface PoolOptions {
  /** Given pools replace the guess. Prefixes outside every one are left out and listed. */
  pools?: string[];
  site: string;
}

/**
 * One pool per RFC 1918 block touched, the smallest aligned block covering
 * everything discovered inside it. Never wider than the RFC 1918 block by
 * construction: a covering block of ranges inside 10.0.0.0/8 is at most
 * 10.0.0.0/8. Public space, when included, is grouped by its first octet
 * and covered the same way. IPv6 unique-local space is one covering block
 * and public v6 is grouped by its first sixteen bits.
 */
export function guessPools(prefixes: DiscoveredPrefix[], options: PoolOptions): GuessedPool[] {
  if (options.pools && options.pools.length > 0) {
    return options.pools.map((cidr) => {
      const v4 = parseIpv4Cidr(cidr);
      const v6 = v4 ? null : parseIpv6Cidr(cidr);
      const normalized = v4?.cidr ?? v6?.cidr;
      if (!normalized) throw new CiscoScanError(`Pool "${cidr}" is not a valid CIDR.`);
      return { name: `${options.site} ${normalized}`, cidr: normalized, family: v4 ? 'IPV4' : 'IPV6', guessed: false };
    });
  }

  const groups = new Map<string, { family: 'IPV4' | 'IPV6'; v4: Ipv4Range[]; v6: Ipv6Range[] }>();
  const groupFor = (key: string, family: 'IPV4' | 'IPV6') => {
    let group = groups.get(key);
    if (!group) {
      group = { family, v4: [], v6: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const prefix of prefixes) {
    if (prefix.family === 'IPV4') {
      const range = parseIpv4Cidr(prefix.cidr);
      if (!range) continue;
      const block = rfc1918BlockOf(range);
      groupFor(block ? block.cidr : `public/${prefix.cidr.split('.')[0]}`, 'IPV4').v4.push(range);
    } else {
      const range = parseIpv6Cidr(prefix.cidr);
      if (!range) continue;
      groupFor(isIpv6UniqueLocal(range) ? 'fc00::/7' : `public6/${range.start >> 112n}`, 'IPV6').v6.push(range);
    }
  }

  const pools: GuessedPool[] = [];
  for (const group of groups.values()) {
    const cidr = group.family === 'IPV4' ? coveringIpv4Block(group.v4)?.cidr : coveringIpv6Block(group.v6)?.cidr;
    if (!cidr) continue;
    pools.push({ name: `${options.site} ${cidr}`, cidr, family: group.family, guessed: true });
  }
  return pools.sort((a, b) => a.cidr.localeCompare(b.cidr));
}

function poolOf(prefix: DiscoveredPrefix, pools: GuessedPool[]): GuessedPool | null {
  if (prefix.family === 'IPV4') {
    const range = parseIpv4Cidr(prefix.cidr);
    if (!range) return null;
    return pools.find((pool) => pool.family === 'IPV4' && contains(parseIpv4Cidr(pool.cidr)!, range)) ?? null;
  }
  const range = parseIpv6Cidr(prefix.cidr);
  if (!range) return null;
  return pools.find((pool) => {
    if (pool.family !== 'IPV6') return false;
    const poolRange = parseIpv6Cidr(pool.cidr)!;
    return range.start >= poolRange.start && range.end <= poolRange.end;
  }) ?? null;
}

/** The text of the trust wording, used verbatim by --help, the README and the manifest header. */
export const WHAT_NXIP_NEVER_DOES = [
  'nxip reads what your network already knows. It signs in to named',
  'devices with a read-only credential you create, scope and revoke, and',
  'reads their tables: routes, interfaces, VRFs, ARP. It never probes an',
  'endpoint. No ping sweeps, no port scans, no traffic to any address it',
  'has not been given a credential for.',
];

export const BET_33_NOTE = [
  'Two VRFs on this estate carry overlapping address space. nxip refuses',
  'overlap inside one organisation, so each VRF has its own manifest. Apply',
  'each to a separate organisation (one per routing domain) until routing',
  'domains exist; see nx-ip.com/blog on modelling VRFs.',
];

export interface ManifestSections {
  /** Which VRF this manifest is for, or null for everything. */
  vrf: string | null;
  header: string[];
  pools: string[];
  subnets: string[];
  footer: string[];
}

export interface CiscoManifestOptions extends PoolOptions {
  environment: string;
  /** Names already taken by the cloud half of the same file, so no entry repeats one. */
  reservedNames?: Set<string>;
  /**
   * Network ids (`vrf/cidr`) that lost a collision against a cloud network
   * in the same run. Rendered commented out, the way the cloud renderer
   * treats its losers, so the file applies cleanly as written.
   */
  commentOut?: Set<string>;
}

/**
 * One manifest's worth of YAML lines for a set of prefixes: the pools at
 * the top, then every prefix as a subnet in its pool. Prefixes nest under
 * a broader discovered prefix that contains them (a /24 VLAN inside a /16
 * static summary), because nxip refuses overlapping siblings and a
 * routing table nests by nature. `landing_point: false` on every entry:
 * a discovered prefix records what is routed and must never become the
 * place new requests are placed.
 */
export function renderCiscoSections(details: CiscoDetails, prefixes: DiscoveredPrefix[], vrf: string | null, options: CiscoManifestOptions): ManifestSections {
  const pools = guessPools(prefixes, options);
  const header: string[] = [];
  const poolLines: string[] = [];
  const subnetLines: string[] = [];
  const footer: string[] = [];

  header.push('# Cisco source: routed prefixes read over SSH from');
  for (const device of details.devices) {
    header.push(`#   ${device.hostname} (${device.platform}${device.version ? ` ${device.version}` : ''}${device.serial ? `, serial ${device.serial}` : ''})`);
  }
  for (const failure of details.failures) header.push(`#   ${failure.host}: NOT READ, ${failure.message.split('\n')[0]}`);
  header.push('#');
  if (vrf !== null) {
    header.push(`# VRF ${vrf} only.`);
    header.push(...BET_33_NOTE.map((line) => `# ${line}`));
    header.push('#');
  }
  if (pools.some((pool) => pool.guessed)) {
    header.push('# The pools below are a GUESS: one per RFC 1918 range touched, the');
    header.push('# smallest block covering everything discovered inside it. A routing');
    header.push('# table cannot say what the plan is. Change the pool cidrs to your real');
    header.push('# plan, or re-run with --pool 10.0.0.0/14 (or `pools:` in agent.yaml).');
    header.push('#');
  }
  header.push('#   environment  Every entry is labelled as given (--environment or the');
  header.push(`#                config); this file says "${options.environment}".`);
  header.push(`#   region       The site: "${options.site}". One region per site keeps the`);
  header.push('#                pools of two sites apart.');
  header.push('#   kind         vlan, interface, transit or route, from how the prefix');
  header.push('#                was found. landing_point is false on every entry.');
  header.push('#');

  for (const pool of pools) {
    poolLines.push(`  - name: ${JSON.stringify(pool.name)}`);
    poolLines.push(`    cidr: ${JSON.stringify(pool.cidr)}`);
    poolLines.push(`    family: ${pool.family}`);
    poolLines.push(`    environment: ${JSON.stringify(options.environment)}`);
    poolLines.push(`    region: ${JSON.stringify(options.site)}`);
    poolLines.push('    metadata:');
    poolLines.push('      source: "nxip-agent"');
    if (pool.guessed) poolLines.push('      guessed: "true"');
    if (vrf !== null) poolLines.push(`      vrf: ${JSON.stringify(vrf)}`);
    poolLines.push('');
  }

  // Broadest first, so a contained prefix can name the entry above it.
  const ordered = [...prefixes].sort((a, b) => Number(a.cidr.split('/')[1]) - Number(b.cidr.split('/')[1]) || a.cidr.localeCompare(b.cidr));
  const placed: { prefix: DiscoveredPrefix; name: string; commented: boolean }[] = [];
  const used = new Set<string>([...(options.reservedNames ?? []), ...pools.map((pool) => pool.name)]);
  const outside: string[] = [];

  for (const prefix of ordered) {
    const pool = poolOf(prefix, pools);
    if (!pool) {
      outside.push(`${prefix.cidr} (${prefix.vrf}, ${describePrefix(prefix)})`);
      continue;
    }

    let name = describePrefix(prefix);
    if (used.has(name)) {
      name = `${name} ${prefix.cidr}`;
      let suffix = 2;
      while (used.has(name)) name = `${describePrefix(prefix)} ${prefix.cidr} (${suffix++})`;
    }
    used.add(name);

    const parent = [...placed].reverse().find((candidate) => candidate.prefix.family === prefix.family && candidate.prefix.vrf === prefix.vrf && strictlyContains(candidate.prefix, prefix));
    // A child of a commented-out entry is commented out with it: live, it
    // would name a parent that is never created.
    const lost = options.commentOut?.has(`${prefix.vrf}/${prefix.cidr}`) ?? false;
    const commented = lost || (parent?.commented ?? false);
    placed.push({ prefix, name, commented });

    if (lost) {
      subnetLines.push('  # COMMENTED OUT: collides with another network in this file, and nxip');
      subnetLines.push('  # cannot register both. Uncomment this and comment out the other side');
      subnetLines.push('  # if this is the one you want, or renumber and re-scan.');
    } else if (commented) {
      subnetLines.push(`  # COMMENTED OUT with its parent ${JSON.stringify(parent?.name ?? '')}.`);
    }

    const entry: string[] = [];
    entry.push(`  - name: ${JSON.stringify(name)}`);
    entry.push(`    family: ${prefix.family}`);
    entry.push(`    cidr: ${JSON.stringify(prefix.cidr)}`);
    if (parent) {
      entry.push(`    parent: ${JSON.stringify(parent.name)}`);
    } else {
      entry.push(`    environment: ${JSON.stringify(options.environment)}`);
      entry.push(`    region: ${JSON.stringify(options.site)}`);
    }
    entry.push(`    kind: ${JSON.stringify(prefix.kind)}`);
    entry.push('    landing_point: false');
    entry.push('    metadata:');
    for (const [key, value] of Object.entries(prefixMetadata(prefix))) {
      entry.push(`      ${key}: ${JSON.stringify(value)}`);
    }
    subnetLines.push(...(commented ? entry.map((line) => `# ${line}`) : entry));
    subnetLines.push('');
  }

  if (outside.length > 0) {
    footer.push('# Left out: these prefixes fall outside every pool given. Widen a pool');
    footer.push('# or add one, then re-run.');
    for (const entry of outside) footer.push(`#   ${entry}`);
    footer.push('');
  }

  return { vrf, header, pools: poolLines, subnets: subnetLines, footer };
}

function strictlyContains(outer: DiscoveredPrefix, inner: DiscoveredPrefix): boolean {
  if (outer.cidr === inner.cidr) return false;
  if (outer.family === 'IPV4') {
    const a = parseIpv4Cidr(outer.cidr);
    const b = parseIpv4Cidr(inner.cidr);
    return a !== null && b !== null && contains(a, b);
  }
  const a = parseIpv6Cidr(outer.cidr);
  const b = parseIpv6Cidr(inner.cidr);
  return a !== null && b !== null && b.start >= a.start && b.end <= a.end;
}

const MAX_METADATA_VALUE = 256;

/** The metadata every entry carries, per the spec, bounded to what the API accepts. */
export function prefixMetadata(prefix: DiscoveredPrefix): Record<string, string> {
  const metadata: Record<string, string> = {
    source: 'nxip-agent',
    network_id: prefix.serial ?? prefix.device,
    device: prefix.device,
    vrf: prefix.vrf,
    route_type: prefix.routeType,
  };
  if (prefix.interface) metadata.interface = prefix.interface;
  if (prefix.vlanId) metadata.vlan_id = prefix.vlanId;
  if (prefix.gateway) metadata.gateway = prefix.gateway;
  if (prefix.nextHop) metadata.next_hop = prefix.nextHop;
  if (prefix.protocol) metadata.protocol = prefix.protocol;
  if (prefix.seenOn.length > 0) {
    let seenOn = prefix.seenOn.join(',');
    // The API caps a value at 256 characters; a prefix every core in a
    // large estate routes to could exceed that, and losing the tail of the
    // list beats losing the entry.
    if (seenOn.length > MAX_METADATA_VALUE) seenOn = `${seenOn.slice(0, MAX_METADATA_VALUE - 3)}...`;
    metadata.seen_on = seenOn;
  }
  return metadata;
}

/**
 * Which manifests a Cisco estate needs: one for everything, or one per
 * VRF when two VRFs overlap. The first group is the primary, which is
 * where any cloud entries from the same run go.
 */
export function manifestGroups(details: CiscoDetails): { vrf: string | null; prefixes: DiscoveredPrefix[] }[] {
  if (details.overlappingVrfs.length === 0) return [{ vrf: null, prefixes: details.prefixes }];
  const vrfs = [...new Set(details.prefixes.map((p) => p.vrf))].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  return vrfs.map((vrf) => ({ vrf, prefixes: details.prefixes.filter((p) => p.vrf === vrf) }));
}

/** The Cisco part of the human report. */
export function formatCiscoSection(details: CiscoDetails): string[] {
  const lines: string[] = [];
  lines.push(`Cisco: ${details.devices.length} device${details.devices.length === 1 ? '' : 's'} read at site ${details.site}${details.failures.length > 0 ? `, ${details.failures.length} not read` : ''}.`);
  lines.push('');
  for (const device of details.devices) {
    lines.push(`  ${device.hostname}  ${device.platform}${device.version ? ` ${device.version}` : ''}${device.model ? `  ${device.model}` : ''}${device.serial ? `  serial ${device.serial}` : ''}`);
    lines.push(`    VRFs: ${device.vrfs.length > 0 ? device.vrfs.join(', ') : 'default only'}`);
    for (const refused of device.refused) lines.push(`    refused: ${refused.command}  (${refused.message})`);
  }
  for (const failure of details.failures) {
    lines.push(`  ${failure.host}  NOT READ`);
    lines.push(`    ${failure.message.split('\n').join('\n    ')}`);
  }
  lines.push('');

  const byKind = new Map<PrefixKind, number>();
  for (const prefix of details.prefixes) byKind.set(prefix.kind, (byKind.get(prefix.kind) ?? 0) + 1);
  lines.push(
    `  ${details.prefixes.length} routed prefix${details.prefixes.length === 1 ? '' : 'es'}: ` +
      (['vlan', 'interface', 'transit', 'route'] as PrefixKind[]).map((kind) => `${byKind.get(kind) ?? 0} ${kind}`).join(', ') +
      `. ${details.hosts} host${details.hosts === 1 ? '' : 's'} in ARP.`
  );
  lines.push('');
  const width = Math.max(18, ...details.prefixes.map((p) => p.cidr.length));
  for (const prefix of [...details.prefixes].sort((a, b) => a.vrf.localeCompare(b.vrf) || a.cidr.localeCompare(b.cidr))) {
    const where = prefix.routeType === 'connected' ? prefix.interface ?? '' : prefix.nextHop ? `via ${prefix.nextHop}` : prefix.protocol ?? '';
    const seen = prefix.seenOn.length > 0 ? `  also on ${prefix.seenOn.join(', ')}` : '';
    const hosts = prefix.hosts > 0 ? `  ${prefix.hosts} host${prefix.hosts === 1 ? '' : 's'}` : '';
    lines.push(`    ${prefix.cidr.padEnd(width)} ${prefix.vrf.padEnd(10)} ${prefix.kind.padEnd(9)} ${prefix.device} ${where}${seen}${hosts}`);
  }
  lines.push('');

  const dropped = details.dropped;
  const droppedTotal = Object.values(dropped).reduce((sum, n) => sum + n, 0);
  if (droppedTotal > 0) {
    const parts = [
      dropped.defaultRoute ? `${dropped.defaultRoute} default` : '',
      dropped.hostRoute ? `${dropped.hostRoute} host /32 or /128` : '',
      dropped.summary ? `${dropped.summary} summary or null` : '',
      dropped.linkLocal ? `${dropped.linkLocal} link-local` : '',
      dropped.public ? `${dropped.public} public (pass --include-public to keep them)` : '',
      dropped.learned ? `${dropped.learned} learned (--static-only)` : '',
      dropped.other ? `${dropped.other} other (HSRP, NHRP and similar)` : '',
      dropped.vrfFiltered ? `${dropped.vrfFiltered} outside the VRF filter` : '',
    ].filter(Boolean);
    lines.push(`  Dropped ${droppedTotal} route${droppedTotal === 1 ? '' : 's'}: ${parts.join('; ')}.`);
    lines.push('');
  }

  if (details.overlappingVrfs.length > 0) {
    lines.push(`  VRFs with overlapping address space: ${details.overlappingVrfs.join(', ')}.`);
    lines.push(...BET_33_NOTE.map((line) => `  ${line}`));
    lines.push('');
  }
  return lines;
}
