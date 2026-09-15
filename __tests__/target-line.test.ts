import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Done means 14 and 15a (docs/specs/msp-tenancy-phase2.md Part C): plan and
// apply print a "Target: ..." line as the first thing they print, and it
// must never block the command even when the best-effort check behind it
// fails. Run the same way mcp-lazy-load.test.ts does - importing the real
// src/index.ts with argv and fetch mocked - rather than spawning a
// subprocess, since these are pure "what did console.log see, in what
// order" questions and the manifest is a real file on disk either way.

const manifestDir = mkdtempSync(join(tmpdir(), 'nxip-target-line-'));
const manifestPath = join(manifestDir, 'subnets.yaml');
writeFileSync(
  manifestPath,
  'subnets:\n  - name: payments\n    environment: production\n    region: us-east-1\n    family: IPV4\n    prefix_length: 24\n',
  'utf-8'
);

const CHILDREN_URL = '/v1/organizations/children';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch mock covering every call plan/apply make against a one-subnet,
 * no-pools manifest: the organizations/children check (resolveTargetLine),
 * POST /v1/subnets/preview (planManifest), GET /v1/pools (listPoolsQuietly
 * in plan, or the existing-pools read inside apply). `childrenBehavior`
 * controls only the first of these, which is what these tests vary.
 */
function stubFetch(childrenBehavior: 'has-customers' | 'no-customers' | 'fails') {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(CHILDREN_URL)) {
      if (childrenBehavior === 'fails') return jsonResponse({ message: 'Forbidden' }, 403);
      return jsonResponse({ data: childrenBehavior === 'has-customers' ? [{ id: 'org_child' }] : [] });
    }
    if (url.includes('/v1/subnets/preview')) {
      return jsonResponse({
        wouldSucceed: true,
        subnet: { cidr: '10.0.0.0/24', prefixLength: 24, family: 'IPV4', environment: 'production', region: 'us-east-1' },
        container: { type: 'pool', id: 'pool_1', name: 'prod', cidr: '10.0.0.0/16' },
        utilization: { before: {}, after: {} },
      });
    }
    if (url.includes('/v1/pools')) {
      return jsonResponse({ data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 1 } });
    }
    if (url.includes('/v1/subnets')) {
      return jsonResponse({ id: 'sub_1', cidr: '10.0.0.0/24' }, 201);
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('plan and apply print a Target line first (Done means 14, 15a)', () => {
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

  async function runIndex(args: string[]): Promise<string[]> {
    process.argv = ['node', 'nxip', ...args];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/index.js');
    // main() is not exported and not awaited by the caller; give its
    // promise chain (several awaited fetches) time to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return logSpy.mock.calls.map((call) => String(call[0]));
  }

  it('plan prints "Target: customer organization <id>" first when --organization is set', async () => {
    stubFetch('no-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['plan', '-f', manifestPath, '--organization', 'org_customer']);
    expect(lines[0]).toBe('Target: customer organization org_customer');
  });

  it('plan uses NXIP_ORGANIZATION when --organization is not given', async () => {
    stubFetch('no-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    process.env.NXIP_ORGANIZATION = 'org_from_env';
    const lines = await runIndex(['plan', '-f', manifestPath]);
    expect(lines[0]).toBe('Target: customer organization org_from_env');
  });

  it('--organization flag wins over NXIP_ORGANIZATION', async () => {
    stubFetch('no-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    process.env.NXIP_ORGANIZATION = 'org_from_env';
    const lines = await runIndex(['plan', '-f', manifestPath, '--organization', 'org_from_flag']);
    expect(lines[0]).toBe('Target: customer organization org_from_flag');
  });

  it('plan prints "Target: your own organization..." when unset and the key\'s org has customers', async () => {
    stubFetch('has-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['plan', '-f', manifestPath]);
    expect(lines[0]).toBe('Target: your own organization. Pass --organization to manage a customer.');
  });

  it('plan prints nothing extra when unset and there are no customers', async () => {
    stubFetch('no-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['plan', '-f', manifestPath]);
    expect(lines.some((l) => l.startsWith('Target:'))).toBe(false);
  });

  it('a failed check prints nothing extra and never blocks the plan', async () => {
    stubFetch('fails');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['plan', '-f', manifestPath]);
    expect(lines.some((l) => l.startsWith('Target:'))).toBe(false);
    // The plan itself still ran and produced its usual output.
    expect(lines.join('\n')).toMatch(/Plan:/);
  });

  it('apply prints the Target line first, before the auto-approved apply output', async () => {
    stubFetch('no-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['apply', '-f', manifestPath, '--organization', 'org_customer', '--auto-approve']);
    expect(lines[0]).toBe('Target: customer organization org_customer');
    expect(lines.join('\n')).toMatch(/Apply complete/);
  });

  it('apply with an unset organization and a customer-having org prints the same line as plan', async () => {
    stubFetch('has-customers');
    process.env.NXIP_API_KEY = 'nxip_live_targetlinetest';
    delete process.env.NXIP_ORGANIZATION;
    const lines = await runIndex(['apply', '-f', manifestPath, '--auto-approve']);
    expect(lines[0]).toBe('Target: your own organization. Pass --organization to manage a customer.');
  });
});
