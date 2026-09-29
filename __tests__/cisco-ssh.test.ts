import { afterEach, describe, expect, it } from 'vitest';
import { openShellSession, SshError, stripEchoAndPrompt } from '../src/ssh.js';
import { readDevice } from '../src/cisco.js';
import { startFakeDevice, wrongKeyFor, type FakeDevice } from './ssh-test-server.js';

/**
 * The SSH transport, against a real ssh2 server on loopback rather than a
 * fake session: key exchange, the host key verifier, password auth, the
 * interactive shell, finding the prompt and stripping the echo. The two
 * things the spec names are here: `terminal length 0` goes first, and a
 * command the device refuses does not abort the rest of the device.
 */

const MINIMAL_IOS = `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.4(3)M2, RELEASE SOFTWARE (fc2)

router1 uptime is 1 day, 2 hours, 3 minutes

Cisco CISCO2911/K9 (revision 1.0) with 483328K/40960K bytes of memory.
Processor board ID FTX0000TEST`;

const ROUTES = `Codes: L - local, C - connected, S - static
       O - OSPF, B - BGP

Gateway of last resort is not set

      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks
C        10.60.0.0/24 is directly connected, GigabitEthernet0/0
L        10.60.0.1/32 is directly connected, GigabitEthernet0/0`;

function iosOutputs(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      'terminal length 0': '',
      'show version': MINIMAL_IOS,
      'show vrf': '',
      'show ip interface': 'GigabitEthernet0/0 is up, line protocol is up\n  Internet address is 10.60.0.1/24\n  MTU is 1500 bytes',
      'show ipv6 interface': '',
      'show ip route': ROUTES,
      'show ipv6 route': '',
      'show ip arp': 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface\nInternet  10.60.0.9              12   0050.56aa.0009  ARPA   GigabitEthernet0/0',
      ...overrides,
    })
  );
}

let device: FakeDevice | null = null;

afterEach(async () => {
  await device?.close();
  device = null;
});

async function connect(fake: FakeDevice, knownHosts = fake.knownHosts, timeoutMs = 15_000) {
  return openShellSession(
    { host: '127.0.0.1', port: fake.port, username: 'readonly', password: 'secret' },
    { knownHosts, onUnknown: async () => false },
    { timeoutMs }
  );
}

// A hash-bordered `banner motd`, which is what a great many production
// devices carry. Every line of the border ends in the same character a
// Cisco prompt ends in.
const HASH_BANNER = `${'#'.repeat(50)}
#  AUTHORISED ACCESS ONLY. Activity is logged.   #
${'#'.repeat(50)}`;

