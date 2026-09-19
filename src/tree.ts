import { freeBlocks, parseCidr } from './free-space.js';
import type { NxipPoolDetail, NxipSubnet } from './types.js';

/**
 * `nxip tree`: every pool, its subnets nested beneath it, and optionally the
 * free space at each level, drawn the way `tree` draws a directory
 * (docs/specs/address-tree-and-editing.md, Part B).
 *
 * Pure functions only. index.ts does the reading and the printing, so
 * everything here is testable against plain objects with no fetch at all.
 */

export interface TreeSubnet {
  id: string;
  cidr: string;
  name: string | null;
  kind: string | null;
  subnets: TreeSubnet[];
  /** Present with --free on every node whose subnets are shown. Uncapped. */
  free?: string[];
}

export interface TreePool {
  id: string;
  name: string;
  cidr: string;
  family: NxipPoolDetail['family'];
  environment: string;
  region: string;
  utilization: NxipPoolDetail['utilization'];
  subnets: TreeSubnet[];
  free?: string[];
}

export interface BuildOptions {
  free: boolean;
  /**
   * Levels of subnets to show beneath each pool: 0 is pools alone, 1 adds
   * their top-level subnets, and so on. Unset means all of them.
   */
  depth?: number;
}

// Address order, the order a network engineer reads a plan in. The API
// returns subnets newest first, which puts 10.0.0.32/27 above 10.0.0.0/27
// for no reason anyone looking at the tree would guess.
function byAddress(a: { cidr: string }, b: { cidr: string }): number {
  const x = parseCidr(a.cidr)?.start ?? 0n;
  const y = parseCidr(b.cidr)?.start ?? 0n;
  return x < y ? -1 : x > y ? 1 : a.cidr.localeCompare(b.cidr);
}

/**
 * Nests subnets under their pools and parents.
 *
 * A subnet goes under its pool by ipPoolId, not by environment and region.
 * The API allows one pool per environment, region and family, but that is
 * a check in the route, not a database constraint (only the CIDR is), and
 * ipPoolId is the one field that says for certain which range a subnet is
 * drawn in. One whose parent is missing from
 * the read is shown at the top of its pool rather than dropped, since
 * dropping it would draw its space as free.
 *
 * Free space at each level counts that level's direct children only. A
 * grandchild sits inside its parent, so it never frees or uses anything a
 * level up.
 */
export function buildTree(pools: NxipPoolDetail[], subnets: NxipSubnet[], options: BuildOptions): TreePool[] {
  const byPool = new Map<string, NxipSubnet[]>();
  for (const subnet of subnets) {
    const list = byPool.get(subnet.ipPoolId) ?? [];
    list.push(subnet);
    byPool.set(subnet.ipPoolId, list);
  }

  return pools.map((pool) => {
    const own = byPool.get(pool.id) ?? [];
    const ids = new Set(own.map((s) => s.id));
    const childrenOf = new Map<string | null, NxipSubnet[]>();
    for (const subnet of own) {
      const parent = subnet.parentSubnetId && ids.has(subnet.parentSubnetId) ? subnet.parentSubnetId : null;
      const list = childrenOf.get(parent) ?? [];
      list.push(subnet);
      childrenOf.set(parent, list);
    }

    // `level` is the depth the children being built would sit at.
    const build = (parentId: string | null, level: number): TreeSubnet[] => {
      if (options.depth !== undefined && level > options.depth) return [];
      return [...(childrenOf.get(parentId) ?? [])].sort(byAddress).map((subnet) => {
        const node: TreeSubnet = {
          id: subnet.id,
          cidr: subnet.cidr,
          name: subnet.name,
          kind: subnet.kind,
          subnets: build(subnet.id, level + 1),
        };
        if (options.free && node.subnets.length > 0) {
          node.free = freeBlocks(node.cidr, node.subnets.map((c) => c.cidr)).map((b) => b.cidr);
        }
        return node;
      });
    };

    const top = build(null, 1);
    const node: TreePool = {
      id: pool.id,
      name: pool.name,
      cidr: pool.cidr,
      family: pool.family,
      environment: pool.environment,
      region: pool.region,
      utilization: pool.utilization,
      subnets: top,
    };
    if (options.free && top.length > 0) {
      node.free = freeBlocks(pool.cidr, top.map((c) => c.cidr)).map((b) => b.cidr);
    }
    return node;
  });
}

export class PoolSelectionError extends Error {}

