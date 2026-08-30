#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolveClientOptions } from './client.js';
import { ManifestError, parseManifest } from './manifest.js';
import { formatPlan, planManifest } from './plan.js';
import { applyManifest, formatApplyResults } from './apply.js';
import { expandSiteSpec, renderManifest, SiteSpecError } from './site.js';

interface ParsedArgs {
  command: string;
  file?: string;
  output?: string;
  apiKey?: string;
  url?: string;
  autoApprove: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const args: ParsedArgs = { command: command ?? '', autoApprove: false };

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

function loadManifest(file: string | undefined) {
  if (!file) {
    console.error('Missing required -f/--file <manifest.yaml>');
    process.exitCode = 1;
    return null;
  }
  try {
    const raw = readFileSync(file, 'utf-8');
    return parseManifest(raw);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  const options = resolveClientOptions(args.apiKey, args.url);

  if (!options.apiKey) {
    console.error('Missing API key. Set NXIP_API_KEY, or pass --api-key. Get one free at https://nx-ip.com/signup.');
    process.exitCode = 1;
    return;
  }

  if (args.command === 'plan') {
    const entries = loadManifest(args.file);
    if (!entries) return;
    const planned = await planManifest(options, entries);
    console.log(formatPlan(planned));
    return;
  }

  if (args.command === 'apply') {
    const entries = loadManifest(args.file);
    if (!entries) return;

    if (!args.autoApprove) {
      const planned = await planManifest(options, entries);
      console.log(formatPlan(planned));
      const approved = await confirm('Do you want to perform these actions?');
      if (!approved) {
        console.log('Apply cancelled.');
        return;
      }
    }

    const results = await applyManifest(options, entries);
    console.log(formatApplyResults(results));
    if (results.some((r) => r.outcome === 'failed')) {
      process.exitCode = 1;
    }
    return;
  }

  console.error('Usage: nxip <plan|apply> -f <manifest.yaml> [--api-key KEY] [--url URL] [--auto-approve]');
  console.error('       nxip scaffold -f <site.yaml> [-o <manifest.yaml>]');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
