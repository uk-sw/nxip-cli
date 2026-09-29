import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { knownHostName, parseKnownHosts, type KnownHostEntry } from '../src/known-hosts.js';

/**
 * A real SSH server, from the ssh2 package the transport itself uses, so
 * the transport tests exercise the whole thing: key exchange, the host key
 * verifier, authentication, the interactive shell, the prompt hunt and the
 * echo stripping. A fake DeviceSession can prove none of that.
 *
 * It listens on 127.0.0.1 with an ephemeral port and generates a fresh host
 * key per server, so a test can decide whether the key is in known_hosts and
 * get "known", "unknown" or "mismatch" on purpose. Nothing here talks to
 * anything but loopback.
 */

const { Server, utils } = ssh2;

/**
 * A host key, as a PEM private key and as the wire-format public blob that
 * known_hosts records in base64. Node generates it rather than ssh2's own
 * keygen, whose OpenSSH-format output ssh2 itself intermittently refuses to
 * parse back ("Malformed OpenSSH private key"), which showed up as a flake
 * roughly one run in twenty. PKCS#1 PEM is parsed the same way every time.
 */
function newHostKey(): { pem: string; type: string; blobBase64: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  return { pem: privateKey, type: parsed.type, blobBase64: parsed.getPublicSSH().toString('base64') };
}

// One key for every server in a file, and one that no server ever presents.
// Generated once because 2048-bit RSA per test adds up, and reusing them
// changes nothing: the tests vary what known_hosts holds, not the key.
const HOST_KEY = newHostKey();
const OTHER_KEY = newHostKey();

export interface FakeDevice {
  port: number;
  /** Every command line the shell received, in order, including `terminal length 0`. */
  commands: string[];
  /** The known_hosts entries that trust this server, for the HostKeyPolicy. */
  knownHosts: KnownHostEntry[];
  /** The known_hosts line itself, for the tests that check the wording of a refusal. */
  knownHostsLine: string;
  close(): Promise<void>;
}

export interface FakeDeviceOptions {
  /** What the device answers, by command. A command not here gets `unknown`. */
  outputs: Map<string, string>;
  /** IOS's answer to a command it does not have. */
  unknown?: string;
  /** The prompt, which is how the transport knows one command's output has ended. */
  prompt?: string;
  /** Printed before the first prompt, as a real device prints a banner. */
  banner?: string;
  password?: string;
}

/**
 * Starts the server and resolves once it is listening. The caller closes it,
 * always in a finally or an afterEach: a leaked listener keeps vitest alive.
 */
export async function startFakeDevice(options: FakeDeviceOptions): Promise<FakeDevice> {
  const prompt = options.prompt ?? 'router1#';
  const unknown = options.unknown ?? `${' '.repeat(22)}^\r\n% Invalid input detected at '^' marker.`;
  const password = options.password ?? 'secret';
  const commands: string[] = [];

  const server = new Server({ hostKeys: [HOST_KEY.pem] }, (client) => {
    client.on('authentication', (ctx) => {
      // Password only, which is what a read-only IOS user has. A wrong one
      // is rejected so a test can prove the credential is really carried.
      if (ctx.method === 'password' && ctx.password === password) ctx.accept();
      else if (ctx.method === 'none') ctx.reject(['password']);
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (accepted) => accepted?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write(`${options.banner ?? ''}\r\n${prompt}`);
          let buffer = '';
          stream.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            let at = buffer.indexOf('\n');
            while (at >= 0) {
              const command = buffer.slice(0, at).replace(/\r/g, '').trim();
              buffer = buffer.slice(at + 1);
              commands.push(command);
              // The device echoes the command, prints its output, then its
              // prompt. Exactly what the transport has to strip back off.
              const output = options.outputs.get(command) ?? unknown;
              stream.write(`${command}\r\n${output.replace(/\n/g, '\r\n')}\r\n${prompt}`);
              at = buffer.indexOf('\n');
            }
          });
        });
      });
    });
    // A client that walks away mid-handshake is normal in these tests.
    client.on('error', () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const line = `${knownHostName('127.0.0.1', port)} ${HOST_KEY.type} ${HOST_KEY.blobBase64}`;

  return {
    port,
    commands,
    knownHosts: parseKnownHosts(line),
    knownHostsLine: line,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A known_hosts entry for this host and port carrying a key no device ever presents. */
export function wrongKeyFor(port: number): KnownHostEntry[] {
  return parseKnownHosts(`${knownHostName('127.0.0.1', port)} ${OTHER_KEY.type} ${OTHER_KEY.blobBase64}`);
}
