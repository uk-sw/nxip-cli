import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { discoverCisco, type CiscoDiscovery } from './cisco.js';
import { listPools, listAllSubnets, listProposals, previewSubnet, proposeChanges, type NxipClientOptions } from './client.js';
import { parseCron, nextRun, type CronSchedule } from './cron.js';
import { readKnownHosts, type KnownHostEntry } from './known-hosts.js';
import { parseFullManifest, type Manifest, type ManifestEntry } from './manifest.js';
import { analyseDiscovery, mergeDiscoveries, renderDiscoveryManifests } from './scan.js';
import { parseSharedRanges, type SharedRange } from './shared-ranges.js';
import { contains, parseIpv4Cidr, rangesOverlap } from './cidr.js';
import { parseIpv6Cidr } from './ipv6.js';
import { mapWithConcurrency } from './concurrency.js';
import type { NxipPool, NxipProposalOperation, NxipSubnet, PreviewResult } from './types.js';
import type { DeviceSession, SshTarget } from './ssh.js';

/**
 * The `agent` subcommand: reads agent.yaml, runs the Cisco source on a
 * schedule, and files what is new as change proposals. It never prompts,
 * never applies, and exits non-zero only on a config error. A person
 * approves each proposal in the dashboard, which is the agent model bet #2
 * already shipped: an agent can ask, only a person can apply.
 *
 * One JSON object per run on stdout, so `docker logs` is the whole
 * observability story for phase 1 of roadmap bet #3.
 */

export class AgentConfigError extends Error {}

// The cisco source block of agent.yaml. `.strict()` so a misspelled key is
// a config error rather than silently ignored, and so a plain `password:`
// is refused (with a better message than "unrecognized key", see below).
const ciscoSourceSchema = z
  .object({
    type: z.literal('cisco'),
    hosts: z.array(z.string().min(1)).min(1),
    user: z.string().min(1).optional(),
    user_env: z.string().min(1).optional(),
    password_env: z.string().min(1).optional(),
    key_file: z.string().min(1).optional(),
    known_hosts: z.string().min(1).optional(),
    vrfs: z.array(z.string().min(1)).optional(),
    static_only: z.boolean().optional(),
    include_public: z.boolean().optional(),
  })
  .strict();

const agentConfigSchema = z
  .object({
    schedule: z.string().min(1).optional(),
    organization: z.string().min(1).optional(),
    environment: z.string().min(1).default('production'),
    region: z.string().min(1).default('on-prem'),
    pools: z.array(z.string().min(1)).optional(),
    sources: z.array(ciscoSourceSchema).min(1),
    exclude: z.array(z.string().min(1)).optional(),
    /** Runs a prefix must be missing for before it is reported as no longer routed. */
    missing_runs: z.number().int().min(1).default(3),
  })
  .strict();

export type AgentConfigFile = z.infer<typeof agentConfigSchema>;

/** Keys that would hold a secret if a secret were ever written into the file. */
const SECRET_KEYS = /^(password|passphrase|secret|api_key|apikey|token|private_key|key)$/i;

/**
 * Walks the parsed YAML before validation and refuses any key that looks
 * like it carries a secret as a plain value. The rule is stated in the
 * spec and enforced here because the strict schema would otherwise say
 * only "unrecognized key", which reads as a typo rather than as a policy.
 */
function refusePlainSecrets(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => refusePlainSecrets(item, [...path, String(index)]));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      const where = [...path, key].join('.');
      throw new AgentConfigError(
        `Config refused: "${where}" holds a secret as a plain value. Secrets are never written into agent.yaml. ` +
          'Name an environment variable instead (password_env: NXIP_SSH_PASSWORD) or mount a file (key_file: /agent/id_ed25519).'
      );
    }
    refusePlainSecrets(child, [...path, key]);
  }
}

export interface ResolvedCiscoSource {
  hosts: string[];
  username: string;
  password?: string;
  privateKey?: Buffer;
  knownHostsPath: string;
  vrfs?: string[];
  staticOnly: boolean;
  includePublic: boolean;
}

export interface AgentConfig {
  schedule: CronSchedule | null;
  organization?: string;
  environment: string;
  site: string;
  pools?: string[];
  exclude: SharedRange[];
  missingRuns: number;
  sources: ResolvedCiscoSource[];
}

export interface ConfigEnvironment {
  env: NodeJS.ProcessEnv;
  /** Reads a mounted file; replaced in tests. */
  readFile: (path: string) => Buffer;
}

