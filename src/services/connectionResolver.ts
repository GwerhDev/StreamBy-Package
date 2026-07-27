import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { StreamByConfig, Auth, DbConnection, StorageConnection, StorageAdapter } from '../types';
import { getConnection } from '../adapters/database/connectionManager';
import { assertBuiltinAccess } from '../utils/builtinAccess';
import { getDecryptedIntegrationCredentialById } from './userIntegration';
import { decrypt, isEncryptionKeySet } from '../utils/encryption';
import { createStorageProvider } from '../providers/storage';
import { S3Adapter } from '../adapters/storage/s3';

export type ResolvedDbClient = { client: Pool | MongoClient; type: 'sql' | 'nosql'; ephemeral: boolean };
export type ResolveError = { error: string; status: number };

export function findDbConnection(project: any, connId: string): DbConnection | undefined {
  return project.dbConnections?.find((c: DbConnection) => c.id === connId);
}

export function findStorageConnection(project: any, connId: string): StorageConnection | undefined {
  return project.storageConnections?.find((c: StorageConnection) => c.id === connId);
}

// `connId` must be the `id` of a real row in project.dbConnections — never a bare
// config id (config.databases[].id). Builtin rows reuse the shared pooled client keyed by
// conn.integrationId (config id); BYOC/manual rows open a short-lived client from their own
// decrypted credential, which the caller must close via `releaseDbClient` once done.
export async function resolveDbConnectionClient(
  project: any,
  connId: string,
  config: StreamByConfig,
  auth: Auth,
): Promise<ResolvedDbClient | ResolveError> {
  const conn = findDbConnection(project, connId);
  if (!conn) return { error: 'DB connection not found', status: 404 };

  if (conn.source === 'builtin') {
    const builtinId = conn.integrationId!;
    if (!(await assertBuiltinAccess(auth, builtinId, config, 'database'))) {
      return { error: 'Access to this built-in database is not permitted', status: 403 };
    }
    const db = (config.databases ?? []).find(d => d.id === builtinId);
    if (!db) return { error: `Database '${builtinId}' not found in config`, status: 404 };
    try {
      const { client, type } = getConnection(builtinId);
      return { client: client as Pool | MongoClient, type, ephemeral: false };
    } catch (e: any) {
      return { error: e.message, status: 503 };
    }
  }

  let connectionString: string;
  if (conn.source === 'integration') {
    if (!conn.integrationId) return { error: 'Connection is missing its integrationId', status: 500 };
    const credential = await getDecryptedIntegrationCredentialById(conn.integrationId);
    if (!credential) return { error: 'Integration not found', status: 400 };
    connectionString = credential as string;
  } else {
    if (!isEncryptionKeySet()) return { error: 'Encryption key is not set', status: 500 };
    if (!conn.encryptedCredential) return { error: 'Connection has no stored credential', status: 400 };
    connectionString = decrypt(conn.encryptedCredential);
  }

  const type: 'sql' | 'nosql' = conn.dbType === 'postgresql' ? 'sql' : 'nosql';
  try {
    if (type === 'sql') {
      const pool = new Pool({ connectionString });
      await pool.query('SELECT 1');
      return { client: pool, type, ephemeral: true };
    }
    const client = new MongoClient(connectionString);
    await client.connect();
    return { client, type, ephemeral: true };
  } catch (e: any) {
    return { error: `Failed to connect: ${e.message}`, status: 503 };
  }
}

// Only closes clients this resolver opened itself (`ephemeral: true`) — the shared pooled
// builtin clients are owned by connectionManager and must outlive a single request.
export async function releaseDbClient(resolved: ResolvedDbClient): Promise<void> {
  if (!resolved.ephemeral) return;
  if (resolved.type === 'sql') await (resolved.client as Pool).end();
  else await (resolved.client as MongoClient).close();
}

export async function resolveStorageAdapter(
  project: any,
  connId: string,
  config: StreamByConfig & { adapter?: StorageAdapter },
  auth: Auth,
): Promise<StorageAdapter | ResolveError> {
  const conn = findStorageConnection(project, connId);
  if (!conn) return { error: 'Storage connection not found', status: 404 };

  if (conn.source === 'builtin') {
    const builtinId = conn.integrationId!;
    if (!(await assertBuiltinAccess(auth, builtinId, config, 'storage'))) {
      return { error: 'Access to this built-in storage is not permitted', status: 403 };
    }
    const provider = config.storageProviders.find(p => p.id === builtinId);
    if (!provider) return { error: 'Storage provider not found', status: 404 };
    if (provider.type === 's3') return new S3Adapter(provider.config);
    return config.adapter || createStorageProvider(config.storageProviders);
  }

  if (conn.source === 'integration') {
    if (!conn.integrationId) return { error: 'Connection is missing its integrationId', status: 500 };
    try {
      const s3Config = await getDecryptedIntegrationCredentialById(conn.integrationId);
      if (!s3Config) return { error: 'Integration not found', status: 400 };
      return new S3Adapter(s3Config as any);
    } catch (e: any) {
      return { error: `Failed to initialize storage adapter: ${e.message}`, status: 500 };
    }
  }

  if (!isEncryptionKeySet()) return { error: 'Encryption key not set', status: 500 };
  if (!conn.encryptedCredential) return { error: 'Connection has no stored credential', status: 400 };
  try {
    const s3Config = JSON.parse(decrypt(conn.encryptedCredential));
    return new S3Adapter(s3Config);
  } catch (e: any) {
    return { error: `Failed to initialize storage adapter: ${e.message}`, status: 500 };
  }
}
