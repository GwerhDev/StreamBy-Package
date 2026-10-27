import crypto from 'crypto';
import { ApiTokenScope, OAuthResourceConfig } from '../types';
import { ApiTokenPermission } from './apiTokenPermissions';

// ── OAuth access tokens ──
// An app the user signed in to with their account (e.g. claude.ai's connector) comes with an
// OAuth access token: a JWT the authorization server signed (RS256) for one resource (its
// audience, RFC 8707). It's checked with the server's published keys alone (JWKS): no secret
// is shared. What it may do is what the user approved -- its scopes -- as permissions of the
// API tokens' kind, so the same checks limit it; and, as a user's token, never more than the
// user can (their role in each project still applies).

export const OAUTH_SCOPES = ['streamby:read', 'streamby:write'] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];

const READ_PERMISSIONS: ApiTokenPermission[] = [
  'project:read', 'members:read', 'assets:read', 'production:read', 'workflow:read',
  'exports:read', 'rights:read', 'jobs:read',
];
// Making and changing, as the consent screen says: never deleting, nor managing members.
const WRITE_PERMISSIONS: ApiTokenPermission[] = [
  'project:update', 'assets:write', 'production:write', 'workflow:write', 'exports:write',
  'rights:write', 'jobs:run', 'projects:create',
];

/** The permissions each scope grants. */
export const OAUTH_SCOPE_PERMISSIONS: Record<OAuthScope, ApiTokenPermission[]> = {
  'streamby:read': READ_PERMISSIONS,
  'streamby:write': [...READ_PERMISSIONS, ...WRITE_PERMISSIONS],
};

/** What a token's scopes let it do (scopes that aren't StreamBy's grant nothing here). */
export const permissionsForOAuthScopes = (scopes: string[]): ApiTokenPermission[] =>
  [...new Set(scopes.flatMap(scope => OAUTH_SCOPE_PERMISSIONS[scope as OAuthScope] ?? []))];

export interface Jwk { kty: string; kid?: string; n?: string; e?: string; alg?: string; use?: string }
export interface Jwks { keys: Jwk[] }

export interface OAuthTokenVerifierOptions {
  // The authorization server's issuer: a token from any other is refused.
  issuer: string;
  // What a token may be for: its audience must be one of these (StreamBy's resources).
  audiences: string[];
  // The server's public keys: its JWKS URL, or a function giving them (a host that is the
  // authorization server itself needs no request).
  jwks: string | (() => Promise<Jwks>);
  // How long fetched keys are kept (default 5 minutes). An unknown key id fetches them again,
  // at most once a minute.
  jwksCacheMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

export interface VerifiedOAuthToken {
  // The user (the token's subject).
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: Date;
  // What it reaches, for the host's authProvider to return as Auth.apiToken: a user's scope,
  // with the permissions of its scopes, on every project the user is a member of.
  scope: ApiTokenScope;
}

const SKEW_SECONDS = 60;
const REFETCH_MIN_MS = 60 * 1000;

const decodePart = (part: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Whether a bearer is shaped as an OAuth access token (a JWT signed with RS256), not whether
 * it's valid: for an authProvider to tell it from its own session tokens.
 */
export const looksLikeOAuthAccessToken = (token: unknown): token is string => {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && decodePart(parts[0])?.alg === 'RS256';
};

/** The grant an OAuth request counts as (its rate limit's key): one app, for one user. */
export const oauthGrantId = (clientId: string, userId: string) => `oauth:${clientId}:${userId}`;

/**
 * Checks OAuth access tokens: their signature with the issuer's keys, the issuer, that they're
 * for StreamBy (their audience), and that they haven't expired. The verified token, or null.
 * It doesn't know whether the user has since revoked the app: the host may check that too.
 */
export function createOAuthTokenVerifier(options: OAuthTokenVerifierOptions) {
  const now = () => (options.now ? options.now() : Date.now());
  const cacheMs = options.jwksCacheMs ?? 5 * 60 * 1000;
  const fetcher = options.fetcher ?? fetch;
  let keys = new Map<string, crypto.KeyObject>();
  let fetchedAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const loadKeys = async (): Promise<void> => {
    const jwks = typeof options.jwks === 'function'
      ? await options.jwks()
      : await fetcher(options.jwks, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) })
        .then(res => (res.ok ? res.json() as Promise<Jwks> : Promise.reject(new Error(`JWKS answered ${res.status}`))));
    const next = new Map<string, crypto.KeyObject>();
    for (const jwk of jwks?.keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
      try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' })); } catch { /* not a usable key */ }
    }
    keys = next;
    fetchedAt = now();
  };

  const refresh = async (): Promise<void> => {
    inFlight ??= loadKeys().catch(err => {
      fetchedAt = now(); // don't hammer a failing JWKS
      console.error('❌ StreamBy OAuth: could not load the issuer\'s keys:', err instanceof Error ? err.message : err);
    }).finally(() => { inFlight = null; });
    await inFlight;
  };

  const keyFor = async (kid: string): Promise<crypto.KeyObject | undefined> => {
    if (now() - fetchedAt > cacheMs) await refresh();
    if (!keys.has(kid) && now() - fetchedAt > REFETCH_MIN_MS) await refresh();
    return keys.get(kid);
  };

  return async function verify(token: unknown): Promise<VerifiedOAuthToken | null> {
    if (!looksLikeOAuthAccessToken(token)) return null;
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    const header = decodePart(headerPart);
    const claims = decodePart(payloadPart);
    if (!header || !claims || typeof header.kid !== 'string') return null;

    const key = await keyFor(header.kid);
    if (!key) return null;
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, 'base64url'));
    if (!signed) return null;

    const seconds = Math.floor(now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== options.issuer) return null;
    if (!audiences.some(aud => typeof aud === 'string' && options.audiences.includes(aud))) return null;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS <= seconds) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > seconds) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.client_id !== 'string' || !claims.client_id) return null;

    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    return {
      userId: claims.sub,
      clientId: claims.client_id,
      scopes,
      expiresAt: new Date(claims.exp * 1000),
      scope: {
        tokenId: oauthGrantId(claims.client_id, claims.sub),
        kind: 'user',
        permissions: permissionsForOAuthScopes(scopes),
        projectIds: '*',
      },
    };
  };
}

// ── The protected resource's metadata (RFC 9728) ──

/** Where RFC 9728 puts a resource's metadata: at its origin, before its path. */
export const defaultResourceMetadataUrl = (resource: string): string => {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
};

export const resourceMetadataUrlOf = (oauth: OAuthResourceConfig): string =>
  oauth.resourceMetadataUrl ?? defaultResourceMetadataUrl(oauth.resource);

/** The metadata a client reads to know where to sign in, and what to ask for. */
export const protectedResourceMetadata = (oauth: OAuthResourceConfig) => ({
  resource: oauth.resource,
  authorization_servers: [oauth.issuer],
  scopes_supported: [...OAUTH_SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: oauth.resourceName ?? 'StreamBy',
});

/** The WWW-Authenticate challenge of a 401: the metadata's URL, and why the token was refused. */
export const wwwAuthenticate = (oauth: OAuthResourceConfig, invalidToken: boolean): string =>
  `Bearer resource_metadata="${resourceMetadataUrlOf(oauth)}"${invalidToken ? ', error="invalid_token"' : ''}`;
