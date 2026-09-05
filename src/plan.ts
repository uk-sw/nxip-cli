import { mapWithConcurrency } from './concurrency.js';
import { previewSubnet, type NxipClientOptions } from './client.js';
import type { ManifestEntry } from './manifest.js';
import { parseIpv4Cidr, rangesOverlap } from './cidr.js';
import type { PlannedSubnet } from './types.js';

const PREVIEW_CONCURRENCY = 5;

/**
 * Entries that nest under another entry in this same file are deliberately
 * not previewed: their parent does not exist yet, so there is nothing for
 * the API to resolve them against, and a preview would fail for a reason
 * that says nothing about whether the apply will work. They are reported
 * separately by `formatNestedEntries`, the same way a subnet waiting on a
 * pool declared in the same file is reported rather than failed.
 */
export async function planManifest(options: NxipClientOptions, entries: ManifestEntry[]): Promise<PlannedSubnet[]> {
  const standalone = entries.filter((entry) => !entry.parent);
  return mapWithConcurrency(standalone, PREVIEW_CONCURRENCY, async (entry) => ({
    name: entry.name,
    body: entry.body,
    result: await previewSubnet(options, entry.body),
  }));
}

/**
 * Manifest entries whose address space lands inside a pool other than the
 * one they will resolve into.
 *
 * A subnet resolves to a pool by (environment, region, family), so a block
 * sitting inside a pool scoped to a *different* region is not going to be
 * routed there. It is either a mislabelled entry or a genuine collision
 * between two regions' address plans, and both are worth saying out loud
 * before anything is created.
 *
 * The API now refuses to create overlapping pools outright, so this exists
 * to catch the case earlier and with a clearer message than a 409, and to
 * flag estates that already contain an overlap from before that rule.
 */
export function findCrossPoolOverlaps(
  entries: ManifestEntry[],
  pools: import('./types.js').NxipPool[]
): { entry: ManifestEntry; pool: import('./types.js').NxipPool }[] {
  const findings: { entry: ManifestEntry; pool: import('./types.js').NxipPool }[] = [];

  for (const entry of entries) {
    const cidr = entry.body.cidr;
    if (!cidr || entry.body.family !== 'IPV4') continue;
    const range = parseIpv4Cidr(cidr);
    if (!range) continue;

    for (const pool of pools) {
      if (pool.family !== 'IPV4') continue;
      // The pool this entry is actually destined for is not a finding: its
      // space is supposed to sit inside that one.
      if (pool.environment === entry.body.environment && pool.region === entry.body.region) continue;

      const poolRange = parseIpv4Cidr(pool.cidr);
      if (poolRange && rangesOverlap(range, poolRange)) {
        findings.push({ entry, pool });
      }
    }
  }

  return findings;
}

/** Renders findCrossPoolOverlaps for `plan` output. */
export function formatCrossPoolOverlaps(
  findings: { entry: ManifestEntry; pool: import('./types.js').NxipPool }[]
): string {
  if (findings.length === 0) return '';

  const lines = [
    '',
    `  Warning: ${findings.length} entr${findings.length === 1 ? 'y overlaps' : 'ies overlap'} a pool in another region.`,
    '',
  ];
  for (const { entry, pool } of findings) {
    const where = entry.body.region ? `${entry.body.environment ?? '?'} / ${entry.body.region}` : 'nested under a parent';
    lines.push(`    ${entry.name}  ${entry.body.cidr}  (${where})`);
    lines.push(`      sits inside pool "${pool.name}" ${pool.cidr} (${pool.environment} / ${pool.region})`);
  }
  lines.push('');
  lines.push('  A subnet resolves to a pool by environment, region and family, so this');
  lines.push('  will not route there. Either the entry is labelled for the wrong region,');
  lines.push('  or two regions have been given overlapping address space.');
  lines.push('');
  return lines.join('\n');
}

