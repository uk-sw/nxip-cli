import { describe, it, expect } from 'vitest';
import { contains, intToIpv4, ipv4ToInt, overlapKind, parseIpv4Cidr, rangesOverlap, unionSize } from '../src/cidr.js';

describe('ipv4ToInt', () => {
  it.each([
    ['0.0.0.0', 0],
    ['0.0.0.1', 1],
    ['10.0.0.0', 167772160],
    ['255.255.255.255', 4294967295],
    // Above 2^31, where a bitwise implementation would go negative.
    ['192.168.1.1', 3232235777],
  ])('parses %s', (ip, expected) => {
    expect(ipv4ToInt(ip)).toBe(expected);
  });

  it.each(['10.0.0', '10.0.0.0.0', '10.0.0.256', '10.0.0.-1', 'ten.0.0.1', '10.0.0.1e2', '', '10.0.0.01x'])(
    'rejects %s',
    (ip) => {
      expect(ipv4ToInt(ip)).toBeNull();
    }
  );

  it('round-trips through intToIpv4', () => {
    for (const ip of ['0.0.0.0', '10.20.30.40', '192.168.1.1', '255.255.255.255']) {
      expect(intToIpv4(ipv4ToInt(ip)!)).toBe(ip);
    }
  });
});

describe('parseIpv4Cidr', () => {
  it('computes bounds for a /24', () => {
    const range = parseIpv4Cidr('10.0.1.0/24')!;
    expect(range.size).toBe(256);
    expect(intToIpv4(range.start)).toBe('10.0.1.0');
    expect(intToIpv4(range.end)).toBe('10.0.1.255');
  });

  it('handles the whole space and a single host', () => {
    expect(parseIpv4Cidr('0.0.0.0/0')!.size).toBe(4294967296);
    expect(parseIpv4Cidr('10.0.0.5/32')!.size).toBe(1);
  });

  it('normalizes host bits away, so equal blocks compare equal', () => {
    // A bitwise mask would misbehave here for large prefixes; this is the
    // property that matters for dedupe and comparison.
    expect(parseIpv4Cidr('10.0.1.77/24')!.cidr).toBe('10.0.1.0/24');
    expect(parseIpv4Cidr('192.168.1.200/16')!.cidr).toBe('192.168.0.0/16');
  });

  it('stays correct above 2^31, where signed bitwise maths breaks', () => {
    const range = parseIpv4Cidr('192.168.0.0/16')!;
    expect(range.start).toBeGreaterThan(2 ** 31);
    expect(intToIpv4(range.start)).toBe('192.168.0.0');
    expect(intToIpv4(range.end)).toBe('192.168.255.255');
  });

  it.each(['10.0.0.0/33', '10.0.0.0/x', '10.0.0.0', 'not-a-cidr', '10.0.0.0/', '2001:db8::/32'])(
    'rejects %s',
    (cidr) => {
      expect(parseIpv4Cidr(cidr)).toBeNull();
    }
  );
});

describe('rangesOverlap and contains', () => {
  const a = parseIpv4Cidr('10.0.0.0/16')!;

  it('detects a shared block', () => {
    expect(rangesOverlap(a, parseIpv4Cidr('10.0.1.0/24')!)).toBe(true);
  });

  it('rejects adjacent but disjoint blocks', () => {
    // The classic off-by-one: 10.0.0.0/16 ends at 10.0.255.255 and
    // 10.1.0.0/16 starts at 10.1.0.0, so they must not overlap.
    expect(rangesOverlap(a, parseIpv4Cidr('10.1.0.0/16')!)).toBe(false);
  });

  it('is symmetric', () => {
    const b = parseIpv4Cidr('10.0.128.0/17')!;
    expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
  });

  it('knows containment', () => {
    expect(contains(a, parseIpv4Cidr('10.0.5.0/24')!)).toBe(true);
    expect(contains(parseIpv4Cidr('10.0.5.0/24')!, a)).toBe(false);
  });
});

describe('overlapKind', () => {
  it.each([
    ['10.0.0.0/16', '10.0.0.0/16', 'identical'],
    ['10.0.0.0/16', '10.0.1.0/24', 'contains'],
    ['10.0.1.0/24', '10.0.0.0/16', 'contained-by'],
    ['10.0.0.0/16', '10.1.0.0/16', null],
  ])('%s vs %s is %s', (left, right, expected) => {
    expect(overlapKind(parseIpv4Cidr(left)!, parseIpv4Cidr(right)!)).toBe(expected);
  });

  it('detects a genuine partial overlap', () => {
    // Two ranges that straddle each other's boundary without either
    // containing the other. CIDR blocks cannot do this to each other, but
    // the range maths must still be right, since a future source may supply
    // arbitrary ranges rather than aligned blocks.
    const left = { start: 100, end: 200, prefixLength: 0, size: 101, cidr: 'a' };
    const right = { start: 150, end: 250, prefixLength: 0, size: 101, cidr: 'b' };
    expect(overlapKind(left, right)).toBe('partial');
  });
});

describe('unionSize', () => {
  it('sums disjoint ranges', () => {
    expect(unionSize([parseIpv4Cidr('10.0.0.0/24')!, parseIpv4Cidr('10.0.1.0/24')!])).toBe(512);
  });

  it('counts overlapping ranges once', () => {
    // The property that keeps "carved" honest: a subnet listed twice, or a
    // block nested inside another, must not inflate the total.
    expect(unionSize([parseIpv4Cidr('10.0.0.0/16')!, parseIpv4Cidr('10.0.1.0/24')!])).toBe(65536);
  });

  it('handles duplicates and empty input', () => {
    const range = parseIpv4Cidr('10.0.0.0/24')!;
    expect(unionSize([range, range, range])).toBe(256);
    expect(unionSize([])).toBe(0);
  });

  it('merges adjacent ranges without double counting the join', () => {
    expect(unionSize([parseIpv4Cidr('10.0.0.0/24')!, parseIpv4Cidr('10.0.1.0/24')!])).toBe(512);
  });
});
