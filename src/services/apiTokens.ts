import crypto from 'crypto';
import { getModel } from '../models/manager';
import { ApiTokenAccess, ApiTokenScope, StreamByConfig } from '../types';

// API tokens: how an agent or a service works with StreamBy as a user, without their browser
// session. A token is "sbt_" and 32 random bytes; only its hash is stored, with a prefix to
// tell it apart in a list. It's sent as `Authorization: Bearer sbt_...` and the host's
// authProvider resolves it (resolveApiToken), so the request is its owner's -- limited by the
// token's scope (read or write, which projects), and never more than its owner can do: the
// owner's role in each project still decides.

export const API_TOKEN_PREFIX = 'sbt_';
const PREFIX_SHOWN = API_TOKEN_PREFIX.length + 8;
export const API_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  // The token's first characters, to tell it apart (never enough to use it).
  prefix: string;
  // sha256 of the whole token: the token itself is never stored.
  hash: string;
  access: ApiTokenAccess;
  // The projects it reaches, as stored: their ids, or ['*'] for every project its owner is a
  // member of (those joined later included). Always a list, so it's valid JSON in SQL.
  projectIds: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

/** What a token's owner sees of it. */
export type ApiTokenInfo = Omit<ApiTokenRecord, 'hash' | 'userId' | 'projectIds'> & { projectIds: string[] | '*' };

const ALL_PROJECTS = '*';

export class ApiTokenError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const infoOf = ({ hash: _hash, userId: _userId, ...info }: ApiTokenRecord): ApiTokenInfo => ({
  ...info,
  projectIds: parseProjectIds(info.projectIds),
});

// As stored (a list, read back from SQL JSON as a list or its text): ['*'] is every project.
const parseProjectIds = (value: unknown): string[] | '*' => {
  if (typeof value === 'string') {
    try { return parseProjectIds(JSON.parse(value)); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const ids = value.map(String);
  return ids.includes(ALL_PROJECTS) ? '*' : ids;
};

const mainDbType = (config: StreamByConfig) => config.databases?.find(db => db.main)?.type ?? 'nosql';

export interface CreateApiTokenInput {
  name: string;
  access: ApiTokenAccess;
  projectIds: string[] | '*';
  // One of API_TOKEN_EXPIRY_DAYS, or null: it never expires (only revoking ends it).
  expiresInDays: number | null;
}

/** A new token for `userId`: the token itself, shown only now, and what's kept of it. */
export async function createApiToken(
  userId: string,
  input: CreateApiTokenInput,
  config: StreamByConfig,
): Promise<{ token: string; info: ApiTokenInfo }> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ApiTokenError('A token needs a name.');
  if (input.access !== 'read' && input.access !== 'write') throw new ApiTokenError("access must be 'read' or 'write'.");
  if (input.projectIds !== '*' && (!Array.isArray(input.projectIds) || !input.projectIds.length || !input.projectIds.every(id => typeof id === 'string' && id && id !== ALL_PROJECTS))) {
    throw new ApiTokenError("projectIds must be '*' or a list of project ids.");
  }
  if (input.expiresInDays !== null && !(API_TOKEN_EXPIRY_DAYS as readonly number[]).includes(input.expiresInDays)) {
    throw new ApiTokenError(`expiresInDays must be one of ${API_TOKEN_EXPIRY_DAYS.join(', ')}, or null.`);
  }

  const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const record: ApiTokenRecord = {
    id: crypto.randomUUID(),
    userId,
    name,
    prefix: token.slice(0, PREFIX_SHOWN),
    hash: hashOf(token),
    access: input.access,
    projectIds: input.projectIds === '*' ? [ALL_PROJECTS] : [...new Set(input.projectIds)],
    createdAt: now,
    expiresAt: input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000),
    lastUsedAt: null,
  };
  await getModel('api_tokens').create({ ...record, dbType: mainDbType(config) } as any);
  return { token, info: infoOf(record) };
}

/** The tokens `userId` has. */
export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const records = (await getModel('api_tokens').find({ userId })) as ApiTokenRecord[];
  return records
    .map(infoOf)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Revokes one of `userId`'s tokens: it stops working at once. Whether there was one. */
export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  return (await getModel('api_tokens').delete({ id: tokenId, userId })) > 0;
}

export interface ResolvedApiToken {
  userId: string;
  scope: ApiTokenScope;
}

/**
 * The token's owner and scope, for the host's authProvider; null when it isn't a token, isn't
 * known (revoked), or has expired. Marks when it was last used.
 */
export async function resolveApiToken(token: unknown): Promise<ResolvedApiToken | null> {
  if (typeof token !== 'string' || !token.startsWith(API_TOKEN_PREFIX)) return null;
  const ApiTokens = getModel('api_tokens');
  const record = (await ApiTokens.findOne({ hash: hashOf(token) })) as ApiTokenRecord | null;
  if (!record) return null;
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;
  ApiTokens.update({ id: record.id }, { lastUsedAt: new Date() }).catch(() => { /* a missed timestamp only */ });
  return {
    userId: record.userId,
    scope: { tokenId: record.id, access: record.access, projectIds: parseProjectIds(record.projectIds) },
  };
}
