import { Auth, StreamByConfig } from '../types';

// How long a signed storage URL works. A request made with an API token (an agent, the MCP
// server) gets short-lived ones; a browser session, the adapter's own (an hour to upload, a
// day to read).
export const DEFAULT_TOKEN_SIGNED_URL_TTL = { upload: 15 * 60, download: 5 * 60 };

export const signedUrlTtl = (auth: Auth | undefined, config: StreamByConfig, kind: 'upload' | 'download'): number | undefined =>
  auth?.apiToken ? config.mcp?.signedUrlTtl?.[kind] ?? DEFAULT_TOKEN_SIGNED_URL_TTL[kind] : undefined;
