import crypto from 'crypto';
import { getModel } from '../models/manager';
import { ApiTokenKind, ApiTokenScope, StreamByConfig } from '../types';
import { projectTokenPrincipal } from '../utils/auth';
import { ApiTokenPermission, isAccountPermission, isProjectPermission } from './apiTokenPermissions';

// API tokens: how an agent or a service works with StreamBy without a browser session. A token
// is "sbt_" and 32 random bytes; only its hash is stored, with a prefix to tell it apart in a
// list. It's sent as `Authorization: Bearer sbt_...` and the host's authProvider resolves it
// (resolveApiToken). It does only what its permissions allow (see apiTokenPermissions), and:
//
// - a user's token acts as its user, on the projects it reaches: never more than its user can,
//   since their role in each project still decides;
// - a project's token acts on its project alone, as the project's, not as whoever made it: it
//   keeps working after they leave the project. Only the project's admins manage it.

export const API_TOKEN_PREFIX = 'sbt_';
const PREFIX_SHOWN = API_TOKEN_PREFIX.length + 8;
export const API_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;

export interface ApiTokenRecord {
  id: string;
  kind: ApiTokenKind;
  // Who made it: a user's token's owner, or the admin who made a project's token.
  userId: string;
  // Their username then, to show who made a project's token after they've left it.
  createdByName: string | null;
  name: string;
  // The token's first characters, to tell it apart (never enough to use it).
  prefix: string;
  // sha256 of the whole token: the token itself is never stored.
  hash: string;
  permissions: ApiTokenPermission[];
  // The projects it reaches, as stored: their ids, or ['*'] for every project its owner is a
  // member of (those joined later included). Always a list, so it's valid JSON in SQL. A
  // project's token: its project.
  projectIds: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

/** What's shown of a token: never its hash. */
export type ApiTokenInfo = Omit<ApiTokenRecord, 'hash' | 'userId' | 'projectIds' | 'createdByName'> & {
  projectIds: string[] | '*';
  createdBy: { userId: string; username: string | null };
};

const ALL_PROJECTS = '*';

export class ApiTokenError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// A list, as stored in SQL JSON: read back as a list or as its text.
const listOf = (value: unknown): string[] => {
  if (typeof value === 'string') {
    try { return listOf(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String) : [];
};

const parseProjectIds = (value: unknown): string[] | '*' => {
  const ids = listOf(value);
  return ids.includes(ALL_PROJECTS) ? '*' : ids;
};

// Only the permissions its kind may have: a stored one that isn't known anymore is dropped.
const parsePermissions = (value: unknown, kind: ApiTokenKind): ApiTokenPermission[] =>
  listOf(value).filter((p): p is ApiTokenPermission => isProjectPermission(p) || (kind === 'user' && isAccountPermission(p)));

// Tokens made before they had a kind and permissions don't work anymore, nor are listed.
const isCurrent = (record: Partial<ApiTokenRecord> | null): record is ApiTokenRecord =>
  !!record && (record.kind === 'user' || record.kind === 'project');

const infoOf = (record: ApiTokenRecord): ApiTokenInfo => {
  const { hash: _hash, userId, createdByName, projectIds, permissions, ...info } = record;
  return {
    ...info,
    permissions: parsePermissions(permissions, record.kind),
    projectIds: parseProjectIds(projectIds),
    createdBy: { userId, username: createdByName ?? null },
  };
};

const mainDbType = (config: StreamByConfig) => config.databases?.find(db => db.main)?.type ?? 'nosql';

export interface CreateApiTokenInput {
  name: string;
  permissions: ApiTokenPermission[];
  // A user's token: the projects it reaches, or '*'. (A project's token: its project.)
  projectIds?: string[] | '*';
  // One of API_TOKEN_EXPIRY_DAYS, or null: it never expires (only revoking ends it).
  expiresInDays: number | null;
}

export interface ApiTokenOwner {
  kind: ApiTokenKind;
  // Who makes it, and their username.
  userId: string;
  username?: string | null;
  // A project's token: its project.
  projectId?: string;
}

const validPermissions = (value: unknown, kind: ApiTokenKind): ApiTokenPermission[] => {
  if (!Array.isArray(value) || !value.length) throw new ApiTokenError('A token needs at least one permission.');
  for (const p of value) {
    if (isAccountPermission(p) && kind === 'project') throw new ApiTokenError(`A project's token can't have '${p}'.`);
    if (!isProjectPermission(p) && !isAccountPermission(p)) throw new ApiTokenError(`Unknown permission '${String(p)}'.`);
  }
  return [...new Set(value as ApiTokenPermission[])];
};

/** A new token: the token itself, shown only now, and what's kept of it. */
export async function createApiToken(
  owner: ApiTokenOwner,
  input: CreateApiTokenInput,
  config: StreamByConfig,
): Promise<{ token: string; info: ApiTokenInfo }> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ApiTokenError('A token needs a name.');
  const permissions = validPermissions(input.permissions, owner.kind);

  let projectIds: string[];
  if (owner.kind === 'project') {
    if (!owner.projectId) throw new ApiTokenError("A project's token needs its project.");
    projectIds = [owner.projectId];
  } else if (input.projectIds === '*') {
    projectIds = [ALL_PROJECTS];
  } else {
    const ids = input.projectIds;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id && id !== ALL_PROJECTS)) {
      throw new ApiTokenError("projectIds must be '*' or a list of project ids.");
    }
    // No project yet only for a token that makes them: it reaches the ones it makes.
    if (!ids.length && !permissions.includes('projects:create')) {
      throw new ApiTokenError('A token needs at least one project, or to be able to create them.');
    }
    projectIds = [...new Set(ids)];
  }

