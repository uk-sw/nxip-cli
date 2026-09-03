import { createPool, createSubnet, listPools, NxipApiError, type NxipClientOptions } from './client.js';
import { planManifest } from './plan.js';
import type { Manifest, ManifestEntry, PoolEntry } from './manifest.js';

export interface ApplyResult {
  name: string;
  kind: 'pool' | 'subnet';
  outcome: 'created' | 'skipped' | 'failed';
  detail: string;
}

/**
 * Pools are applied before subnets, and a pool that already exists is
 * skipped rather than treated as an error: re-running an apply against a
 * partly-loaded estate has to be safe, since that is exactly what happens
 * when a first pass fails halfway.
 *
 * If a pool fails to create, its subnets are still attempted. They will fail
 * on their own with a clear "no pool" reason, which is more useful than
 * silently skipping them and leaving the operator guessing what was tried.
 */
export async function applyPools(options: NxipClientOptions, pools: PoolEntry[]): Promise<ApplyResult[]> {
  if (pools.length === 0) return [];

  let existing: Awaited<ReturnType<typeof listPools>> = [];
  try {
    existing = await listPools(options);
  } catch {
    // A failed read must not stop the apply - worst case a pool that
    // already exists returns 409 below and is reported as skipped anyway.
  }

  const results: ApplyResult[] = [];
  for (const pool of pools) {
    const already = existing.find(
      (p) =>
        p.cidr === pool.body.cidr ||
        (p.environment === pool.body.environment && p.region === pool.body.region && p.family === pool.body.family)
    );
    if (already) {
      results.push({ name: pool.name, kind: 'pool', outcome: 'skipped', detail: `already exists as ${already.cidr}` });
      continue;
    }

    try {
      const created = await createPool(options, pool.body);
      results.push({ name: pool.name, kind: 'pool', outcome: 'created', detail: `${created.cidr} (id ${created.id})` });
    } catch (error) {
      const message = error instanceof NxipApiError ? error.message : error instanceof Error ? error.message : String(error);
      // A 409 means someone or something else created it between the read
      // above and now, which is a success for our purposes, not a failure.
      const conflict = error instanceof NxipApiError && error.status === 409;
      results.push({ name: pool.name, kind: 'pool', outcome: conflict ? 'skipped' : 'failed', detail: message });
    }
  }

  return results;
}

/** Applies a whole manifest: pools first, then the subnets that need them. */
export async function applyFullManifest(options: NxipClientOptions, manifest: Manifest): Promise<ApplyResult[]> {
  const poolResults = await applyPools(options, manifest.pools);
  const subnetResults = await applyManifest(options, manifest.subnets);
  return [...poolResults, ...subnetResults];
}

/**
 * Re-runs the plan immediately before applying (not the caller's earlier
 * plan output, if any) - the preview is never reserved, so the only safe
 * apply is one based on a fresh read, and even then the real create can
 * still fail if something else raced it in between. That failure is
 * reported per-subnet, not thrown - one collision shouldn't abort every
 * other subnet in the same manifest.
 */
export async function applyManifest(options: NxipClientOptions, entries: ManifestEntry[]): Promise<ApplyResult[]> {
  const planned = await planManifest(options, entries);
  const results: ApplyResult[] = [];

  for (const item of planned) {
    if (!item.result.wouldSucceed) {
      results.push({ name: item.name, kind: 'subnet', outcome: 'skipped', detail: `${item.result.reason}: ${item.result.message}` });
      continue;
    }

    try {
      const created = await createSubnet(options, item.body);
      results.push({ name: item.name, kind: 'subnet', outcome: 'created', detail: `${created.cidr} (id ${created.id})` });
    } catch (error) {
      const message = error instanceof NxipApiError ? error.message : error instanceof Error ? error.message : String(error);
      results.push({ name: item.name, kind: 'subnet', outcome: 'failed', detail: message });
    }
  }

  return results;
}

export function formatApplyResults(results: ApplyResult[]): string {
  const lines: string[] = [];
  let created = 0;

  for (const result of results) {
    // Only pools are labelled: they are the new, less expected thing in a
    // manifest, and prefixing every subnet line would be noise on the
    // subnets-only files that were the norm before this.
    const label = result.kind === 'pool' ? `pool ${result.name}` : result.name;
    if (result.outcome === 'created') {
      created++;
      lines.push(`  + ${label}: created at ${result.detail}`);
    } else if (result.outcome === 'skipped') {
      lines.push(`  x ${label}: skipped, ${result.detail}`);
    } else {
      lines.push(`  ! ${label}: failed, ${result.detail}`);
    }
  }

  lines.push('');
  lines.push(`Apply complete: ${created} created, ${results.length - created} not created.`);
  return lines.join('\n');
}
