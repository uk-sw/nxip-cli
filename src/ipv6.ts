/**
 * Minimal IPv6 prefix arithmetic, the v6 counterpart of cidr.ts. The Cisco
 * source is the first thing in this package that reads v6 prefixes off a
 * device rather than skipping them, so it needs to normalise them, tell a
 * host route from a subnet, and decide whether a prefix is link-local or
 * unique-local. BigInt because 128 bits do not fit a Number; the same
 * "plain arithmetic, no bitwise" rule as cidr.ts applies for the same
 * reason, since `<<` and `&` are 32-bit signed operations.
 */

export interface Ipv6Range {
  start: bigint;
  end: bigint;
  prefixLength: number;
  /** The normalized CIDR: lower-case, compressed, host bits cleared. */
  cidr: string;
}

const MAX = (1n << 128n) - 1n;

/** Expands "::" and parses each group. Returns null on anything malformed. */
export function ipv6ToBigInt(ip: string): bigint | null {
  const text = ip.trim().toLowerCase();
  if (text.length === 0 || /[^0-9a-f:.]/.test(text)) return null;

  // An embedded IPv4 tail (::ffff:10.0.0.1) is rare on a router interface
  // but legal, so it is turned into two groups rather than rejected.
  let expanded = text;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const high = ((octets[0] * 256 + octets[1]).toString(16)).padStart(4, '0');
    const low = ((octets[2] * 256 + octets[3]).toString(16)).padStart(4, '0');
    expanded = `${text.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = value * 65536n + BigInt(parseInt(group, 16));
  }
  return value;
}

/** Renders in the RFC 5952 compressed form, lower-case. */
export function bigIntToIpv6(value: bigint): string {
  const groups: number[] = [];
  let remaining = value;
  for (let i = 0; i < 8; i++) {
    groups.unshift(Number(remaining % 65536n));
    remaining = remaining / 65536n;
  }

  // Longest run of zero groups (length 2 or more) becomes "::", the first
  // such run winning a tie, which is what RFC 5952 asks for.
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

/** Returns null rather than throwing: input here comes off a device. */
export function parseIpv6Cidr(cidr: string): Ipv6Range | null {
  const [ip, prefix] = cidr.split('/');
  if (ip === undefined || prefix === undefined) return null;
  if (!/^\d{1,3}$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  if (prefixLength > 128) return null;

  const value = ipv6ToBigInt(ip);
  if (value === null) return null;

  const size = 1n << BigInt(128 - prefixLength);
  const start = (value / size) * size;
  const end = start + size - 1n > MAX ? MAX : start + size - 1n;
  return { start, end, prefixLength, cidr: `${bigIntToIpv6(start)}/${prefixLength}` };
}

/**
 * The smallest aligned block containing every range given. The v6 answer to
 * "which pool covers these", worked out the same way as coveringIpv4Block:
 * shorten the prefix until one block holds the lowest and highest address.
 */
export function coveringIpv6Block(ranges: Ipv6Range[]): Ipv6Range | null {
  if (ranges.length === 0) return null;
  const low = ranges.reduce((min, r) => (r.start < min ? r.start : min), ranges[0].start);
  const high = ranges.reduce((max, r) => (r.end > max ? r.end : max), ranges[0].end);
  for (let prefixLength = 128; prefixLength >= 0; prefixLength--) {
    const size = 1n << BigInt(128 - prefixLength);
    const start = (low / size) * size;
    if (start + size - 1n >= high) {
      return { start, end: start + size - 1n, prefixLength, cidr: `${bigIntToIpv6(start)}/${prefixLength}` };
    }
  }
  return null;
}

/** fe80::/10, never routed and never an address plan. */
export function isIpv6LinkLocal(range: Ipv6Range): boolean {
  return range.start >= 0xfe80n << 112n && range.end <= (0xfec0n << 112n) - 1n;
}

/** fc00::/7, the private space of v6, RFC 4193. */
export function isIpv6UniqueLocal(range: Ipv6Range): boolean {
  return range.start >= 0xfc00n << 112n && range.end <= (0xfe00n << 112n) - 1n;
}
