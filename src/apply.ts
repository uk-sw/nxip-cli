import { createPool, createSubnet, listAllSubnets, listPools, previewSubnet, NxipApiError, type NxipClientOptions } from './client.js';
import { findExistingByName, nameMatchResult, needsNameMatch, planManifest } from './plan.js';
import type { Manifest, ManifestEntry, PoolEntry } from './manifest.js';

export interface ApplyResult {
  name: string;
  kind: 'pool' | 'subnet';
  outcome: 'created' | 'existing' | 'skipped' | 'failed';
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
    // The same CIDR is this pool, already in place: existing, which a re-run
    // has to report as a success. The same environment, region and family on
    // a different CIDR is not: the manifest's pool was not created, and plan
    // already calls that a naming clash, so apply must not exit 0 on it.
    if (already && already.cidr === pool.body.cidr) {
      results.push({ name: pool.name, kind: 'pool', outcome: 'existing', detail: `${already.cidr} (id ${already.id})` });
      continue;
    }
    if (already) {
      results.push({
        name: pool.name,
        kind: 'pool',
        outcome: 'skipped',
        detail: `environment "${pool.body.environment}" in ${pool.body.region} already belongs to a pool on ${already.cidr}, not ${pool.body.cidr}`,
      });
      continue;
    }

    try {
      const created = await createPool(options, pool.body);
      results.push({ name: pool.name, kind: 'pool', outcome: 'created', detail: `${created.cidr} (id ${created.id})` });
    } catch (error) {
      const message = error instanceof NxipApiError ? error.message : error instanceof Error ? error.message : String(error);
      // A 409 is either a race (someone created it between the read above
      // and now) or an overlap with another pool. It stays "skipped" rather
      // than "failed", but the API does not say which of the two it was, so
      // it is not counted as existing and the apply exits 1 either way: a
      // re-run settles a race, and an overlap needs a person.
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

  // Read once, for every prefix_length entry, nested or not: see
  // findExistingByName in plan.ts for why these are matched by name, and why
  // a failed read stops the apply rather than being skipped.
  const existingSubnets = ordered.some(needsNameMatch) ? await listAllSubnets(options) : [];
  const planned = await planManifest(options, standalone, existingSubnets);
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

      // Children are not previewed up front, because their parent may not
      // exist until earlier in this same run. Once the parent is known it can
      // be, and has to be: a re-import of a network with subnets inside it
      // would otherwise mark the network as existing and then fail on every
      // child with a 409, since each is already registered too.
      if (body.cidr) {
        const childPreview = await previewSubnet(options, body);
        if (!childPreview.wouldSucceed && childPreview.reason === 'already-exists' && childPreview.existing) {
          createdIds.set(entry.name, childPreview.existing.id);
          results.push({ name: entry.name, kind: 'subnet', outcome: 'existing', detail: `${childPreview.existing.cidr} (id ${childPreview.existing.id})` });
          continue;
        }
      } else {
        // The same problem for a sized child: the preview cannot recognise
        // it, so a second apply would nest a second one under the parent.
        const matched = nameMatchResult(entry, findExistingByName(entry, parentId, existingSubnets));
        if (matched?.reason === 'already-exists' && matched.existing) {
          createdIds.set(entry.name, matched.existing.id);
          results.push({ name: entry.name, kind: 'subnet', outcome: 'existing', detail: `${matched.existing.cidr} (id ${matched.existing.id})` });
          continue;
        }
        if (matched) {
          results.push({ name: entry.name, kind: 'subnet', outcome: 'failed', detail: `${matched.reason}: ${matched.message}` });
          continue;
        }
      }
    } else {
      const item = plannedByName.get(entry.name);
      // Already registered: skip it, but record its id. A child declared under
      // it in this manifest nests by looking its parent up in createdIds, and
      // without this every subnet inside an already-imported network would be
      // skipped as "parent was not created", even though the parent exists.
      if (item && !item.result.wouldSucceed && item.result.reason === 'already-exists' && item.result.existing) {
        createdIds.set(entry.name, item.result.existing.id);
        results.push({ name: entry.name, kind: 'subnet', outcome: 'existing', detail: `${item.result.existing.cidr} (id ${item.result.existing.id})` });
        continue;
      }
      // Failed, not skipped: nothing stopped this entry except that apply
      // will not choose between two subnets on the operator's behalf.
      if (item && !item.result.wouldSucceed && item.result.reason === 'ambiguous-name') {
        results.push({ name: entry.name, kind: 'subnet', outcome: 'failed', detail: `${item.result.reason}: ${item.result.message}` });
        continue;
      }
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

/**
 * 0 when everything in the manifest is now in place, whether this run
 * created it or it already existed, so the all-existing second run of a
 * manifest loop is green. 1 when anything failed, or was skipped: by now
 * every "already exists" is outcome 'existing', so a skip is always
 * something that was not created and should have been (no pool, a parent
 * that was not created, a naming clash). Exiting 0 on those let CI pass an
 * apply that created nothing (weft triage item 4b).
 */
export function applyExitCode(results: ApplyResult[]): 0 | 1 {
  return results.some((result) => result.outcome === 'failed' || result.outcome === 'skipped') ? 1 : 0;
}

export function formatApplyResults(results: ApplyResult[]): string {
  const lines: string[] = [];
  let created = 0;
  let existing = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of results) {
    // Only pools are labelled: they are the new, less expected thing in a
    // manifest, and prefixing every subnet line would be noise on the
    // subnets-only files that were the norm before this.
    const label = result.kind === 'pool' ? `pool ${result.name}` : result.name;
    if (result.outcome === 'created') {
      created++;
      lines.push(`  + ${label}: created at ${result.detail}`);
    } else if (result.outcome === 'existing') {
      existing++;
      lines.push(`  = ${label}: already exists at ${result.detail}`);
    } else if (result.outcome === 'skipped') {
      skipped++;
      lines.push(`  x ${label}: skipped, ${result.detail}`);
    } else {
      failed++;
      lines.push(`  ! ${label}: failed, ${result.detail}`);
    }
  }

  lines.push('');
  // Existing entries are counted apart from failures: a re-run that finds
  // everything already in place is a success, and should read as one.
  // Skipped and failed are counted apart too, and either makes the exit
  // code 1 (applyExitCode), so a CI log says why the step went red.
  lines.push(`Apply complete: ${created} created, ${existing} already existed, ${skipped} skipped, ${failed} failed.`);
  return lines.join('\n');
}
