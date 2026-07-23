import { Auth, StreamByConfig } from '../types';

// Gates access to a built-in database/storage provider. Delegates to config.canUseBuiltin
// when the mounting app implements it (e.g. Nhexa-API checking user_subscriptions);
// defaults to allow when absent, preserving pre-BYOC behavior for deploys without gating.
export async function assertBuiltinAccess(
  auth: Auth,
  builtinId: string,
  config: StreamByConfig,
  kind: 'database' | 'storage',
): Promise<boolean> {
  if (!config.canUseBuiltin) return true;
  return config.canUseBuiltin(auth, builtinId, kind);
}

export function isBuiltinStorageId(id: string, config: StreamByConfig): boolean {
  return (config.storageProviders ?? []).some(p => p.id === id);
}

export function isBuiltinDb(id: string, config: StreamByConfig): boolean {
  return (config.databases ?? []).some(db => db.id === id);
}

// Display names for builtin connections — never the raw config id/type. The frontend pairs
// this with the StreamBy icon to visually mark a connection as built-in vs BYOC.
export const BUILTIN_STORAGE_DISPLAY: Record<string, string> = {
  s3: 'AWS S3',
  gcs: 'Google Cloud Storage',
  r2: 'Cloudflare R2',
  azure: 'Azure Blob Storage',
};

export const BUILTIN_DB_DISPLAY: Record<string, string> = {
  sql: 'PostgreSQL',
  nosql: 'MongoDB',
};
