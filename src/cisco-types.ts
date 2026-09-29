/**
 * What the Cisco parsers hand back, one shape for every platform. The
 * classification in cisco.ts works from these and knows nothing about
 * whether a route came from IOS text or NX-OS JSON, which is what lets one
 * set of rules (transit, drop list, dedupe) cover all three platforms.
 */

export type CiscoPlatform = 'ios' | 'ios-xe' | 'nxos';

export interface DeviceIdentity {
  hostname: string;
  /** Processor board id. Null when the platform did not print one. */
  serial: string | null;
  platform: CiscoPlatform;
  version: string | null;
  model: string | null;
}

export interface InterfaceAddress {
  interface: string;
  /** The interface's own address, without a prefix length. */
  address: string;
  /** The connected prefix, normalised (host bits cleared). */
  prefix: string;
  family: 'IPV4' | 'IPV6';
  vrf: string;
  secondary: boolean;
}

/**
 * How a route got into the table. `local` is the device's own address as a
 * host route; `other` covers the codes nobody plans address space with
 * (HSRP, VRRP, NHRP, LISP, the adjacency manager).
 */
export type RouteOrigin = 'connected' | 'local' | 'static' | 'learned' | 'other';

export interface RouteEntry {
  /** Normalised prefix. */
  prefix: string;
  family: 'IPV4' | 'IPV6';
  vrf: string;
  /** The routing-table code as printed: C, S, O E2, B, or an NX-OS client name. */
  code: string;
  origin: RouteOrigin;
  /** ospf, eigrp, bgp, isis, rip; null for connected and static. */
  protocol: string | null;
  nextHops: string[];
  /** Outgoing interfaces named on the entry, when any. */
  interfaces: string[];
  /** A summary or discard route (to Null0), which claims space but leads nowhere. */
  summary: boolean;
}

export interface ArpEntry {
  address: string;
  interface: string | null;
  vrf: string;
  /** The device's own address, which IOS lists with age "-". Not a host. */
  own: boolean;
}

export interface VrfInfo {
  name: string;
  /** Address families the VRF carries, from `show vrf`. Empty when unknown. */
  families: ('IPV4' | 'IPV6')[];
}

/** Every command's output for one device, ready to classify. */
export interface DeviceTables {
  identity: DeviceIdentity;
  vrfs: VrfInfo[];
  interfaces: InterfaceAddress[];
  routes: RouteEntry[];
  arp: ArpEntry[];
  /** Commands the device refused, with what it said. */
  refused: { command: string; message: string }[];
}

/**
 * Whether a device rejected a command rather than answering it. IOS and
 * NX-OS both answer a refused or unknown command with a line beginning
 * "% ", and that line is the whole answer, so its presence is the signal.
 */
const REFUSAL = /^%\s*(Invalid|Incomplete|Ambiguous|Permission denied|Authorization failed|Unrecognized|Unknown|Command not found)/im;

export function refusalOf(output: string): string | null {
  const match = REFUSAL.exec(output);
  if (!match) return null;
  const line = output.slice(match.index).split(/\r?\n/)[0];
  return line.trim();
}
