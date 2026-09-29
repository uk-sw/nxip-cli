#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolveClientOptions, resolveTargetLine, listPools, listAllPoolDetails, listAllSubnets } from './client.js';
import { ManifestError, parseFullManifest, type Manifest } from './manifest.js';
import { formatPlan, planManifest, planPools, formatPoolPlan, annotateAgainstPools, formatAnnotatedPlan, formatNestedEntries, findCrossPoolOverlaps, formatCrossPoolOverlaps } from './plan.js';
import { applyFullManifest, formatApplyResults } from './apply.js';
import { expandSiteSpec, renderManifest, SiteSpecError } from './site.js';
import { readVersion } from './version.js';
import { discoverAws, AwsScanError } from './aws.js';
import { discoverAzure, AzureScanError } from './azure.js';
import { analyseDiscovery, everyCiscoDeviceFailed, formatScanReport, renderDiscoveryManifests, mergeDiscoveries, redactDiscovery, type Discovery } from './scan.js';
import { DEFAULT_SHARED_RANGES, parseSharedRanges, SharedRangeError } from './shared-ranges.js';
import { findUnknownMcpArgument } from './mcp-args.js';
import { buildTree, formatTree, PoolSelectionError, selectPool, shouldUseColor } from './tree.js';
import { discoverCisco, CiscoScanError, WHAT_NXIP_NEVER_DOES } from './cisco.js';
import { readKnownHosts, KnownHostsError, type KnownHostEntry } from './known-hosts.js';
import type { UnknownHostKey } from './ssh.js';
import { AgentConfigError, defaultDependencies, loadAgentConfig, runAgent } from './agent.js';

interface ParsedArgs {
  command: string;
  subcommand?: string;
  file?: string;
  output?: string;
  apiKey?: string;
  url?: string;
  organization?: string;
  autoApprove: boolean;
  regions?: string[];
  allRegions: boolean;
  profile?: string;
  json: boolean;
  emitManifest: boolean;
  exclude?: string[];
  includeShared: boolean;
  includeDefaultNetworks: boolean;
  redact: boolean;
  providers: string[];
  subscriptions?: string[];
  allSubscriptions: boolean;
  failOnOverlap: boolean;
  readOnly: boolean;
  /** tree: one pool by id or name. scan cisco: pools replacing the guess, comma-separated. */
  pool?: string;
  depth?: string;
  free: boolean;
  /** scan cisco. */
  hosts: string[];
  user?: string;
  keyFile?: string;
  knownHosts?: string;
  vrfs?: string[];
  staticOnly: boolean;
  includePublic: boolean;
  site?: string;
  environment?: string;
  /** agent. */
  config?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const args: ParsedArgs = {
    command: command ?? '',
    autoApprove: false,
    allRegions: false,
    json: false,
    emitManifest: false,
    includeShared: false,
    includeDefaultNetworks: false,
    redact: false,
    providers: [],
    allSubscriptions: false,
    failOnOverlap: false,
    readOnly: false,
    free: false,
    hosts: [],
    staticOnly: false,
    includePublic: false,
  };

