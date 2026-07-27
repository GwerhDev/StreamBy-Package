import crypto from 'crypto';
import { getModel } from '../models/manager';
import { IntegrationKind, ServiceProviderType, StreamByConfig, UserIntegration } from '../types';
import { encrypt, decrypt, isEncryptionKeySet } from '../utils/encryption';
import { refreshTokens } from './oauthClient';

const OAUTH_SERVICE_PROVIDERS = new Set<string>(['jira', 'google']);
export function isOAuthServiceProvider(provider: string): boolean {
  return OAUTH_SERVICE_PROVIDERS.has(provider);
}

// Refresh if the token expires within this window — a small buffer against clock skew and
// request latency so a caller never receives a token that expires mid-flight.
const REFRESH_SKEW_MS = 60_000;

export class OAuthRefreshError extends Error {
  constructor(public provider: string, public integrationId: string, message: string) {
    super(message);
    this.name = 'OAuthRefreshError';
  }
}

// Thrown when a client tries to set/overwrite the credential of an OAuth-backed (jira/
// google) integration directly — those can only be linked/relinked via the OAuth flow.
export class InvalidCredentialUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCredentialUpdateError';
  }
}

function encryptCredential(kind: IntegrationKind, value: unknown): string {
  return kind === 'storage' ? encrypt(JSON.stringify(value)) : encrypt(String(value));
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// OAuth tokens never go through encryptCredential/decryptIntegration (those stay unchanged,
// used only for database/storage/claude's single encryptedCredential field) — each token is
// encrypted independently via the existing single-string encrypt()/decrypt() primitives.
function encryptOAuthTokens(tokens: OAuthTokenSet): Pick<UserIntegration, 'encryptedAccessToken' | 'encryptedRefreshToken' | 'tokenExpiresAt'> {
  return {
    encryptedAccessToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: encrypt(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  };
}

function decryptOAuthTokens(integration: UserIntegration): OAuthTokenSet | null {
  if (!integration.encryptedAccessToken || !integration.encryptedRefreshToken || !integration.tokenExpiresAt) return null;
  return {
    accessToken: decrypt(integration.encryptedAccessToken),
    refreshToken: decrypt(integration.encryptedRefreshToken),
    expiresAt: integration.tokenExpiresAt,
  };
}

export async function listUserIntegrations(userId: string): Promise<UserIntegration[]> {
  const UserIntegrationModel = getModel('user_integrations');
  return UserIntegrationModel.find({ userId });
}

export async function createUserIntegration(
  userId: string,
  input: { kind: IntegrationKind; provider: string; name: string; description?: string; credentialValue: unknown },
): Promise<UserIntegration> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot create integration.');
  }
  // Defense in depth — the router rejects direct jira/google creation before this is ever
  // called (see userIntegration.ts route's POST handler), but guard here too rather than
  // silently mis-encrypting an OAuth provider's value into the wrong (single-string) field.
  if (isOAuthServiceProvider(input.provider)) {
    throw new InvalidCredentialUpdateError(`Provider '${input.provider}' requires OAuth — cannot be created with a direct credential.`);
  }

  const UserIntegrationModel = getModel('user_integrations');
  const now = new Date();
  const integration: UserIntegration = {
    id: crypto.randomUUID(),
    userId,
    kind: input.kind,
    provider: input.provider as UserIntegration['provider'],
    name: input.name,
    description: input.description,
    encryptedCredential: encryptCredential(input.kind, input.credentialValue),
    createdAt: now,
    updatedAt: now,
  };

  return UserIntegrationModel.create(integration);
}

// Creates or updates the OAuth-backed UserIntegration for (userId, provider) — called only
// from the OAuth callback (oauth.ts), never from the generic CRUD router. Upserts rather
// than always inserting, so a user re-consenting (e.g. after revoking access on the
// provider's side) re-links the same integration instead of creating a duplicate.
export async function upsertOAuthServiceIntegration(
  userId: string,
  provider: Extract<ServiceProviderType, 'jira' | 'google'>,
  name: string,
  tokens: OAuthTokenSet,
): Promise<UserIntegration> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot store integration tokens.');
  }

  const UserIntegrationModel = getModel('user_integrations');
  const existing = await UserIntegrationModel.findOne({ userId, kind: 'service', provider }) as UserIntegration | null;
  const encryptedTokens = encryptOAuthTokens(tokens);
  const now = new Date();

  if (existing) {
    const updated = await UserIntegrationModel.update({ id: existing.id, userId }, { ...encryptedTokens, updatedAt: now });
    return updated ?? existing;
  }

  const integration: UserIntegration = {
    id: crypto.randomUUID(),
    userId,
    kind: 'service',
    provider,
    name,
    ...encryptedTokens,
    createdAt: now,
    updatedAt: now,
  };
  return UserIntegrationModel.create(integration);
}

