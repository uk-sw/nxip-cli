/**
 * Free space inside a container, as the smallest set of maximal aligned
 * CIDR blocks: a /24 with only 10.0.0.0/26 used is free as
 * `10.0.0.64/26, 10.0.0.128/25`, never as 192 addresses or three /26s.
 * What `nxip tree --free` prints (docs/specs/address-tree-and-editing.md,
 * Part B).
 *
 * BigInt throughout, and for both families, unlike cidr.ts next door, which
 * is IPv4-only because scan only ever sees IPv4 VPCs. An IPv6 /32 with one
 * /64 carved out has 2^96 free addresses, so nothing here ever walks
 * addresses: the work is proportional to the number of children and the
 * prefix bits, not to the size of the space.
 *
 * The GUI has its own copy of this logic (src/lib/free-space.ts in
 * nx-ip-gui-frontend). A shared package was ruled out of scope by the spec,
 * so each copy carries its own brute-force test instead.
 */

export type Family = 'IPV4' | 'IPV6';

export interface ParsedCidr {
  family: Family;
  /** First address, inclusive. */
  start: bigint;
  /** Addresses in the block, so the block ends before start + size. */
  size: bigint;
  prefixLength: number;
}

export interface FreeBlock {
  cidr: string;
  start: bigint;
  size: bigint;
}

const BITS: Record<Family, number> = { IPV4: 32, IPV6: 128 };

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Plain decimal octets only, the same strictness as cidr.ts: "01" or
    // "1e2" is a typo, not an address.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256n + BigInt(octet);
  }
  return value;
}

function parseIpv6(ip: string): bigint | null {
  // A trailing dotted quad (::ffff:10.0.0.1) stands for the last two groups.
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  // "::" must stand for at least one group; without it there must be eight.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  let value = 0n;
  for (const group of [...head, ...Array<string>(missing).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

/** Returns null rather than throwing, so callers decide what bad input means. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const ip = cidr.slice(0, slash);
  const prefix = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return null;

  const family: Family = ip.includes(':') ? 'IPV6' : 'IPV4';
  const value = family === 'IPV6' ? parseIpv6(ip) : parseIpv4(ip);
  const prefixLength = Number(prefix);
  if (value === null || prefixLength > BITS[family]) return null;

  const size = 1n << BigInt(BITS[family] - prefixLength);
  // Host bits cleared, so 10.0.0.5/24 means the same block as 10.0.0.0/24.
  return { family, start: value - (value % size), size, prefixLength };
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join('.');
}

// RFC 5952 form, the one the API itself returns (ip-address's correctForm):
// lowercase, no leading zeros, and the longest run of two or more zero
// groups collapsed to "::", the first such run on a tie.
function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((value >> shift) & 0xffffn));
  }

  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

export function formatCidr(family: Family, start: bigint, prefixLength: number): string {
  return `${family === 'IPV6' ? formatIpv6(start) : formatIpv4(start)}/${prefixLength}`;
}

/**
 * Splits [start, end) into maximal aligned blocks, largest first from the
 * left. At each step the block is the biggest power of two that both starts
 * on its own boundary and still fits, which is exactly the set of maximal
 * aligned blocks in the range. At most two blocks per prefix length come
 * out of one range, so this is bounded by the prefix bits, never by the
 * number of addresses.
 */
function splitRange(family: Family, start: bigint, end: bigint, out: FreeBlock[]) {
  const bits = BITS[family];
  let cursor = start;
  while (cursor < end) {
    // How far the cursor is aligned: its trailing zero bits.
    let hostBits = 0;
    while (hostBits < bits && ((cursor >> BigInt(hostBits)) & 1n) === 0n) hostBits++;
    // Then shrink until the block fits in what is left.
    while (cursor + (1n << BigInt(hostBits)) > end) hostBits--;
    const size = 1n << BigInt(hostBits);
    out.push({ cidr: formatCidr(family, cursor, bits - hostBits), start: cursor, size });
    cursor += size;
  }
}

/**
 * The free space in `container` once `children` are taken out, in address
 * order.
 *
 * Callers pass a level's direct children only. A grandchild sits inside a
 * child, so it never changes the answer at this level, and passing one
 * anyway is harmless: overlapping and nested children are merged before
 * the gaps are measured. A child reaching outside the container counts only
 * for the part inside it.
 *
 * Throws on a CIDR that does not parse or a child of the other family. The
 * data comes from the API, so either would be a bug, and quietly skipping a
 * child would report its space as free, which is the one wrong answer this
 * must never give.
 */
export function freeBlocks(container: string, children: string[]): FreeBlock[] {
  const outer = parseCidr(container);
  if (!outer) throw new Error(`Not a valid CIDR: ${container}`);
  const outerEnd = outer.start + outer.size;

  const used = children
    .map((child) => {
      const parsed = parseCidr(child);
      if (!parsed) throw new Error(`Not a valid CIDR: ${child}`);
      if (parsed.family !== outer.family) throw new Error(`${child} is not the same address family as ${container}`);
      // Clipped at the container's end, so a child wholly past it has
      // nothing left and is dropped below, rather than stretching the gap
      // before it beyond the container. The start needs no clip: anything
      // before the container is already behind the cursor.
      const childEnd = parsed.start + parsed.size;
      return { from: parsed.start, to: childEnd < outerEnd ? childEnd : outerEnd };
    })
    .filter((range) => range.from < range.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const free: FreeBlock[] = [];
  let cursor = outer.start;
  for (const range of used) {
    if (range.from > cursor) splitRange(outer.family, cursor, range.from, free);
    if (range.to > cursor) cursor = range.to;
  }
  if (cursor < outerEnd) splitRange(outer.family, cursor, outerEnd, free);
  return free;
}
