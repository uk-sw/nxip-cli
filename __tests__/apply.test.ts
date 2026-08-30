import { describe, expect, it } from 'vitest';
import { formatApplyResults, type ApplyResult } from '../src/apply.js';

describe('formatApplyResults', () => {
  it('reports created, skipped, and failed subnets, with a correct total', () => {
    const results: ApplyResult[] = [
      { name: 'payments', outcome: 'created', detail: '10.0.4.0/24 (id sub_1)' },
      { name: 'overflow', outcome: 'skipped', detail: 'full: Pool is full' },
      { name: 'race-loser', outcome: 'failed', detail: 'CIDR was taken by a concurrent request' },
    ];

    const output = formatApplyResults(results);
    expect(output).toContain('+ payments: created at 10.0.4.0/24 (id sub_1)');
    expect(output).toContain('x overflow: skipped, full: Pool is full');
    expect(output).toContain('! race-loser: failed, CIDR was taken by a concurrent request');
    expect(output).toContain('Apply complete: 1 created, 2 not created.');
  });

  it('reports zero created when every subnet was skipped', () => {
    const results: ApplyResult[] = [{ name: 'a', outcome: 'skipped', detail: 'full: Pool is full' }];
    expect(formatApplyResults(results)).toContain('Apply complete: 0 created, 1 not created.');
  });
});