/** The nested half of a manifest, rendered for `plan` output. */
export function formatNestedEntries(entries: ManifestEntry[]): string {
  const nested = entries.filter((entry) => entry.parent);
  if (nested.length === 0) return '';

  const lines = [
    '',
    `  ${nested.length} subnet${nested.length === 1 ? '' : 's'} nest inside another subnet in this file,`,
    '  so they are created after their parent and cannot be previewed',
    '  independently:',
    '',
  ];
  for (const entry of nested) {
    const cidr = entry.body.cidr ? ` ${entry.body.cidr}` : '';
    lines.push(`    + ${entry.name}${cidr}  under "${entry.parent}"`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatUtilization(before: { percentageUsed?: number }, after: { percentageUsed?: number }): string {
  if (before.percentageUsed === undefined || after.percentageUsed === undefined) return '';
  return ` (${before.percentageUsed}% -> ${after.percentageUsed}%)`;
}

export function formatPlan(planned: PlannedSubnet[]): string {
  const lines: string[] = [];
  let toCreate = 0;
  let wouldFail = 0;

  for (const item of planned) {
    if (item.result.wouldSucceed) {
      toCreate++;
      const { subnet, container } = item.result;
      lines.push(`  # ${item.name} will be created`);
      lines.push(`  + environment   = "${subnet.environment}"`);
      lines.push(`    region        = "${subnet.region}"`);
      lines.push(`    family        = "${subnet.family}"`);
      lines.push(`    prefix_length = ${subnet.prefixLength}`);
      lines.push(`    cidr          = "${subnet.cidr}" (predicted, not reserved)`);
      lines.push(
        `    container     = ${container.type} "${container.name ?? container.id}"${formatUtilization(item.result.utilization.before, item.result.utilization.after)}`
      );
      lines.push('');
    } else {
      wouldFail++;
      lines.push(`  # ${item.name} would fail`);
      lines.push(`  x reason:  ${item.result.reason}`);
      // A failure has no allocated subnet to report, so this comes from what
      // was asked for. Without it the reader knows which entry failed but not
      // which block, and has to go back to the manifest to find out.
      if (item.body.cidr) {
        lines.push(`    cidr:    ${item.body.cidr}`);
      } else if (item.body.prefixLength !== undefined) {
        lines.push(`    size:    /${item.body.prefixLength}`);
      }
      lines.push(`    message: ${item.result.message}`);
      lines.push('');
    }
  }

  lines.push(`Plan: ${toCreate} to create, ${wouldFail} would fail.`);
  if (toCreate > 0) {
    lines.push('');
    lines.push(
      'Note: this prediction is not reserved. Nothing is locked, so a concurrent apply against the same container can land differently by the time you actually run `nxip apply`.'
    );
  }

  return lines.join('\n');
}

export interface PlannedPool {
  name: string;
  body: import('./types.js').NxipPoolBody;
  /** Pools have no preview endpoint, so this comes from a real list read. */
  status: 'will-create' | 'exists' | 'unknown';
  detail?: string;
}

/**
 * Pools have no preview endpoint, unlike subnets, so the only honest thing
 * a plan can do is read what exists and compare. When that read fails the
 * status is 'unknown' rather than a guess - claiming "will create" about a
 * pool that already exists would make the plan lie.
 */
export async function planPools(
  options: import('./client.js').NxipClientOptions,
  pools: import('./manifest.js').PoolEntry[]
): Promise<PlannedPool[]> {
  if (pools.length === 0) return [];

  let existing: Awaited<ReturnType<typeof import('./client.js').listPools>> | null = null;
  try {
    const { listPools } = await import('./client.js');
    existing = await listPools(options);
  } catch {
    existing = null;
  }

  return pools.map((pool) => {
    if (existing === null) {
      return { name: pool.name, body: pool.body, status: 'unknown' as const, detail: 'could not read existing pools' };
    }
    const already = existing.find(
      (e) =>
        e.cidr === pool.body.cidr ||
        (e.environment === pool.body.environment && e.region === pool.body.region && e.family === pool.body.family)
    );
    return already
      ? { name: pool.name, body: pool.body, status: 'exists' as const, detail: already.cidr }
      : { name: pool.name, body: pool.body, status: 'will-create' as const };
  });
}

export function formatPoolPlan(planned: PlannedPool[]): string {
  if (planned.length === 0) return '';
  const lines: string[] = [];
  let toCreate = 0;

  for (const pool of planned) {
    if (pool.status === 'will-create') {
      toCreate++;
      lines.push(`  # pool ${pool.name} will be created`);
      lines.push(`  + cidr          = "${pool.body.cidr}"`);
      lines.push(`    environment   = "${pool.body.environment}"`);
      lines.push(`    region        = "${pool.body.region}"`);
      lines.push(`    family        = "${pool.body.family}"`);
    } else if (pool.status === 'exists') {
      lines.push(`  # pool ${pool.name} already exists (${pool.detail}), no change`);
    } else {
      lines.push(`  # pool ${pool.name}: ${pool.detail}`);
    }
    lines.push('');
  }

  lines.push(`Pools: ${toCreate} to create, ${planned.length - toCreate} unchanged.`);
  return lines.join('\n');
}

export type SubnetBlocker =
  /** Its pool is declared in this same manifest and will be created first. */
  | 'pending-pool'
  /** A different pool already holds this environment/region/family key. */
  | 'pool-key-taken'
  /** Genuinely blocked, independent of pools. */
  | 'real';

export interface AnnotatedSubnet {
  planned: PlannedSubnet;
  blocker: SubnetBlocker;
  detail?: string;
}

/**
 * A subnet preview runs against the estate as it is *now*, so a subnet whose
 * pool is declared a few lines above it in the same manifest always previews
 * as a failure. Reporting that as "would fail" is technically true and
 * practically a lie: apply creates the pool first and the subnet then
 * succeeds. This separates the two cases so a first run does not look broken.
 *
 * It also catches the reverse problem. A scan is offline and cannot know
 * which pools already exist, so it may propose an environment/region/family
 * key that something else already holds on a different CIDR. That one is a
 * genuine conflict needing a human decision, and it is called out as such.
 */
export function annotateAgainstPools(planned: PlannedSubnet[], pools: PlannedPool[]): AnnotatedSubnet[] {
  return planned.map((item) => {
    if (item.result.wouldSucceed) return { planned: item, blocker: 'real' as const };

    const reason = item.result.reason;
    if (reason !== 'no-pool' && reason !== 'outside-pool') {
      return { planned: item, blocker: 'real' as const };
    }

    const match = pools.find(
      (pool) =>
        pool.body.environment === item.body.environment &&
        pool.body.region === item.body.region &&
        pool.body.family === item.body.family
    );

    if (!match) return { planned: item, blocker: 'real' as const };

    if (match.status === 'will-create') {
      return {
        planned: item,
        blocker: 'pending-pool' as const,
        detail: `pool ${match.name} (${match.body.cidr}) is created first by this same apply`,
      };
    }

    if (match.status === 'exists' && match.detail && match.detail !== match.body.cidr) {
      return {
        planned: item,
        blocker: 'pool-key-taken' as const,
        detail: `environment "${match.body.environment}" in ${match.body.region} already belongs to a pool on ${match.detail}, not ${match.body.cidr}`,
      };
    }

    return { planned: item, blocker: 'real' as const };
  });
}

export function formatAnnotatedPlan(annotated: AnnotatedSubnet[]): string {
  const lines: string[] = [];
  let willCreate = 0;
  let pending = 0;
  let blocked = 0;

  for (const item of annotated) {
    if (item.planned.result.wouldSucceed) {
      willCreate++;
      continue;
    }
    if (item.blocker === 'pending-pool') {
      pending++;
      continue;
    }

    blocked++;
    if (item.blocker === 'pool-key-taken') {
      lines.push(`  # ${item.planned.name} is blocked by a naming clash`);
      lines.push(`  ! ${item.detail}`);
      lines.push(`    Rename this subnet's environment, and its pool's, to something unused.`);
    } else {
      lines.push(`  # ${item.planned.name} would fail`);
      lines.push(`  x reason:  ${item.planned.result.reason}`);
      lines.push(`    message: ${item.planned.result.message}`);
    }
    lines.push('');
  }

  if (pending > 0) {
    lines.push(
      `  ${pending} subnet${pending === 1 ? '' : 's'} waiting on a pool declared in this manifest, which apply creates first.`
    );
    lines.push('');
  }

  lines.push(
    `Plan: ${willCreate + pending} to create (${pending} after their pool), ${blocked} blocked.`
  );
  return lines.join('\n');
}
