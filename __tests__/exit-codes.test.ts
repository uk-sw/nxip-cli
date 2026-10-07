import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Weft triage item 4b: plan and apply exited 0 when an entry would fail, or
// was skipped because it would, so CI went green on an apply that created
// nothing. These run the real src/index.ts with argv and fetch mocked, the
// way target-line.test.ts does, because the exit code is set in main() and
// nowhere else.

const dir = mkdtempSync(join(tmpdir(), 'nxip-exit-codes-'));

function manifest(name: string, yaml: string): string {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

const entry = (name: string, environment = 'production') =>
  `  - name: ${name}\n    environment: ${environment}\n    region: us-east-1\n    family: IPV4\n    prefix_length: 26\n`;

const GOOD_AND_NO_POOL = manifest('one-fails', `subnets:\n${entry('good')}${entry('no-pool-here', 'nowhere')}`);
const TWO_GOOD = manifest('two-good', `subnets:\n${entry('app-a')}${entry('app-b')}`);
const WITH_POOL = manifest(
  'with-pool',
  `pools:\n  - name: core\n    cidr: 10.240.0.0/16\n    family: IPV4\n    environment: production\n    region: us-east-1\nsubnets:\n${entry('app-a')}`
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const subnet = (name: string, cidr: string) => ({
  id: `sub_${name}`, name, cidr, prefixLength: 26, family: 'IPV4', environment: 'production', region: 'us-east-1',
  ipPoolId: 'pool_1', parentSubnetId: null, kind: null, description: null, metadata: {}, createdAt: '', utilization: { registeredAddresses: 0 },
});

/**
 * One fake API for every case. Preview fails with no-pool for the "nowhere"
 * environment (or everywhere, with noPoolYet) and succeeds otherwise; `existing` is what GET /v1/subnets
 * lists; `pools` what GET /v1/pools lists; `createStatus` is what a create
 * answers.
 */
function stubApi(opts: { existing?: unknown[]; pools?: unknown[]; createStatus?: number; noPoolYet?: boolean } = {}) {
  const creates: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('/v1/organizations/children')) return json({ data: [] });
    if (url.includes('/v1/subnets/preview')) {
      if (body.environment === 'nowhere' || opts.noPoolYet) {
        return json({ wouldSucceed: false, reason: 'no-pool', message: 'No matching IPV4 IP pool found.', httpStatusIfAttempted: 400 });
      }
      return json({
        wouldSucceed: true,
        subnet: { cidr: '10.240.9.0/26', prefixLength: 26, family: 'IPV4', environment: body.environment, region: 'us-east-1' },
        container: { type: 'pool', id: 'pool_1', name: 'core' },
        utilization: { before: {}, after: {} },
      });
    }
    if (url.includes('/v1/subnets') && method === 'GET') {
      const list = opts.existing ?? [];
      return json({ data: list, meta: { total: list.length, page: 1, limit: 100, totalPages: 1 } });
    }
    if (url.includes('/v1/subnets') && method === 'POST') {
      creates.push(body);
      const status = opts.createStatus ?? 201;
      return status === 201 ? json(subnet(body.name, '10.240.9.0/26'), 201) : json({ message: 'CIDR was taken by a concurrent request' }, status);
    }
    if (url.includes('/v1/pools') && method === 'GET') {
      const list = opts.pools ?? [];
      return json({ data: list, meta: { total: list.length, page: 1, limit: 100, totalPages: 1 } });
    }
    if (url.includes('/v1/pools') && method === 'POST') {
      return json({ id: 'pool_new', ...body }, 201);
    }
    throw new Error(`unexpected fetch to ${method} ${url}`);
  }));
  return creates;
}