/**
 * `--pool`: an exact id first, then an exact name. Names are not unique, and
 * picking one of two same-named pools would show a tree the caller did not
 * ask for with nothing saying so, so more than one match is an error that
 * lists the ids to choose between.
 */
export function selectPool<T extends { id: string; name: string }>(pools: T[], selector: string): T {
  const byId = pools.find((p) => p.id === selector);
  if (byId) return byId;

  const named = pools.filter((p) => p.name === selector);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new PoolSelectionError(
      `More than one pool is named "${selector}": ${named.map((p) => p.id).join(', ')}. Pass one of those ids to --pool instead.`
    );
  }
  throw new PoolSelectionError(`No pool has the id or name "${selector}".`);
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

/** How many free blocks a text line lists before "+N more". --json lists all. */
export const MAX_FREE_SHOWN = 8;

// Same thresholds as the dashboard's (UTILIZATION_WARNING and
// UTILIZATION_CRITICAL in the GUI's capacity.ts), so the two never disagree
// about which pool is in trouble.
const WARNING = 70;
const CRITICAL = 90;

const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
};

/**
 * Colour and the usage bar only for a person at a terminal. Piped output is
 * read by grep, diff and scripts, and escape codes in it are noise at best.
 * NO_COLOR turns it off whatever its value (the spec says "unset", so an
 * empty NO_COLOR counts as set).
 */
export function shouldUseColor(isTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return isTTY === true && env.NO_COLOR === undefined;
}

// Rounded for reading, but never rounded to a claim that is false: a pool
// with one /28 carved from a /8 is not "0% used", and one a /30 short of
// full is not "100% used".
function formatPercent(value: number): string {
  if (value > 0 && value < 1) return '<1';
  if (value > 99 && value < 100) return '>99';
  return String(Math.round(value));
}

function usageBar(percent: number, paint: (code: string, text: string) => string): string {
  const cells = 10;
  const filled = Math.min(cells, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * cells)));
  const colour = percent >= CRITICAL ? ANSI.red : percent >= WARNING ? ANSI.yellow : ANSI.green;
  return `${paint(colour, '█'.repeat(filled))}${paint(ANSI.dim, '░'.repeat(cells - filled))}`;
}

function freeLine(free: string[]): string {
  if (free.length === 0) return 'free none';
  const shown = free.slice(0, MAX_FREE_SHOWN).join(', ');
  const more = free.length - MAX_FREE_SHOWN;
  return `free ${shown}${more > 0 ? `, +${more} more` : ''}`;
}

export function formatTree(pools: TreePool[], options: { color: boolean }): string {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${ANSI.reset}` : text);
  const lines: string[] = [];

  const drawChildren = (subnets: TreeSubnet[], free: string[] | undefined, prefix: string) => {
    // Siblings' CIDRs are padded to one width so their names line up.
    const width = Math.max(0, ...subnets.map((s) => s.cidr.length));
    subnets.forEach((subnet, index) => {
      const last = index === subnets.length - 1 && free === undefined;
      const label = [subnet.name ?? '', subnet.kind ? paint(ANSI.magenta, `[${subnet.kind}]`) : '']
        .filter(Boolean)
        .join(' ');
      const cidr = label ? `${subnet.cidr.padEnd(width)}  ` : subnet.cidr;
      lines.push(`${prefix}${paint(ANSI.dim, last ? '└── ' : '├── ')}${paint(ANSI.cyan, cidr)}${label}`);
      drawChildren(subnet.subnets, subnet.free, `${prefix}${paint(ANSI.dim, last ? '    ' : '│   ')}`);
    });
    if (free !== undefined) {
      lines.push(`${prefix}${paint(ANSI.dim, '└── ')}${paint(ANSI.green, freeLine(free))}`);
    }
  };

  pools.forEach((pool, index) => {
    if (index > 0) lines.push('');
    const parts = [paint(ANSI.bold, pool.name), paint(ANSI.cyan, pool.cidr), `${pool.environment} / ${pool.region}`];
    // IPv6 pools carry no percentage (the API withholds it, since a share
    // of 2^128 means nothing), so they carry no usage rather than a fake 0%.
    const percent = pool.utilization.percentageUsed;
    if (percent !== undefined) {
      const usage = `${formatPercent(percent)}% used`;
      parts.push(options.color ? `${usageBar(percent, paint)} ${usage}` : usage);
    }
    lines.push(parts.join('  '));
    drawChildren(pool.subnets, pool.free, '');
  });

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
