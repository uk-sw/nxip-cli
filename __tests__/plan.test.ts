import { describe, expect, it } from 'vitest';
import { formatPlan, findCrossPoolOverlaps, formatCrossPoolOverlaps } from '../src/plan.js';
import type { PlannedSubnet } from '../src/types.js';

describe('formatPlan', () => {
  it('formats a successful prediction with the predicted CIDR and container utilization', () => {
    const planned: PlannedSubnet[] = [
      {
        name: 'payments',
        body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'us-east-1' },
        result: {
          wouldSucceed: true,
          subnet: {
            cidr: '10.0.4.0/24',
            prefixLength: 24,
            family: 'IPV4',
            environment: 'production',
            region: 'us-east-1',
            ipPoolId: 'pool_1',
            parentSubnetId: null,
            kind: null,
            name: null,
            description: null,
            metadata: {},
          },
          container: { type: 'pool', id: 'pool_1', name: 'prod-us-east', cidr: '10.0.0.0/16' },
          utilization: {
            before: { subnetCount: 3, percentageUsed: 18 },
            after: { subnetCount: 4, percentageUsed: 24 },
          },
        },
      },
    ];

    const output = formatPlan(planned);
    expect(output).toContain('payments will be created');
    expect(output).toContain('10.0.4.0/24');
    expect(output).toContain('pool "prod-us-east" (18% -> 24%)');
    expect(output).toContain('Plan: 1 to create, 0 would fail.');
    expect(output).toContain('not reserved');
  });

  it('formats a predicted failure with its reason and message', () => {
    const planned: PlannedSubnet[] = [
      {
        name: 'overflow',
        body: { family: 'IPV4', prefixLength: 24, environment: 'production', region: 'us-east-1' },
        result: { wouldSucceed: false, reason: 'full', message: 'Pool is full', httpStatusIfAttempted: 402 },
      },
    ];

    const output = formatPlan(planned);
    expect(output).toContain('overflow would fail');
    expect(output).toContain('reason:  full');
    expect(output).toContain('Pool is full');
    expect(output).toContain('Plan: 0 to create, 1 would fail.');
    expect(output).not.toContain('not reserved');
  });

  it('counts a mix of successes and failures correctly', () => {
    const planned: PlannedSubnet[] = [
      {
        name: 'a',
        body: { family: 'IPV4', prefixLength: 24 },
        result: {
          wouldSucceed: true,
          subnet: {
            cidr: '10.0.0.0/24',
            prefixLength: 24,
            family: 'IPV4',
            environment: 'production',
            region: 'us-east-1',
            ipPoolId: 'pool_1',
            parentSubnetId: null,
            kind: null,
            name: null,
            description: null,
            metadata: {},
          },
          container: { type: 'pool', id: 'pool_1', name: 'prod', cidr: '10.0.0.0/16' },
          utilization: { before: { subnetCount: 0 }, after: { subnetCount: 1 } },
        },
      },
      {
        name: 'b',
        body: { family: 'IPV4', prefixLength: 24 },
        result: { wouldSucceed: false, reason: 'tier-limit', message: 'Over limit', httpStatusIfAttempted: 402 },
      },
    ];

    expect(formatPlan(planned)).toContain('Plan: 1 to create, 1 would fail.');
  });
});

describe('findCrossPoolOverlaps', () => {
  const pool = (name: string, cidr: string, environment: string, region: string) =>
    ({ id: name, name, cidr, family: 'IPV4' as const, environment, region });
  const entry = (name: string, cidr: string, environment?: string, region?: string) =>
    ({ name, body: { family: 'IPV4' as const, cidr, environment, region } });

  it('flags an entry sitting inside a pool scoped to another region', () => {
    const found = findCrossPoolOverlaps(
      [entry('vnet-beta', '10.165.0.0/16', 'xpool', 'region-beta')],
      [pool('Alpha', '10.160.0.0/12', 'xpool', 'region-alpha')]
    );
    expect(found).toHaveLength(1);
    expect(found[0].pool.name).toBe('Alpha');
  });

  // The pool an entry is actually destined for is not a finding: its space
  // is supposed to sit inside that one.
  it('does not flag an entry against its own target pool', () => {
    const found = findCrossPoolOverlaps(
      [entry('web', '10.20.1.0/24', 'production', 'eu-west-2')],
      [pool('EU West', '10.20.0.0/16', 'production', 'eu-west-2')]
    );
    expect(found).toHaveLength(0);
  });

  it('ignores entries that do not overlap anything', () => {
    const found = findCrossPoolOverlaps(
      [entry('far-away', '192.168.0.0/16', 'xpool', 'region-beta')],
      [pool('Alpha', '10.160.0.0/12', 'xpool', 'region-alpha')]
    );
    expect(found).toHaveLength(0);
  });

  // Nested entries inherit their pool from a parent, and carry no
  // environment or region of their own to compare against.
  it('skips entries with no cidr to compare', () => {
    const found = findCrossPoolOverlaps(
      [{ name: 'sized', body: { family: 'IPV4' as const, prefixLength: 24, environment: 'xpool', region: 'region-beta' } }],
      [pool('Alpha', '10.160.0.0/12', 'xpool', 'region-alpha')]
    );
    expect(found).toHaveLength(0);
  });

  it('renders nothing when there is nothing to warn about', () => {
    expect(formatCrossPoolOverlaps([])).toBe('');
  });

  it('names both sides, since either could be the mistake', () => {
    const out = formatCrossPoolOverlaps(
      findCrossPoolOverlaps(
        [entry('vnet-beta', '10.165.0.0/16', 'xpool', 'region-beta')],
        [pool('Alpha', '10.160.0.0/12', 'xpool', 'region-alpha')]
      )
    );
    expect(out).toContain('10.165.0.0/16');
    expect(out).toContain('10.160.0.0/12');
    expect(out).toContain('region-alpha');
  });
});

describe('formatPlan failures name the block', () => {
  const failure = (name: string, body: Record<string, unknown>) => ({
    name,
    body: { family: 'IPV4' as const, ...body },
    result: { wouldSucceed: false as const, reason: 'no-pool', message: 'No matching IPV4 IP pool found.' },
  });

  // A failure has no allocated subnet, so the block has to come from the
  // request. Without it you know which entry failed but not which CIDR,
  // and have to go back to the manifest to find out.
  it('shows the requested cidr when one was pinned', () => {
    const out = formatPlan([failure('koreasouth-vnet', { cidr: '10.250.0.0/23' })] as never);
    expect(out).toContain('cidr:    10.250.0.0/23');
  });

  it('shows the requested size when allocating by prefix length', () => {
    const out = formatPlan([failure('payments', { prefixLength: 24 })] as never);
    expect(out).toContain('size:    /24');
  });

  it('adds no such line when neither was given', () => {
    const out = formatPlan([failure('odd', {})] as never);
    expect(out).not.toContain('cidr:');
    expect(out).not.toContain('size:');
  });
});
