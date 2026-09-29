import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAgentConfig,
  newAgentState,
  runAgent,
  runAgentOnce,
  type AgentConfig,
  type AgentDependencies,
  type ConfigEnvironment,
  type RunLog,
} from '../src/agent.js';
import type { NxipPool, NxipProposal, NxipProposalOperation, NxipSubnet, PreviewResult } from '../src/types.js';
import { TranscriptSession } from './cisco-fixtures.js';
import { startFakeDevice, type FakeDevice } from './ssh-test-server.js';

/**
 * Scheduled mode: read the devices, compare with what the organisation
 * already holds, propose what is new. Nothing is ever applied, and nothing
 * is ever deleted, because proposals cannot delete and reclaim is
 * flag-and-alert by roadmap decision.
 *
 * The API is a fake: every call the agent can make is a dependency, so a
 * run here touches no network at all except the loopback SSH server in the
 * host-key test at the bottom.
 */

const ROUTES = `Codes: L - local, C - connected, S - static
       O - OSPF, B - BGP

Gateway of last resort is not set

      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks
C        10.50.0.0/24 is directly connected, GigabitEthernet0/0
L        10.50.0.1/32 is directly connected, GigabitEthernet0/0`;

const SHOW_VERSION = `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.4(3)M2, RELEASE SOFTWARE (fc2)

lab1 uptime is 1 day, 2 hours

Cisco CISCO2911/K9 (revision 1.0) with 483328K/40960K bytes of memory.
Processor board ID FTX0000TEST`;

/** One small device: one connected /24 and nothing else worth reporting. */
function labDevice(routes = ROUTES): Map<string, string> {
  return new Map([
    ['terminal length 0', ''],
    ['show version', SHOW_VERSION],
    ['show vrf', ''],
    ['show ip interface', 'GigabitEthernet0/0 is up, line protocol is up\n  Internet address is 10.50.0.1/24\n  MTU is 1500 bytes'],
    ['show ipv6 interface', ''],
    ['show ip route vrf *', routes],
    ['show ipv6 route', ''],
    ['show ip arp', ''],
  ]);
}

const CONFIG_YAML = `
schedule: "0 2 * * *"
region: hq
pools: [10.50.0.0/16]
sources:
  - type: cisco
    hosts: [lab1.example]
    user: readonly
    password_env: NXIP_SSH_PASSWORD
`;

const CONFIG_ENVIRONMENT: ConfigEnvironment = { env: { NXIP_SSH_PASSWORD: 'x' }, readFile: () => Buffer.alloc(0) };

function config(yaml = CONFIG_YAML): AgentConfig {
  return loadAgentConfig(yaml, CONFIG_ENVIRONMENT);
}

function pool(cidr: string, overrides: Partial<NxipPool> = {}): NxipPool {
  return { id: `pool_${cidr}`, name: `pool ${cidr}`, cidr, family: 'IPV4', environment: 'production', region: 'hq', ...overrides };
}

function subnet(cidr: string, metadata: Record<string, string> = {}, overrides: Partial<NxipSubnet> = {}): NxipSubnet {
  return {
    id: `sub_${cidr}`,
    cidr,
    prefixLength: Number(cidr.split('/')[1]),
    family: 'IPV4',
    environment: 'production',
    region: 'hq',
    ipPoolId: 'pool_1',
    parentSubnetId: null,
    kind: null,
    name: cidr,
    description: null,
    metadata,
    createdAt: '2026-01-01T00:00:00.000Z',
    utilization: { registeredAddresses: 0 },
    ...overrides,
  };
}

interface FakeApi {
  deps: AgentDependencies;
  proposals: { reason?: string; operations: NxipProposalOperation[] }[];
  previews: unknown[];
}

/** A PENDING proposal as GET /v1/proposals returns it, holding these operations. */
function pendingProposal(operations: NxipProposalOperation[]): NxipProposal {
  return {
    id: 'prop_pending',
    status: 'PENDING',
    operations: operations.map((operation) => ({ ...operation, input: operation.input as unknown as Record<string, unknown>, preview: {}, result: null })),
  } as unknown as NxipProposal;
}

