import { parse } from 'yaml';
import { z } from 'zod';
import type { NxipPoolBody, NxipSubnetBody } from './types.js';

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
    cidr: z.string().min(1).optional(),
    parent_subnet_id: z.string().min(1).optional(),
    /**
     * A parent declared elsewhere in this same file, referenced by its
     * name. A manifest is written before anything exists, so it cannot
     * carry the parent's nxip id: apply creates parents first and
     * substitutes the real id into each child.
     */
    parent: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (entry) =>
      entry.parent_subnet_id !== undefined ||
      entry.parent !== undefined ||
      (entry.environment !== undefined && entry.region !== undefined),
    { message: 'Either parent (a name in this file), parent_subnet_id, or both environment and region, is required.' }
  )
  .refine((entry) => !(entry.parent !== undefined && entry.parent_subnet_id !== undefined), {
    message: 'Use either `parent` (a name in this file) or `parent_subnet_id` (an existing nxip id), not both.',
  })
  // Mirrors the API's own rule (createSubnetSchema): exactly one of cidr or
  // prefix_length. Caught here so a whole manifest fails locally with a
  // clear message rather than one entry at a time against the API.
  .refine((entry) => (entry.cidr === undefined) !== (entry.prefix_length === undefined), {
    message: 'Exactly one of `cidr` or `prefix_length` is required.',
  });

// Pools are optional and listed first because they must exist before any
// subnet can route into one. A manifest that declares both applies in that
// order, which is what makes a discovered estate loadable in one step.
const poolEntrySchema = z
  .object({
    name: z.string().min(1),
    cidr: z.string().min(1),
    family: z.enum(['IPV4', 'IPV6']),
    environment: z.string().min(1),
    region: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const manifestSchema = z
  .object({
    // .nullish(): a key written with nothing under it parses as null in
    // YAML, which is a reasonable thing for a person to write.
    pools: z.array(poolEntrySchema).nullish(),
    subnets: z.array(subnetEntrySchema).nullish(),
  })
  .refine((m) => (m.pools?.length ?? 0) + (m.subnets?.length ?? 0) > 0, {
    message: 'Manifest must declare at least one pool or subnet.',
  });

export interface ManifestEntry {
  /** The manifest's own name for this subnet - not sent to the API, used only for CLI output. */
  name: string;
  /**
   * Name of another entry in this same file that this one nests under.
   * Resolved to a real parentSubnetId by apply, once the parent exists.
   */
  parent?: string;
  body: NxipSubnetBody;
}

export interface PoolEntry {
  name: string;
  body: NxipPoolBody;
}

export interface Manifest {
  pools: PoolEntry[];
  subnets: ManifestEntry[];
}

export class ManifestError extends Error {}

export function parseManifest(rawYaml: string): ManifestEntry[] {
  return parseFullManifest(rawYaml).subnets;
}

export function parseFullManifest(rawYaml: string): Manifest {
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

  const poolNames = new Set<string>();
  for (const pool of result.data.pools ?? []) {
    if (poolNames.has(pool.name)) {
      throw new ManifestError(`Duplicate pool name in manifest: "${pool.name}" - names must be unique within a file.`);
    }
    poolNames.add(pool.name);
  }

  const names = new Set<string>();
  for (const entry of result.data.subnets ?? []) {
    if (names.has(entry.name)) {
      throw new ManifestError(`Duplicate subnet name in manifest: "${entry.name}" - names must be unique within a file.`);
    }
    names.add(entry.name);
  }

  // Caught at parse time rather than mid-apply, where half the estate
  // would already be created.
  for (const entry of result.data.subnets ?? []) {
    if (entry.parent === undefined) continue;
    if (entry.parent === entry.name) {
      throw new ManifestError(`Subnet "${entry.name}" lists itself as its own parent.`);
    }
    if (!names.has(entry.parent)) {
      throw new ManifestError(
        `Subnet "${entry.name}" has parent "${entry.parent}", which is not declared in this file. ` +
          'Use parent_subnet_id to nest under a subnet that already exists in nxip.'
      );
    }
  }

  const parentOf = new Map(
    (result.data.subnets ?? []).filter((e) => e.parent).map((e) => [e.name, e.parent as string])
  );
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start]);
    let current = parentOf.get(start);
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new ManifestError(`Circular parent reference in manifest, involving "${current}".`);
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }

  return {
    pools: (result.data.pools ?? []).map((pool) => ({
      name: pool.name,
      body: {
        name: pool.name,
        cidr: pool.cidr,
        family: pool.family,
        environment: pool.environment,
        region: pool.region,
        metadata: pool.metadata,
      },
    })),
    subnets: (result.data.subnets ?? []).map((entry) => ({
    name: entry.name,
    parent: entry.parent,
    body: {
      family: entry.family,
      prefixLength: entry.prefix_length,
      cidr: entry.cidr,
      environment: entry.environment,
      region: entry.region,
      parentSubnetId: entry.parent_subnet_id,
      kind: entry.kind,
      description: entry.description,
      metadata: entry.metadata,
    },
  })),
  };
}