export async function updateUserIntegration(
  userId: string,
  integrationId: string,
  updates: { name?: string; description?: string; credentialValue?: unknown },
): Promise<UserIntegration | null> {
  const UserIntegrationModel = getModel('user_integrations');
  const existing = await UserIntegrationModel.findOne({ id: integrationId, userId }) as UserIntegration | null;
  if (!existing) return null;

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) $set.name = updates.name;
  if (updates.description !== undefined) $set.description = updates.description;
  if (updates.credentialValue !== undefined) {
    if (existing.kind === 'service' && isOAuthServiceProvider(existing.provider)) {
      throw new InvalidCredentialUpdateError('OAuth-backed integrations cannot have their credential set directly — reconnect via OAuth.');
    }
    if (!isEncryptionKeySet()) {
      throw new Error('Encryption key is not set. Cannot update integration.');
    }
    $set.encryptedCredential = encryptCredential(existing.kind, updates.credentialValue);
  }

  return UserIntegrationModel.update({ id: integrationId, userId }, $set);
}

export async function deleteUserIntegration(userId: string, integrationId: string): Promise<boolean> {
  const UserIntegrationModel = getModel('user_integrations');
  const deletedCount = await UserIntegrationModel.delete({ id: integrationId, userId });
  return deletedCount > 0;
}

export interface ResolvedCredential {
  provider: string;
  kind: IntegrationKind;
  credential: unknown; // plain string for db/storage/claude; a plain ACCESS TOKEN string for
                        // jira/google too — the refreshToken never leaves this module.
}

export async function getDecryptedIntegrationCredential(userId: string, integrationId: string, config: StreamByConfig): Promise<ResolvedCredential | null> {
  const UserIntegrationModel = getModel('user_integrations');
  const integration = await UserIntegrationModel.findOne({ id: integrationId, userId }) as UserIntegration | null;
  return resolveCredential(integration, config);
}

// Used when resolving a project connection's `integrationId` at connection-use time — the
// project already validated ownership when the connection was created (see project.ts /
// dbConnection.ts POST), so there's no userId to filter by here, only the integrationId
// stored on the connection itself. `config` is required (not just for OAuth's sake) so a
// near-expiry jira/google token can be refreshed using the host-injected client
// credentials in config.oauthProviders.
export async function getDecryptedIntegrationCredentialById(integrationId: string, config: StreamByConfig): Promise<ResolvedCredential | null> {
  const UserIntegrationModel = getModel('user_integrations');
  const integration = await UserIntegrationModel.findOne({ id: integrationId }) as UserIntegration | null;
  return resolveCredential(integration, config);
}

async function decryptIntegration(integration: UserIntegration): Promise<unknown> {
  if (!isEncryptionKeySet()) {
    throw new Error('Encryption key is not set. Cannot decrypt integration credential.');
  }
  const decrypted = decrypt(integration.encryptedCredential!);
  return integration.kind === 'storage' ? JSON.parse(decrypted) : decrypted;
}

// OAuth-backed integrations (jira/google) transparently refresh-and-repersist their access
// token when it's expired or near-expiry, before returning it — callers never see a stale
// token or have to think about refresh themselves.
async function resolveCredential(integration: UserIntegration | null, config: StreamByConfig): Promise<ResolvedCredential | null> {
  if (!integration) return null;

  if (integration.kind === 'service' && isOAuthServiceProvider(integration.provider)) {
    const tokens = decryptOAuthTokens(integration);
    if (!tokens) {
      throw new OAuthRefreshError(integration.provider, integration.id, `The ${integration.provider} connection for this integration is incomplete — reconnect it from account integrations.`);
    }

    if (tokens.expiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
      return { provider: integration.provider, kind: integration.kind, credential: tokens.accessToken };
    }

    const provider = integration.provider as 'jira' | 'google';
    const oauthConfig = config.oauthProviders?.[provider];
    if (!oauthConfig) {
      throw new OAuthRefreshError(integration.provider, integration.id, `OAuth for '${provider}' is not configured on this deployment — cannot refresh the token.`);
    }

    try {
      const refreshed = await refreshTokens(provider, oauthConfig, tokens.refreshToken);
      const encryptedTokens = encryptOAuthTokens(refreshed);
      const UserIntegrationModel = getModel('user_integrations');
      await UserIntegrationModel.update({ id: integration.id }, { ...encryptedTokens, updatedAt: new Date() });
      return { provider: integration.provider, kind: integration.kind, credential: refreshed.accessToken };
    } catch (e: any) {
      throw new OAuthRefreshError(integration.provider, integration.id, `The ${integration.provider} connection for this integration has expired — reconnect it from account integrations.`);
    }
  }

  return { provider: integration.provider, kind: integration.kind, credential: await decryptIntegration(integration) };
}
