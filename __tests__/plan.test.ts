import { describe, expect, it } from 'vitest';
import { formatPlan } from '../src/plan.js';
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
