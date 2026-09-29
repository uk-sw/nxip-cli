import { describe, expect, it } from 'vitest';
import { AgentConfigError, loadAgentConfig, type ConfigEnvironment } from '../src/agent.js';

/**
 * agent.yaml. The rule the spec states and this file enforces: no secret is
 * ever a plain value in the file, only the name of an environment variable
 * or the path of a mounted one. A missing variable names itself, because
 * "no password" on its own sends the operator to the wrong place.
 */

function environment(env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}): ConfigEnvironment {
  return {
    env,
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return Buffer.from(contents);
    },
  };
}

const MINIMAL = `
sources:
  - type: cisco
    hosts: [core1.example]
    user: readonly
    password_env: NXIP_SSH_PASSWORD
`;

describe('secrets are never in the file', () => {
  it('refuses a plain password and says where to put it instead', () => {
    const yaml = `
sources:
  - type: cisco
    hosts: [core1.example]
    user: readonly
    password: hunter2
`;
    expect(() => loadAgentConfig(yaml, environment())).toThrow(AgentConfigError);
    expect(() => loadAgentConfig(yaml, environment())).toThrow(/"sources.0.password" holds a secret as a plain value/);
    expect(() => loadAgentConfig(yaml, environment())).toThrow(/password_env: NXIP_SSH_PASSWORD/);
  });

  it('refuses any key that reads as a secret, wherever it is nested', () => {
    for (const key of ['password', 'secret', 'token', 'api_key', 'passphrase', 'private_key']) {
      const yaml = `${key}: something\nsources:\n  - type: cisco\n    hosts: [c1]\n    user: u\n    password_env: P\n`;
      expect(() => loadAgentConfig(yaml, environment({ P: 'x' }))).toThrow(new RegExp(`"${key}" holds a secret`));
    }
  });

  it('refuses a numeric secret too, which YAML would otherwise hand through unquoted', () => {
    const yaml = `${MINIMAL}\ntoken: 12345\n`;
    expect(() => loadAgentConfig(yaml, environment({ NXIP_SSH_PASSWORD: 'x' }))).toThrow(/"token" holds a secret/);
  });

  it('allows password_env and key_file, which name a secret without holding one', () => {
    const config = loadAgentConfig(
      `
sources:
  - type: cisco
    hosts: [core1.example]
    user: readonly
    key_file: /agent/id_ed25519
`,
      environment({}, { '/agent/id_ed25519': 'PRIVATE KEY BYTES' })
    );
    expect(config.sources[0].privateKey?.toString()).toBe('PRIVATE KEY BYTES');
    // A key alone is a complete credential, so no password is demanded.
    expect(config.sources[0].password).toBeUndefined();
  });
});

describe('environment variables', () => {
  it('names the missing variable rather than saying "no password"', () => {
    expect(() => loadAgentConfig(MINIMAL, environment())).toThrow(AgentConfigError);
    expect(() => loadAgentConfig(MINIMAL, environment())).toThrow(
      /sources\.0: environment variable NXIP_SSH_PASSWORD \(password_env\) is not set\. Pass it with -e NXIP_SSH_PASSWORD to docker run\./
    );
  });

  it('names the variable the config chose, not the default', () => {
    const yaml = MINIMAL.replace('NXIP_SSH_PASSWORD', 'CORE_PASSWORD');
    expect(() => loadAgentConfig(yaml, environment())).toThrow(/environment variable CORE_PASSWORD \(password_env\) is not set/);
  });

  it('falls back to NXIP_SSH_PASSWORD when password_env is not given', () => {
    const yaml = `
sources:
  - type: cisco
    hosts: [core1.example]
    user: readonly
`;
    expect(() => loadAgentConfig(yaml, environment())).toThrow(/environment variable NXIP_SSH_PASSWORD/);
    expect(loadAgentConfig(yaml, environment({ NXIP_SSH_PASSWORD: 'from-env' })).sources[0].password).toBe('from-env');
  });

  it('reads the user from user_env, and names it when unset', () => {
    const yaml = `
sources:
  - type: cisco
    hosts: [core1.example]
    user_env: CORE_USER
    password_env: P
`;
    expect(() => loadAgentConfig(yaml, environment({ P: 'x' }))).toThrow(/no SSH user.*CORE_USER \(user_env\)/s);
    expect(loadAgentConfig(yaml, environment({ P: 'x', CORE_USER: 'readonly' })).sources[0].username).toBe('readonly');
  });

  it('names NXIP_SSH_USER when neither user nor user_env is given', () => {
    const yaml = `
sources:
  - type: cisco
    hosts: [core1.example]
    password_env: P
`;
    expect(() => loadAgentConfig(yaml, environment({ P: 'x' }))).toThrow(/environment variable NXIP_SSH_USER \(user_env\)/);
  });

  it('says which key_file it could not read', () => {
    const yaml = `
sources:
  - type: cisco
    hosts: [core1.example]
    user: readonly
    key_file: /agent/missing
`;
    expect(() => loadAgentConfig(yaml, environment())).toThrow(/could not read key_file \/agent\/missing/);
  });
});

