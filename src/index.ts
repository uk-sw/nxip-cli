#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolveClientOptions } from './client.js';
import { ManifestError, parseFullManifest, type Manifest } from './manifest.js';
import { formatPlan, planManifest, planPools, formatPoolPlan, annotateAgainstPools, formatAnnotatedPlan } from './plan.js';
import { applyFullManifest, formatApplyResults } from './apply.js';
import { expandSiteSpec, renderManifest, SiteSpecError } from './site.js';
import { readVersion } from './version.js';
import { discoverAws, AwsScanError } from './aws.js';
import { discoverAzure, AzureScanError } from './azure.js';
import { analyseDiscovery, formatScanReport, renderDiscoveryManifest, mergeDiscoveries, redactDiscovery, type Discovery } from './scan.js';
import { DEFAULT_SHARED_RANGES, parseSharedRanges, SharedRangeError } from './shared-ranges.js';

interface ParsedArgs {
  command: string;
  subcommand?: string;
  file?: string;
  output?: string;
  apiKey?: string;
  url?: string;
  autoApprove: boolean;
  regions?: string[];
  allRegions: boolean;
  profile?: string;
  json: boolean;
  emitManifest: boolean;
  exclude?: string[];
  includeShared: boolean;
  redact: boolean;
  providers: string[];
  subscriptions?: string[];
  allSubscriptions: boolean;
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
    redact: false,
    providers: [],
    allSubscriptions: false,
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
    } else if (arg === '--redact') {
      args.redact = true;
    } else if (arg === '--subscription') {
      args.subscriptions = (rest[++i] ?? '').split(',').map((r) => r.trim()).filter(Boolean);
    } else if (arg === '--all-subscriptions') {
      args.allSubscriptions = true;
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
  write('Usage: nxip scan <aws|azure> [aws|azure] [--exclude CIDR,...] [--include-shared]');
  write('                     [--redact] [--json] [--emit-manifest] [-o FILE]');
  write('         aws:   [--region NAME,...] [--all-regions] [--profile NAME]');
  write('         azure: [--subscription ID,...] [--all-subscriptions]');
  write('       nxip scaffold -f <site.yaml> [-o <manifest.yaml>]');
  write('       nxip <plan|apply> -f <manifest.yaml> [--api-key KEY] [--url URL] [--auto-approve]');
  write('');
  write('scan and scaffold need no nxip account. plan and apply need an API key.');
  write('Docs: https://nx-ip.com/docs/nxip-cli');
}

const COMMANDS = new Set(['scan', 'scaffold', 'plan', 'apply']);


async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Help, and anything unrecognized, resolve before the API-key gate below.
  // Otherwise a bare `npx nxip-cli` greets a first-time user with "Missing
  // API key", which is both unhelpful and untrue for the two commands that
  // do not need one.
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
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
      console.log(`Wrote ${args.output}. Review it, then run: nxip plan -f ${args.output}`);
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
    const SUPPORTED = new Set(['aws', 'azure']);
    const unknown = args.providers.filter((p) => !SUPPORTED.has(p));
    if (args.providers.length === 0 || unknown.length > 0) {
      console.error('Usage: nxip scan <aws|azure> [aws|azure] [provider flags] [--exclude CIDR,...] [--include-shared] [--redact] [--json] [--emit-manifest] [-o FILE]');
      console.error(
        unknown.length > 0
          ? `Unknown provider${unknown.length === 1 ? '' : 's'} ${unknown.map((u) => `"${u}"`).join(', ')}. Supported: aws, azure.`
          : 'Missing provider. Supported: aws, azure.'
      );
      process.exitCode = 1;
      return;
    }

    // Each provider is scanned separately then merged, so one estate is
    // analysed as a whole. That is where cross-cloud findings come from: no
    // cloud's own IPAM can see another's.
    const discoveries: Discovery[] = [];
    for (const provider of args.providers) {
      try {
        discoveries.push(
          provider === 'aws'
            ? await discoverAws({ regions: args.regions, allRegions: args.allRegions, profile: args.profile })
            : await discoverAzure({ subscriptions: args.subscriptions, allSubscriptions: args.allSubscriptions })
        );
      } catch (error) {
        const known = error instanceof AwsScanError || error instanceof AzureScanError;
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
    try {
      sharedRanges = args.includeShared
        ? []
        : [...DEFAULT_SHARED_RANGES, ...parseSharedRanges(args.exclude ?? [])];
    } catch (error) {
      console.error(error instanceof SharedRangeError ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    const report = analyseDiscovery(discovery, { sharedRanges });

    const output = args.emitManifest
      ? renderDiscoveryManifest(report)
      : args.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatScanReport(report);

    if (args.emitManifest && args.redact) {
      console.error(
        'Note: --redact replaces the network and subnet ids this manifest records as provenance, so the link back to the real resources is lost. Useful for sharing an example, not for loading your own estate.'
      );
    }

    if (args.output) {
      writeFileSync(args.output, output, 'utf-8');
      console.log(
        args.emitManifest
          ? `Wrote ${args.output}. Review it, then run: nxip plan -f ${args.output}`
          : `Wrote ${args.output}.`
      );
    } else {
      process.stdout.write(output);
    }

    // The pitch goes to stderr so it never contaminates piped JSON or a
    // manifest being redirected to a file.
    if (!args.emitManifest && !args.json) {
      if (report.clusters.length > 0) {
        console.error('Want these checked before the next terraform apply, not after? https://nx-ip.com');
      } else {
        console.error('Want this tracked continuously as your estate changes? https://nx-ip.com');
      }
    }
    return;
  }

  const options = resolveClientOptions(args.apiKey, args.url);

  if (!options.apiKey) {
    console.error('Missing API key. Set NXIP_API_KEY, or pass --api-key. Get one free at https://nx-ip.com/signup.');
    process.exitCode = 1;
    return;
  }

  if (args.command === 'plan') {
    const manifest = loadManifest(args.file);
    if (!manifest) return;
    const poolPlan = await planPools(options, manifest.pools);
    if (poolPlan.length > 0) console.log(formatPoolPlan(poolPlan));
    const planned = await planManifest(options, manifest.subnets);
    // When the manifest declares pools, a plain subnet plan reads as all
    // failures, since the pools do not exist yet.
    console.log(poolPlan.length > 0 ? formatAnnotatedPlan(annotateAgainstPools(planned, poolPlan)) : formatPlan(planned));
    return;
  }

  if (args.command === 'apply') {
    const manifest = loadManifest(args.file);
    if (!manifest) return;

    if (!args.autoApprove) {
      const poolPlan = await planPools(options, manifest.pools);
      if (poolPlan.length > 0) console.log(formatPoolPlan(poolPlan));
      const planned = await planManifest(options, manifest.subnets);
      console.log(poolPlan.length > 0 ? formatAnnotatedPlan(annotateAgainstPools(planned, poolPlan)) : formatPlan(planned));
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
