# nxip-cli

**See what IP space you actually have, before you commit to anything:**

```bash
npx nxip-cli scan aws azure
```

Read-only, no nxip account, no signup. It uses the AWS credentials you
already have, finds every VPC and subnet, and tells you which blocks
collide and how much space is sitting unused. Nothing is written anywhere
and nothing leaves your machine.

```
Found 5 VPCs and 6 subnets.

Overlapping address space: 2 conflicts across 4 VPCs

  10.0.0.0/16 claimed by 2 VPCs
    prod-euw2 (vpc-0aa1)               eu-west-2      10.0.0.0/16
    staging-use1 (vpc-0bb2)            us-east-1      10.0.0.0/16
    65,536 addresses in common at most

  10.20.0.0/16 / 10.20.5.0/24 overlap across 2 VPCs
    data-platform (vpc-0cc3)           eu-west-2      10.20.0.0/16
    legacy-dc-link (vpc-0ee5)          eu-west-2      10.20.5.0/24
    256 addresses in common at most

  These cannot be peered or routed to each other without renumbering one side.

Across everything: 327,936 addresses reserved, 9,216 carved into subnets, 97% never allocated.
```

Overlap that is deliberate, like the `100.64.0.0/10` pod ranges AWS
recommends reusing across EKS clusters, is recognized and set aside rather
than reported. See [below](#overlaps-that-are-supposed-to-be-there).

Overlapping CIDRs are the kind of thing nobody discovers until the day they
try to peer two networks, or acquire a company, and by then the fix is
renumbering production. This finds them in about ten seconds.

**Scan more than one cloud at once and they are analysed as a single
estate.** That matters because no cloud can see another: AWS IPAM has no
idea your Azure hub VNet exists, and Azure has no idea about your VPCs. An
AWS VPC and an Azure VNet both claiming `10.0.0.0/16` is invisible to both
vendors, and visible here.

```
### aws alone:   0 conflicts
### azure alone: 0 conflicts

Overlapping address space: 1 conflict across 2 networks

  10.0.0.0/16 claimed by 2 networks
    azure  vnet-hub (rg-hub/vnet-hub)         uksouth        10.0.0.0/16
    aws    prod-euw2 (vpc-0aa1)               eu-west-2      10.0.0.0/16
```

## The rest of it

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

Or run it without installing:

```bash
npx nxip-cli scan aws
```

`scan` and `scaffold` need no nxip account. `plan` and `apply` need an API
key, free at [nx-ip.com](https://nx-ip.com/signup).

## Scanning a cloud account (`nxip scan`)

```bash
nxip scan aws                          # one cloud
nxip scan aws azure                    # both, analysed as one estate
nxip scan aws --all-regions
nxip scan azure --all-subscriptions
nxip scan aws azure --exclude 192.168.0.0/16
nxip scan aws azure --json             # machine-readable, for piping
```

Provider flags:

| Cloud | Flags | Permissions | Credentials |
|---|---|---|---|
| `aws` | `--region NAME,...`, `--all-regions`, `--profile NAME` | read-only `ec2:DescribeVpcs`, `ec2:DescribeSubnets` | the standard AWS chain: environment, named profile, SSO, instance role |
| `azure` | `--subscription ID,...`, `--all-subscriptions` | read access to `Microsoft.Network/virtualNetworks`, which the built-in **Reader** role covers | `DefaultAzureCredential`: `az login`, environment variables, managed or workload identity |

Both use whatever credentials you already have rather than asking you to
mint something new. With no `--subscription`, Azure enumerates every
enabled subscription the identity can see.

What it reports:

- **Every network and subnet**, with how much of each is actually carved up
- **Overlapping address space** between networks, across regions, accounts,
  subscriptions and clouds, ranked by how much they share. This is the
  finding that matters
- **Unused space**, because a `/16` that is 3% carved is a decision someone
  made once and never revisited

### Turning a scan into a registry (`--emit-manifest`)

```bash
nxip scan aws --all-regions --emit-manifest -o discovered.yaml
nxip plan -f discovered.yaml
```

This writes a manifest using the CIDRs that are *actually deployed*, so
applying it registers your estate as it really is rather than allocating a
parallel set of blocks alongside it. Each entry carries its AWS VPC and
subnet id in metadata, so the link back to the source survives.

Review it before applying. Names come from AWS `Name` tags, which are
frequently duplicated and not always what you would want nxip to call
things, and you need a pool in nxip covering each environment/region/family
before `nxip apply` will succeed.

### Overlaps that are supposed to be there

Plenty of overlap is deliberate. AWS's own EKS guidance recommends carving
pod subnets from `100.64.0.0/10` precisely so they do not consume corporate
RFC1918 space, which means a fleet of clusters is *meant* to reuse the same
block in every VPC. Flagging each of those would bury the handful of real
collisions under hundreds of false ones.

So these ranges are recognized as expected-shared by default, and overlaps
confined to them are counted but not reported as conflicts:

| Range | Why |
|---|---|
| `100.64.0.0/10` | RFC 6598 shared address space, AWS's recommendation for EKS pod subnets |
| `198.19.0.0/16` | RFC 2544 benchmarking range, also used for non-routable secondary CIDRs |
| `169.254.0.0/16` | RFC 3927 link-local, never routable between networks |

RFC1918 is deliberately *not* on that list. Two VPCs both claiming
`10.0.0.0/16` is the exact problem this exists to find.

The suppression is judged on the overlapping region, not the VPC, so a VPC
carrying a `100.64` secondary alongside a routable primary still gets its
routable collisions reported. Nothing is hidden silently either - the report
says how many overlaps it set aside and which range did it:

```
Ignored 300 overlaps in ranges that are expected to be shared:
  100.64.0.0/10      RFC 6598 shared address space, which AWS recommends for EKS pod subnets
  Pass --include-shared to see them, or --exclude to add your own ranges.
```

Add your own conventions with `--exclude 192.168.0.0/16,172.20.0.0/14`, or
turn the whole thing off with `--include-shared`.

### Findings are grouped, not listed pairwise

Twenty VPCs sharing one block is 190 overlapping pairs all saying the same
thing. They are reported as a single conflict listing all twenty, so output
grows with the number of VPCs involved rather than the square of it.
Grouping is transitive: if A contains B and B overlaps C, all three are one
finding even where A and C do not touch.

### Limits worth knowing

IPv6 blocks are listed but not overlap-analysed. Cloud providers allocate
IPv6 from their own globally unique space, so the collision problem that
makes this worth running simply does not arise there in the way it does for
RFC1918 IPv4.

GCP is not supported yet, and it is not simply another module. In GCP only
subnets carry CIDR ranges, the VPC network itself has none and is global
rather than regional, so the per-network analysis here has no equivalent to
measure. It also deliberately permits subnets in different regions of the
same VPC to share a range, which is a second variant of the
expected-overlap problem. Worth doing properly rather than approximating.

The scan reads VPCs and subnets, not what is running inside them. It can
tell you a `/16` is 3% carved; it cannot yet tell you the carved 3% is
itself mostly idle.

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
| `prefix_length` | Exactly one of these two | Size of the block to auto-allocate, letting nxip choose where it lands. |
| `cidr` | Exactly one of these two | Register this exact block instead. What `nxip scan --emit-manifest` emits, so a discovered estate is recorded as it really is rather than reallocated. |
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
