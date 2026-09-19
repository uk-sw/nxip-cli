import { describe, expect, it } from 'vitest';
import { formatCidr, freeBlocks, parseCidr } from '../src/free-space.js';

// Done means 6 (docs/specs/address-tree-and-editing.md): the free-space
// function matches a brute-force reference on thousands of random IPv4
// layouts, the same way the API's allocateSubnet.test.ts pins its jumping
// allocator against the old stepping loop.

// The reference answer, by the most literal method there is: mark every
// address, then cover what is unmarked by recursive halving. A block that is
// entirely free is one answer; a block that is entirely used is none; a mixed
// one splits in two. That yields the maximal aligned free blocks by
// construction, and shares no code or approach with the gap-splitting in
// free-space.ts. Only ever run on small IPv4 spaces, where marking is cheap.
function bruteForceFree(container: string, children: string[]): string[] {
  const toInt = (ip: string) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const toIp = (n: number) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
  const parse = (cidr: string) => {
    const [ip, prefix] = cidr.split('/');
    const size = 2 ** (32 - Number(prefix));
    return { start: Math.floor(toInt(ip) / size) * size, size };
  };

  const outer = parse(container);
  const used = new Array<boolean>(outer.size).fill(false);
  for (const child of children.map(parse)) {
    for (let a = child.start; a < child.start + child.size; a++) {
      if (a >= outer.start && a < outer.start + outer.size) used[a - outer.start] = true;
    }
  }

  const out: string[] = [];
  const cover = (offset: number, size: number) => {
    const slice = used.slice(offset, offset + size);
    if (slice.every((u) => !u)) {
      out.push(`${toIp(outer.start + offset)}/${32 - Math.log2(size)}`);
    } else if (slice.some((u) => !u)) {
      cover(offset, size / 2);
      cover(offset + size / 2, size / 2);
    }
  };
  cover(0, outer.size);
  return out;
}

// Deterministic pseudo-random numbers, so a failure is reproducible.
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const cidrs = (container: string, children: string[]) => freeBlocks(container, children).map((b) => b.cidr);

