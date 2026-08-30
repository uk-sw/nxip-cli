import { mapWithConcurrency } from './concurrency.js';
import { previewSubnet, type NxipClientOptions } from './client.js';
import type { ManifestEntry } from './manifest.js';
import type { PlannedSubnet } from './types.js';

const PREVIEW_CONCURRENCY = 5;

export async function planManifest(options: NxipClientOptions, entries: ManifestEntry[]): Promise<PlannedSubnet[]> {
  return mapWithConcurrency(entries, PREVIEW_CONCURRENCY, async (entry) => ({
    name: entry.name,
    body: entry.body,
    result: await previewSubnet(options, entry.body),
  }));
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
