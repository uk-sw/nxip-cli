import { describe, expect, it } from 'vitest';
import { findUnknownMcpArgument } from '../src/mcp-args.js';

const USAGE = 'Usage: npx nxip-cli mcp [--read-only] [--api-key KEY] [--url URL] [--organization ID]';

describe('findUnknownMcpArgument', () => {
  it.each([
    [[]],
    [['--read-only']],
    [['--read-only', '--url', 'http://localhost:3000', '--api-key', 'k']],
    [['--organization', 'org_123']],
    [['--read-only', '--organization', 'org_123', '--api-key', 'k']],
  ])('accepts %j', (args) => {
    expect(findUnknownMcpArgument(args)).toBeUndefined();
  });

  // Each of these would otherwise start a server with write tools enabled.
  it.each([['--readonly'], ['--read_only'], ['-r'], ['readonly'], ['--read-only=true']])('refuses %s', (arg) => {
    expect(findUnknownMcpArgument(['--url', 'http://x', arg])).toBe(`Unknown argument "${arg}" for mcp. ${USAGE}`);
  });

  // A typo here (--org, --organisation) would otherwise start the server
  // against the key's own organization with nothing saying the flag was
  // ignored, which is a silent fail-open exactly like --readonly above.
  it.each([['--org'], ['--organisation'], ['--customer']])('refuses %s, not just --read-only typos', (arg) => {
    expect(findUnknownMcpArgument([arg, 'org_123'])).toBe(`Unknown argument "${arg}" for mcp. ${USAGE}`);
  });

  it('refuses an option missing its value, rather than swallowing the next flag', () => {
    expect(findUnknownMcpArgument(['--url', '--read-only'])).toMatch(/^--url needs a value\./);
    expect(findUnknownMcpArgument(['--api-key'])).toMatch(/^--api-key needs a value\./);
    expect(findUnknownMcpArgument(['--organization'])).toMatch(/^--organization needs a value\./);
    expect(findUnknownMcpArgument(['--organization', '--read-only'])).toMatch(/^--organization needs a value\./);
  });
});