  // `scan` takes one or more providers as leading positionals, so
  // `nxip scan aws azure` analyses both together as a single estate.
  for (const candidate of rest) {
    if (candidate.startsWith('-')) break;
    args.providers.push(candidate);
  }
  args.subcommand = args.providers[0];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-f' || arg === '--file') {
      args.file = rest[++i];
    } else if (arg === '-o' || arg === '--output') {
      args.output = rest[++i];
    } else if (arg === '--api-key') {
      args.apiKey = rest[++i];
    } else if (arg === '--url') {
      args.url = rest[++i];
    } else if (arg === '--organization') {
      args.organization = rest[++i];
    } else if (arg === '--auto-approve') {
      args.autoApprove = true;
    } else if (arg === '--region') {
      args.regions = (rest[++i] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    } else if (arg === '--all-regions') {
      args.allRegions = true;
    } else if (arg === '--profile') {
      args.profile = rest[++i];
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--emit-manifest') {
      args.emitManifest = true;
    } else if (arg === '--exclude') {
      args.exclude = (rest[++i] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    } else if (arg === '--include-shared') {
      args.includeShared = true;
    } else if (arg === '--include-default-networks') {
      args.includeDefaultNetworks = true;
    } else if (arg === '--redact') {
      args.redact = true;
    } else if (arg === '--subscription') {
      args.subscriptions = (rest[++i] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    } else if (arg === '--all-subscriptions') {
      args.allSubscriptions = true;
    } else if (arg === '--fail-on-overlap') {
      args.failOnOverlap = true;
    } else if (arg === '--read-only') {
      args.readOnly = true;
    } else if (arg === '--pool') {
      args.pool = rest[++i];
    } else if (arg === '--depth') {
      args.depth = rest[++i];
    } else if (arg === '--free') {
      args.free = true;
    } else if (arg === '--host') {
      // Repeatable, and each occurrence may be a comma list: `--host a --host b`
      // and `--host a,b` read the same.
      args.hosts.push(...(rest[++i] ?? '').split(',').map((h) => h.trim()).filter(Boolean));
    } else if (arg === '--user') {
      args.user = rest[++i];
    } else if (arg === '--key-file') {
      args.keyFile = rest[++i];
    } else if (arg === '--known-hosts') {
      args.knownHosts = rest[++i];
    } else if (arg === '--vrf') {
      args.vrfs = [...(args.vrfs ?? []), ...(rest[++i] ?? '').split(',').map((v) => v.trim()).filter(Boolean)];
    } else if (arg === '--static-only') {
      args.staticOnly = true;
    } else if (arg === '--include-public') {
      args.includePublic = true;
    } else if (arg === '--site') {
      args.site = rest[++i];
    } else if (arg === '--environment') {
      args.environment = rest[++i];
    } else if (arg === '--config') {
      args.config = rest[++i];
    }
  }

  return args;
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} Only 'yes' will be accepted to approve.\n\nEnter a value: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function loadManifest(file: string | undefined): Manifest | null {
  if (!file) {
    console.error('Missing required -f/--file <manifest.yaml>');
    process.exitCode = 1;
    return null;
  }
  try {
    const raw = readFileSync(file, 'utf-8');
    return parseFullManifest(raw);
  } catch (error) {
    if (error instanceof ManifestError) {
      console.error(error.message);
    } else {
      console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
    return null;
  }
}

function printUsage(stream: 'out' | 'err' = 'err') {
  const write = stream === 'out' ? console.log : console.error;
  write(`Usage: ${CLI} scan <aws|azure|cisco> [aws|azure|cisco] [--exclude CIDR,...] [--include-shared]`);
  write('                     [--include-default-networks]');
  write('                     [--redact] [--json] [--emit-manifest] [-o FILE]');
  write('                     [--fail-on-overlap]   exit 1 if a real conflict is found');
  write('         aws:   [--region NAME,...] [--profile NAME]');
  write('         azure: [--subscription ID,...]');
  write('         cisco: --host HOST[:PORT] [--host ...] [--user NAME] [--key-file PATH]');
  write('                [--known-hosts PATH] [--vrf NAME,...] [--static-only] [--include-public]');
  write('                [--pool CIDR,...] [--site NAME] [--environment NAME]');
  write('                credentials: NXIP_SSH_USER, NXIP_SSH_PASSWORD, or --key-file');
  write(`       ${CLI} agent --config <agent.yaml>   read devices on a schedule, file change proposals (needs NXIP_API_KEY)`);
  write(`       ${CLI} scaffold -f <site.yaml> [-o <manifest.yaml>]`);
  write(`       ${CLI} <plan|apply> -f <manifest.yaml> [--api-key KEY] [--url URL] [--organization ID] [--auto-approve]`);
  write(`       ${CLI} mcp [--read-only] [--organization ID]   MCP server on stdio, for AI agents (needs NXIP_API_KEY)`);
  write(`       ${CLI} tree [--pool ID|NAME] [--depth N] [--free] [--json] [--organization ID]`);
  write('                     every pool with its subnets nested beneath it; --free adds free space');
  write('');
  write('--organization ID (or NXIP_ORGANIZATION) manages or reads a customer organization instead');
  write('of the API key\'s own. Unset means the key\'s own organization, as before.');
  write('');
  write('Both providers scan everything by default: every AWS region, every Azure');
  write('subscription the identity can see. Narrow with --region or --subscription.');
  write('');
  write('scan compares the networks it discovers against each other, entirely on');
  write('this machine. It never contacts nxip. To compare against what your nxip');
  write(`organization already holds, use \`${CLI} plan -f <manifest.yaml>\` instead.`);
  write('');
  write('scan and scaffold need no nxip account. plan, apply, tree, mcp and agent need an API key.');
  write('');
  write('What nxip never does, on your network:');
  for (const line of WHAT_NXIP_NEVER_DOES) write(`  ${line}`);
  write('');
  write('Docs: https://nx-ip.com/docs/nxip-cli   Agent: https://nx-ip.com/docs/nxip-agent');
}

// How to tell someone to run this. The bin is `nxip`, which only exists
// after a global install, but the docs, README and every published example
// lead with npx. Emitting a bare `nxip` tells most users to run a command
// they do not have, so instruction text always uses the runnable form.
// npx resolves an existing local or global install before fetching, so this
// is correct for everyone.
const CLI = 'npx nxip-cli';

/**
 * Pools, for the overlap warning only. Best-effort on purpose: the warning
 * is additional information, so failing to fetch it must not turn a
 * working plan into an error.
 */
async function listPoolsQuietly(options: Parameters<typeof listPools>[0]) {
  try {
    return await listPools(options);
  } catch {
    return [];
  }
}

const COMMANDS = new Set(['scan', 'scaffold', 'plan', 'apply', 'mcp', 'tree', 'agent']);

/**
 * How `scan cisco` treats a host key that is not in known_hosts: it asks,
 * as ssh does, when someone is at the keyboard, and refuses otherwise. The
 * key is never written to the file, which is usually a read-only mount;
 * the line to add is printed so the operator can add it on purpose.
 */
async function askAboutUnknownHostKey(key: UnknownHostKey): Promise<boolean> {
  console.error(`The authenticity of host ${key.host}${key.port === 22 ? '' : `:${key.port}`} can't be established.`);
  console.error(`${key.keyType} key fingerprint is ${key.fingerprint}.`);
  console.error(`To trust it in future, add this line to your known_hosts file:\n  ${key.line}`);
  if (!process.stdin.isTTY) {
    console.error('Not connecting: no terminal to ask on. Add the line above to known_hosts and re-run.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Are you sure you want to continue connecting (yes/no)? ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** The known_hosts file for scan cisco: the flag, the container mount, or the user's own. */
function loadKnownHostsForScan(path: string | undefined): KnownHostEntry[] {
  const candidates = path ? [path] : ['/agent/known_hosts', `${process.env.HOME ?? ''}/.ssh/known_hosts`];
  for (const candidate of candidates) {
    try {
      return readKnownHosts(candidate);
    } catch (error) {
      // A named file that cannot be read is an error; a default that does
      // not exist just means nothing is trusted yet.
      if (path) throw error;
    }
  }
  return [];
}


async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Help, and anything unrecognized, resolve before the API-key gate below.
  // Otherwise a bare `npx nxip-cli` greets a first-time user with "Missing
  // API key", which is both unhelpful and untrue for the two commands that
  // do not need one.
  // Asking for help after a subcommand (`nxip scan --help`) is at least as
  // natural as asking before one, and used to fall through to "Missing
  // provider" and exit 1, which reads as a failure rather than an answer.
  const wantsHelp = process.argv.slice(2).some((a) => a === '--help' || a === '-h' || a === 'help');
  if (!args.command || wantsHelp) {
    printUsage('out');
    return;
  }

  // Before the unknown-command check, not after: these are flags rather than
  // commands, so COMMANDS will never contain them and they would otherwise
  // always fall through to "Unknown command".
  if (args.command === '--version' || args.command === '-v' || args.command === 'version') {
    console.log(readVersion());
    return;
  }

  if (!COMMANDS.has(args.command)) {
    console.error(`Unknown command "${args.command}".`);
    console.error('');
    printUsage();
    process.exitCode = 1;
    return;
  }

  // scaffold is a pure local generator - no nxip account needed to expand
  // a site spec into a manifest, only to plan/apply the result afterward.
  if (args.command === 'scaffold') {
    if (!args.file) {
      console.error('Missing required -f/--file <site.yaml>');
      process.exitCode = 1;
      return;
    }
    let manifest: string;
    try {
      const raw = readFileSync(args.file, 'utf-8');
      manifest = renderManifest(expandSiteSpec(raw));
    } catch (error) {
      console.error(error instanceof SiteSpecError ? error.message : `Could not read ${args.file}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    if (args.output) {
      writeFileSync(args.output, manifest, 'utf-8');
      console.log(`Wrote ${args.output}. Review it, then run: ${CLI} plan -f ${args.output}`);
    } else {
      process.stdout.write(manifest);
    }
    return;
  }

  // scan reads a cloud account and analyses it entirely locally. Like
  // scaffold, it sits before the API-key gate on purpose: the whole point is
  // that someone can get something useful out of nxip before they have an
  // account, using credentials they already have. Nothing is written
  // anywhere and nothing leaves the machine.
  if (args.command === 'scan') {
    const SUPPORTED = new Set(['aws', 'azure', 'cisco']);
    const unknown = args.providers.filter((p) => !SUPPORTED.has(p));
    if (args.providers.length === 0 || unknown.length > 0) {
      console.error(`Usage: ${CLI} scan <aws|azure|cisco> [aws|azure|cisco] [provider flags] [--exclude CIDR,...] [--include-shared] [--redact] [--json] [--emit-manifest] [-o FILE]`);
      console.error(
        unknown.length > 0
          ? `Unknown provider${unknown.length === 1 ? '' : 's'} ${unknown.map((u) => `"${u}"`).join(', ')}. Supported: aws, azure, cisco.`
          : 'Missing provider. Supported: aws, azure, cisco.'
      );
      process.exitCode = 1;
      return;
    }

    // The Cisco source's labels. The site is the manifest's region, so it
    // is a separate flag from --region, which names AWS regions.
    const site = args.site ?? 'on-prem';
    const environment = args.environment ?? 'production';
    const ciscoPools = args.providers.includes('cisco') && args.pool ? args.pool.split(',').map((p) => p.trim()).filter(Boolean) : undefined;

    // Each provider is scanned separately then merged, so one estate is
    // analysed as a whole. That is where cross-cloud findings come from: no
    // cloud's own IPAM can see another's.
    const discoveries: Discovery[] = [];
    for (const provider of args.providers) {
      try {
        if (provider === 'cisco') {
          // Credentials come from the environment or a key file, never a
          // flag: a password on the command line lands in shell history and
          // in `ps` output on a shared host.
          const keyFile = args.keyFile;
          discoveries.push(
            await discoverCisco({
              hosts: args.hosts,
              username: args.user ?? process.env.NXIP_SSH_USER ?? '',
              password: keyFile ? undefined : process.env.NXIP_SSH_PASSWORD,
              privateKey: keyFile ? readFileSync(keyFile) : undefined,
              hostKeys: { knownHosts: loadKnownHostsForScan(args.knownHosts), onUnknown: askAboutUnknownHostKey },
              site,
              environment,
              vrfs: args.vrfs,
              staticOnly: args.staticOnly,
              includePublic: args.includePublic,
              onProgress: (message) => console.error(message),
            })
          );
          continue;
        }
        discoveries.push(
          provider === 'aws'
            ? await discoverAws({ regions: args.regions, allRegions: args.allRegions, profile: args.profile })
            : await discoverAzure({ subscriptions: args.subscriptions, allSubscriptions: args.allSubscriptions })
        );
      } catch (error) {
        const known = error instanceof AwsScanError || error instanceof AzureScanError || error instanceof CiscoScanError || error instanceof KnownHostsError;
        console.error(known ? (error as Error).message : `${provider} scan failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
    }
    // Redaction happens before analysis, not after rendering, so every
    // downstream output sees the same pseudonymised data.
    const discovery = args.redact ? redactDiscovery(mergeDiscoveries(discoveries)) : mergeDiscoveries(discoveries);

    // Ranges where overlap is expected by design. Defaults cover the ones
    // cloud providers themselves recommend reusing (see shared-ranges.ts);
    // --exclude adds org-specific ones, --include-shared turns the lot off.
    let sharedRanges;
    let configuredShared: ReturnType<typeof parseSharedRanges> = [];
    try {
      // Two distinct things, deliberately kept apart: which ranges count as
      // expectedly-shared, and whether the analysis acts on them.
      // --include-shared only turns off the acting, so the manifest can
      // still label CGNAT space either way.
      configuredShared = [...DEFAULT_SHARED_RANGES, ...parseSharedRanges(args.exclude ?? [])];
      sharedRanges = args.includeShared ? [] : configuredShared;
    } catch (error) {
      console.error(error instanceof SharedRangeError ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    const report = analyseDiscovery(discovery, { sharedRanges, includeDefaultNetworks: args.includeDefaultNetworks });

    // Set here rather than at the end, because every branch below returns
    // its own way and one of them would otherwise skip it. Nothing was
    // read from any device the run named, so the run failed even though
    // the report prints happily: the section above says which host and
    // what it said.
    if (everyCiscoDeviceFailed(discovery)) {
      process.exitCode = 1;
    }

    // Usually one manifest. The Cisco source produces one per VRF when two
    // VRFs overlap, since nxip refuses overlap inside one organisation.
    const manifests = args.emitManifest
      ? renderDiscoveryManifests(report, {
          sharedRanges: configuredShared,
          includeShared: args.includeShared,
          includeDefaultNetworks: args.includeDefaultNetworks,
          cisco: { environment, site, pools: ciscoPools },
        })
      : [];
    const output = args.emitManifest
      ? manifests[0]?.text ?? ''
      : args.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatScanReport(report);

    if (args.emitManifest && args.redact) {
      console.error(
        'Note: --redact replaces the network and subnet ids this manifest records as provenance, so the link back to the real resources is lost. Useful for sharing an example, not for loading your own estate.'
      );
    }

    // An emitted manifest with nothing in it will not parse, so it is worth
    // saying at the moment it is written rather than at `plan -f`.
    if (args.emitManifest && report.totals.networks > 0 && !output.includes('\nsubnets:')) {
      console.error('Nothing to import: everything discovered was a default network or shared-range space.');
      console.error('Use --include-default-networks or --include-shared to emit them anyway.');
    }

    if (manifests.length > 1) {
      const vrfs = manifests.map((m) => m.vrf ?? 'default');
      console.error(`\nNOTE: VRFs ${vrfs.join(', ')} carry overlapping address space, so this is one manifest per VRF.`);
      console.error('nxip refuses overlap inside one organisation: apply each file to a separate');
      console.error('organisation, one per routing domain, until routing domains exist (roadmap bet #33).');
      if (args.output) {
        // estate.yaml becomes estate-default.yaml, estate-CUST-A.yaml, and so on.
        const dot = args.output.lastIndexOf('.');
        const stem = dot > 0 ? args.output.slice(0, dot) : args.output;
        const ext = dot > 0 ? args.output.slice(dot) : '';
        for (const manifest of manifests) {
          const file = `${stem}-${(manifest.vrf ?? 'default').replace(/[^A-Za-z0-9_-]+/g, '_')}${ext}`;
          writeFileSync(file, manifest.text, 'utf-8');
          console.log(`Wrote ${file} (VRF ${manifest.vrf ?? 'default'}). Review it, then run: ${CLI} plan -f ${file}`);
        }
        return;
      }
      // To stdout: one YAML stream, a document per VRF, since a single
      // manifest cannot hold both sides of an overlap.
      process.stdout.write(manifests.map((m) => m.text).join('\n---\n'));
      console.error('Pass -o FILE to write one file per VRF instead of one YAML stream.');
      return;
    }

    // Said on stderr as well as in the file. Someone redirecting to -o may
    // never open the manifest before running plan, and this decides what
    // they should do next rather than merely describing what was found.
    if (args.emitManifest && report.clusters.length > 0) {
      const count = report.clusters.length;
      console.error(
        `\nWARNING: ${count} address collision${count === 1 ? '' : 's'} found. The manifest lists both sides,`
      );
      console.error('and nxip refuses to record two networks owning the same addresses, so');
      console.error('applying it as-is cannot fully succeed. See the WARNING block at the top');
      console.error('of the file, and renumber or remove one side before applying.');
    }

    if (args.output) {
      writeFileSync(args.output, output, 'utf-8');
      console.log(
        args.emitManifest
          ? `Wrote ${args.output}. Review it, then run: ${CLI} plan -f ${args.output}`
          : `Wrote ${args.output}.`
      );
    } else {
      process.stdout.write(output);
    }

    // The pitch goes to stderr so it never contaminates piped JSON or a
    // manifest being redirected to a file. It names the literal next command
    // rather than a bare URL: this fires at the moment someone has just seen
    // their own estate, so sending them to a homepage to re-orient wastes it.
    // Nothing discovered means there is nothing to pitch about: telling
    // someone with zero networks to emit a manifest of nothing reads as
    // broken, and it is the first thing a stranger sees if they point this
    // at the wrong subscription or an empty account.
    // Opt-in, never the default: "found an overlap" is a finding rather than
    // a failure, and defaulting to non-zero would break anyone piping this.
    // Keyed on real conflicts only, so deliberately shared ranges (CGNAT and
    // friends) never fail a build. Mirrors terraform plan -detailed-exitcode.
    if (args.failOnOverlap && report.clusters.length > 0) {
      process.exitCode = 1;
    }

    if (!args.emitManifest && !args.json && report.totals.networks > 0) {
      // Name the file after what was actually scanned, so an estate with
      // both clouds does not end up with two files called discovered.yaml
      // overwriting each other.
      const suggested = `${args.providers.join('-')}-discovered.yaml`;
      // Carry forward the flags that decided what was scanned. Suggesting a
      // bare command after a targeted scan produced a manifest covering less
      // than the report above it, with nothing saying so.
      const scopeFlags = [
        args.profile ? `--profile ${args.profile}` : '',
        args.regions?.length ? `--region ${args.regions.join(',')}` : '',
        args.subscriptions?.length ? `--subscription ${args.subscriptions.join(',')}` : '',
        args.exclude?.length ? `--exclude ${args.exclude.join(',')}` : '',
        args.includeShared ? '--include-shared' : '',
        args.hosts.length ? `--host ${args.hosts.join(',')}` : '',
        args.vrfs?.length ? `--vrf ${args.vrfs.join(',')}` : '',
        args.staticOnly ? '--static-only' : '',
        args.includePublic ? '--include-public' : '',
        args.site ? `--site ${args.site}` : '',
      ].filter(Boolean).join(' ');
      const scope = scopeFlags ? ` ${scopeFlags}` : '';

      if (report.clusters.length > 0) {
        // Said plainly because it decides what to do next, and the previous
        // wording jumped straight to offering an import that cannot fully
        // succeed while a conflict exists: nxip will not record two
        // networks owning the same addresses, so the second one is refused.
        console.error('\nThese conflicts are between the networks this scan discovered, and');
        console.error('they exist in your cloud, not in nxip. Importing both sides');
        console.error('would ask nxip to record two networks owning the same addresses, which');
        console.error('it refuses by design. Renumber one side first, or import the rest and');
        console.error('leave the conflict out until it is resolved.');
      } else {
        // Deliberately scoped. This scan never contacts nxip: it compares the
        // discovered networks against each other and nothing else. Saying
        // "nothing overlaps" full stop would be a clean bill of health this
        // command is not in a position to give, and the first contradiction
        // would arrive as a failed apply against a pool it never saw.
        console.error('\nNothing in this scan overlaps anything else in it.');
        console.error('');
        console.error('That is a comparison of the discovered networks against each other.');
        console.error('It is not a check against what nxip already holds, which this command');
        console.error('never contacts. `plan` does that, and is where a clash with an');
        console.error('existing pool or subnet would show up.');
      }

      console.error('');
      console.error('Turn this scan into a manifest you can review and import:');
      console.error(`  npx nxip-cli scan ${args.providers.join(' ')}${scope} --emit-manifest -o ${suggested}`);
      console.error('Guide: https://nx-ip.com/docs/discovery#getting-it-into-nxip');
    }
    return;
  }

  // Before the API-key gate, so a typo is reported as a typo rather than
  // hidden behind "missing API key". mcp only: every other command keeps
  // its existing, lenient flag handling.
  if (args.command === 'mcp') {
    const unknown = findUnknownMcpArgument(process.argv.slice(3));
    if (unknown) {
      console.error(unknown);
      process.exitCode = 1;
      return;
    }
  }

  // Also before the API-key gate, for the same reason as mcp above: a typo
  // in --depth is a typo, and "missing API key" would hide it.
  // Given without a value, the general parser would swallow the next flag
  // as the value (`--pool --free`) or leave it unset, and either way the
  // tree would quietly show something other than what was asked for.
  if (args.command === 'tree') {
    const given = process.argv.slice(3);
    if (given.includes('--depth') && !/^\d+$/.test(args.depth ?? '')) {
      console.error(`--depth needs a whole number of levels, 0 or more (got "${args.depth ?? ''}").`);
      process.exitCode = 1;
      return;
    }
    if (given.includes('--pool') && (!args.pool || args.pool.startsWith('-'))) {
      console.error('--pool needs a pool id or exact pool name.');
      process.exitCode = 1;
      return;
    }
  }

  // The agent's config is read before the API-key gate: a config error is
  // the one thing the agent exits non-zero for, and it must be reported as
  // itself rather than hidden behind "missing API key". The config may name
  // the organization to act in; a flag still wins over it.
  let agentConfig: ReturnType<typeof loadAgentConfig> | undefined;
  if (args.command === 'agent') {
    if (!args.config) {
      console.error('Missing required --config <agent.yaml>');
      process.exitCode = 1;
      return;
    }
    try {
      agentConfig = loadAgentConfig(readFileSync(args.config, 'utf-8'));
    } catch (error) {
      console.error(error instanceof AgentConfigError ? error.message : `Could not read ${args.config}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const options = resolveClientOptions(args.apiKey, args.url, args.organization ?? agentConfig?.organization);

  if (!options.apiKey) {
    console.error('Missing API key. Set NXIP_API_KEY, or pass --api-key. Get one free at https://nx-ip.com/signup.');
    process.exitCode = 1;
    return;
  }

  // Scheduled or once, the agent never prompts and never applies: it files
  // change proposals, and exits non-zero only for the config errors above.
  if (args.command === 'agent' && agentConfig) {
    console.error(`nxip-agent: ${agentConfig.sources.reduce((n, s) => n + s.hosts.length, 0)} host(s) at site ${agentConfig.site}, ` + (agentConfig.schedule ? `schedule "${agentConfig.schedule.source}" (UTC)` : 'running once'));
    await runAgent(agentConfig, defaultDependencies(options));
    return;
  }

  // After the API-key gate on purpose: a server that started without a key
  // would look healthy to the client and then fail every tool call. Exiting
  // here puts the one line saying what to set in the client's server log.
  if (args.command === 'mcp') {
    // Loaded here rather than at the top of the file: the MCP SDK is a
    // sizeable import tree, and scan, plan, apply and --version have no use
    // for it. A static import made every one of them slower to start.
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer(options, { readOnly: args.readOnly });
    return;
  }

  if (args.command === 'tree') {
    // The same target line as plan and apply, first. With --json it goes to
    // stderr instead, the way mcp prints it: stdout is then a document for
    // a program to parse, and a line of prose ahead of it would break that.
    const targetLine = await resolveTargetLine(options);
    if (targetLine) (args.json ? console.error : console.log)(targetLine);

    const depth = args.depth === undefined ? undefined : Number(args.depth);
    // Pools only at --depth 0, so there is no reason to read every subnet.
    const [allPools, subnets] = await Promise.all([
      listAllPoolDetails(options),
      depth === 0 ? Promise.resolve([]) : listAllSubnets(options),
    ]);

    let pools = allPools;
    if (args.pool) {
      try {
        pools = [selectPool(allPools, args.pool)];
      } catch (error) {
        if (!(error instanceof PoolSelectionError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
    }

    const tree = buildTree(pools, subnets, { free: args.free, depth });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ pools: tree }, null, 2)}\n`);
    } else if (tree.length === 0) {
      console.log(`No pools yet. Create one in the dashboard, or declare one in a manifest and run: ${CLI} apply -f <manifest.yaml>`);
    } else {
      process.stdout.write(formatTree(tree, { color: shouldUseColor(process.stdout.isTTY, process.env) }));
    }
    return;
  }

  if (args.command === 'plan') {
    // First line of output, before anything else, including a missing
    // manifest: see docs/specs/msp-tenancy-phase2.md Part C. Advisory only -
    // resolveTargetLine never throws, so this can never block a plan.
    const targetLine = await resolveTargetLine(options);
    if (targetLine) console.log(targetLine);

    const manifest = loadManifest(args.file);
    if (!manifest) return;
    const poolPlan = await planPools(options, manifest.pools);
    if (poolPlan.length > 0) console.log(formatPoolPlan(poolPlan));
    const planned = await planManifest(options, manifest.subnets);
    // When the manifest declares pools, a plain subnet plan reads as all
    // failures, since the pools do not exist yet.
    console.log(poolPlan.length > 0 ? formatAnnotatedPlan(annotateAgainstPools(planned, poolPlan)) : formatPlan(planned));
    process.stdout.write(formatNestedEntries(manifest.subnets));
    process.stdout.write(formatCrossPoolOverlaps(findCrossPoolOverlaps(manifest.subnets, await listPoolsQuietly(options))));
    return;
  }

  if (args.command === 'apply') {
    // Same rule as plan above, printed regardless of --auto-approve so it is
    // always the first thing an apply prints, not just the first thing an
    // interactive one prints before the confirmation prompt.
    const targetLine = await resolveTargetLine(options);
    if (targetLine) console.log(targetLine);

    const manifest = loadManifest(args.file);
    if (!manifest) return;

    if (!args.autoApprove) {
      const poolPlan = await planPools(options, manifest.pools);
      if (poolPlan.length > 0) console.log(formatPoolPlan(poolPlan));
      const planned = await planManifest(options, manifest.subnets);
      console.log(poolPlan.length > 0 ? formatAnnotatedPlan(annotateAgainstPools(planned, poolPlan)) : formatPlan(planned));
    process.stdout.write(formatNestedEntries(manifest.subnets));
    process.stdout.write(formatCrossPoolOverlaps(findCrossPoolOverlaps(manifest.subnets, await listPoolsQuietly(options))));
      const approved = await confirm('Do you want to perform these actions?');
      if (!approved) {
        console.log('Apply cancelled.');
        return;
      }
    }

    const results = await applyFullManifest(options, manifest);
    console.log(formatApplyResults(results));
    if (results.some((r) => r.outcome === 'failed')) {
      process.exitCode = 1;
    }
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
