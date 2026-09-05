import type { Discovery, DiscoveredNetwork, DiscoveredSubnet } from './scan.js';

export class AwsScanError extends Error {}

function nameTag(tags: { Key?: string; Value?: string }[] | undefined): string | null {
  return tags?.find((tag) => tag.Key === 'Name')?.Value ?? null;
}

/**
 * Reads VPCs and subnets from AWS. Strictly read-only: DescribeVpcs,
 * DescribeSubnets, DescribeRegions, and a caller-identity lookup so the
 * report can say which account it looked at. Nothing is written anywhere,
 * and nothing leaves the machine - the analysis all happens locally.
 *
 * Credentials come from the standard AWS chain (environment, shared config
 * profile, SSO, instance role), so this works with whatever the caller
 * already uses for the AWS CLI.
 *
 * The SDK is imported dynamically so `nxip plan`/`apply`/`scaffold` never
 * pay to load it, and so a missing install produces a sentence a person can
 * act on rather than a module-resolution stack trace.
 */
export async function discoverAws(options: {
  regions?: string[];
  allRegions?: boolean;
  profile?: string;
}): Promise<Discovery> {
  let EC2Client: typeof import('@aws-sdk/client-ec2').EC2Client;
  let DescribeVpcsCommand: typeof import('@aws-sdk/client-ec2').DescribeVpcsCommand;
  let DescribeSubnetsCommand: typeof import('@aws-sdk/client-ec2').DescribeSubnetsCommand;
  let DescribeRegionsCommand: typeof import('@aws-sdk/client-ec2').DescribeRegionsCommand;

  try {
    const sdk = await import('@aws-sdk/client-ec2');
    ({ EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeRegionsCommand } = sdk);
  } catch {
    throw new AwsScanError(
      'The AWS SDK is not installed. Run `npm install @aws-sdk/client-ec2` alongside nxip-cli, or use `npx nxip-cli` which bundles it.'
    );
  }

  if (options.profile) {
    // Set before the first client is constructed - the SDK reads this when
    // it resolves the credential chain, not on every call.
    process.env.AWS_PROFILE = options.profile;
  }

  const seedRegion = options.regions?.[0] ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

  // Every region by default, which matches Azure's default of every
  // subscription. Scanning one region by default made the tool answer "no
  // overlapping address space found" after looking at a fraction of an
  // estate: a false clean on the single question it exists to answer, and
  // cross-region collisions are invisible by construction.
  //
  // --all-regions is now the default rather than a flag. It is still
  // accepted, so existing scripts and docs keep working.
  let regions = options.regions ?? [];
  if (regions.length === 0) {
    const client = new EC2Client({ region: seedRegion });
    try {
      const response = await client.send(new DescribeRegionsCommand({}));
      regions = (response.Regions ?? []).map((r) => r.RegionName).filter((r): r is string => Boolean(r)).sort();
    } catch (error) {
      // Missing or rejected credentials are not a permissions problem, and
      // narrowing to one region only reaches the same failure a step later
      // while advising a fix (grant ec2:DescribeRegions) that would not have
      // helped. Say the one true thing instead.
      if (isCredentialsFailure(error)) {
        throw new AwsScanError(describeAwsFailure(error));
      }
      // Enumerating needs ec2:DescribeRegions, which a tightly-scoped
      // identity predating this change may not have. Falling back to one
      // region beats failing outright, but it is said out loud rather than
      // silently narrowing the scan and reporting a clean result.
      console.error(`Could not list regions (${describeAwsFailure(error)}).`);
      console.error(`Scanning ${seedRegion} only. Grant ec2:DescribeRegions, or pass --region a,b,c.`);
      regions = [seedRegion];
    }
  }

  const networks: DiscoveredNetwork[] = [];
  const subnets: DiscoveredSubnet[] = [];

  for (const region of regions) {
    const client = new EC2Client({ region });

    try {
      // Both endpoints paginate; NextToken is followed rather than assuming
      // one page, since an estate large enough to have an overlap problem is
      // exactly the kind large enough to paginate.
      let vpcToken: string | undefined;
      do {
        const response = await client.send(new DescribeVpcsCommand({ NextToken: vpcToken }));
        for (const vpc of response.Vpcs ?? []) {
          if (!vpc.VpcId) continue;
          const cidrs = (vpc.CidrBlockAssociationSet ?? [])
            .filter((a) => a.CidrBlockState?.State === 'associated')
            .map((a) => a.CidrBlock)
            .filter((c): c is string => Boolean(c));
          networks.push({
            id: vpc.VpcId,
            name: nameTag(vpc.Tags),
            region,
            cidrs: cidrs.length > 0 ? cidrs : vpc.CidrBlock ? [vpc.CidrBlock] : [],
            isDefault: vpc.IsDefault ?? false,
          });
        }
        vpcToken = response.NextToken;
      } while (vpcToken);

      let subnetToken: string | undefined;
      do {
        const response = await client.send(new DescribeSubnetsCommand({ NextToken: subnetToken }));
        for (const subnet of response.Subnets ?? []) {
          if (!subnet.SubnetId || !subnet.VpcId || !subnet.CidrBlock) continue;
          subnets.push({
            id: subnet.SubnetId,
            name: nameTag(subnet.Tags),
            networkId: subnet.VpcId,
            region,
            cidr: subnet.CidrBlock,
            availabilityZone: subnet.AvailabilityZone ?? null,
          });
        }
        subnetToken = response.NextToken;
      } while (subnetToken);
    } catch (error) {
      throw new AwsScanError(`${region}: ${describeAwsFailure(error)}`);
    }
  }

  return { provider: 'aws', account: await resolveAccountId(seedRegion), regions, networks, subnets };
}

/**
 * Best-effort. The scan is still useful without knowing the account id, so
 * a failure here degrades to null rather than aborting - and it means the
 * command works even for a caller whose policy allows ec2:Describe* but not
 * sts:GetCallerIdentity.
 */
async function resolveAccountId(region: string): Promise<string | null> {
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const client = new STSClient({ region });
    const identity = await client.send(new GetCallerIdentityCommand({}));
    return identity.Account ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the identity itself is the problem (absent, expired or rejected),
 * as opposed to a valid identity lacking one permission. The two want
 * opposite responses: stop, versus carry on with less.
 */
function isCredentialsFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return /CredentialsProviderError|Could not load credentials|AuthFailure|ExpiredToken|InvalidClientTokenId/i.test(
    name + message
  );
}

/** Turns SDK errors into something a person can act on. */
function describeAwsFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (/CredentialsProviderError|Could not load credentials/i.test(name + message)) {
    return 'No AWS credentials found. Configure them the same way you would for the AWS CLI (AWS_PROFILE, environment variables, or `aws sso login`).';
  }
  if (/UnauthorizedOperation|AccessDenied/i.test(name + message)) {
    return 'Access denied. This command needs read-only ec2:DescribeVpcs and ec2:DescribeSubnets.';
  }
  if (/AuthFailure|ExpiredToken|InvalidClientTokenId/i.test(name + message)) {
    return 'AWS rejected the credentials. They may have expired - try `aws sso login` or refresh your session.';
  }
  return message;
}
