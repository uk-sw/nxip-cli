/**
 * Every argument `nxip mcp` understands. Kept apart from mcp.ts so index.ts
 * can check arguments without loading the MCP SDK, which only the mcp
 * command should pay for.
 */
const FLAGS = new Set(['--read-only']);
const OPTIONS_WITH_VALUE = new Set(['--api-key', '--url']);

/**
 * Returns a one-line complaint about the first argument `nxip mcp` does not
 * understand, or undefined if every argument is known.
 *
 * The general parser ignores what it does not recognise, which is harmless
 * for scan or plan but not here: `--readonly` for `--read-only` would start
 * a server with the write tools enabled and nothing saying so. A guardrail
 * that silently fails open is worse than none, so mcp fails closed instead.
 */
export function findUnknownMcpArgument(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (FLAGS.has(arg)) continue;
    if (OPTIONS_WITH_VALUE.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return `${arg} needs a value. Usage: npx nxip-cli mcp [--read-only] [--api-key KEY] [--url URL]`;
      }
      i++;
      continue;
    }
    return `Unknown argument "${arg}" for mcp. Usage: npx nxip-cli mcp [--read-only] [--api-key KEY] [--url URL]`;
  }
  return undefined;
}
