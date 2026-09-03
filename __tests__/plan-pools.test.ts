import { describe, it, expect } from 'vitest';
import { annotateAgainstPools, formatAnnotatedPlan, formatPoolPlan, type PlannedPool } from '../src/plan.js';
import type { PlannedSubnet } from '../src/types.js';

function pool(overrides: Partial<PlannedPool> = {}): PlannedPool {
  return {
    name: 'prod-euw2',
    body: { name: 'prod-euw2', cidr: '10.210.0.0/16', family: 'IPV4', environment: 'prod-euw2', region: 'eu-west-2' },
    status: 'will-create',
    ...overrides,
  };
}

function failingSubnet(reason: string, environment = 'prod-euw2'): PlannedSubnet {
  return {
    name: 'web-a',
    body: { family: 'IPV4', cidr: '10.210.1.0/24', environment, region: 'eu-west-2' },
    result: {
      wouldSucceed: false,
      reason: reason as never,
      message: 'nope',
      httpStatusIfAttempted: 409,
    },
  };
}

describe('annotateAgainstPools', () => {
  it('treats a missing pool as pending when this manifest creates it', () => {
    // The case that made the first run look broken: a subnet always previews
    // as a failure when its pool is a few lines above it and does not exist yet.
    const [annotated] = annotateAgainstPools([failingSubnet('no-pool')], [pool()]);
    expect(annotated.blocker).toBe('pending-pool');
    expect(annotated.detail).toContain('created first by this same apply');
  });

  it('flags a key already held by a different pool as a real clash', () => {
    const existing = pool({ status: 'exists', detail: '10.100.0.0/16' });
    const [annotated] = annotateAgainstPools([failingSubnet('outside-pool')], [existing]);
    expect(annotated.blocker).toBe('pool-key-taken');
    expect(annotated.detail).toContain('10.100.0.0/16');
    expect(annotated.detail).toContain('10.210.0.0/16');
  });

  it('does not excuse a failure unrelated to pools', () => {
    for (const reason of ['tier-limit', 'overlaps-existing', 'invalid-cidr']) {
      expect(annotateAgainstPools([failingSubnet(reason)], [pool()])[0].blocker).toBe('real');
    }
  });

  it('does not excuse a subnet no declared pool would serve', () => {
    // Different environment, so the declared pool is irrelevant to it.
    const [annotated] = annotateAgainstPools([failingSubnet('no-pool', 'somewhere-else')], [pool()]);
    expect(annotated.blocker).toBe('real');
  });

  it('leaves succeeding subnets alone', () => {
    const ok: PlannedSubnet = {
      name: 'fine',
      body: { family: 'IPV4', prefixLength: 24, environment: 'prod', region: 'eu-west-2' },
      result: { wouldSucceed: true } as never,
    };
    expect(annotateAgainstPools([ok], [pool()])[0].blocker).toBe('real');
  });
});

describe('formatAnnotatedPlan', () => {
  it('counts pending subnets as creatable, not failed', () => {
    const output = formatAnnotatedPlan(annotateAgainstPools([failingSubnet('no-pool')], [pool()]));
    expect(output).toContain('waiting on a pool declared in this manifest');
    expect(output).toContain('Plan: 1 to create (1 after their pool), 0 blocked.');
    // The old wording was actively misleading here.
    expect(output).not.toContain('would fail');
  });

  it('tells you how to fix a naming clash rather than just reporting it', () => {
    const existing = pool({ status: 'exists', detail: '10.100.0.0/16' });
    const output = formatAnnotatedPlan(annotateAgainstPools([failingSubnet('outside-pool')], [existing]));
    expect(output).toContain('blocked by a naming clash');
    expect(output).toContain('Rename');
    expect(output).toContain('1 blocked');
  });
});

describe('formatPoolPlan', () => {
  it('separates pools to create from pools already there', () => {
    const output = formatPoolPlan([pool(), pool({ name: 'other', status: 'exists', detail: '10.9.0.0/16' })]);
    expect(output).toContain('pool prod-euw2 will be created');
    expect(output).toContain('pool other already exists (10.9.0.0/16), no change');
    expect(output).toContain('Pools: 1 to create, 1 unchanged.');
  });

  it('admits when it could not read existing pools rather than guessing', () => {
    const output = formatPoolPlan([pool({ status: 'unknown', detail: 'could not read existing pools' })]);
    expect(output).toContain('could not read existing pools');
  });

  it('renders nothing for a manifest with no pools', () => {
    expect(formatPoolPlan([])).toBe('');
  });
});
