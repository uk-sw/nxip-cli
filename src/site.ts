import { parse } from 'yaml';
import { z } from 'zod';
import type { ManifestEntry } from './manifest.js';

// Cloud-first, per bet #11's own scoping: on-prem sites reuse this same
// shape later once a discovery agent or CSV import exists to seed them
// from what's already there, not built here.
const siteSpecSchema = z.object({
  site: z.string().min(1),
  environments: z.array(z.string().min(1)).min(1),
  clouds: z
    .array(
      z.object({
        provider: z.enum(['aws', 'azure', 'gcp']),
        region: z.string().min(1),
      })
    )
    .min(1),
  sizing: z.record(z.string(), z.number().int().min(1).max(31)),
});

export class SiteSpecError extends Error {}

/**
 * Expands a site spec into one subnet per (environment x cloud) pair -
 * the higher-level generator bet #11 describes, over primitives bet #8
 * already provides. Each combination needs a pool already registered for
 * its environment/region, same as any other nxip_subnet: this generates
 * the declarations, it doesn't create pools.
 */
export function expandSiteSpec(rawYaml: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = parse(rawYaml);
  } catch (error) {
    throw new SiteSpecError(`Could not parse YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = siteSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new SiteSpecError(`Invalid site spec:\n${issues}`);
  }

  const spec = result.data;
  const missingSizing = spec.environments.filter((env) => spec.sizing[env] === undefined);
  if (missingSizing.length > 0) {
    throw new SiteSpecError(`Missing sizing for environment(s): ${missingSizing.join(', ')}`);
  }

  const entries: ManifestEntry[] = [];
  for (const environment of spec.environments) {
    for (const cloud of spec.clouds) {
      const region = `${cloud.provider}-${cloud.region}`;
      const name = `${spec.site}-${environment}-${cloud.provider}-${cloud.region}`;
      entries.push({
        name,
        body: {
          family: 'IPV4',
          environment,
          region,
          prefixLength: spec.sizing[environment],
        },
      });
    }
  }

  return entries;
}

/** Renders expanded entries back into a bet #8 subnets.yaml manifest, ready for `nxip plan`/`nxip apply`. */
export function renderManifest(entries: ManifestEntry[]): string {
  const lines = ['subnets:'];
  for (const entry of entries) {
    lines.push(`  - name: ${entry.name}`);
    lines.push(`    environment: ${entry.body.environment}`);
    lines.push(`    region: ${entry.body.region}`);
    lines.push(`    family: ${entry.body.family}`);
    if (entry.body.prefixLength !== undefined) {
      lines.push(`    prefix_length: ${entry.body.prefixLength}`);
    }
  }
  return lines.join('\n') + '\n';
}
