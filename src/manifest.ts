import { parse } from 'yaml';
import { z } from 'zod';
import type { NxipSubnetBody } from './types.js';

// YAML uses the same snake_case attribute names as the Terraform provider's
// HCL (prefix_length, parent_subnet_id) - deliberately, so anyone who's
// already used nxip_subnet recognizes every field immediately.
const subnetEntrySchema = z
  .object({
    name: z.string().min(1),
    environment: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    family: z.enum(['IPV4', 'IPV6']),
    prefix_length: z.number().int().optional(),
    parent_subnet_id: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine((entry) => entry.parent_subnet_id !== undefined || (entry.environment !== undefined && entry.region !== undefined), {
    message: 'Either parent_subnet_id, or both environment and region, is required.',
  });

const manifestSchema = z.object({
  subnets: z.array(subnetEntrySchema).min(1, 'Manifest must declare at least one subnet.'),
});

export interface ManifestEntry {
  /** The manifest's own name for this subnet - not sent to the API, used only for CLI output. */
  name: string;
  body: NxipSubnetBody;
}

export class ManifestError extends Error {}

export function parseManifest(rawYaml: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = parse(rawYaml);
  } catch (error) {
    throw new ManifestError(`Could not parse YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new ManifestError(`Invalid manifest:\n${issues}`);
  }

  const names = new Set<string>();
  for (const entry of result.data.subnets) {
    if (names.has(entry.name)) {
      throw new ManifestError(`Duplicate subnet name in manifest: "${entry.name}" - names must be unique within a file.`);
    }
    names.add(entry.name);
  }

  return result.data.subnets.map((entry) => ({
    name: entry.name,
    body: {
      family: entry.family,
      prefixLength: entry.prefix_length,
      environment: entry.environment,
      region: entry.region,
      parentSubnetId: entry.parent_subnet_id,
      kind: entry.kind,
      description: entry.description,
      metadata: entry.metadata,
    },
  }));
}
