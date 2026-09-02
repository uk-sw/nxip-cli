import type { Discovery, DiscoveredNetwork, DiscoveredSubnet } from './scan.js';

export class AzureScanError extends Error {}

/**
 * An Azure resource id is a path, not an opaque token:
 *   /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{name}
 * The full path is unwieldy in a report, so networks are identified by
 * "resourceGroup/name", which is unique within a subscription and is what a
 * person would actually call the thing.
 */
function shortId(resourceId: string | undefined, fallback: string): string {
  if (!resourceId) return fallback;
  const match = /\/resourceGroups\/([^/]+)\//i.exec(resourceId);
  const group = match?.[1];
  const name = resourceId.split('/').pop();
  return group && name ? `${group}/${name}` : (name ?? fallback);
}

/**
 * Reads virtual networks and subnets from Azure. Read-only throughout: it
 * only lists, never writes, and the analysis happens locally.
 *
 * Credentials come from DefaultAzureCredential, which resolves the same way
 * the Azure CLI and SDKs already do - `az login`, environment variables,
 * a managed identity, or a workload identity in CI. Same principle as the
 * AWS scanner: use whatever the caller already has rather than asking them
 * to mint something new for this.
 *
 * The SDK is imported dynamically so the other commands never pay to load
 * it, and so a missing install produces a sentence rather than a module
 * resolution stack trace.
 */
export async function discoverAzure(options: {
  subscriptions?: string[];
  allSubscriptions?: boolean;
}): Promise<Discovery> {
  let NetworkManagementClient: typeof import('@azure/arm-network').NetworkManagementClient;
  let DefaultAzureCredential: typeof import('@azure/identity').DefaultAzureCredential;

  try {
    ({ NetworkManagementClient } = await import('@azure/arm-network'));
    ({ DefaultAzureCredential } = await import('@azure/identity'));
  } catch {
    throw new AzureScanError(
      'The Azure SDK is not installed. Run `npm install @azure/arm-network @azure/identity` alongside nxip-cli, or use `npx nxip-cli` which bundles it.'
    );
  }

  const credential = new DefaultAzureCredential();

  let subscriptionIds = options.subscriptions ?? [];
  if (options.allSubscriptions || subscriptionIds.length === 0) {
    subscriptionIds = await listSubscriptions(credential, subscriptionIds);
  }

  if (subscriptionIds.length === 0) {
    throw new AzureScanError(
      'No Azure subscriptions found. Sign in with `az login`, or pass --subscription <id>.'
    );
  }

  const networks: DiscoveredNetwork[] = [];
  const subnets: DiscoveredSubnet[] = [];
  const regions = new Set<string>();

  for (const subscriptionId of subscriptionIds) {
    const client = new NetworkManagementClient(credential, subscriptionId);

    try {
      // listAll spans every resource group in the subscription, and the
      // SDK's async iterator handles paging, so there is no continuation
      // token to follow by hand as there is on the AWS side.
      for await (const vnet of client.virtualNetworks.listAll()) {
        const networkId = shortId(vnet.id, vnet.name ?? 'unknown');
        const region = vnet.location ?? 'unknown';
        regions.add(region);

        networks.push({
          id: networkId,
          name: vnet.name ?? null,
          region,
          // Unlike GCP, an Azure VNet does carry its own address space, so
          // this maps onto the same shape AWS uses without a redesign.
          cidrs: vnet.addressSpace?.addressPrefixes ?? [],
          account: subscriptionId,
        });

        for (const subnet of vnet.subnets ?? []) {
          // Older API versions set a single addressPrefix; newer ones set
          // addressPrefixes. Both appear in real tenants, so both are read.
          const prefixes = subnet.addressPrefixes ?? (subnet.addressPrefix ? [subnet.addressPrefix] : []);
          for (const prefix of prefixes) {
            subnets.push({
              id: subnet.name ? `${networkId}/${subnet.name}` : shortId(subnet.id, 'unknown'),
              name: subnet.name ?? null,
              networkId,
              region,
              cidr: prefix,
              account: subscriptionId,
            });
          }
        }
      }
    } catch (error) {
      throw new AzureScanError(`subscription ${subscriptionId}: ${describeAzureFailure(error)}`);
    }
  }

  return {
    provider: 'azure',
    account: subscriptionIds.length === 1 ? subscriptionIds[0] : `${subscriptionIds.length} subscriptions`,
    regions: [...regions].sort(),
    networks,
    subnets,
  };
}

async function listSubscriptions(credential: unknown, fallback: string[]): Promise<string[]> {
  try {
    const { SubscriptionClient } = await import('@azure/arm-resources-subscriptions');
    // The credential type is structural here; the SDK only needs getToken.
    const client = new SubscriptionClient(credential as never);
    const ids: string[] = [];
    for await (const subscription of client.subscriptions.list()) {
      if (subscription.subscriptionId && subscription.state === 'Enabled') {
        ids.push(subscription.subscriptionId);
      }
    }
    return ids.length > 0 ? ids : fallback;
  } catch {
    // Listing subscriptions needs a tenant-level permission that a
    // narrowly-scoped principal may not have. Falling back keeps an
    // explicitly-passed --subscription working in that case.
    return fallback;
  }
}

/** Turns SDK errors into something a person can act on. */
function describeAzureFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${name} ${message}`;

  if (/CredentialUnavailable|DefaultAzureCredential|no credential|AuthenticationRequired/i.test(combined)) {
    return 'No Azure credentials found. Sign in with `az login`, or set AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET.';
  }
  if (/AuthorizationFailed|does not have authorization|Forbidden/i.test(combined)) {
    return 'Access denied. This command needs read access to Microsoft.Network/virtualNetworks, which the built-in Reader role covers.';
  }
  if (/ExpiredAuthenticationToken|InvalidAuthenticationToken/i.test(combined)) {
    return 'Azure rejected the credentials. They may have expired - try `az login` again.';
  }
  if (/SubscriptionNotFound/i.test(combined)) {
    return 'Subscription not found, or this identity cannot see it.';
  }
  return message;
}