const DEFAULT_ENVIRONMENT: ConfigEnvironment = {
  env: process.env,
  readFile: (path) => readFileSync(path),
};

/**
 * Parses and resolves agent.yaml: secrets come from the environment
 * variables and files it names, never from the file itself. A missing
 * variable is an error that names the variable, since "no password" on
 * its own sends the operator to the wrong place.
 */
export function loadAgentConfig(rawYaml: string, environment: ConfigEnvironment = DEFAULT_ENVIRONMENT): AgentConfig {
  let parsed: unknown;
  try {
    parsed = parse(rawYaml);
  } catch (error) {
    throw new AgentConfigError(`Could not parse agent.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  refusePlainSecrets(parsed);

  const result = agentConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new AgentConfigError(`Invalid agent.yaml:\n${issues}`);
  }
  const file = result.data;

  let schedule: CronSchedule | null = null;
  if (file.schedule) {
    try {
      schedule = parseCron(file.schedule);
    } catch (error) {
      throw new AgentConfigError(`Invalid schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let exclude: SharedRange[] = [];
  try {
    exclude = parseSharedRanges(file.exclude ?? []);
  } catch (error) {
    throw new AgentConfigError(`Invalid exclude: ${error instanceof Error ? error.message : String(error)}`.replace('--exclude got', 'exclude has'));
  }

  const sources = file.sources.map((source, index): ResolvedCiscoSource => {
    const where = `sources.${index}`;
    const userEnv = source.user_env ?? (source.user ? null : 'NXIP_SSH_USER');
    const username = source.user ?? (userEnv ? environment.env[userEnv] : undefined);
    if (!username) {
      throw new AgentConfigError(`${where}: no SSH user. Set user, or environment variable ${userEnv ?? 'NXIP_SSH_USER'} (user_env).`);
    }

    let password: string | undefined;
    let privateKey: Buffer | undefined;
    if (source.key_file) {
      try {
        privateKey = environment.readFile(source.key_file);
      } catch (error) {
        throw new AgentConfigError(`${where}: could not read key_file ${source.key_file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A password is read when named, or by default when no key is given;
    // with a key it is optional, since a key alone is a complete credential.
    const passwordEnv = source.password_env ?? (privateKey ? null : 'NXIP_SSH_PASSWORD');
    if (passwordEnv) {
      password = environment.env[passwordEnv];
      if (password === undefined) {
        throw new AgentConfigError(`${where}: environment variable ${passwordEnv} (password_env) is not set. Pass it with -e ${passwordEnv} to docker run.`);
      }
    }

    return {
      hosts: source.hosts,
      username,
      password,
      privateKey,
      knownHostsPath: source.known_hosts ?? '/agent/known_hosts',
      vrfs: source.vrfs,
      staticOnly: source.static_only ?? false,
      includePublic: source.include_public ?? false,
    };
  });

  return {
    schedule,
    organization: file.organization,
    environment: file.environment,
    site: file.region,
    pools: file.pools,
    exclude,
    missingRuns: file.missing_runs,
    sources,
  };
}

/** One run's log line, the only thing the agent prints for a run. */
export interface RunLog {
  run: string;
  site: string;
  schedule: string | null;
  devices: { read: number; failed: { host: string; message: string }[] };
  refused_commands: number;
  prefixes: {
    discovered: number;
    known: number;
    new: number;
    waiting_for_pool: number;
    waiting_for_parent: number;
    /** Already in a proposal nobody has decided yet, so not asked for again. */
    awaiting_approval: number;
    would_fail: { cidr: string; reason: string; message: string }[];
    moved: { cidr: string; from: string; to: string }[];
  };
  pools: { discovered: number; known: number; new: number; awaiting_approval: number };
  hosts: number;
  dropped: Record<string, number>;
  /** VRFs left out of the proposal because they overlap another VRF. */
  skipped_vrfs: string[];
  proposals: { id: string; operations: number }[];
  /** Proposals the API would not take, with how many operations went down with each. */
  proposals_failed: { operations: number; message: string }[];
  no_longer_routed: string[];
  /**
   * Why the pending proposals could not be read, when they could not.
   * Advisory: the run still files, so at worst it asks again for something
   * already waiting.
   */
  pending_unread?: string;
  error?: string;
}

/** Carried between runs in one process: how many runs each agent-sourced prefix has been missing. */
export interface AgentState {
  missing: Map<string, number>;
}

export function newAgentState(): AgentState {
  return { missing: new Map() };
}

/** Everything a run touches outside the process, so tests can replace it. */
export interface AgentDependencies {
  options: NxipClientOptions;
  listPools: typeof listPools;
  listAllSubnets: typeof listAllSubnets;
  previewSubnet: typeof previewSubnet;
  proposeChanges: typeof proposeChanges;
  listProposals: typeof listProposals;
  readKnownHosts: (path: string) => KnownHostEntry[];
  openSession?: (target: SshTarget) => Promise<DeviceSession>;
  now: () => Date;
}

export function defaultDependencies(options: NxipClientOptions): AgentDependencies {
  return { options, listPools, listAllSubnets, previewSubnet, proposeChanges, listProposals, readKnownHosts, now: () => new Date() };
}

// proposalService.ts MAX_OPERATIONS_PER_PROPOSAL in the API. A run with more
// new prefixes than this files several proposals rather than one; each is
// still one approval for a person, and the log lists every id.
const MAX_OPERATIONS_PER_PROPOSAL = 20;

// At most this many previews in flight at once, the same ceiling `plan`
// uses for the same call. It bounds the fan-out of a first run against a
// real estate, which previews every prefix it found; a steady nightly run
// previews only what is genuinely new, which is usually nothing. It bounds
// requests in flight rather than requests per minute, so it is not itself a
// rate limiter.
const PREVIEW_CONCURRENCY = 4;

// A ceiling so a paging bug cannot loop forever while reading the pending
// queue. Far above any real number of undecided proposals.
const MAX_PROPOSAL_PAGES = 20;

/**
 * One run: read the devices, compare with what the organisation holds,
 * file a proposal for what is new. Nothing is applied here, ever.
 *
 * Never throws. Whatever went wrong, the log object comes back with the
 * counts the run did manage to collect and `error` saying what stopped it:
 * a run that reached nine devices and then lost the API is worth more in
 * `docker logs` than a bare error message with no device, prefix or drop
 * counts attached to it.
 */
export async function runAgentOnce(config: AgentConfig, deps: AgentDependencies, state: AgentState): Promise<RunLog> {
  const log = emptyLog(config, deps.now());
  try {
    await collectAndPropose(config, deps, state, log);
  } catch (error) {
    log.error = error instanceof Error ? error.message : String(error);
  }
  return log;
}

async function collectAndPropose(config: AgentConfig, deps: AgentDependencies, state: AgentState, log: RunLog): Promise<void> {
  const started = new Date(log.run);

  // Every source is read before anything is compared, so one estate with
  // two source blocks is diffed as a whole.
  const discoveries: CiscoDiscovery[] = [];
  for (const source of config.sources) {
    const knownHosts = deps.readKnownHosts(source.knownHostsPath);
    discoveries.push(
      await discoverCisco({
        hosts: source.hosts,
        username: source.username,
        password: source.password,
        privateKey: source.privateKey,
        // Scheduled mode never asks: an unknown key is a hard error for
        // that device, logged with the fingerprint and the line to add.
        hostKeys: { knownHosts, onUnknown: async () => false },
        site: config.site,
        environment: config.environment,
        vrfs: source.vrfs,
        staticOnly: source.staticOnly,
        includePublic: source.includePublic,
        openSession: deps.openSession,
      })
    );
  }

  const merged = mergeDiscoveries(discoveries);
  const details = merged.cisco;

  // Everything the devices actually said, taken before anything is held
  // back and added to below with whatever reached the manifest. It answers
  // one question only: is this prefix still routed? Three things keep a
  // routed prefix out of the manifest and none of them make it unrouted:
  // the manifest holds one VRF when two overlap, it leaves out anything
  // outside the configured pools, and `exclude:` holds back ranges the
  // operator never wants reported. Built from the filtered list, an
  // excluded prefix nxip already holds from this agent came back as "no
  // longer routed", which is the same lie the pool case was (1900f63) and
  // the operator acts on it by hunting for a VLAN that is still up.
  const discoveredCidrs = new Set<string>(details?.prefixes.map((prefix) => prefix.cidr) ?? []);

  if (details) {
    log.devices.read = details.devices.length;
    log.devices.failed = details.failures;
    log.refused_commands = details.devices.reduce((sum, d) => sum + d.refused.length, 0);
    log.hosts = details.hosts;
    log.dropped = { ...details.dropped };
    // Ranges the operator never wants reported are removed before anything
    // else looks, as scan --exclude would hold them back.
    details.prefixes = details.prefixes.filter((prefix) => {
      const range = parseIpv4Cidr(prefix.cidr);
      return !range || !config.exclude.some((shared) => rangesOverlap(shared.range, range));
    });
    merged.networks = merged.networks.filter((network) => {
      const range = parseIpv4Cidr(network.cidrs[0] ?? '');
      return !range || !config.exclude.some((shared) => rangesOverlap(shared.range, range));
    });
    log.prefixes.discovered = details.prefixes.length;
  }

  // The manifest the one-shot command would write, parsed back through the
  // same schema `plan` and `apply` use. What the proposal asks for is then
  // exactly what an operator would have applied by hand from the file.
  const report = analyseDiscovery(merged, { sharedRanges: config.exclude });
  const manifests = renderDiscoveryManifests(report, { cisco: { environment: config.environment, site: config.site, pools: config.pools } });
  // Overlapping VRFs need separate organisations (bet #33); the agent
  // proposes the first manifest's VRF and names the rest in the log.
  log.skipped_vrfs = manifests.slice(1).map((m) => m.vrf ?? 'default');
  let manifest: Manifest = { pools: [], subnets: [] };
  if (manifests.length > 0 && log.prefixes.discovered > 0) {
    manifest = parseFullManifest(manifests[0].text);
  }

  const existingPools = await deps.listPools(deps.options);
  const existingSubnets = await deps.listAllSubnets(deps.options);
  const pending = await readPendingOperations(config, deps, log);
  const operations: NxipProposalOperation[] = [];

  // Pools: known by its own CIDR, or by an existing pool for the same
  // (environment, region, family) that already covers the block. One pool
  // per key is the rule, so a wider pool for this site means the operator's
  // plan already covers what was discovered and nothing needs proposing.
  //
  // The containment test is the point. Matching on the key alone let any
  // pool at all for the site suppress the proposal, so a 192.168.0.0/16
  // pool silently swallowed a proposed 10.0.0.0/14: the pool was never
  // asked for, and every subnet under it then failed its preview with "no
  // pool covers this block" for a pool the agent had decided not to ask for.
  log.pools.discovered = manifest.pools.length;
  const poolKnown = (pool: Manifest['pools'][number]): NxipPool | undefined =>
    existingPools.find(
      (p) =>
        p.cidr === pool.body.cidr ||
        (p.environment === pool.body.environment &&
          p.region === pool.body.region &&
          p.family === pool.body.family &&
          covers(p.cidr, pool.body.cidr))
    );
  const newPoolKeys = new Set<string>();
  for (const pool of manifest.pools) {
    if (poolKnown(pool)) {
      log.pools.known += 1;
      continue;
    }
    // Already asked for and nobody has decided yet: asking again would file
    // the same operation a second time, and a week of that is seven
    // identical proposals for one person to work through.
    if (pending.has(`create_pool|${pool.body.cidr}`)) {
      log.pools.awaiting_approval += 1;
      newPoolKeys.add(`${pool.body.environment}|${pool.body.region}|${pool.body.family}`);
      continue;
    }
    log.pools.new += 1;
    newPoolKeys.add(`${pool.body.environment}|${pool.body.region}|${pool.body.family}`);
    operations.push({ type: 'create_pool', input: pool.body });
  }

  // Subnets: the CIDR is the address claim and decides "known". network_id
  // is provenance: a known CIDR now announced by a different device is
  // drift worth a log line, never a proposal, since proposals cannot update.
  const existingByCidr = new Map(existingSubnets.map((s) => [s.cidr, s]));
  const knownNames = new Map<string, NxipSubnet>();
  const newNames = new Set<string>();

  // Which entries are candidates, in manifest order. The order matters:
  // parents come before their children, so knownNames is complete by the
  // time a child looks its parent up.
  const candidates: ManifestEntry[] = [];
  for (const entry of manifest.subnets) {
    const cidr = entry.body.cidr;
    if (!cidr) continue;
    discoveredCidrs.add(cidr);
    const existing = existingByCidr.get(cidr);
    if (existing) {
      log.prefixes.known += 1;
      knownNames.set(entry.name, existing);
      const was = existing.metadata?.network_id;
      const now = entry.body.metadata?.network_id;
      if (existing.metadata?.source === 'nxip-agent' && was && now && was !== now) {
        log.prefixes.moved.push({ cidr, from: was, to: now });
      }
      continue;
    }

    // Already waiting for a person. Not new: "new" means new against what
    // nxip holds and against what has already been asked for.
    if (pending.has(`create_subnet|${cidr}`)) {
      log.prefixes.awaiting_approval += 1;
      newNames.add(entry.name);
      continue;
    }

    if (entry.parent) {
      const parent = knownNames.get(entry.parent);
      if (!parent) {
        // Its parent is new in this same run. Proposals are previewed
        // against the organisation as it is, so the child waits for the
        // parent's approval and is proposed on a later run.
        log.prefixes.waiting_for_parent += 1;
        newNames.add(entry.name);
        continue;
      }
      candidates.push({ ...entry, body: { ...entry.body, parentSubnetId: parent.id } });
      continue;
    }

    if (newPoolKeys.has(`${entry.body.environment}|${entry.body.region}|${entry.body.family}`)) {
      // Same reason: the pool is in this proposal and does not exist yet.
      log.prefixes.waiting_for_pool += 1;
      newNames.add(entry.name);
      continue;
    }
    candidates.push(entry);
  }

  // Previewed one at a time so one bad entry (a prefix outside every pool,
  // a tier limit) is logged and the rest are still proposed: the API
  // refuses a whole proposal when any one operation would fail. A few at a
  // time rather than one after another, since a first run against a real
  // estate has hundreds of prefixes to ask about and every later run has
  // almost none.
  const verdicts = await mapWithConcurrency<ManifestEntry, PreviewVerdict>(candidates, PREVIEW_CONCURRENCY, async (entry) => {
    try {
      return { entry, preview: await deps.previewSubnet(deps.options, entry.body) };
    } catch (error) {
      // A preview that could not be answered is not a "no". It is recorded
      // against the prefix and the run carries on: letting it escape threw
      // away every other prefix's proposal, and the counts with it, because
      // one request timed out.
      return { entry, failed: error instanceof Error ? error.message : String(error) };
    }
  });

  for (const verdict of verdicts) {
    const { entry } = verdict;
    if ('failed' in verdict) {
      log.prefixes.would_fail.push({ cidr: entry.body.cidr ?? '', reason: 'preview-failed', message: verdict.failed });
      continue;
    }
    if (!verdict.preview.wouldSucceed) {
      log.prefixes.would_fail.push({ cidr: entry.body.cidr ?? '', reason: verdict.preview.reason, message: verdict.preview.message });
      continue;
    }
    log.prefixes.new += 1;
    newNames.add(entry.name);
    operations.push({ type: 'create_subnet', input: entry.body });
  }

  // Prefixes this agent recorded that are no longer routed: counted per
  // run, reported once missing for `missing_runs` runs, never proposed for
  // deletion. Reclaim is flag-and-alert by roadmap decision, and proposals
  // cannot delete anyway. Only this site's entries are judged: another
  // site's agent answers for its own.
  for (const subnet of existingSubnets) {
    const ours = subnet.metadata?.source === 'nxip-agent' && subnet.region === config.site;
    if (!ours) continue;
    if (discoveredCidrs.has(subnet.cidr)) {
      state.missing.delete(subnet.cidr);
      continue;
    }
    const count = (state.missing.get(subnet.cidr) ?? 0) + 1;
    state.missing.set(subnet.cidr, count);
    if (count >= config.missingRuns) log.no_longer_routed.push(subnet.cidr);
  }
  log.no_longer_routed.sort();

  const date = started.toISOString().slice(0, 10);
  for (let at = 0; at < operations.length; at += MAX_OPERATIONS_PER_PROPOSAL) {
    const chunk = operations.slice(at, at + MAX_OPERATIONS_PER_PROPOSAL);
    const part = operations.length > MAX_OPERATIONS_PER_PROPOSAL ? ` (part ${Math.floor(at / MAX_OPERATIONS_PER_PROPOSAL) + 1})` : '';
    try {
      const proposal = await deps.proposeChanges(deps.options, {
        reason: `nxip-agent ${config.site} ${date}: ${log.pools.new} new pool${log.pools.new === 1 ? '' : 's'}, ${log.prefixes.new} new subnet${log.prefixes.new === 1 ? '' : 's'} discovered on Cisco devices${part}`,
        operations: chunk,
      });
      log.proposals.push({ id: proposal.id, operations: chunk.length });
    } catch (error) {
      // One part refused or lost does not take the other parts with it.
      // Whatever is filed is filed, and the log names what was not, with
      // how many operations went down with it.
      log.proposals_failed.push({ operations: chunk.length, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** One entry's preview: an answer, or the reason there was no answer. */
type PreviewVerdict = { entry: ManifestEntry; preview: PreviewResult } | { entry: ManifestEntry; failed: string };

/**
 * Whether an existing pool's block covers a proposed one. Both families,
 * since a v6 pool is proposed the same way a v4 one is.
 */
function covers(outer: string, inner: string | undefined): boolean {
  if (!inner) return false;
  if (outer === inner) return true;
  if (outer.includes(':') !== inner.includes(':')) return false;
  if (outer.includes(':')) {
    const a = parseIpv6Cidr(outer);
    const b = parseIpv6Cidr(inner);
    return a !== null && b !== null && b.start >= a.start && b.end <= a.end;
  }
  const a = parseIpv4Cidr(outer);
  const b = parseIpv4Cidr(inner);
  return a !== null && b !== null && contains(a, b);
}

/**
 * The operations this agent has already asked for that nobody has decided.
 *
 * Nothing consulted the pending queue, so an unapproved proposal was filed
 * again on every run: a week of nobody approving left seven identical
 * proposals, each of which a person then has to work through. "New" has to
 * mean new against what nxip holds *and* against what is already waiting.
 *
 * Best effort, and fails open on purpose. A key that may not read
 * proposals, or an API that is briefly down, must not stop a run filing:
 * a duplicate proposal is a nuisance, a discovery nobody ever hears about
 * is the thing the agent exists to prevent. A failed read is named in the
 * log and the run goes on exactly as it did before this existed.
 *
 * Only this agent's own asks count. A person's pending proposal for the
 * same block is their business, and whether both can be approved is the
 * API's decision, not this one's.
 */
async function readPendingOperations(config: AgentConfig, deps: AgentDependencies, log: RunLog): Promise<Set<string>> {
  const pending = new Set<string>();
  try {
    for (let page = 1; page <= MAX_PROPOSAL_PAGES; page++) {
      const response = await deps.listProposals(deps.options, { status: 'PENDING', limit: 100, page });
      for (const proposal of response.data ?? []) {
        for (const operation of proposal.operations ?? []) {
          const input = operation.input as { cidr?: unknown; region?: unknown; metadata?: { source?: unknown } | null };
          if (input?.metadata?.source !== 'nxip-agent' || input.region !== config.site) continue;
          if (typeof input.cidr === 'string') pending.add(`${operation.type}|${input.cidr}`);
        }
      }
      const totalPages = response.meta?.totalPages;
      if (typeof totalPages !== 'number' || page >= totalPages) break;
    }
  } catch (error) {
    log.pending_unread = error instanceof Error ? error.message : String(error);
  }
  return pending;
}

/**
 * Runs once and returns, or runs on the schedule until the process is
 * stopped. A run that throws (a device gone, the API down) is logged as a
 * run with an error and the next one still happens: a container that
 * exited on the first bad night would need a person to notice.
 */
export async function runAgent(
  config: AgentConfig,
  deps: AgentDependencies,
  io: { print: (log: RunLog) => void; sleep: (ms: number) => Promise<void>; stopAfter?: number } = { print: (log) => console.log(JSON.stringify(log)), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }
): Promise<void> {
  const state = newAgentState();
  let runs = 0;

  const once = async () => {
    try {
      io.print(await runAgentOnce(config, deps, state));
    } catch (error) {
      io.print({ ...emptyLog(config, deps.now()), error: error instanceof Error ? error.message : String(error) });
    }
    runs += 1;
  };

  if (!config.schedule) {
    await once();
    return;
  }

  while (io.stopAfter === undefined || runs < io.stopAfter) {
    const next = nextRun(config.schedule, deps.now());
    await io.sleep(Math.max(0, next.getTime() - deps.now().getTime()));
    await once();
  }
}

function emptyLog(config: AgentConfig, at: Date): RunLog {
  return {
    run: at.toISOString(),
    site: config.site,
    schedule: config.schedule?.source ?? null,
    devices: { read: 0, failed: [] },
    refused_commands: 0,
    prefixes: { discovered: 0, known: 0, new: 0, waiting_for_pool: 0, waiting_for_parent: 0, awaiting_approval: 0, would_fail: [], moved: [] },
    pools: { discovered: 0, known: 0, new: 0, awaiting_approval: 0 },
    hosts: 0,
    dropped: {},
    skipped_vrfs: [],
    proposals: [],
    proposals_failed: [],
    no_longer_routed: [],
  };
}
