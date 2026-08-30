import { createSubnet, NxipApiError, type NxipClientOptions } from './client.js';
import { planManifest } from './plan.js';
import type { ManifestEntry } from './manifest.js';

export interface ApplyResult {
  name: string;
  outcome: 'created' | 'skipped' | 'failed';
  detail: string;
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
      results.push({ name: item.name, outcome: 'skipped', detail: `${item.result.reason}: ${item.result.message}` });
      continue;
    }

    try {
      const created = await createSubnet(options, item.body);
      results.push({ name: item.name, outcome: 'created', detail: `${created.cidr} (id ${created.id})` });
    } catch (error) {
      const message = error instanceof NxipApiError ? error.message : error instanceof Error ? error.message : String(error);
      results.push({ name: item.name, outcome: 'failed', detail: message });
    }
  }

  return results;
}

export function formatApplyResults(results: ApplyResult[]): string {
  const lines: string[] = [];
  let created = 0;

  for (const result of results) {
    if (result.outcome === 'created') {
      created++;
      lines.push(`  + ${result.name}: created at ${result.detail}`);
    } else if (result.outcome === 'skipped') {
      lines.push(`  x ${result.name}: skipped, ${result.detail}`);
    } else {
      lines.push(`  ! ${result.name}: failed, ${result.detail}`);
    }
  }

  lines.push('');
  lines.push(`Apply complete: ${created} created, ${results.length - created} not created.`);
  return lines.join('\n');
}
