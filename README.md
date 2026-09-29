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

`scan` and `scaffold` need no nxip account. `plan`, `apply`, `mcp` and `agent`
need an API key, free at [nx-ip.com](https://nx-ip.com/signup).

For on-premises networks there is a container, `ghcr.io/uk-sw/nxip-agent`,
which is this CLI with Cisco devices as a source. See
[Discovering Cisco networks](#discovering-cisco-networks-nxip-scan-cisco-and-the-nxip-agent-container).

## Scanning a cloud account (`nxip scan`)

**Scope:** every AWS region and every Azure subscription the identity can
see, by default. Narrow with `--region` or `--subscription`. Scanning a
fraction of an estate and reporting "no overlapping address space found"
would be a false clean on the one question this answers, so the default is
everything.

**What it compares against:** the networks it discovers, against each other.
Nothing else. It reads your cloud provider APIs, does the overlap analysis
entirely on your machine, and exits. It never contacts nxip, needs no nxip
account, and carries no telemetry.

If you want to compare against what your nxip organization already holds,
that is a different command: `nxip plan -f <manifest.yaml>`.

```bash
nxip scan aws                          # one cloud
nxip scan aws azure                    # both, analysed as one estate
nxip scan aws --region eu-west-2,us-east-1   # narrow it; the default is every region
nxip scan azure --subscription <id>          # the default is every subscription
nxip scan aws azure --exclude 192.168.0.0/16
nxip scan aws azure --redact           # safe to share
nxip scan aws azure --json             # machine-readable, for piping
nxip scan aws azure --fail-on-overlap  # exit 1 on a real conflict, for CI
```

### Using it as a CI check (`--fail-on-overlap`)

By default `scan` always exits 0: finding an overlap is a result, not a
failure, and defaulting otherwise would break anyone piping the output.

Pass `--fail-on-overlap` to exit 1 when a genuine conflict is found. It is
keyed on real conflicts only, so deliberately shared ranges (`100.64.0.0/10`
for EKS pods, link-local, and anything you add with `--exclude`) never fail
a build. A fleet of Kubernetes clusters sharing pod CIDRs by design stays
green.

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
nxip scan aws --emit-manifest -o aws-discovered.yaml
nxip plan -f aws-discovered.yaml

# -o takes any path. Naming it after the estate keeps a two-cloud scan
# from overwriting itself:
nxip scan azure --emit-manifest -o azure-discovered.yaml
```

**A VPC or VNet is a subnet, not a pool.** A pool is the block you carve
address space out of; a cloud network is itself carved out of that. So the
manifest declares no pools, and models the hierarchy you actually have:

| In your estate | In nxip |
|---|---|
| Your address plan, say `10.0.0.0/8` | A **pool**. You create this, once. |
| A VPC or VNet, say `10.20.0.0/16` | A **subnet** in that pool, tagged structurally |
| A subnet inside it, say `10.20.1.0/24` | A **child subnet** of that network |

Only you know what your real address plan is, so a scan will not invent one.
Create the pool covering that environment, region and family first, and if
none exists `nxip plan` will say so rather than creating anything.

Children reference their network by name, not by id, because nothing in the
file exists yet. `apply` creates each network first and substitutes its real
id into the subnets beneath it.

This writes a manifest using the CIDRs that are *actually deployed*, so
applying it registers your estate as it really is rather than allocating a
parallel set of blocks alongside it. Each entry carries its source network
and subnet id in metadata, so the link back to the real resource survives.

**It emits the pools too, and `apply` creates them before the subnets**, so
a discovered estate loads in one step rather than needing pools built by
hand first.

The interesting constraint is that nxip allows one pool per
environment/region/family, and real accounts routinely put several networks
in one region. So where a region holds exactly one network the environment
defaults to `production`; where it holds several, the environment is derived
from each network's own name to keep them distinct. Both are guesses a scan
cannot verify, and the file says so at the top.

Review it before applying. Names come from cloud `Name` tags, which are
frequently duplicated and not always what you would want nxip to call
things, and only you know which network is really staging.

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

### Default VPCs are left alone

AWS creates a default VPC in every region of every account, and it is
`172.31.0.0/16` in all of them. Enable 17 regions and you have 17 identical
networks nobody deployed, producing 136 pairwise overlaps between them. On an
untouched account that is the whole report, and a real finding is buried
under it.

Default networks are therefore set aside: not compared, not counted as
conflicts, and not written into the manifest. As with shared ranges, nothing
happens silently:

```
No overlapping VPC address space found.

Ignored 4 cloud-provisioned default networks (use --include-default-networks to analyse them).
```

**This is keyed on the provider's `isDefault` flag, never on the CIDR.**
`172.31.0.0/16` is not a blocklisted range. A VPC you deliberately built at
`172.31.0.0/16` is address space you own, so it is analysed like any other
network, reported if it collides, and imported by name. Deleting the default
VPC and building your own in its place is a normal thing to have done, and it
is exactly what a CIDR-based rule would get wrong.

`--include-default-networks` analyses them anyway. Worth running once: a
default VPC that has been peered, or has had subnets built in it, has stopped
being boilerplate and belongs in your plan.

They always appear in the inventory, marked `[default]`, whether or not they
are being analysed. Only the conflict analysis skips them.

Azure has no equivalent, since it does not create VNets for you. Every VNet a
scan finds there is one somebody made, and all of them are analysed.

### Sharing a report safely (`--redact`)

A scan report names your accounts, subscriptions, VPCs and VNets. None of
that is secret, but together it is an inventory of your estate, and the most
useful thing to do with a finding is usually to show someone.

`--redact` replaces every identifier with a stable pseudonym:

```
nxip scan  AWS + AZURE   [redacted]
  aws    aws-account-1  1 region: eu-west-2
  azure  azure-account-1  1 region: uksouth
  Identifiers replaced with stable pseudonyms. Address space, regions
  and every finding are unchanged.

Overlapping address space: 1 conflict across 2 networks

  10.0.0.0/16 claimed by 2 networks
    aws    network-1                          eu-west-2      10.0.0.0/16
    azure  network-2                          uksouth        10.0.0.0/16
```

**How it works.** Not a regex pass over the output, and not a library. It is
a transform over the discovery data before any analysis runs, so the fields
it touches are known rather than guessed. Scrubbing rendered text would mean
pattern-matching what an identifier looks like, which both over-matches (a
twelve-digit number might be an address count) and under-matches (a VPC named
after a customer looks like nothing in particular).

**Pseudonyms are stable, not blanked.** Replacing everything with `REDACTED`
would destroy the only thing worth sharing, since a conflict is the claim
that *these two* networks collide. `network-1` and `network-2` keep that
readable.

**What is deliberately kept**: CIDRs, regions, families and every count.
Without the address space there is no finding left to show, and private
ranges are weakly identifying at best - a great many organizations use
`10.0.0.0/16`, whereas an account id identifies exactly one. If your networks
carry publicly routable ranges that reasoning does not hold, so read before
you post.

Combining `--redact` with `--emit-manifest` is allowed but rarely what you
want: the manifest records network and subnet ids as provenance, and
pseudonymising them severs the link back to the real resources. The CLI says
so when you do it.

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

## Discovering Cisco networks (`nxip scan cisco` and the nxip-agent container)

The cloud scan reads what a cloud API says. On premises the equivalent is
the routing table: a subnet that is not routed is not a subnet, so the
routing and interface tables of the routers are close to the whole address
plan, including the static-only VLANs, transit links, management networks
and per-VRF space that DHCP or a port scan would never show.

`scan cisco` signs in to the devices you name over SSH with a read-only
login, runs `show` commands, and produces the same report, collision
findings and manifest as `scan aws`. It composes with the cloud sources in
one run, so `scan cisco aws` reports a 10.1.20.0/24 that exists both on a
core switch and in a VPC as one collision.

### What nxip never does

> nxip reads what your network already knows. It signs in to named
> devices with a read-only credential you create, scope and revoke, and
> reads their tables: routes, interfaces, VRFs, ARP. It never probes an
> endpoint. No ping sweeps, no port scans, no traffic to any address it
> has not been given a credential for.

Concretely: the agent opens SSH sessions to the hosts in its config and
runs `show` commands. It never enters `configure`, never needs `enable`,
sends nothing to any other address, and talks to nxip outbound on 443
only. Device credentials stay in the container's environment or a mounted
file and are never sent to nxip.

### The read-only user to create

IOS and IOS-XE, privilege level 1, which is the default:

```
username readonly privilege 1 secret <password>
```

NX-OS, the built-in `network-operator` role:

```
username readonly password <password> role network-operator
```

Every command the source runs works at that level on a default
configuration: `show version`, `show vrf`, `show ip interface`,
`show ipv6 interface`, `show ip route vrf *` (or `show ip route` plus one
per VRF where `vrf *` is not supported), `show ipv6 route`, and
`show ip arp`, with `| json` variants on NX-OS. A refused command is
reported and the device continues with what it returned.

### One shot, the first five minutes

```bash
docker run --rm -it \
  -e NXIP_SSH_USER=readonly -e NXIP_SSH_PASSWORD \
  -v ~/.ssh/known_hosts:/agent/known_hosts:ro \
  -v "$PWD":/out \
  ghcr.io/uk-sw/nxip-agent scan cisco --host core1.example --host core2.example --emit-manifest -o /out/estate.yaml
```

Or from the CLI directly: `npx nxip-cli scan cisco --host core1.example`.
Needs no nxip account. An unknown host key is asked about, as `ssh` does;
the line to add to `known_hosts` is printed and nothing is written to the
file.

What the manifest holds:

- **Pools**, one per RFC 1918 range touched, the smallest block covering
  everything discovered inside it. This is a guess, said so in the file;
  `--pool 10.0.0.0/14` (or `pools:` in the config) replaces it.
- **Subnets**, one per distinct prefix across every device:
  - a connected prefix on a VLAN interface or sub-interface is
    `kind: vlan` with `interface`, `vlan_id` and `gateway` in metadata;
  - a connected prefix on any other interface is `kind: interface`;
  - any connected /30 or /31 is `kind: transit`;
  - a static route is `kind: route` with `next_hop`;
  - a route learned from OSPF, EIGRP, BGP, IS-IS or RIP is `kind: route`
    with `protocol`; `--static-only` drops these;
  - every entry carries `source: nxip-agent`, `network_id` (the device
    serial), `device`, `vrf` and `route_type`, and `landing_point: false`.
- A prefix seen on several devices is one subnet, attributed to the device
  where it is connected, the others listed in `seen_on`.
- Dropped and counted: the default route, /32 and /128 host routes,
  summary and null routes, link-local, and public prefixes unless
  `--include-public`.
- A prefix inside a broader discovered prefix (a /24 VLAN inside a /16
  static summary) nests under it with `parent:`, because nxip refuses
  overlapping siblings and a routing table nests by nature.
- Two VRFs with overlapping space produce one manifest per VRF
  (`estate-default.yaml`, `estate-CUST-A.yaml`) and a note: nxip refuses
  overlap inside one organisation, so each goes to its own.
- ARP entries are counted per subnet in the report and the `--json`
  output. The manifest has no address section, so nothing is written.

### Scheduled: the container files proposals, a person approves

```bash
docker run -d --name nxip-agent --restart unless-stopped \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  -v ./known_hosts:/agent/known_hosts:ro \
  -e NXIP_API_KEY -e NXIP_SSH_PASSWORD \
  ghcr.io/uk-sw/nxip-agent agent --config /agent/agent.yaml
```

```yaml
# agent.yaml
schedule: "0 2 * * *"          # cron, UTC; omit to run once and exit
organization: org_...          # optional, for a provider acting in a customer
environment: production        # default
region: hq                     # the site; default on-prem
pools: [10.0.0.0/14]           # optional; otherwise guessed and commented
sources:
  - type: cisco
    hosts: [core1.example, core2.example:2222]
    user: readonly              # or user_env: NXIP_SSH_USER
    password_env: NXIP_SSH_PASSWORD
    key_file: /agent/id_ed25519 # alternative to a password
    known_hosts: /agent/known_hosts
    vrfs: [default, CUST-A]     # optional filter
    static_only: false
    include_public: false
exclude: [192.168.0.0/16]      # ranges never reported, as scan --exclude
missing_runs: 3                # runs a prefix is missing before it is logged
```

Rules: no secret is ever a plain value in the file, only an environment
variable name or a mounted path, and the agent refuses a config that
tries. An unknown host key is a hard error in scheduled mode, logged with
the fingerprint and the `known_hosts` line to add, so you add it on
purpose.

Each run compares what it discovered with what the organisation already
holds (`GET /v1/pools` and `GET /v1/subnets`, matched on CIDR and on
`metadata.network_id`):

- a new pool or subnet becomes a change proposal (`POST /v1/proposals`)
  holding every `create_pool` and `create_subnet`, titled with the site
  and the date, for a person to approve in the dashboard. A proposal-only
  key is enough and is the recommended key for the agent;
- a prefix already in nxip produces nothing;
- a prefix nxip holds with `source: nxip-agent` that has not been seen
  for `missing_runs` runs is logged as no longer routed, and nothing is
  proposed, because proposals cannot delete;
- nothing new produces no proposal and one log line.

Two details of the API shape the proposals. A proposal is previewed
against the organisation as it is, so a subnet cannot be proposed in a
pool the same proposal creates: on a first run the pools are proposed,
and the subnets follow on the next run once the pools are approved, logged
as `waiting_for_pool`. And a proposal holds at most 20 operations, so a
large estate is filed as several proposals in one run, each listed in the
log.

The run log is stdout, one JSON object per run with counts, so
`docker logs nxip-agent` is the whole observability story. The agent
never prompts, never applies, and exits non-zero only on a config error.

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

### Managing a customer organization (`--organization`)

If your nxip organization is a provider managing customers (see
[Customer organizations](https://nx-ip.com/docs/customer-organizations)),
`plan`, `apply`, `tree` and `mcp` all take `--organization <id>`, or the
`NXIP_ORGANIZATION` environment variable, to act on a customer instead of
your own organization. A flag always wins over the environment variable.

```bash
nxip plan -f subnets.yaml --organization org_abc123
# or
export NXIP_ORGANIZATION=org_abc123
nxip plan -f subnets.yaml
```

**Leaving it unset means your own organization**, exactly as before this
flag existed. Nothing changes for anyone without customers.

`plan` and `apply` print which organization they are targeting as the first
line of output, so a manifest never lands somewhere unintended:

```
Target: customer organization org_abc123
```

If you manage customers and forget to set it, they say so instead of
silently acting on your own organization:

```
Target: your own organization. Pass --organization to manage a customer.
```

For `mcp`, the organization is fixed for the life of the server process,
not something a tool argument can change, so an agent talking to it cannot
switch customers on its own. The same target line is printed to stderr,
alongside the server's usual startup diagnostic:

```json
{
  "mcpServers": {
    "nxip-acme": {
      "command": "npx",
      "args": ["-y", "nxip-cli", "mcp", "--organization", "org_abc123"],
      "env": {
        "NXIP_API_KEY": "<your key>"
      }
    }
  }
}
```

## Seeing the whole plan (`nxip tree`)

`nxip tree` prints every pool with its subnets nested beneath it, in address
order, the way `tree` prints a directory. Add `--free` to see what is still
unallocated at each level:

```bash
npx nxip-cli tree --free
```

```
Production US-East  10.109.0.0/16  production / us-east-1  6% used
├── 10.109.0.0/20  us-east-1 region block [region]
│   ├── 10.109.0.0/24  Payments team
│   │   ├── 10.109.0.0/27   Payments AZ-b [az-subnet]
│   │   ├── 10.109.0.32/27  Payments AZ-a [az-subnet]
│   │   └── free 10.109.0.64/26, 10.109.0.128/25
│   └── free 10.109.1.0/24, 10.109.2.0/23, 10.109.4.0/22, 10.109.8.0/21
└── free 10.109.16.0/20, 10.109.32.0/19, 10.109.64.0/18, 10.109.128.0/17
```

Each line is a CIDR, its name and `[kind]`; a pool line adds its
environment, region and how much of it is allocated. Free space is listed as
the fewest aligned blocks that cover it, so each one is a CIDR you could
actually allocate. A `free` line shows at most 8 blocks, then `+N more`.

| Flag | What it does |
|---|---|
| `--pool <id or name>` | One pool only. A name must match exactly; if two pools share it, the command stops and lists their ids |
| `--depth <n>` | Levels of subnets to show under each pool. `0` is pools only |
| `--free` | Adds a `free` line under every level that has subnets |
| `--json` | The same tree as nested JSON, with every free block rather than the first 8 |
| `--organization <id>` | A customer organization's tree, as on `plan` and `apply` |

It reads every page of pools and subnets before drawing anything, since a
tree missing a subnet would show that subnet's space as free. Colour and a
small usage bar appear only on a terminal: piped output, and any run with
`NO_COLOR` set, is plain text. With `--json`, the `Target:` line goes to
stderr so stdout stays valid JSON.

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

## Letting an AI agent use nxip (`nxip mcp`)

`nxip mcp` is an [MCP](https://modelcontextprotocol.io) server over stdio.
It lets Claude Desktop, Claude Code, Cursor or any other MCP client read your
organization's address space through nxip and, if the key allows it, allocate
from it.

The key is a secret: never commit a file containing a real one.

**Claude Desktop** (`claude_desktop_config.json`, which lives in your user
profile rather than in any repository):

```json
{
  "mcpServers": {
    "nxip": {
      "command": "npx",
      "args": ["-y", "nxip-cli", "mcp"],
      "env": {
        "NXIP_API_KEY": "<your key>"
      }
    }
  }
}
```

**Claude Code, for yourself** (local scope, stored outside the repository):

```bash
claude mcp add nxip -e NXIP_API_KEY=<your key> -- npx -y nxip-cli mcp
```

**Claude Code, shared with a project** (`.mcp.json`, which is meant to be
committed). Claude Code expands `${VAR}` from the environment, so the file
names the variable and each person keeps their own key in their shell:

```json
{
  "mcpServers": {
    "nxip": {
      "command": "npx",
      "args": ["-y", "nxip-cli", "mcp"],
      "env": {
        "NXIP_API_KEY": "${NXIP_API_KEY}"
      }
    }
  }
}
```

**Cursor** takes the same block as Claude Desktop. Put it in `~/.cursor/mcp.json`
(your user profile). If you use a project's `.cursor/mcp.json` instead, keep
that file out of version control while it holds a real key.

`NXIP_URL` is optional and defaults to `https://nxip.dev`. Without
`NXIP_API_KEY` the server exits at startup and says so on stderr, which is
where MCP clients show a server's log.

### The tools

| Tool | What it does | Calls |
|---|---|---|
| `list_pools` | Pools, one page at a time, with utilization | `GET /v1/pools` |
| `get_pool` | One pool by id | `GET /v1/pools/:id` |
| `forecast_pools` | When each pool runs out, from real allocation history | `GET /v1/pools/forecast` |
| `list_subnets` | Subnets, filterable by environment, region and family | `GET /v1/subnets` |
| `get_subnet` | One subnet by id | `GET /v1/subnets/:id` |
| `list_addresses` | Addresses registered in a subnet | `GET /v1/subnets/:id/addresses` |
| `lookup_ip` | What owns an IP: address, subnet or pool | `GET /v1/lookup` |
| `search` | Free text across names, CIDRs, hostnames and metadata | `GET /v1/search` |
| `get_usage` | Tier and usage against each limit | `GET /v1/organizations/usage` |
| `preview_subnet` | What `create_subnet` would do, without doing it | `POST /v1/subnets/preview` |
| `create_pool` | Create a pool | `POST /v1/pools` |
| `create_subnet` | Allocate a subnet | `POST /v1/subnets` |
| `allocate_address` | Register a specific address in a subnet | `POST /v1/subnets/:id/addresses` |
| `propose_changes` | Propose pools, subnets or addresses for a person to approve | `POST /v1/proposals` |
| `get_proposal` | One proposal, with its status and decision | `GET /v1/proposals/:id` |
| `list_proposals` | Proposals, filterable by status | `GET /v1/proposals` |

There are no update or delete tools. The three proposal tools are how an
agent asks for a change without making it: see "Proposal-only keys" below.

### Why an agent can be trusted to allocate

The agent cannot invent a CIDR, it can only ask nxip for one. Every tool is a
thin call to one existing API endpoint, so a write from an agent goes through
exactly the same checks as a write from Terraform: overlap refusal, tier
limits, the key's role, and the audit log. The server checks none of these
itself, because a second copy of the rules would drift from the real ones.
When nxip refuses, the agent gets nxip's own message back as a tool error,
and the conversation carries on.

So the agent has exactly the permissions of the key you give it:

- A **READ_ONLY** key can use every read tool and `preview_subnet`. The three
  create tools are refused by the API with a 403.
- An **ADMIN** or **MEMBER** key can also create pools, subnets and addresses.
- A **proposal-only** key (a MEMBER or ADMIN key created with "Proposal
  only" ticked) can read everything and propose changes, and nothing else.

The key is never included in anything the server returns or logs.

### Proposal-only keys: the agent proposes, a person approves

Create the key in the dashboard under Settings, API keys, with **Proposal
only** ticked. Give that key to the agent. The server then registers the ten
read tools plus `propose_changes`, `get_proposal` and `list_proposals`, and
does not register `create_pool`, `create_subnet` or `allocate_address` at all,
so the agent never plans around a write it cannot make.

`propose_changes` takes the same operations `create_pool`, `create_subnet` and
`allocate_address` would, pins the container each one resolves to, and returns
a proposal id and the page where a person decides:
`https://app.nx-ip.com/proposals`. Approval applies the pinned operations
under the approver's own role, and the audit log records both the proposal
and the decision. Rejection applies nothing. If the world moved between the
proposal and the approval (the space was taken, a pool was resized), the
approval fails on that operation and says so rather than applying something
different from what was proposed.

A proposal made while acting for a customer (`NXIP_ORGANIZATION`) lives in
that customer, so the approver switches to that customer first; the returned
page link says so.

### `--read-only`

```json
"args": ["-y", "nxip-cli", "mcp", "--read-only"]
```

Registers only the ten read tools, whatever the key's role allows. The write
tools and the proposal tools are not listed at all, so the agent never plans
around them, and a call to one by name is refused. Use it when you want an agent to answer
questions about your address space with a key that could otherwise write,
though a READ_ONLY key is the stronger guarantee, since that one is enforced
by the API.

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
| `landing_point` | No | Whether ordinary requests for the same environment, region and family are placed inside this subnet. Omitted, a kind-tagged top-level subnet defaults to `true`; `scan cisco` writes `false` on every entry so a discovered prefix never becomes a placement target. |
| `description` | No | Free text. |
| `metadata` | No | String key/value pairs, capped at 20 keys / 128-char keys / 256-char values, same limit the API itself enforces. |

## Known limitations

- **Pools are proposed, not decided.** A scan cannot tell which network is
  staging, so `environment` is always a guess you should review. If a
  proposed environment/region/family key is already held by a different pool,
  `nxip plan` says so explicitly and tells you to rename it.
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

## Credentials

**AWS.** The credential chain is the standard one, so anything you already use
works. In order of preference: **IAM Identity Center or an assumed role**
(`aws sso login`, then `AWS_PROFILE=...`), because nothing long-lived is
stored and the credentials expire on their own; **an IAM role** in CI, also
keyless; **a named profile** holding an access key, which at least keeps the
secret in a permission-restricted file rather than in every child process's
environment; and **environment variables** last, if you have no AWS CLI
installed, since that is a bearer secret with no MFA sitting in your shell.

The whole read-only policy, including what `--all-regions` needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRegions"],
    "Resource": "*"
  }]
}
```