describe('the rest of the config', () => {
  const env = environment({ NXIP_SSH_PASSWORD: 'x' });

  it('applies the documented defaults', () => {
    const config = loadAgentConfig(MINIMAL, env);
    expect(config.environment).toBe('production');
    expect(config.site).toBe('on-prem');
    expect(config.schedule).toBeNull();
    expect(config.missingRuns).toBe(3);
    expect(config.sources[0].knownHostsPath).toBe('/agent/known_hosts');
    expect(config.sources[0].staticOnly).toBe(false);
    expect(config.sources[0].includePublic).toBe(false);
  });

  it('reads the whole documented file', () => {
    const config = loadAgentConfig(
      `
schedule: "0 2 * * *"
organization: org_abc123
environment: staging
region: hq
pools: [10.0.0.0/14]
sources:
  - type: cisco
    hosts: [core1.example, "core2.example:2222"]
    user: readonly
    password_env: NXIP_SSH_PASSWORD
    known_hosts: /agent/known_hosts
    vrfs: [default, CUST-A]
    static_only: true
    include_public: true
exclude: [192.168.0.0/16]
`,
      env
    );

    expect(config.schedule?.source).toBe('0 2 * * *');
    expect(config.organization).toBe('org_abc123');
    expect(config.environment).toBe('staging');
    expect(config.site).toBe('hq');
    expect(config.pools).toEqual(['10.0.0.0/14']);
    expect(config.exclude.map((r) => r.cidr)).toEqual(['192.168.0.0/16']);
    expect(config.sources[0]).toMatchObject({
      hosts: ['core1.example', 'core2.example:2222'],
      username: 'readonly',
      password: 'x',
      vrfs: ['default', 'CUST-A'],
      staticOnly: true,
      includePublic: true,
    });
  });

  it('refuses a misspelled key rather than ignoring it', () => {
    // A silently ignored `static-only:` would look like the flag is on and
    // the run would quietly include every learned route.
    expect(() => loadAgentConfig(`${MINIMAL}\nstatic-only: true\n`, env)).toThrow(AgentConfigError);
    expect(() =>
      loadAgentConfig(
        `
sources:
  - type: cisco
    hosts: [c1]
    user: u
    password_env: NXIP_SSH_PASSWORD
    staticonly: true
`,
        env
      )
    ).toThrow(AgentConfigError);
  });

  it('refuses a config with no sources, and one with a source that names no host', () => {
    expect(() => loadAgentConfig('environment: production\n', env)).toThrow(/Invalid agent.yaml/);
    expect(() => loadAgentConfig('sources: [{type: cisco, hosts: [], user: u, password_env: NXIP_SSH_PASSWORD}]\n', env)).toThrow(
      /Invalid agent.yaml/
    );
  });

  it('refuses a schedule that is not a five-field cron expression', () => {
    expect(() => loadAgentConfig(`schedule: "0 2 * *"\n${MINIMAL}`, env)).toThrow(/Invalid schedule/);
    expect(() => loadAgentConfig(`schedule: "0 99 * * *"\n${MINIMAL}`, env)).toThrow(/Invalid schedule/);
  });

  it('refuses an exclude range that is not a CIDR', () => {
    expect(() => loadAgentConfig(`${MINIMAL}\nexclude: [not-a-cidr]\n`, env)).toThrow(/Invalid exclude/);
  });

  it('refuses YAML it cannot parse at all', () => {
    expect(() => loadAgentConfig('sources: [', env)).toThrow(/Could not parse agent.yaml/);
  });
});
