# nxip-cli

Declare nxip subnets in YAML, `plan` and `apply` them, the same mental
model Terraform gives you, without needing Terraform. Built for teams who
will never adopt HCL: on-prem network teams, teams standardized on
Ansible or plain scripting, anyone who wants nxip's reconciliation
loop (does the registry match what I've declared, right now) without
adopting an entirely new toolchain to get it.

No new backend capability here: `nxip plan` calls `POST /v1/subnets/preview`,
the same dry-run endpoint the [Terraform PR bot](https://github.com/uk-sw/nxip-terraform-plan-action)
already uses, and `nxip apply` calls the real create endpoint for anything
the plan predicted would succeed. This is a YAML parser and a CLI shell
around primitives that already work.

## Install

```bash
npm install -g nxip-cli
```

Or run without installing:

```bash
npx nxip-cli plan -f subnets.yaml
```

## Usage

```bash
export NXIP_API_KEY="<your key>"   # or pass --api-key
nxip plan -f subnets.yaml
nxip apply -f subnets.yaml
```

`subnets.yaml`:

```yaml
subnets:
  - name: payments
    environment: production
    region: us-east-1
    family: IPV4
    prefix_length: 24
    metadata:
      owner: platform-team
```

`nxip plan` output, real, against a live nxip organization:

```
  # payments will be created
  + environment   = "production"
    region        = "us-east-1"
    family        = "IPV4"
    prefix_length = 24
    cidr          = "10.100.1.0/28" (predicted, not reserved)
    container     = subnet "us-east-1 region block" (6.25% -> 6.64%)

Plan: 1 to create, 0 would fail.
```

`nxip apply` shows the same plan, asks for confirmation (`yes`, same as
Terraform), then creates whatever the plan predicted would succeed. Pass
`--auto-approve` to skip the prompt, e.g. in CI.

## Scaffolding a new site (`nxip scaffold`)

For standing up a new site or landing zone across multiple clouds at
once, rather than declaring subnets one at a time. `nxip scaffold` expands
a higher-level site spec into a normal `nxip plan`/`apply` manifest, no
new nxip capability, this is a generator over the same
`nxip_subnet`-carving primitive, extended from one workload's subnet
shape to an entire new site's full addressing plan.

`site.yaml`:

```yaml
site: emea-fra-01
environments: [production, staging]
clouds:
  - provider: aws
    region: eu-central-1
  - provider: azure
    region: germanywestcentral
sizing:
  production: 24
  staging: 26
```

```bash
nxip scaffold -f site.yaml -o subnets.yaml
nxip plan -f subnets.yaml
```

Expands into one subnet per (environment x cloud) pair, four subnets for
the example above, each routed to `{provider}-{region}` as its nxip
`region`, guaranteed non-overlapping against every other allocation in the
organization, not just within one cloud, the same wedge as
[`terraform-nxip-modules`](https://github.com/uk-sw/terraform-nxip-modules)'
Kubernetes CIDR authority modules, applied to a whole site instead of one
cluster. Cloud-first for now: a pool must already exist for each
(environment, region) combination this produces, on-prem sites are a
later extension once a discovery agent or CSV import exists to seed them.

## Field reference

YAML fields deliberately match `nxip_subnet`'s Terraform attribute names
(`prefix_length`, `parent_subnet_id`), so anything already familiar from
the Terraform provider carries over directly:

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | The manifest's own label - not sent to the API, used only for CLI output. |
| `family` | Yes | `IPV4` or `IPV6`. |
| `environment` / `region` | One of these, or `parent_subnet_id` | Routes to a matching pool by auto-resolution. |
| `parent_subnet_id` | One of these, or `environment`/`region` | Nest under an already-existing subnet by real ID, bypassing auto-resolution. |
| `prefix_length` | No | Size of the block to auto-allocate. |
| `kind` | No | Tags this subnet as a structural landing point for later auto-resolution. |
| `description` | No | Free text. |
| `metadata` | No | String key/value pairs, capped at 20 keys / 128-char keys / 256-char values, same limit the API itself enforces. |

## Known limitations

- **Top-level subnets only.** A subnet referencing another subnet declared
  later in the *same* manifest isn't resolved - `parent_subnet_id` must be
  a real, already-existing ID. Nesting a manifest's own subnets under each
  other is real, harder scope (the same dependency-resolution problem the
  Terraform PR bot's plan parser solves for `after_unknown` values), not
  yet built here.
- **A prediction is not reserved.** Nothing is locked between `plan` and
  `apply`, or between two concurrent runs of either - a concurrent apply
  against the same pool or subnet can land differently than what was
  previewed. `apply` reports this per-subnet if it happens, rather than
  aborting the whole run.
- **Pools aren't managed here.** This tool assumes the pool your subnets
  route into already exists (create it once via the GUI, curl, or
  Terraform). Scope may grow to cover pools later; v1 is deliberately
  subnets-only.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