  if (input.expiresInDays !== null && !(API_TOKEN_EXPIRY_DAYS as readonly number[]).includes(input.expiresInDays)) {
    throw new ApiTokenError(`expiresInDays must be one of ${API_TOKEN_EXPIRY_DAYS.join(', ')}, or null.`);
  }

  const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const record: ApiTokenRecord = {
    id: crypto.randomUUID(),
    kind: owner.kind,
    userId: owner.userId,
    createdByName: owner.username ?? null,
    name,
    prefix: token.slice(0, PREFIX_SHOWN),
    hash: hashOf(token),
    permissions,
    projectIds,
    createdAt: now,
    expiresAt: input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000),
    lastUsedAt: null,
  };
  await getModel('api_tokens').create({ ...record, dbType: mainDbType(config) } as any);
  return { token, info: infoOf(record) };
}

const newestFirst = (a: ApiTokenInfo, b: ApiTokenInfo) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/** A user's own tokens. */
export async function listUserApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const records = (await getModel('api_tokens').find({ userId, kind: 'user' })) as ApiTokenRecord[];
  return records.filter(isCurrent).map(infoOf).sort(newestFirst);
}

/** A project's tokens. */
export async function listProjectApiTokens(projectId: string): Promise<ApiTokenInfo[]> {
  const records = (await getModel('api_tokens').find({ kind: 'project' })) as ApiTokenRecord[];
  return records
    .filter(r => isCurrent(r) && listOf(r.projectIds)[0] === projectId)
    .map(infoOf)
    .sort(newestFirst);
}

/** Revokes a user's own token: it stops working at once. Whether there was one. */
export async function revokeUserApiToken(userId: string, tokenId: string): Promise<boolean> {
  return (await getModel('api_tokens').delete({ id: tokenId, userId, kind: 'user' })) > 0;
}

/** Revokes a project's token. Whether there was one. */
export async function revokeProjectApiToken(projectId: string, tokenId: string): Promise<boolean> {
  const ApiTokens = getModel('api_tokens');
  const record = (await ApiTokens.findOne({ id: tokenId, kind: 'project' })) as ApiTokenRecord | null;
  if (!record || listOf(record.projectIds)[0] !== projectId) return false;
  return (await ApiTokens.delete({ id: tokenId })) > 0;
}

/** A project's tokens that `userId` made (to tell its admins they keep working once they leave). */
export async function projectApiTokensMadeBy(projectId: string, userId: string): Promise<ApiTokenInfo[]> {
  return (await listProjectApiTokens(projectId)).filter(t => t.createdBy.userId === userId);
}

/** Ends a deleted project's tokens. */
export async function deleteProjectApiTokens(projectId: string): Promise<void> {
  const ApiTokens = getModel('api_tokens');
  for (const token of await listProjectApiTokens(projectId)) await ApiTokens.delete({ id: token.id });
}

/** A project a user's token made: it reaches it from now on (one reaching every project already does). */
export async function addProjectToApiToken(tokenId: string, projectId: string): Promise<void> {
  const ApiTokens = getModel('api_tokens');
  const record = (await ApiTokens.findOne({ id: tokenId, kind: 'user' })) as ApiTokenRecord | null;
  if (!record) return;
  const ids = listOf(record.projectIds);
  if (ids.includes(ALL_PROJECTS) || ids.includes(projectId)) return;
  await ApiTokens.update({ id: tokenId }, { projectIds: [...ids, projectId] });
}

export interface ResolvedApiToken {
  // A user's token: its owner. A project's token: the token itself, on its project (the
  // request isn't any user's; see utils/auth).
  userId: string;
  // The token's name, for a project's token to be shown by (it has no user).
  name: string;
  scope: ApiTokenScope;
}

/**
 * The token's request: who it is and what it may do, for the host's authProvider; null when
 * it isn't a token, isn't known (revoked), or has expired. Marks when it was last used.
 */
export async function resolveApiToken(token: unknown): Promise<ResolvedApiToken | null> {
  if (typeof token !== 'string' || !token.startsWith(API_TOKEN_PREFIX)) return null;
  const ApiTokens = getModel('api_tokens');
  const record = (await ApiTokens.findOne({ hash: hashOf(token) })) as ApiTokenRecord | null;
  if (!isCurrent(record)) return null;
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;
  ApiTokens.update({ id: record.id }, { lastUsedAt: new Date() }).catch(() => { /* a missed timestamp only */ });

  const scope: ApiTokenScope = {
    tokenId: record.id,
    kind: record.kind,
    permissions: parsePermissions(record.permissions, record.kind),
    projectIds: parseProjectIds(record.projectIds),
  };
  if (record.kind === 'project') {
    const projectId = listOf(record.projectIds)[0];
    if (!projectId) return null;
    return { userId: projectTokenPrincipal(record.id, projectId), name: record.name, scope: { ...scope, projectIds: [projectId] } };
  }
  return { userId: record.userId, name: record.name, scope };
}