function fakeApi(options: {
  pools?: NxipPool[];
  subnets?: NxipSubnet[];
  preview?: (body: unknown) => PreviewResult;
  propose?: () => never;
  proposalsPending?: NxipProposal[];
  listProposals?: AgentDependencies['listProposals'];
  outputs?: Map<string, string>;
  openSession?: AgentDependencies['openSession'];
  now?: () => Date;
} = {}): FakeApi {
  const proposals: FakeApi['proposals'] = [];
  const previews: unknown[] = [];
  const outputs = options.outputs ?? labDevice();

  const deps: AgentDependencies = {
    options: { apiKey: 'test-key', baseUrl: 'https://nxip.test' },
    listPools: async () => options.pools ?? [pool('10.50.0.0/16')],
    listAllSubnets: async () => options.subnets ?? [],
    previewSubnet: async (_options, body) => {
      previews.push(body);
      return options.preview?.(body) ?? ({ wouldSucceed: true, cidr: body.cidr ?? '', poolId: 'pool_1' } as unknown as PreviewResult);
    },
    proposeChanges: async (_options, body) => {
      options.propose?.();
      proposals.push(body);
      return { id: `prop_${proposals.length}`, status: 'PENDING' } as unknown as NxipProposal;
    },
    listProposals:
      options.listProposals ??
      (async () => ({ data: options.proposalsPending ?? [], meta: { total: 0, page: 1, limit: 100, totalPages: 1 } })),
    readKnownHosts: () => [],
    openSession: options.openSession ?? (async () => new TranscriptSession(outputs)),
    now: options.now ?? (() => new Date('2026-09-29T02:00:00.000Z')),
  };

  return { deps, proposals, previews };
}

