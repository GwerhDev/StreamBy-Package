import { ServiceProviderType } from '../types';

// Where a service integration's credential may be sent: its own provider's API, over https.
// A node chooses the endpoint it calls, and anyone who can edit the node could otherwise point
// it at a server of their own and receive the credential of whoever connected the integration.
const PROVIDER_HOSTS: Record<ServiceProviderType, (host: string) => boolean> = {
  claude: (host) => host === 'api.anthropic.com',
  jira: (host) => host === 'api.atlassian.com' || host.endsWith('.atlassian.net'),
  google: (host) => host === 'googleapis.com' || host.endsWith('.googleapis.com'),
};

export function isServiceEndpoint(provider: ServiceProviderType, endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string') return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const allowed = PROVIDER_HOSTS[provider];
  return !!allowed && allowed(url.hostname.toLowerCase());
}
