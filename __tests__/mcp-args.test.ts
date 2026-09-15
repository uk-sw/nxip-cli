import { describe, expect, it } from 'vitest';
import { findUnknownMcpArgument } from '../src/mcp-args.js';

describe('findUnknownMcpArgument', () => {
  it.each([[[]], [['--read-only']], [['--read-only', '--url', 'http://localhost:3000', '--api-key', 'k']]])('accepts %j', (args) => {
    expect(findUnknownMcpArgument(args)).toBeUndefined();
  });

  // Each of these would otherwise start a server with write tools enabled.
  it.each([['--readonly'], ['--read_only'], ['-r'], ['readonly'], ['--read-only=true']])('refuses %s', (arg) => {
    expect(findUnknownMcpArgument(['--url', 'http://x', arg])).toBe(
      `Unknown argument "${arg}" for mcp. Usage: npx nxip-cli mcp [--read-only] [--api-key KEY] [--url URL]`
    );
  });

  it('refuses an option missing its value, rather than swallowing the next flag', () => {
    expect(findUnknownMcpArgument(['--url', '--read-only'])).toMatch(/^--url needs a value\./);
    expect(findUnknownMcpArgument(['--api-key'])).toMatch(/^--api-key needs a value\./);
  });
});
