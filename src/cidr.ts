/**
 * Minimal IPv4 CIDR arithmetic, enough to detect overlaps and measure how
 * much of a block is carved up. Deliberately dependency-free and
 * deliberately not bitwise: JavaScript's `<<` and `&` operate on 32-bit
 * *signed* integers, so `1 << 31` is negative and every mask above /1 goes
 * wrong in ways that look right for small examples. Plain arithmetic on
 * numbers is exact here because the whole IPv4 space (2^32) sits well
 * inside Number.MAX_SAFE_INTEGER.
 */

export interface Ipv4Range {
  /** First address as an integer, inclusive. */
  start: number;
  /** Last address as an integer, inclusive. */
  end: number;
  prefixLength: number;
  /** Total addresses in the block. */
  size: number;
  /** The normalized CIDR, i.e. with host bits cleared. */
  cidr: string;
}

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // Reject "01", "1e2", "+1" and friends - only plain decimal octets.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function intToIpv4(value: number): string {
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

/** Returns null rather than throwing: input here comes from a cloud API. */
export function parseIpv4Cidr(cidr: string): Ipv4Range | null {
  const [ip, prefix] = cidr.split('/');
  if (ip === undefined || prefix === undefined) return null;
  if (!/^\d{1,2}$/.test(prefix)) return null;

  const prefixLength = Number(prefix);
  if (prefixLength > 32) return null;

  const value = ipv4ToInt(ip);
  if (value === null) return null;

  const size = 2 ** (32 - prefixLength);
  // Clear host bits by flooring to the block boundary, so 10.0.0.5/24 and
  // 10.0.0.0/24 compare equal rather than silently differing.
  const start = Math.floor(value / size) * size;

  return { start, end: start + size - 1, prefixLength, size, cidr: `${intToIpv4(start)}/${prefixLength}` };
}

/** True when two ranges share at least one address. */
export function rangesOverlap(a: Ipv4Range, b: Ipv4Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** True when `inner` sits entirely within `outer`. */
export function contains(outer: Ipv4Range, inner: Ipv4Range): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * Describes how two overlapping ranges relate, which changes how serious it
 * is: an identical pair is almost always a real collision, whereas
 * containment is often just a nested-by-design block someone modelled as a
 * separate VPC.
 */
export type OverlapKind = 'identical' | 'contains' | 'contained-by' | 'partial';

export function overlapKind(a: Ipv4Range, b: Ipv4Range): OverlapKind | null {
  if (!rangesOverlap(a, b)) return null;
  if (a.start === b.start && a.end === b.end) return 'identical';
  if (contains(a, b)) return 'contains';
  if (contains(b, a)) return 'contained-by';
  return 'partial';
}

/** Addresses covered by a set of ranges, counting overlaps only once. */
export function unionSize(ranges: Ipv4Range[]): number {
  if (ranges.length === 0) return 0;

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -1;

  for (const range of sorted) {
    const from = Math.max(range.start, cursor + 1);
    if (range.end >= from) {
      total += range.end - from + 1;
      cursor = range.end;
    }
  }
  return total;
}
