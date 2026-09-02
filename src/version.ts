import { createRequire } from 'node:module';

/**
 * Read from package.json rather than duplicated as a constant, so it cannot
 * drift from what was actually published. dist/version.js sits one level
 * below the package root, the same relative position src/version.ts does.
 *
 * Kept in its own module rather than in index.ts on purpose: index.ts calls
 * main() at the top level, so anything importing it to read the version
 * would run the whole CLI as a side effect.
 */
export function readVersion(): string {
  try {
    return createRequire(import.meta.url)('../package.json').version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