describe('the SSH transport against an ssh2 server', () => {
  it('sends terminal length 0 before anything else, then reads the device', async () => {
    device = await startFakeDevice({ outputs: iosOutputs() });
    const session = await connect(device);
    let tables;
    try {
      tables = await readDevice(session, '127.0.0.1');
    } finally {
      await session.close();
    }

    // First, not merely present: a classic IOS that is still paging answers
    // the second command with --More-- and the parse is silently short.
    expect(device.commands[0]).toBe('terminal length 0');
    expect(device.commands[1]).toBe('show version');
    expect(tables.identity.hostname).toBe('router1');
    expect(tables.identity.serial).toBe('FTX0000TEST');
    expect(tables.routes.map((r) => r.prefix)).toEqual(['10.60.0.0/24', '10.60.0.1/32']);
    expect(tables.interfaces.map((i) => i.prefix)).toEqual(['10.60.0.0/24']);
  });

  it('finds the prompt behind a hash-bordered banner and still reads the device', async () => {
    // The banner arrives in its own write, before the prompt, exactly as a
    // device sends it. A prompt hunt that accepts a line ending in "#"
    // followed by a newline takes the banner's border for the prompt, and
    // every command after it then waits for a line the device never prints
    // again: a healthy device fails the whole run with "no prompt".
    // The timeout is short so the failure is a fast one rather than a
    // minute of waiting.
    device = await startFakeDevice({ outputs: iosOutputs(), banner: HASH_BANNER });
    const session = await connect(device, device.knownHosts, 4_000);
    let tables;
    try {
      tables = await readDevice(session, '127.0.0.1');
    } finally {
      await session.close();
    }

    expect(device.commands[0]).toBe('terminal length 0');
    expect(tables.identity.hostname).toBe('router1');
    expect(tables.routes.map((r) => r.prefix)).toEqual(['10.60.0.0/24', '10.60.0.1/32']);
    // The banner is not output either: it arrived before the first command
    // was ever sent, so nothing it says can reach a parser.
    expect(tables.identity.serial).toBe('FTX0000TEST');
  });

  it('records a refused command and carries on with the rest of the device', async () => {
    // A privilege-1 user denied `show ip arp` still gives every route, which
    // is most of the value; the run must not lose the device over it.
    const outputs = iosOutputs();
    outputs.delete('show ip arp');
    device = await startFakeDevice({ outputs, unknown: '% Permission denied for the role' });

    const session = await connect(device);
    let tables;
    try {
      tables = await readDevice(session, '127.0.0.1');
    } finally {
      await session.close();
    }

    expect(tables.refused.map((r) => r.command)).toContain('show ip arp');
    expect(tables.refused.find((r) => r.command === 'show ip arp')?.message).toBe('% Permission denied for the role');
    expect(tables.arp).toEqual([]);
    // The commands after the refusal were still asked and still parsed.
    expect(tables.routes).toHaveLength(2);
    expect(device.commands).toContain('show ip arp');
  });

  it('records a device that refused terminal length 0 rather than assuming it took', async () => {
    // Without the check, a device still paging looks like a device with a
    // short routing table: the --More-- markers are stripped from whatever
    // does arrive and nothing anywhere says the read was cut off.
    const outputs = iosOutputs({ 'terminal length 0': '% Permission denied for the role' });
    device = await startFakeDevice({ outputs });
    const session = await connect(device);
    let tables;
    try {
      tables = await readDevice(session, '127.0.0.1');
    } finally {
      await session.close();
    }

    expect(tables.refused.map((r) => r.command)).toContain('terminal length 0');
    // And the device is still read with whatever it will give, as the spec
    // says a refused command must be.
    expect(tables.routes).toHaveLength(2);
  });

  it('strips the echoed command and the trailing prompt from every answer', async () => {
    device = await startFakeDevice({ outputs: iosOutputs() });
    const session = await connect(device);
    try {
      const text = await session.run('show version');
      expect(text.startsWith('Cisco IOS Software')).toBe(true);
      expect(text).not.toContain('router1#');
      expect(text).not.toMatch(/^show version/);
    } finally {
      await session.close();
    }
  });

  it('refuses a host whose key is not in known_hosts, naming the fingerprint and the line to add', async () => {
    device = await startFakeDevice({ outputs: iosOutputs() });
    // Scheduled mode's policy: never ask, always refuse.
    await expect(connect(device, [])).rejects.toThrow(SshError);
    await expect(connect(device, [])).rejects.toThrow(/not in known_hosts \(ssh-rsa SHA256:/);
    await expect(connect(device, [])).rejects.toThrow(device.knownHostsLine);
  });

  it('refuses a host whose key does not match the one in known_hosts', async () => {
    device = await startFakeDevice({ outputs: iosOutputs() });
    await expect(connect(device, wrongKeyFor(device.port))).rejects.toThrow(/does not match known_hosts/);
  });

  it('connects when the key is the one known_hosts records', async () => {
    device = await startFakeDevice({ outputs: iosOutputs() });
    const session = await connect(device);
    await session.close();
    expect(device.commands).toEqual([]);
  });

  it('fails the device rather than the run when the password is wrong', async () => {
    device = await startFakeDevice({ outputs: iosOutputs(), password: 'other' });
    await expect(connect(device)).rejects.toThrow(SshError);
  });
});

describe('stripEchoAndPrompt', () => {
  it('drops the echoed command, the trailing prompt and any --More-- left behind', () => {
    // What a device that refused `terminal length 0` sends: the pager's
    // marker between screens, with the spaces and backspaces it erases
    // itself with. Both route lines have to survive it.
    const raw = 'show ip route\r\nC    10.0.0.0/24 is directly connected, Gi0/0\r\n         --More--         \b\b\b\r\nC    10.1.0.0/24 is directly connected, Gi0/1\r\nrouter1#';
    const text = stripEchoAndPrompt(raw, 'show ip route', 'router1#');
    expect(text).not.toContain('--More--');
    expect(text.split('\n').filter((line) => line.trim() !== '')).toEqual([
      'C    10.0.0.0/24 is directly connected, Gi0/0',
      'C    10.1.0.0/24 is directly connected, Gi0/1',
    ]);
  });

  it('keeps output that merely ends in a hash', () => {
    const raw = 'show version\r\nSerial is ABC#\r\nrouter1#';
    expect(stripEchoAndPrompt(raw, 'show version', 'router1#')).toBe('Serial is ABC#');
  });
});