describe('plan and apply exit codes (weft triage item 4b)', () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function run(args: string[]): Promise<{ exitCode: number; output: string }> {
    process.env.NXIP_API_KEY = 'nxip_live_exitcodetest';
    delete process.env.NXIP_ORGANIZATION;
    process.argv = ['node', 'nxip', ...args];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await import('../src/index.js');
    // main() is not exported; let its awaited fetches settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exitCode = Number(process.exitCode ?? 0);
    return { exitCode, output: logSpy.mock.calls.map((call) => String(call[0])).join('\n') };
  }

  it('plan exits 1 when any entry would fail', async () => {
    stubApi();
    const { exitCode, output } = await run(['plan', '-f', GOOD_AND_NO_POOL]);
    expect(output).toContain('Plan: 1 to create, 0 already exist, 1 would fail.');
    expect(exitCode).toBe(1);
  });

  it('plan exits 0 when everything would be created', async () => {
    stubApi();
    expect((await run(['plan', '-f', TWO_GOOD])).exitCode).toBe(0);
  });

  it('plan exits 0 when everything already exists', async () => {
    stubApi({ existing: [subnet('app-a', '10.240.0.0/26'), subnet('app-b', '10.240.0.64/26')] });
    const { exitCode, output } = await run(['plan', '-f', TWO_GOOD]);
    expect(output).toContain('Plan: 0 to create, 2 already exist, 0 would fail.');
    expect(exitCode).toBe(0);
  });

  // A subnet waiting on a pool this same manifest creates first previews as
  // no-pool, but apply creates the pool and then the subnet: not a failure.
  it('plan exits 0 when a subnet only waits on a pool declared in the manifest', async () => {
    stubApi({ noPoolYet: true });
    const { exitCode, output } = await run(['plan', '-f', WITH_POOL]);
    expect(output).toContain('waiting on a pool declared in this manifest');
    expect(exitCode).toBe(0);
  });

  it('plan exits 1 when another pool already holds the manifest pool\'s key', async () => {
    stubApi({
      noPoolYet: true,
      pools: [{ id: 'pool_9', name: 'other', cidr: '10.9.0.0/16', family: 'IPV4', environment: 'production', region: 'us-east-1' }],
    });
    const { exitCode, output } = await run(['plan', '-f', WITH_POOL]);
    expect(output).toContain('1 blocked.');
    expect(exitCode).toBe(1);
  });

  it('apply exits 1 when an entry is skipped, even though nothing failed', async () => {
    stubApi();
    const { exitCode, output } = await run(['apply', '-f', GOOD_AND_NO_POOL, '--auto-approve']);
    expect(output).toContain('Apply complete: 1 created, 0 already existed, 1 skipped, 0 failed.');
    expect(exitCode).toBe(1);
  });

  it('apply exits 1 when a create fails', async () => {
    stubApi({ createStatus: 409 });
    const { exitCode, output } = await run(['apply', '-f', TWO_GOOD, '--auto-approve']);
    expect(output).toContain('Apply complete: 0 created, 0 already existed, 0 skipped, 2 failed.');
    expect(exitCode).toBe(1);
  });

  it('apply exits 0 on the all-existing second run, and creates nothing', async () => {
    const creates = stubApi({ existing: [subnet('app-a', '10.240.0.0/26'), subnet('app-b', '10.240.0.64/26')] });
    const { exitCode, output } = await run(['apply', '-f', TWO_GOOD, '--auto-approve']);
    expect(output).toContain('Apply complete: 0 created, 2 already existed, 0 skipped, 0 failed.');
    expect(creates).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('apply exits 0 when the manifest pool is already in place on the same CIDR', async () => {
    stubApi({
      pools: [{ id: 'pool_1', name: 'core', cidr: '10.240.0.0/16', family: 'IPV4', environment: 'production', region: 'us-east-1' }],
      existing: [subnet('app-a', '10.240.0.0/26')],
    });
    const { exitCode, output } = await run(['apply', '-f', WITH_POOL, '--auto-approve']);
    expect(output).toContain('= pool core: already exists at 10.240.0.0/16 (id pool_1)');
    expect(exitCode).toBe(0);
  });

  it('apply exits 1 when another pool already holds the manifest pool\'s environment and region', async () => {
    stubApi({
      pools: [{ id: 'pool_9', name: 'other', cidr: '10.9.0.0/16', family: 'IPV4', environment: 'production', region: 'us-east-1' }],
      existing: [subnet('app-a', '10.9.0.0/26')],
    });
    const { exitCode, output } = await run(['apply', '-f', WITH_POOL, '--auto-approve']);
    expect(output).toContain('x pool core: skipped, environment "production" in us-east-1 already belongs to a pool on 10.9.0.0/16');
    expect(exitCode).toBe(1);
  });
});
