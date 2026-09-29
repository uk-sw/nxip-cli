import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Reads an OpenSSH known_hosts file and answers one question: is this host
 * key the one the operator already trusts for this host? The ssh2 package
 * hands the raw key blob to a verifier and leaves the file format to the
 * caller, so this is the caller.
 *
 * Understood: plain host names, comma lists, `[host]:port` for a port other
 * than 22, `*` and `?` wildcards, `!` negation, hashed entries (`|1|salt|hash`,
 * HMAC-SHA1 over the host name), and `@revoked` markers, which count as a
 * refusal even when the key matches. `@cert-authority` lines are skipped:
 * the agent has no certificate support and a CA line must never be read
 * as a plain key.
 */

export interface KnownHostEntry {
  patterns: string[];
  hashed: { salt: Buffer; digest: Buffer } | null;
  keyType: string;
  key: Buffer;
  revoked: boolean;
}

export type HostKeyVerdict = 'known' | 'unknown' | 'mismatch' | 'revoked';

export class KnownHostsError extends Error {}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);

    let marker: string | null = null;
    if (fields[0].startsWith('@')) marker = fields.shift() ?? null;
    if (marker === '@cert-authority') continue;
    if (fields.length < 3) continue;

    const [hosts, keyType, keyBase64] = fields;
    let key: Buffer;
    try {
      key = Buffer.from(keyBase64, 'base64');
    } catch {
      continue;
    }
    if (key.length === 0) continue;

    const hashedMatch = /^\|1\|([^|]+)\|(.+)$/.exec(hosts);
    entries.push({
      patterns: hashedMatch ? [] : hosts.split(','),
      hashed: hashedMatch ? { salt: Buffer.from(hashedMatch[1], 'base64'), digest: Buffer.from(hashedMatch[2], 'base64') } : null,
      keyType,
      key,
      revoked: marker === '@revoked',
    });
  }
  return entries;
}

export function readKnownHosts(path: string): KnownHostEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new KnownHostsError(`Could not read known_hosts file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseKnownHosts(text);
}

/** How OpenSSH writes a host for a non-default port: `[host]:2222`. */
export function knownHostName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function patternMatches(pattern: string, name: string): boolean {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const regex = new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return regex.test(name) !== negated;
}

function entryMatchesHost(entry: KnownHostEntry, name: string): boolean {
  if (entry.hashed) {
    const digest = createHmac('sha1', entry.hashed.salt).update(name).digest();
    return digest.equals(entry.hashed.digest);
  }
  // A negated pattern that matches vetoes the whole entry, as in OpenSSH.
  if (entry.patterns.some((p) => p.startsWith('!') && !patternMatches(p, name))) return false;
  return entry.patterns.some((p) => !p.startsWith('!') && patternMatches(p, name));
}

/**
 * Compares the key a server presented against the file. "mismatch" is the
 * dangerous answer: the host is known and the key is not the one recorded,
 * which is what a changed device or an interposed one looks like.
 */
export function verifyHostKey(entries: KnownHostEntry[], host: string, port: number, presented: Buffer): HostKeyVerdict {
  const name = knownHostName(host, port);
  const forHost = entries.filter((entry) => entryMatchesHost(entry, name));
  if (forHost.length === 0) return 'unknown';
  const same = forHost.filter((entry) => entry.key.equals(presented));
  if (same.some((entry) => entry.revoked)) return 'revoked';
  if (same.length > 0) return 'known';
  return 'mismatch';
}

/** The SHA256 fingerprint as ssh prints it, so an operator can compare by eye. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The line to add to known_hosts, printed so the operator can copy it. */
export function knownHostsLine(host: string, port: number, keyType: string, key: Buffer): string {
  return `${knownHostName(host, port)} ${keyType} ${key.toString('base64')}`;
}

/** The key type is the first string in the SSH wire encoding of a public key. */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (key.length < 4 + length) return 'unknown';
  return key.subarray(4, 4 + length).toString('ascii');
}
