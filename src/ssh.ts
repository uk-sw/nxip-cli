import { Client, type Algorithms, type ClientChannel } from 'ssh2';
import { fingerprint, keyTypeOf, knownHostsLine, verifyHostKey, type KnownHostEntry } from './known-hosts.js';

/**
 * One interactive shell on one device, and the two things the Cisco source
 * needs from it: run a `show` command and get its text back, and close.
 * Everything else about SSH (the ssh2 package, prompts, paging) stays in
 * this file so the source and its tests can use a fake session instead.
 *
 * A shell rather than exec on purpose. Classic IOS runs each exec request
 * on a fresh vty, so `terminal length 0` sent that way is forgotten by the
 * next command and the output comes back paged with --More-- in it. One
 * shell keeps the setting for the session, which is the whole reason the
 * spec has that command first.
 */
export interface DeviceSession {
  run(command: string): Promise<string>;
  close(): Promise<void>;
}

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  password?: string;
  /** OpenSSH-format private key. An alternative to the password, never both. */
  privateKey?: Buffer;
}

export interface UnknownHostKey {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** The line to add to known_hosts. */
  line: string;
}

export interface HostKeyPolicy {
  knownHosts: KnownHostEntry[];
  /**
   * Called for a host the file does not know. Returns whether to continue.
   * One-shot mode asks the operator; scheduled mode always answers no.
   */
  onUnknown: (key: UnknownHostKey) => Promise<boolean>;
}

export class SshError extends Error {}

/**
 * A line ending in the two characters Cisco prompts end in, with nothing
 * after it but spaces.
 *
 * The trailing class is [ \t] and deliberately not \s: \s matches a newline,
 * and a device whose `banner motd` is drawn with a border of hashes ends a
 * banner line in "#" followed by a newline. That looked exactly like the
 * first prompt, so the prompt text became the banner's border, every later
 * command waited for a line that never came again, and a healthy device
 * failed the run with "no prompt". A prompt is what the device stops at, so
 * it is never followed by a newline.
 */
const PROMPT_LINE = /(^|[\r\n])([^\r\n]*[>#])[ \t]*$/;

const DEFAULT_TIMEOUT_MS = 60_000;

// Older IOS speaks only algorithms ssh2 has since dropped from its defaults.
// They are appended, not preferred, so a modern device still negotiates a
// modern set and only a legacy one falls through to these. The cast is
// because the typings want all of append, prepend and remove on each list
// while the runtime accepts any one of them.
const LEGACY_ALGORITHMS = {
  kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha1'] },
  serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] },
  cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] },
} as unknown as Algorithms;

/**
 * Opens a shell on the device and waits for its prompt. The prompt text
 * is captured from the first thing the device says after the banner and
 * used to tell where every later command's output ends.
 */
export async function openShellSession(
  target: SshTarget,
  policy: HostKeyPolicy,
  options: { timeoutMs?: number; onProgress?: (message: string) => void } = {}
): Promise<DeviceSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client();

  // Set by the verifier so the connection error that follows a refused key
  // says why, rather than ssh2's generic "Host key verification failed".
  let hostKeyProblem: string | null = null;

  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => resolve());
    client.on('error', (error: Error) => reject(new SshError(hostKeyProblem ?? `${target.host}: ${error.message}`)));
    // IOS commonly offers keyboard-interactive rather than plain password
    // authentication; the answer to its one prompt is the same password.
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => target.password ?? ''));
    });
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      privateKey: target.privateKey,
      tryKeyboard: target.password !== undefined,
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const verdict = verifyHostKey(policy.knownHosts, target.host, target.port, key);
        if (verdict === 'known') return verify(true);
        if (verdict === 'mismatch' || verdict === 'revoked') {
          hostKeyProblem =
            `${target.host}: host key ${verdict === 'revoked' ? 'is revoked' : 'does not match known_hosts'} ` +
            `(${fingerprint(key)}). Refusing to connect. If the device was replaced, update the known_hosts entry on purpose.`;
          return verify(false);
        }
        const unknown: UnknownHostKey = {
          host: target.host,
          port: target.port,
          keyType: keyTypeOf(key),
          fingerprint: fingerprint(key),
          line: knownHostsLine(target.host, target.port, keyTypeOf(key), key),
        };
        policy
          .onUnknown(unknown)
          .then((accepted) => {
            if (!accepted) {
              hostKeyProblem =
                `${target.host}: host key is not in known_hosts (${unknown.keyType} ${unknown.fingerprint}). ` +
                `Add this line to the known_hosts file to trust it:\n  ${unknown.line}`;
            }
            verify(accepted);
          })
          .catch(() => verify(false));
      },
      // Older IOS speaks only algorithms ssh2 has since dropped from its
      // defaults. They are appended, not preferred, so a modern device still
      // negotiates a modern set and only a legacy one falls through to these.
      algorithms: LEGACY_ALGORITHMS,
    });
  });

  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'vt100', rows: 100, cols: 511 }, (error, stream) => (error ? reject(new SshError(`${target.host}: ${error.message}`)) : resolve(stream)));
  });

  let buffer = '';
  let waiter: { settle: (text: string) => void; fail: (error: Error) => void; complete: (text: string) => boolean } | null = null;
  let closed = false;

  const check = () => {
    if (waiter && waiter.complete(buffer)) {
      const done = waiter;
      waiter = null;
      const text = buffer;
      buffer = '';
      done.settle(text);
    }
  };
  channel.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    check();
  });
  channel.stderr.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    check();
  });
  channel.on('close', () => {
    closed = true;
    if (waiter) waiter.fail(new SshError(`${target.host}: the session closed while waiting for output.`));
    waiter = null;
  });

  const waitFor = (complete: (text: string) => boolean, what: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new SshError(`${target.host}: no prompt within ${Math.round(timeoutMs / 1000)}s while waiting for ${what}.`));
      }, timeoutMs);
      waiter = {
        complete,
        settle: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      check();
    });

  // The first prompt. Its text is what every later command waits for.
  const banner = await waitFor((text) => PROMPT_LINE.test(text), 'the first prompt');
  const prompt = PROMPT_LINE.exec(banner)?.[2]?.trim() ?? '';
  options.onProgress?.(`${target.host}: prompt "${prompt}"`);

  const endsWithPrompt = (text: string): boolean => {
    const trimmed = text.trimEnd();
    if (!trimmed.endsWith(prompt)) return false;
    // The prompt must be at the start of its line, or the tail of a line of
    // output that happens to end in "#" would look like one.
    const at = trimmed.length - prompt.length;
    return at === 0 || trimmed[at - 1] === '\n' || trimmed[at - 1] === '\r';
  };

  return {
    async run(command: string): Promise<string> {
      if (closed) throw new SshError(`${target.host}: the session is closed.`);
      channel.write(`${command}\n`);
      const raw = await waitFor(endsWithPrompt, `"${command}"`);
      return stripEchoAndPrompt(raw, command, prompt);
    },
    async close(): Promise<void> {
      if (!closed) {
        channel.end();
        closed = true;
      }
      client.end();
    },
  };
}

/**
 * The device echoes the command as the first line and prints its prompt
 * as the last; neither is output. Any --More-- markers, which should not
 * appear after `terminal length 0` but do on a device that refused it,
 * are removed so the text still parses.
 */
export function stripEchoAndPrompt(raw: string, command: string, prompt: string): string {
  let text = raw.replace(/\r/g, '');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[0].trim().endsWith(command.trim())) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length > 0 && lines[lines.length - 1].trim() === prompt) lines.pop();
  text = lines.join('\n');
  return text.replace(/ *--More--[ \b]*/g, '');
}
