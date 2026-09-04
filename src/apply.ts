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
/**
 * Parents before children, so a `parent:` reference can be swapped for the
 * real nxip id by the time the child is created. Cycles and dangling
 * references are already rejected at parse time, so the escape hatch here is
 * defensive rather than expected.
 */
function orderParentsFirst(entries: ManifestEntry[]): ManifestEntry[] {
  const ordered: ManifestEntry[] = [];
  const emitted = new Set<string>();
  let remaining = [...entries];

  while (remaining.length > 0) {
    const ready = remaining.filter((entry) => !entry.parent || emitted.has(entry.parent));
    if (ready.length === 0) {
      ordered.push(...remaining);
      break;
    }
    for (const entry of ready) {
      ordered.push(entry);
      emitted.add(entry.name);
    }
    const readySet = new Set(ready);
    remaining = remaining.filter((entry) => !readySet.has(entry));
  }

  return ordered;
}

export async function applyManifest(options: NxipClientOptions, entries: ManifestEntry[]): Promise<ApplyResult[]> {
  const ordered = orderParentsFirst(entries);

  // Only entries that stand on their own can be previewed up front. A child
  // nests under something this same apply has not created yet, so there is
  // nothing for the preview to resolve against: those are validated by the
  // API at creation time instead.
  const standalone = ordered.filter((entry) => !entry.parent);
  const planned = await planManifest(options, standalone);
  const plannedByName = new Map(planned.map((item) => [item.name, item]));

  const createdIds = new Map<string, string>();
  const results: ApplyResult[] = [];

  for (const entry of ordered) {
    let body = entry.body;

    if (entry.parent) {
      const parentId = createdIds.get(entry.parent);
      if (!parentId) {
        results.push({
          name: entry.name,
          kind: 'subnet',
          outcome: 'skipped',
          detail: `parent "${entry.parent}" was not created, so this could not be nested under it`,
        });
        continue;
      }
      body = { ...body, parentSubnetId: parentId };
    } else {
      const item = plannedByName.get(entry.name);
      if (item && !item.result.wouldSucceed) {
        results.push({ name: entry.name, kind: 'subnet', outcome: 'skipped', detail: `${item.result.reason}: ${item.result.message}` });
        continue;
      }
      if (item) body = item.body;
    }

    try {
      const created = await createSubnet(options, body);
      createdIds.set(entry.name, created.id);
      results.push({ name: entry.name, kind: 'subnet', outcome: 'created', detail: `${created.cidr} (id ${created.id})` });
    } catch (error) {
      const message = error instanceof NxipApiError ? error.message : error instanceof Error ? error.message : String(error);
      results.push({ name: entry.name, kind: 'subnet', outcome: 'failed', detail: message });
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