describe('what a run proposes', () => {
  it('turns one new prefix into exactly one create_subnet inside exactly one proposal', async () => {
    const api = fakeApi();
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0].operations).toHaveLength(1);
    const [operation] = api.proposals[0].operations;
    expect(operation.type).toBe('create_subnet');
    expect(operation.input).toMatchObject({
      cidr: '10.50.0.0/24',
      family: 'IPV4',
      environment: 'production',
      region: 'hq',
      kind: 'interface',
      landingPoint: false,
    });
    expect((operation.input as { metadata: Record<string, string> }).metadata).toMatchObject({
      source: 'nxip-agent',
      network_id: 'FTX0000TEST',
      device: 'lab1',
      vrf: 'default',
      route_type: 'connected',
    });

    expect(log.prefixes).toMatchObject({ discovered: 1, known: 0, new: 1 });
    expect(log.pools).toEqual({ discovered: 1, known: 1, new: 0, awaiting_approval: 0 });
    expect(log.proposals).toEqual([{ id: 'prop_1', operations: 1 }]);
    expect(api.proposals[0].reason).toContain('nxip-agent hq 2026-09-29');
  });

  it('proposes the pool too when the organisation has none covering the site', async () => {
    const api = fakeApi({ pools: [] });
    await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0].operations.map((o) => o.type)).toEqual(['create_pool']);
    // The subnet waits for the pool's approval: a proposal is previewed
    // against the organisation as it is, and the pool does not exist yet.
    expect(api.proposals[0].operations[0].input).toMatchObject({ cidr: '10.50.0.0/16', region: 'hq' });
  });

  it('asks for the pool when the only one for this site covers a different block', async () => {
    // One pool per (environment, region, family) is the rule, but a
    // 192.168.0.0/16 pool is not a home for a 10.50.0.0/16 plan. Treating
    // it as one meant the pool was never asked for and every subnet under
    // it then failed its preview with "no pool covers this block".
    const api = fakeApi({ pools: [pool('192.168.0.0/16')] });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.pools).toMatchObject({ discovered: 1, known: 0, new: 1 });
    expect(api.proposals[0].operations.map((o) => o.type)).toEqual(['create_pool']);
    expect(api.proposals[0].operations[0].input).toMatchObject({ cidr: '10.50.0.0/16' });
  });

  it('asks for no pool when an existing one for this site already covers the block', async () => {
    const api = fakeApi({ pools: [pool('10.0.0.0/8')] });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.pools).toMatchObject({ known: 1, new: 0 });
    expect(api.proposals[0].operations.map((o) => o.type)).toEqual(['create_subnet']);
  });

  it('proposes nothing for a prefix nxip already holds at the same CIDR and network_id', async () => {
    const api = fakeApi({
      subnets: [subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' })],
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toEqual([]);
    expect(api.previews).toEqual([]);
    expect(log.prefixes).toMatchObject({ discovered: 1, known: 1, new: 0 });
    expect(log.prefixes.moved).toEqual([]);
  });

  it('logs a known prefix now announced by a different device, and still proposes nothing', async () => {
    // Drift worth a line, never a proposal: proposals cannot update, so
    // there is nothing to ask for.
    const api = fakeApi({
      subnets: [subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'OLD-SERIAL' })],
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toEqual([]);
    expect(log.prefixes.moved).toEqual([{ cidr: '10.50.0.0/24', from: 'OLD-SERIAL', to: 'FTX0000TEST' }]);
  });

  it('files no proposal and one log line when nothing is new', async () => {
    const api = fakeApi({ subnets: [subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' })] });
    const printed: RunLog[] = [];
    await runAgent(config('region: hq\npools: [10.50.0.0/16]\nsources:\n  - type: cisco\n    hosts: [lab1.example]\n    user: readonly\n    password_env: NXIP_SSH_PASSWORD\n'), api.deps, {
      print: (log) => printed.push(log),
      sleep: async () => undefined,
    });

    expect(printed).toHaveLength(1);
    expect(printed[0].proposals).toEqual([]);
    expect(api.proposals).toEqual([]);
  });

  it('logs an entry the API would refuse and still proposes the rest', async () => {
    const api = fakeApi({
      preview: (body) =>
        (body as { cidr?: string }).cidr === '10.50.0.0/24'
          ? ({ wouldSucceed: false, reason: 'no-pool', message: 'No pool covers this block', httpStatusIfAttempted: 422 } as PreviewResult)
          : ({ wouldSucceed: true } as unknown as PreviewResult),
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toEqual([]);
    expect(log.prefixes.would_fail).toEqual([{ cidr: '10.50.0.0/24', reason: 'no-pool', message: 'No pool covers this block' }]);
    expect(log.prefixes.new).toBe(0);
  });

  it('splits a run with more operations than one proposal holds', async () => {
    // proposalService.ts caps a proposal at 20 operations. Twenty-five new
    // prefixes are two proposals, each still one approval for a person.
    const lines = Array.from({ length: 25 }, (_, i) => `C        10.${50 + i}.0.0/24 is directly connected, GigabitEthernet0/0`);
    const api = fakeApi({
      outputs: labDevice(`Codes: C - connected\n\n      10.0.0.0/8 is variably subnetted, 25 subnets, 1 masks\n${lines.join('\n')}`),
      pools: [pool('10.0.0.0/8')],
    });
    const log = await runAgentOnce(config(CONFIG_YAML.replace('10.50.0.0/16', '10.0.0.0/8')), api.deps, newAgentState());

    // 10.50.0.0/24 is the one the interface table already gave, so 25 in all.
    expect(log.prefixes.new).toBe(25);
    expect(api.proposals.map((p) => p.operations.length)).toEqual([20, 5]);
    expect(api.proposals[0].reason).toContain('(part 1)');
    expect(api.proposals[1].reason).toContain('(part 2)');
    expect(log.proposals.map((p) => p.id)).toEqual(['prop_1', 'prop_2']);
  });

  it('logs an entry whose preview could not be answered and still proposes the rest', async () => {
    // A timeout on one preview used to escape the whole run, so every other
    // prefix's proposal and every count went with it, and `docker logs`
    // held one error message and nothing else.
    const lines = ['C        10.50.1.0/24 is directly connected, GigabitEthernet0/1'];
    const api = fakeApi({
      outputs: labDevice(`${ROUTES}\n${lines.join('\n')}`),
      preview: (body) => {
        if ((body as { cidr?: string }).cidr === '10.50.0.0/24') throw new Error('fetch failed: ETIMEDOUT');
        return { wouldSucceed: true } as unknown as PreviewResult;
      },
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.error).toBeUndefined();
    expect(log.prefixes.would_fail).toEqual([
      { cidr: '10.50.0.0/24', reason: 'preview-failed', message: 'fetch failed: ETIMEDOUT' },
    ]);
    expect(log.prefixes.new).toBe(1);
    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0].operations.map((o) => (o.input as { cidr?: string }).cidr)).toEqual(['10.50.1.0/24']);
  });

  it('records a proposal the API would not take, and still emits the run\'s counts', async () => {
    const api = fakeApi({
      propose: () => {
        throw new Error('nxip API returned unexpected status 503');
      },
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.proposals).toEqual([]);
    expect(log.proposals_failed).toEqual([{ operations: 1, message: 'nxip API returned unexpected status 503' }]);
    // The counts survive, which is the whole reason the run log exists.
    expect(log.devices.read).toBe(1);
    expect(log.prefixes.discovered).toBe(1);
    expect(log.prefixes.new).toBe(1);
  });

  it('carries the counts it did collect even when the run failed outright', async () => {
    // A run that read nine devices and then lost the API is worth more in
    // `docker logs` than a bare error with nothing attached to it.
    const api = fakeApi();
    api.deps.listAllSubnets = async () => {
      throw new Error('nxip API returned unexpected status 503');
    };
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.error).toBe('nxip API returned unexpected status 503');
    expect(log.devices.read).toBe(1);
    expect(log.prefixes.discovered).toBe(1);
    expect(log.dropped.hostRoute).toBe(1);
    expect(log.proposals).toEqual([]);
  });

  it('previews a few at a time rather than one after another or all at once', async () => {
    // A first run against a real estate has hundreds of prefixes to ask
    // about; the caller's own API is on the other end of it.
    const lines = Array.from({ length: 30 }, (_, i) => `C        10.50.${i + 1}.0/24 is directly connected, GigabitEthernet0/${i}`);
    let inFlight = 0;
    let peak = 0;
    const api = fakeApi({ outputs: labDevice(`${ROUTES}\n${lines.join('\n')}`) });
    const preview = api.deps.previewSubnet;
    api.deps.previewSubnet = async (clientOptions, body) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return preview(clientOptions, body);
    };
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.prefixes.new).toBe(31);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('never applies: every operation it files is a proposal, and it imports nothing that creates', () => {
    // The dependency surface is the whole of what a run can reach, and it
    // holds no create call. This guards the import list too, so a future
    // change that reaches for createSubnet fails here rather than in
    // somebody's organisation.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent.ts'), 'utf-8');
    expect(source).not.toMatch(/\bcreateSubnet\b/);
    expect(source).not.toMatch(/\bcreatePool\b/);
    expect(source).not.toMatch(/\bapplyManifest\b/);
  });

  it('files one create_subnet for a prefix two source blocks both route', async () => {
    // Two `sources:` blocks, two devices, one prefix routed by both. The
    // prefixes are deduplicated inside each discoverCisco call and nothing
    // looked again across them, so the proposal held the same CIDR twice.
    // The API refuses colliding operations, so the run threw, filed
    // nothing, and did the same again every night after.
    const yaml = `
region: hq
pools: [10.50.0.0/16]
sources:
  - type: cisco
    hosts: [lab1.example]
    user: readonly
    password_env: NXIP_SSH_PASSWORD
  - type: cisco
    hosts: [lab2.example]
    user: readonly
    password_env: NXIP_SSH_PASSWORD
`;
    const api = fakeApi({
      openSession: async (target) =>
        new TranscriptSession(
          target.host === 'lab2.example'
            ? labDevice(`${ROUTES}`.replace('lab1', 'lab2'))
            : labDevice()
        ),
    });
    const log = await runAgentOnce(config(yaml), api.deps, newAgentState());

    expect(log.devices.read).toBe(2);
    expect(log.prefixes.discovered).toBe(1);
    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0].operations).toHaveLength(1);
    expect(api.proposals[0].operations[0].input).toMatchObject({ cidr: '10.50.0.0/24' });
  });

  it('holds back ranges the config excludes before anything else looks at them', async () => {
    const api = fakeApi();
    const log = await runAgentOnce(config(`${CONFIG_YAML}exclude: [10.50.0.0/16]\n`), api.deps, newAgentState());

    expect(log.prefixes.discovered).toBe(0);
    expect(api.proposals).toEqual([]);
  });
});

describe('proposals already waiting for a person', () => {
  const alreadyAsked = (cidr = '10.50.0.0/24') =>
    pendingProposal([
      {
        type: 'create_subnet',
        input: { cidr, family: 'IPV4', environment: 'production', region: 'hq', metadata: { source: 'nxip-agent' } },
      } as unknown as NxipProposalOperation,
    ]);

  it('asks once and not again while nobody has approved it', async () => {
    // A week of nobody approving used to leave seven identical proposals,
    // each of which a person then has to work through one at a time.
    const api = fakeApi({ proposalsPending: [alreadyAsked()] });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toEqual([]);
    expect(api.previews).toEqual([]);
    expect(log.prefixes.awaiting_approval).toBe(1);
    expect(log.prefixes.new).toBe(0);
    expect(log.pending_unread).toBeUndefined();
  });

  it('skips a pool it has already asked for too', async () => {
    const api = fakeApi({
      pools: [],
      proposalsPending: [
        pendingProposal([
          { type: 'create_pool', input: { cidr: '10.50.0.0/16', family: 'IPV4', environment: 'production', region: 'hq', metadata: { source: 'nxip-agent' } } } as unknown as NxipProposalOperation,
        ]),
      ],
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(api.proposals).toEqual([]);
    expect(log.pools.awaiting_approval).toBe(1);
    expect(log.pools.new).toBe(0);
    // And the subnet still waits for that pool rather than being proposed
    // against a pool that does not exist yet.
    expect(log.prefixes.waiting_for_pool).toBe(1);
  });

  it('still asks when the pending proposal belongs to another site or another author', async () => {
    const elsewhere = pendingProposal([
      { type: 'create_subnet', input: { cidr: '10.50.0.0/24', region: 'branch', metadata: { source: 'nxip-agent' } } } as unknown as NxipProposalOperation,
      { type: 'create_subnet', input: { cidr: '10.50.0.0/24', region: 'hq', metadata: { source: 'terraform' } } } as unknown as NxipProposalOperation,
    ]);
    const api = fakeApi({ proposalsPending: [elsewhere] });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.prefixes.awaiting_approval).toBe(0);
    expect(api.proposals).toHaveLength(1);
  });

  it('files as before, and says so, when the pending queue cannot be read', async () => {
    // Fails open on purpose: a key that may not read proposals, or an API
    // briefly down, must not stop a run filing. A duplicate proposal is a
    // nuisance; a discovery nobody hears about is what the agent exists to
    // prevent.
    const api = fakeApi({
      listProposals: async () => {
        throw new Error('nxip API returned unexpected status 403');
      },
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.pending_unread).toBe('nxip API returned unexpected status 403');
    expect(log.error).toBeUndefined();
    expect(api.proposals).toHaveLength(1);
  });

  it('reads every page of the pending queue', async () => {
    const pages = [
      { data: [pendingProposal([{ type: 'create_subnet', input: { cidr: '10.99.0.0/24', region: 'hq', metadata: { source: 'nxip-agent' } } } as unknown as NxipProposalOperation])], meta: { total: 2, page: 1, limit: 100, totalPages: 2 } },
      { data: [alreadyAsked()], meta: { total: 2, page: 2, limit: 100, totalPages: 2 } },
    ];
    const asked: number[] = [];
    const api = fakeApi({
      listProposals: async (_options, query) => {
        asked.push(query?.page ?? 1);
        return pages[(query?.page ?? 1) - 1];
      },
    });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(asked).toEqual([1, 2]);
    // The one on page two is the one that matters, so a single-page read
    // would have filed it again.
    expect(log.prefixes.awaiting_approval).toBe(1);
    expect(api.proposals).toEqual([]);
  });
});

describe('prefixes that stop being routed', () => {
  const stale = () => [
    subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' }),
    subnet('10.99.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' }),
  ];

  it('reports one only after it has been missing for missing_runs runs, and proposes nothing', async () => {
    const api = fakeApi({ subnets: stale() });
    const state = newAgentState();

    const first = await runAgentOnce(config(), api.deps, state);
    const second = await runAgentOnce(config(), api.deps, state);
    const third = await runAgentOnce(config(), api.deps, state);

    expect(first.no_longer_routed).toEqual([]);
    expect(second.no_longer_routed).toEqual([]);
    expect(third.no_longer_routed).toEqual(['10.99.0.0/24']);
    // Never an operation: proposals cannot delete, and reclaim is
    // flag-and-alert by roadmap decision.
    expect(api.proposals).toEqual([]);
  });

  it('honours a different missing_runs', async () => {
    const api = fakeApi({ subnets: stale() });
    const state = newAgentState();
    const once = config(`${CONFIG_YAML}missing_runs: 1\n`);
    expect((await runAgentOnce(once, api.deps, state)).no_longer_routed).toEqual(['10.99.0.0/24']);
  });

  it('resets the count when the prefix comes back', async () => {
    const present = labDevice(`${ROUTES}\nC        10.99.0.0/24 is directly connected, GigabitEthernet0/1`);
    const state = newAgentState();

    const gone = fakeApi({ subnets: stale() });
    await runAgentOnce(config(), gone.deps, state);
    await runAgentOnce(config(), gone.deps, state);

    const back = fakeApi({ subnets: stale(), outputs: present });
    expect((await runAgentOnce(config(), back.deps, state)).no_longer_routed).toEqual([]);

    // And the count really was reset, not merely skipped for that run.
    const goneAgain = fakeApi({ subnets: stale() });
    expect((await runAgentOnce(config(), goneAgain.deps, state)).no_longer_routed).toEqual([]);
  });

  it('never calls a prefix unrouted just because it fell outside the configured pools', async () => {
    // 10.99.0.0/24 is routed and was read off the device; it only missed
    // the manifest because `pools: [10.50.0.0/16]` does not cover it, and
    // the file says so in its own footer. Reporting it as no longer routed
    // would send the operator to hunt for a VLAN that is still up.
    const present = labDevice(`${ROUTES}\nC        10.99.0.0/24 is directly connected, GigabitEthernet0/1`);
    const api = fakeApi({ subnets: stale(), outputs: present });
    const state = newAgentState();
    for (let run = 0; run < 4; run++) {
      expect((await runAgentOnce(config(), api.deps, state)).no_longer_routed).toEqual([]);
    }
  });

  it('never calls a prefix unrouted just because the config excludes its range', async () => {
    // 10.50.0.0/24 is routed and was read off the device; `exclude:` only
    // says never report it, not that it has gone. nxip holds it from an
    // earlier run of this same agent, and reporting it as no longer routed
    // sends the operator to hunt for a VLAN that is still up. Same class as
    // the pool case above.
    const api = fakeApi({ subnets: [subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' })] });
    const excluded = config(`${CONFIG_YAML}exclude: [10.50.0.0/16]\n`);
    const state = newAgentState();
    for (let run = 0; run < 4; run++) {
      const log = await runAgentOnce(excluded, api.deps, state);
      expect(log.prefixes.discovered).toBe(0);
      expect(log.no_longer_routed).toEqual([]);
    }
    expect(api.proposals).toEqual([]);
  });

  it('never calls a prefix unrouted just because its VRF was left for another organisation', async () => {
    // Two VRFs overlap, so only the first is proposed; the rest are named
    // in skipped_vrfs. Their prefixes were still seen.
    const outputs = labDevice(
      `Codes: C - connected

      10.0.0.0/8 is variably subnetted, 1 subnets, 1 masks
C        10.50.0.0/24 is directly connected, GigabitEthernet0/0

Routing Table: CUST-A

      10.0.0.0/8 is variably subnetted, 1 subnets, 1 masks
C        10.50.0.0/24 is directly connected, GigabitEthernet0/1
C        10.51.0.0/24 is directly connected, GigabitEthernet0/2`
    );
    const api = fakeApi({
      outputs,
      subnets: [subnet('10.50.0.0/24', { source: 'nxip-agent' }), subnet('10.51.0.0/24', { source: 'nxip-agent' })],
    });
    const state = newAgentState();
    for (let run = 0; run < 4; run++) {
      const log = await runAgentOnce(config(), api.deps, state);
      expect(log.skipped_vrfs).toEqual(['CUST-A']);
      expect(log.no_longer_routed).toEqual([]);
    }
  });

  it('never judges another site\'s entries, or ones this agent did not record', async () => {
    const api = fakeApi({
      subnets: [
        subnet('10.50.0.0/24', { source: 'nxip-agent', network_id: 'FTX0000TEST' }),
        subnet('10.98.0.0/24', { source: 'nxip-agent' }, { region: 'branch' }),
        subnet('10.97.0.0/24', { source: 'terraform' }),
        subnet('10.96.0.0/24'),
      ],
    });
    const state = newAgentState();
    for (let run = 0; run < 5; run++) {
      const log = await runAgentOnce(config(), api.deps, state);
      expect(log.no_longer_routed).toEqual([]);
    }
  });
});

describe('the schedule', () => {
  it('runs once and returns when no schedule is given', async () => {
    const api = fakeApi();
    const printed: RunLog[] = [];
    const slept: number[] = [];
    await runAgent(config(CONFIG_YAML.replace('schedule: "0 2 * * *"\n', '')), api.deps, {
      print: (log) => printed.push(log),
      sleep: async (ms) => void slept.push(ms),
    });

    expect(printed).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('sleeps until the next scheduled minute and runs again', async () => {
    let clock = new Date('2026-09-29T01:30:00.000Z');
    const api = fakeApi({ now: () => clock });
    const printed: RunLog[] = [];
    const slept: number[] = [];

    await runAgent(config(), api.deps, {
      print: (log) => printed.push(log),
      sleep: async (ms) => {
        slept.push(ms);
        clock = new Date(clock.getTime() + ms);
      },
      stopAfter: 2,
    });

    expect(printed).toHaveLength(2);
    // 01:30 to 02:00 is half an hour; then a whole day to the next 02:00.
    expect(slept).toEqual([30 * 60 * 1000, 24 * 60 * 60 * 1000]);
  });

  it('logs a failed run and keeps the schedule rather than exiting', async () => {
    // A container that exited on the first bad night would need a person to
    // notice before the next run ever happened.
    const api = fakeApi();
    api.deps.listPools = async () => {
      throw new Error('nxip API returned unexpected status 503');
    };
    const printed: RunLog[] = [];
    let clock = new Date('2026-09-29T01:59:00.000Z');

    await runAgent(config(), { ...api.deps, now: () => clock }, {
      print: (log) => printed.push(log),
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      stopAfter: 2,
    });

    expect(printed).toHaveLength(2);
    expect(printed[0].error).toBe('nxip API returned unexpected status 503');
    expect(printed[1].error).toBe('nxip API returned unexpected status 503');
  });
});

describe('overlapping VRFs in scheduled mode', () => {
  it('proposes the first VRF and names the rest in the log rather than colliding', async () => {
    // Two VRFs carrying the same prefix cannot both land in one
    // organisation, so only the first is proposed and the log says which
    // were left for a separate organisation (bet #33).
    const outputs = labDevice(
      `Codes: C - connected

      10.0.0.0/8 is variably subnetted, 1 subnets, 1 masks
C        10.50.0.0/24 is directly connected, GigabitEthernet0/0

Routing Table: CUST-A

      10.0.0.0/8 is variably subnetted, 1 subnets, 1 masks
C        10.50.0.0/24 is directly connected, GigabitEthernet0/1`
    );
    const api = fakeApi({ outputs });
    const log = await runAgentOnce(config(), api.deps, newAgentState());

    expect(log.skipped_vrfs).toEqual(['CUST-A']);
    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0].operations).toHaveLength(1);
  });
});

describe('an unknown host key in scheduled mode', () => {
  let device: FakeDevice | null = null;

  afterEach(async () => {
    await device?.close();
    device = null;
  });

  it('is a hard error for that device, printed with the fingerprint and the line to add', async () => {
    // Scheduled mode never asks, so the operator adds the key to the
    // mounted known_hosts on purpose or the device is not read at all.
    device = await startFakeDevice({ outputs: labDevice() });
    const api = fakeApi();
    // The real transport, not the transcript: this is the host key path.
    api.deps.openSession = undefined;
    api.deps.readKnownHosts = () => [];

    const yaml = CONFIG_YAML.replace('lab1.example', `127.0.0.1:${device.port}`);
    const log = await runAgentOnce(config(yaml), api.deps, newAgentState());

    expect(log.devices.read).toBe(0);
    expect(log.devices.failed).toHaveLength(1);
    expect(log.devices.failed[0].message).toMatch(/host key is not in known_hosts \(ssh-rsa SHA256:/);
    expect(log.devices.failed[0].message).toContain(device.knownHostsLine);
    expect(api.proposals).toEqual([]);
  });

  it('reads the device once the mounted known_hosts trusts its key', async () => {
    device = await startFakeDevice({ outputs: labDevice(), password: 'x' });
    const known = device.knownHosts;
    const api = fakeApi();
    api.deps.openSession = undefined;
    api.deps.readKnownHosts = () => known;

    const yaml = CONFIG_YAML.replace('lab1.example', `127.0.0.1:${device.port}`);
    const log = await runAgentOnce(config(yaml), api.deps, newAgentState());

    expect(log.devices.failed).toEqual([]);
    expect(log.devices.read).toBe(1);
    expect(log.prefixes.new).toBe(1);
    expect(device.commands[0]).toBe('terminal length 0');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