describe('freeBlocks', () => {
  it('matches a brute-force reference on 3,000 random IPv4 layouts', () => {
    const random = rng(7);
    for (let trial = 0; trial < 3000; trial++) {
      // Containers from /22 to /28, placed away from 0.0.0.0 so alignment is
      // exercised against a real base address.
      const containerPrefix = 22 + Math.floor(random() * 7);
      const containerSize = 2 ** (32 - containerPrefix);
      const base = 10 * 2 ** 24 + Math.floor(random() * 64) * 1024;
      const containerStart = Math.floor(base / containerSize) * containerSize;
      const container = `${formatCidr('IPV4', BigInt(containerStart), containerPrefix)}`;

      const children: string[] = [];
      const count = Math.floor(random() * 10);
      for (let i = 0; i < count; i++) {
        const roll = random();
        if (roll < 0.03) {
          // A block wider than the container: everything is used.
          children.push(formatCidr('IPV4', BigInt(Math.floor(containerStart / (containerSize * 4)) * containerSize * 4), containerPrefix - 2));
          continue;
        }
        const prefix = containerPrefix + Math.floor(random() * (33 - containerPrefix));
        const size = 2 ** (32 - prefix);
        // Mostly inside, sometimes just past either end, sometimes well
        // clear of it.
        const slots = containerSize / size;
        const index = Math.floor(random() * (slots + 6)) - 3;
        children.push(formatCidr('IPV4', BigInt(containerStart + index * size), prefix));
      }

      expect(cidrs(container, children), `${container} minus ${JSON.stringify(children)}`).toEqual(
        bruteForceFree(container, children)
      );
    }
  });

  it('describes the example in the spec', () => {
    expect(cidrs('10.0.0.0/24', ['10.0.0.0/26'])).toEqual(['10.0.0.64/26', '10.0.0.128/25']);
  });

  it('returns nothing for a full container', () => {
    expect(cidrs('10.0.0.0/24', ['10.0.0.0/24'])).toEqual([]);
    expect(cidrs('10.0.0.0/24', ['10.0.0.0/25', '10.0.0.128/25'])).toEqual([]);
  });

  it('returns the whole container when it is empty', () => {
    expect(cidrs('10.0.0.0/24', [])).toEqual(['10.0.0.0/24']);
    expect(cidrs('0.0.0.0/0', [])).toEqual(['0.0.0.0/0']);
  });

  // Only direct children count at a level. A grandchild lies inside its
  // parent, so passing it as well must not change the answer.
  it('ignores a nested block inside a child', () => {
    const direct = cidrs('10.0.0.0/24', ['10.0.0.0/25']);
    expect(cidrs('10.0.0.0/24', ['10.0.0.0/25', '10.0.0.32/27'])).toEqual(direct);
    expect(direct).toEqual(['10.0.0.128/25']);
  });

  it('returns blocks in address order whatever order the children come in', () => {
    expect(cidrs('10.0.0.0/24', ['10.0.0.192/26', '10.0.0.0/26'])).toEqual(['10.0.0.64/26', '10.0.0.128/26']);
  });

  it('handles IPv6 without enumerating, in the form the API prints', () => {
    // 2^96 free addresses. Anything that walked them would never return.
    const started = performance.now();
    const free = freeBlocks('2001:db8::/32', ['2001:db8::/64']);
    expect(performance.now() - started).toBeLessThan(100);

    expect(free).toHaveLength(32);
    expect(free[0].cidr).toBe('2001:db8:0:1::/64');
    expect(free[1].cidr).toBe('2001:db8:0:2::/63');
    expect(free[31].cidr).toBe('2001:db8:8000::/33');
    // The pieces add up to exactly what is left.
    expect(free.reduce((sum, b) => sum + b.size, 0n)).toBe(2n ** 96n - 2n ** 64n);
  });

  it('handles a tiny IPv6 block deep inside a large one', () => {
    const free = freeBlocks('2602:540a::/48', ['2602:540a:0:0:100::/127']);
    expect(free.reduce((sum, b) => sum + b.size, 0n)).toBe(2n ** 80n - 2n);
    // Two equal runs of zero groups: RFC 5952 collapses the first.
    expect(free.map((b) => b.cidr)).toContain('2602:540a::100:0:0:2/127');
  });

  it('ignores a child wholly outside the container', () => {
    expect(cidrs('10.0.0.0/24', ['10.0.2.0/24'])).toEqual(['10.0.0.0/24']);
    expect(cidrs('10.0.2.0/24', ['10.0.0.0/24', '10.0.2.0/26'])).toEqual(['10.0.2.64/26', '10.0.2.128/25']);
  });

  it('refuses a child it cannot read rather than calling its space free', () => {
    expect(() => freeBlocks('10.0.0.0/24', ['10.0.0.0/33'])).toThrow(/Not a valid CIDR/);
    expect(() => freeBlocks('10.0.0.0/24', ['2001:db8::/64'])).toThrow(/address family/);
  });
});

describe('parseCidr and formatCidr', () => {
  it('round-trips IPv6 in RFC 5952 form', () => {
    for (const [input, expected] of [
      ['2001:0DB8:0000:0000:0000:0000:0000:0000/32', '2001:db8::/32'],
      ['2602:540a:0:0:100::/97', '2602:540a:0:0:100::/97'],
      ['::/0', '::/0'],
      ['2001:db8:0:1:0:0:0:1/128', '2001:db8:0:1::1/128'],
      ['::ffff:10.0.0.0/120', '::ffff:a00:0/120'],
    ]) {
      const parsed = parseCidr(input)!;
      expect(formatCidr(parsed.family, parsed.start, parsed.prefixLength)).toBe(expected);
    }
  });

  it('clears host bits', () => {
    expect(parseCidr('10.0.0.5/24')!.start).toBe(parseCidr('10.0.0.0/24')!.start);
  });

  it('rejects malformed input', () => {
    for (const bad of ['10.0.0.0', '10.0.0/24', '10.0.0.256/24', '1::2::3/64', '2001:db8::/129', '1:2:3:4:5:6:7:8:9/64', 'x/1']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});
